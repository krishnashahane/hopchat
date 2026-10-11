/**
 * Encrypted identity backup, for moving to a new device or recovering a wiped one.
 *
 * The file holds the identity keys, contacts and room keys (not message history or
 * ratchet sessions) sealed with Argon2id(passphrase) → AES-256-GCM. After a restore,
 * sessions re-handshake automatically. Use one device at a time: two live copies of
 * an identity would keep resetting each other's sessions.
 */
import { sealVault, openVault, type SealedVault } from "@/lib/crypto/vault";
import { serializeSecret, deserializeSecret, decodePublicBundle, deriveAddress, type Identity } from "@/lib/crypto/identity";
import { ROOM_NAME } from "@/lib/crypto/room";
import type { Contact } from "@/lib/types";
import type { StoredRoom } from "@/lib/storage/db";

export const MIN_BACKUP_PASSPHRASE = 10;

interface BackupFile {
  app: "hopchat-backup";
  v: 1;
  address: string;
  vault: SealedVault;
}

interface BackupBody {
  secret: Record<string, string>;
  contacts: Contact[];
  rooms: StoredRoom[];
  nick?: string;
}

export interface Restored {
  identity: Identity;
  contacts: Contact[];
  rooms: StoredRoom[];
  nick?: string;
}

export async function makeBackup(
  identity: Identity,
  contacts: Contact[],
  rooms: StoredRoom[],
  nick: string,
  passphrase: string,
): Promise<string> {
  if (passphrase.length < MIN_BACKUP_PASSPHRASE) throw new Error(`use a passphrase of at least ${MIN_BACKUP_PASSPHRASE} characters`);
  const body: BackupBody = { secret: serializeSecret(identity), contacts, rooms, nick };
  const file: BackupFile = { app: "hopchat-backup", v: 1, address: identity.address, vault: await sealVault(JSON.stringify(body), { passphrase }) };
  return JSON.stringify(file);
}

const validContact = (c: Contact): boolean => {
  try {
    return typeof c.nickname === "string" && deriveAddress(decodePublicBundle(c.bundle)) === c.address;
  } catch {
    return false;
  }
};

const validRoom = (r: StoredRoom): boolean =>
  typeof r.name === "string" && typeof r.key === "string" && (ROOM_NAME.test(r.name) || /^geo:[0-9a-z]{1,12}$/.test(r.name));

export async function readBackup(text: string, passphrase: string): Promise<Restored> {
  let file: BackupFile;
  try {
    file = JSON.parse(text) as BackupFile;
  } catch {
    throw new Error("that is not a HopChat backup file");
  }
  if (file?.app !== "hopchat-backup" || file.v !== 1 || file.vault?.kdf !== "argon2id") throw new Error("that is not a HopChat backup file");
  let body: BackupBody;
  try {
    body = JSON.parse(await openVault(file.vault, { passphrase })) as BackupBody;
  } catch {
    throw new Error("wrong passphrase, or the file is damaged");
  }
  const identity = deserializeSecret(body.secret);
  if (identity.address !== file.address) throw new Error("backup is inconsistent");
  return {
    identity,
    contacts: (Array.isArray(body.contacts) ? body.contacts : []).filter(validContact),
    rooms: (Array.isArray(body.rooms) ? body.rooms : []).filter(validRoom),
    nick: typeof body.nick === "string" ? body.nick : undefined,
  };
}
