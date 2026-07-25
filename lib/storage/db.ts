/**
 * Local-first persistence over IndexedDB. All chat history and contacts live on
 * the device — there is no server copy. Identity secrets are stored only as a
 * sealed vault (see crypto/vault.ts).
 */
import { openDB, type DBSchema, type IDBPDatabase } from "idb";
import type { Contact, ChatMessage } from "@/lib/types";
import type { SealedVault } from "@/lib/crypto/vault";

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
}

let dbPromise: Promise<IDBPDatabase<HopDB>> | null = null;

function getDB(): Promise<IDBPDatabase<HopDB>> {
  if (!dbPromise) {
    dbPromise = openDB<HopDB>("hopchat", 1, {
      upgrade(db) {
        db.createObjectStore("identity", { keyPath: "id" });
        const contacts = db.createObjectStore("contacts", { keyPath: "address" });
        contacts.createIndex("byAddedAt", "addedAt");
        const messages = db.createObjectStore("messages", { keyPath: "id" });
        messages.createIndex("byPeer", "peer");
        messages.createIndex("byCreatedAt", "createdAt");
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
  ]);
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
