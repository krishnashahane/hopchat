/**
 * Local-first persistence over IndexedDB. All chat history and contacts live on
 * the device — there is no server copy.
 *
 * Encryption at rest: identity secrets live in a sealed vault (crypto/vault.ts).
 * Everything else that is sensitive — message bodies, file bytes, room authors,
 * ratchet session state, contact cards, room keys — is sealed with AES-256-GCM
 * under a random data key that itself lives *inside* the vault. Only the fields
 * needed for indexing (ids, peer, timestamps, status) stay in the clear.
 */
import { openDB, type DBSchema, type IDBPDatabase } from "idb";
import { gcm } from "@noble/ciphers/aes.js";
import type { Contact, ChatMessage } from "@/lib/types";
import type { SealedVault } from "@/lib/crypto/vault";
import type { SerializedRatchet } from "@/lib/crypto/ratchet";
import { utf8, fromUtf8 } from "@/lib/crypto/encoding";

export interface StoredSession {
  peer: string;
  role: "initiator" | "responder";
  established: boolean;
  ratchet: SerializedRatchet;
  /** Pending handshake offer JSON, retransmitted until established (initiator only). */
  offer?: string;
  seenEk?: string[];
}

export interface StoredRoom {
  /** Display name, e.g. "#general". */
  name: string;
  /** Mesh destination derived from the room key ("ROOM-…"). */
  dest: string;
  /** Raw AES-256 room key (Argon2id of name + optional password), base64url. */
  key: string;
  locked: boolean;
  joinedAt: number;
}

/** AES-GCM box: random 96-bit nonce + ciphertext. */
interface Box {
  n: Uint8Array;
  c: Uint8Array;
}

type MsgClear = Pick<ChatMessage, "id" | "peer" | "direction" | "createdAt" | "status" | "expiresAt">;
type MsgSecret = Pick<ChatMessage, "body" | "file" | "author">;
type MsgRow = MsgClear & { enc: Box; blob?: Box & { type: string } };
type SessionRow = { peer: string; enc: Box };
type ContactRow = { address: string; addedAt: number; enc: Box };
type RoomRow = { name: string; joinedAt: number; enc: Box };

interface HopDB extends DBSchema {
  identity: {
    key: string;
    value: { id: "self"; vault: SealedVault; address: string; bundle: string };
  };
  contacts: {
    key: string;
    value: ContactRow | Contact;
    indexes: { byAddedAt: number };
  };
  messages: {
    key: string;
    value: MsgRow | ChatMessage;
    indexes: { byPeer: string; byCreatedAt: number };
  };
  sessions: {
    key: string;
    value: SessionRow | StoredSession;
  };
  keys: {
    key: string;
    value: { id: string; key: CryptoKey };
  };
  rooms: {
    key: string;
    value: RoomRow | StoredRoom;
  };
}

let dbPromise: Promise<IDBPDatabase<HopDB>> | null = null;
let dataKey: Uint8Array | null = null;

function getDB(): Promise<IDBPDatabase<HopDB>> {
  if (!dbPromise) {
    dbPromise = openDB<HopDB>("hopchat", 3, {
      upgrade(db, oldVersion) {
        if (oldVersion < 1) {
          db.createObjectStore("identity", { keyPath: "id" });
          const contacts = db.createObjectStore("contacts", { keyPath: "address" });
          contacts.createIndex("byAddedAt", "addedAt");
          const messages = db.createObjectStore("messages", { keyPath: "id" });
          messages.createIndex("byPeer", "peer");
          messages.createIndex("byCreatedAt", "createdAt");
        }
        if (oldVersion < 2) {
          db.createObjectStore("sessions", { keyPath: "peer" });
        }
        if (oldVersion < 3) {
          db.createObjectStore("keys", { keyPath: "id" });
          db.createObjectStore("rooms", { keyPath: "name" });
        }
      },
    });
  }
  return dbPromise;
}

// ── at-rest sealing ─────────────────────────────────────────────────────────

/** Install the data key from the unlocked vault. Required before any data access. */
export function setDataKey(key: Uint8Array | null): void {
  dataKey = key;
}

function requireKey(): Uint8Array {
  if (!dataKey) throw new Error("Storage locked");
  return dataKey;
}

