/**
 * Rooms — IRC-style group channels over the mesh.
 *
 * The room key is Argon2id(password, salt = H(name)). A room without a password is
 * public: anyone who knows the name can derive the key. With a password, only people
 * who know both can read or post. The mesh destination is a hash of the key, so relays
 * learn neither the name nor the password.
 *
 * Every post is AES-256-GCM sealed under the room key (AAD = destination) and carries
 * the author's public bundle plus an Ed25519 signature, so a member cannot post under
 * another member's address.
 */
import { gcm } from "@noble/ciphers/aes";
import { sha256 } from "@noble/hashes/sha2";
import { argon2Key } from "./vault";
import { base32Encode, b64uEncode, b64uDecode, utf8, fromUtf8, concatBytes } from "./encoding";
import { decodePublicBundle, deriveAddress, encodePublicBundle, type Identity } from "./identity";
import { signBytes, verifyBytes } from "./e2e";

export const ROOM_NAME = /^#[a-z0-9_-]{1,32}$/;
export const MAX_ROOM_BODY = 2000;

export interface RoomPost {
  id: string;
  ts: number;
  nick: string;
  body: string;
}

interface Inner extends RoomPost {
  bundle: string;
  sig: string;
}

export interface SealedPost {
  n: string;
  c: string;
}

export function normalizeRoom(raw: string): string | null {
  const name = (raw.startsWith("#") ? raw : `#${raw}`).toLowerCase();
  return ROOM_NAME.test(name) ? name : null;
}

export async function deriveRoom(name: string, password = ""): Promise<{ key: Uint8Array; dest: string }> {
  const salt = sha256(utf8(`hopchat-room:${name}`)).slice(0, 16);
  const key = await argon2Key(password, salt);
  const id = sha256(concatBytes(utf8("hopchat-room-id"), key)).slice(0, 15);
  return { key, dest: `ROOM-${base32Encode(id)}` };
}

const transcript = (dest: string, p: RoomPost): Uint8Array =>
  utf8(`hop-room:${dest}:${p.id}:${p.ts}:${p.nick}:${p.body}`);

export function sealPost(id: Identity, key: Uint8Array, dest: string, post: RoomPost): SealedPost {
  const inner: Inner = {
    ...post,
    bundle: encodePublicBundle(id.publicKeys),
    sig: b64uEncode(signBytes(id, transcript(dest, post))),
  };
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const ct = gcm(key, nonce, utf8(dest)).encrypt(utf8(JSON.stringify(inner)));
  return { n: b64uEncode(nonce), c: b64uEncode(ct) };
}

/** Decrypt and authenticate a post. Throws on a wrong key, tampering, or a bad signature. */
export function openPost(key: Uint8Array, dest: string, sealed: SealedPost): RoomPost & { address: string } {
  const pt = gcm(key, b64uDecode(sealed.n), utf8(dest)).decrypt(b64uDecode(sealed.c));
  const inner = JSON.parse(fromUtf8(pt)) as Inner;
  if (
    typeof inner.id !== "string" ||
    !Number.isFinite(inner.ts) ||
    typeof inner.nick !== "string" ||
    typeof inner.body !== "string" ||
    inner.body.length > MAX_ROOM_BODY ||
    inner.nick.length > 32
  ) {
    throw new Error("Malformed room post");
  }
  const pub = decodePublicBundle(inner.bundle);
  if (!verifyBytes(pub.sign, transcript(dest, inner), b64uDecode(inner.sig))) throw new Error("Bad signature");
  return { id: inner.id, ts: inner.ts, nick: inner.nick, body: inner.body, address: deriveAddress(pub) };
}
