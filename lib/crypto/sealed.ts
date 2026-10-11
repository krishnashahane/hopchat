/**
 * Sealed sender for the internet relay. A direct packet is wrapped to the recipient's
 * X25519 key with a fresh ephemeral key, so the relay sees only the destination: not
 * the sender, the packet kind, or (beyond 1 KiB buckets) its size. The inner packet is
 * still ratchet-encrypted and post-quantum seeded; this layer only hides metadata.
 */
import { x25519 } from "@noble/curves/ed25519.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { gcm } from "@noble/ciphers/aes.js";
import type { Identity } from "./identity";
import { b64uEncode, b64uDecode, utf8, fromUtf8, concatBytes } from "./encoding";

const INFO = utf8("hopchat-sealed-sender-v1");
const PAD = 1024;

export interface SealedSender {
  v: 1;
  e: string;
  n: string;
  c: string;
}

const keyFor = (shared: Uint8Array, eph: Uint8Array, recipientKex: Uint8Array) =>
  hkdf(sha256, shared, concatBytes(eph, recipientKex), INFO, 32);

/** Wrap `text` (a JSON packet) for `to`. Trailing spaces pad it; JSON.parse ignores them. */
export function sealSender(to: string, recipientKex: Uint8Array, text: string): SealedSender {
  const sk = x25519.utils.randomSecretKey();
  const eph = x25519.getPublicKey(sk);
  const key = keyFor(x25519.getSharedSecret(sk, recipientKex), eph, recipientKex);
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const padded = text + " ".repeat((PAD - (text.length % PAD)) % PAD);
  const c = gcm(key, nonce, utf8(to)).encrypt(utf8(padded));
  return { v: 1, e: b64uEncode(eph), n: b64uEncode(nonce), c: b64uEncode(c) };
}

export const isSealedSender = (x: unknown): x is SealedSender =>
  !!x && typeof x === "object" && (x as SealedSender).v === 1 && typeof (x as SealedSender).e === "string" && typeof (x as SealedSender).c === "string";

/** Unwrap a packet addressed to `self`. Throws if it was not sealed to us or was altered. */
export function openSender(self: Identity, box: SealedSender): string {
  const eph = b64uDecode(box.e);
  const key = keyFor(x25519.getSharedSecret(self.secretKeys.kex, eph), eph, self.publicKeys.kex);
  return fromUtf8(gcm(key, b64uDecode(box.n), utf8(self.address)).decrypt(b64uDecode(box.c)));
}