/** AAD binds a box to its store and row so ciphertext can't be swapped between rows. */
function sealBytes(bytes: Uint8Array, aad: string): Box {
  const n = crypto.getRandomValues(new Uint8Array(12));
  return { n, c: gcm(requireKey(), n, utf8(aad)).encrypt(bytes) };
}

function openBytes(box: Box, aad: string): Uint8Array {
  return gcm(requireKey(), box.n, utf8(aad)).decrypt(box.c);
}

const seal = (v: unknown, aad: string): Box => sealBytes(utf8(JSON.stringify(v)), aad);
const open = <T,>(box: Box, aad: string): T => JSON.parse(fromUtf8(openBytes(box, aad))) as T;
const isSealed = (row: object): row is { enc: Box } => "enc" in row;

/** Decode rows, dropping any that fail to authenticate (corruption or tampering). */
function decodeAll<R extends object, T>(rows: R[], decode: (r: R) => T): T[] {
  requireKey(); // a locked store must fail loudly, not look empty
  const out: T[] = [];
  for (const r of rows) {
    try {
      out.push(decode(r));
    } catch {
      /* unreadable row — skip */
    }
  }
  return out;
}

async function encodeMessage(m: ChatMessage): Promise<MsgRow> {
  const aad = `msg:${m.id}`;
  const secret: MsgSecret = { body: m.body, file: m.file, author: m.author };
  const row: MsgRow = {
    id: m.id,
    peer: m.peer,
    direction: m.direction,
    createdAt: m.createdAt,
    status: m.status,
    expiresAt: m.expiresAt,
    enc: seal(secret, aad),
  };
  if (m.blob) row.blob = { ...sealBytes(new Uint8Array(await m.blob.arrayBuffer()), `${aad}:blob`), type: m.blob.type };
  return row;
}

function decodeMessage(r: MsgRow | ChatMessage): ChatMessage {
  if (!isSealed(r)) return r as ChatMessage;
  const row = r as MsgRow;
  const aad = `msg:${row.id}`;
  const secret = open<MsgSecret>(row.enc, aad);
  const { enc: _enc, blob, ...clear } = row;
  const m: ChatMessage = { ...clear, ...secret };
  if (blob) m.blob = new Blob([openBytes(blob, `${aad}:blob`).buffer as ArrayBuffer], { type: blob.type });
  return m;
}

const encodeSession = (s: StoredSession): SessionRow => ({ peer: s.peer, enc: seal(s, `session:${s.peer}`) });
const decodeSession = (r: SessionRow | StoredSession): StoredSession =>
  isSealed(r) ? open<StoredSession>((r as SessionRow).enc, `session:${r.peer}`) : (r as StoredSession);

const encodeContact = (c: Contact): ContactRow => ({ address: c.address, addedAt: c.addedAt, enc: seal(c, `contact:${c.address}`) });
const decodeContact = (r: ContactRow | Contact): Contact =>
  isSealed(r) ? open<Contact>((r as ContactRow).enc, `contact:${r.address}`) : (r as Contact);

const encodeRoom = (x: StoredRoom): RoomRow => ({ name: x.name, joinedAt: x.joinedAt, enc: seal(x, `room:${x.name}`) });
const decodeRoom = (r: RoomRow | StoredRoom): StoredRoom =>
  isSealed(r) ? open<StoredRoom>((r as RoomRow).enc, `room:${r.name}`) : (r as StoredRoom);

/** Re-write any rows still stored in the clear (data from before at-rest sealing). */
export async function sealLegacyRows(): Promise<void> {
  const db = await getDB();
  for (const r of await db.getAll("messages")) if (!isSealed(r)) await db.put("messages", await encodeMessage(r as ChatMessage));
  for (const r of await db.getAll("sessions")) if (!isSealed(r)) await db.put("sessions", encodeSession(r as StoredSession));
  for (const r of await db.getAll("contacts")) if (!isSealed(r)) await db.put("contacts", encodeContact(r as Contact));
  for (const r of await db.getAll("rooms")) if (!isSealed(r)) await db.put("rooms", encodeRoom(r as StoredRoom));
}

// ── identity & device key ───────────────────────────────────────────────────

export async function saveIdentityRecord(rec: {
  vault: SealedVault;
  address: string;
  bundle: string;
}): Promise<void> {
  const db = await getDB();
  await db.put("identity", { id: "self", ...rec });
}

export async function loadIdentityRecord(): Promise<
  { vault: SealedVault; address: string; bundle: string } | undefined
