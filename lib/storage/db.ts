/**
 * Local-first persistence over IndexedDB. All chat history and contacts live on
 * the device — there is no server copy. Identity secrets are stored only as a
 * sealed vault (see crypto/vault.ts).
 */
import { openDB, type DBSchema, type IDBPDatabase } from "idb";
import type { Contact, ChatMessage } from "@/lib/types";
import type { SealedVault } from "@/lib/crypto/vault";
import type { SerializedRatchet } from "@/lib/crypto/ratchet";

export interface StoredSession {
  peer: string;
  role: "initiator" | "responder";
  established: boolean;
  ratchet: SerializedRatchet;
  /** Pending handshake offer JSON, retransmitted until established (initiator only). */
  offer?: string;
}

interface HopDB extends DBSchema {
  identity: {
    key: string;
    value: { id: "self"; vault: SealedVault; address: string; bundle: string };
  };
  contacts: {
    key: string;
    value: Contact;
    indexes: { byAddedAt: number };
  };
  messages: {
    key: string;
    value: ChatMessage;
    indexes: { byPeer: string; byCreatedAt: number };
  };
  sessions: {
    key: string;
    value: StoredSession;
  };
  keys: {
    key: string;
    value: { id: string; key: CryptoKey };
  };
  rooms: {
    key: string;
    value: StoredRoom;
  };
}

export interface StoredRoom {
  /** Display name, e.g. "#general". */
  name: string;
  /** Mesh destination derived from the room key ("ROOM-…"). */
  dest: string;
  /** Raw AES-256 room key (Argon2id of name + optional password). */
  key: string;
  locked: boolean;
  joinedAt: number;
}

let dbPromise: Promise<IDBPDatabase<HopDB>> | null = null;

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
}

/** Panic wipe: drop the whole database, not just its rows. */
export async function destroy(): Promise<void> {
  if (dbPromise) (await dbPromise).close();
  dbPromise = null;
  await new Promise<void>((resolve) => {
    const req = indexedDB.deleteDatabase("hopchat");
    req.onsuccess = req.onerror = req.onblocked = () => resolve();
  });
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

export async function listRooms(): Promise<StoredRoom[]> {
  const db = await getDB();
  return (await db.getAll("rooms")).sort((a, b) => a.joinedAt - b.joinedAt);
}

export async function saveRoom(r: StoredRoom): Promise<void> {
  const db = await getDB();
  await db.put("rooms", r);
}

export async function deleteRoom(name: string): Promise<void> {
  const db = await getDB();
  await db.delete("rooms", name);
}

/** Delete every stored message for one conversation (contact address or room name). */
export async function clearMessages(peer: string): Promise<void> {
  const db = await getDB();
  const tx = db.transaction("messages", "readwrite");
  for (const key of await tx.store.index("byPeer").getAllKeys(peer)) await tx.store.delete(key);
  await tx.done;
}

export async function saveSession(s: StoredSession): Promise<void> {
  const db = await getDB();
  await db.put("sessions", s);
}

export async function loadSessions(): Promise<StoredSession[]> {
  const db = await getDB();
  return db.getAll("sessions");
}

export async function upsertContact(c: Contact): Promise<void> {
  const db = await getDB();
  await db.put("contacts", c);
}

export async function getContact(address: string): Promise<Contact | undefined> {
  const db = await getDB();
  return db.get("contacts", address);
}

export async function listContacts(): Promise<Contact[]> {
  const db = await getDB();
  const all = await db.getAll("contacts");
  return all.sort((a, b) => b.addedAt - a.addedAt);
}

export async function deleteContact(address: string): Promise<void> {
  const db = await getDB();
  await db.delete("contacts", address);
}

export async function addMessage(m: ChatMessage): Promise<void> {
  const db = await getDB();
  await db.put("messages", m);
}

export async function updateMessage(m: ChatMessage): Promise<void> {
  const db = await getDB();
  await db.put("messages", m);
}

export async function listMessages(peer: string): Promise<ChatMessage[]> {
  const db = await getDB();
  const all = await db.getAllFromIndex("messages", "byPeer", peer);
  return all.sort((a, b) => a.createdAt - b.createdAt);
}

export async function deleteMessage(id: string): Promise<void> {
  const db = await getDB();
  await db.delete("messages", id);
}

/** Purge messages whose self-destruct time has passed. */
export async function purgeExpired(now = Date.now()): Promise<number> {
  const db = await getDB();
  const all = await db.getAll("messages");
  let n = 0;
  for (const m of all) {
    if (m.expiresAt && m.expiresAt <= now) {
      await db.delete("messages", m.id);
      n++;
    }
  }
  return n;
}