> {
  const db = await getDB();
  return db.get("identity", "self");
}

/** Non-extractable AES-GCM key that seals the identity when no passphrase is set. */
export async function deviceKey(): Promise<CryptoKey> {
  const db = await getDB();
  const found = await db.get("keys", "device");
  if (found) return found.key;
  const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
  await db.put("keys", { id: "device", key });
  return key;
}

export async function clearAll(): Promise<void> {
  const db = await getDB();
  await Promise.all([
    db.clear("identity"),
    db.clear("contacts"),
    db.clear("messages"),
    db.clear("sessions"),
    db.clear("keys"),
    db.clear("rooms"),
  ]);
  dataKey = null;
}

/** Panic wipe: drop the whole database, not just its rows. */
export async function destroy(): Promise<void> {
  dataKey = null;
  if (dbPromise) (await dbPromise).close();
  dbPromise = null;
  await new Promise<void>((resolve) => {
    const req = indexedDB.deleteDatabase("hopchat");
    req.onsuccess = req.onerror = req.onblocked = () => resolve();
  });
}

// ── sessions ────────────────────────────────────────────────────────────────

export async function saveSession(s: StoredSession): Promise<void> {
  const db = await getDB();
  await db.put("sessions", encodeSession(s));
}

export async function loadSessions(): Promise<StoredSession[]> {
  const db = await getDB();
  return decodeAll(await db.getAll("sessions"), decodeSession);
}

// ── contacts ────────────────────────────────────────────────────────────────

export async function upsertContact(c: Contact): Promise<void> {
  const db = await getDB();
  await db.put("contacts", encodeContact(c));
}

export async function getContact(address: string): Promise<Contact | undefined> {
  const db = await getDB();
  const row = await db.get("contacts", address);
  return row ? decodeContact(row) : undefined;
}

export async function listContacts(): Promise<Contact[]> {
  const db = await getDB();
  return decodeAll(await db.getAll("contacts"), decodeContact).sort((a, b) => b.addedAt - a.addedAt);
}

export async function deleteContact(address: string): Promise<void> {
  const db = await getDB();
  await db.delete("contacts", address);
}

// ── rooms ───────────────────────────────────────────────────────────────────

export async function listRooms(): Promise<StoredRoom[]> {
  const db = await getDB();
  return decodeAll(await db.getAll("rooms"), decodeRoom).sort((a, b) => a.joinedAt - b.joinedAt);
}

export async function saveRoom(r: StoredRoom): Promise<void> {
  const db = await getDB();
  await db.put("rooms", encodeRoom(r));
}

export async function deleteRoom(name: string): Promise<void> {
  const db = await getDB();
  await db.delete("rooms", name);
}

// ── messages ────────────────────────────────────────────────────────────────

export async function addMessage(m: ChatMessage): Promise<void> {
  const row = await encodeMessage(m);
  const db = await getDB();
  await db.put("messages", row);
}

export async function hasMessage(id: string): Promise<boolean> {
  const db = await getDB();
  return (await db.getKey("messages", id)) !== undefined;
}

export async function updateMessage(m: ChatMessage): Promise<void> {
  await addMessage(m);
}

export async function listMessages(peer: string): Promise<ChatMessage[]> {
  const db = await getDB();
  const all = decodeAll(await db.getAllFromIndex("messages", "byPeer", peer), decodeMessage);
  return all.sort((a, b) => a.createdAt - b.createdAt);
}

export async function deleteMessage(id: string): Promise<void> {
  const db = await getDB();
  await db.delete("messages", id);
}

/** Delete every stored message for one conversation (contact address or room name). */
export async function clearMessages(peer: string): Promise<void> {
  const db = await getDB();
  const tx = db.transaction("messages", "readwrite");
  for (const key of await tx.store.index("byPeer").getAllKeys(peer)) await tx.store.delete(key);
  await tx.done;
}

/** Purge messages whose self-destruct time has passed (expiry is a clear field). */
export async function purgeExpired(now = Date.now()): Promise<number> {
  const db = await getDB();
  const tx = db.transaction("messages", "readwrite");
  let n = 0;
  for (const m of await tx.store.getAll()) {
    if (m.expiresAt && m.expiresAt <= now) {
      await tx.store.delete(m.id);
      n++;
    }
  }
  await tx.done;
  return n;
}
