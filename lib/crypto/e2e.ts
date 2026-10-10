/**
 * End-to-end message encryption: hybrid post-quantum sealed messaging.
 *
 * Per message, the sender:
 *   1. Generates an *ephemeral* X25519 keypair       → classical forward secrecy.
 *   2. Runs X25519 ECDH against the recipient's kex key.
 *   3. Encapsulates a shared secret to the recipient's ML-KEM-768 key (PQC).
 *   4. HKDF-SHA256(ecdh ‖ kemSecret) → 256-bit AES key.
 *   5. AES-256-GCM encrypts the plaintext (AAD binds sender+recipient identities).
 *   6. Ed25519-signs the envelope for authenticity / tamper-detection.
 *
 * Security properties: confidentiality, integrity, sender authentication,
 * forward secrecy (ephemeral DH), and post-quantum confidentiality (ML-KEM hybrid).
 */
import { ed25519, x25519 } from "@noble/curves/ed25519.js";
import { ml_kem768 } from "@noble/post-quantum/ml-kem.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { gcm } from "@noble/ciphers/aes.js";
import type { Identity, PublicBundle } from "./identity";
import { concatBytes, utf8, b64uEncode, b64uDecode } from "./encoding";

const INFO = utf8("hopchat-e2e-v1");

function randomBytes(n: number): Uint8Array {
  const b = new Uint8Array(n);
  crypto.getRandomValues(b);
  return b;
}

function deriveKey(ecdh: Uint8Array, kemSecret: Uint8Array, salt: Uint8Array): Uint8Array {
  return hkdf(sha256, concatBytes(ecdh, kemSecret), salt, INFO, 32);
}

export interface SealedEnvelope {
  v: 1;
  ephPub: string; // ephemeral X25519 public key
  kemCt: string; // ML-KEM ciphertext
  nonce: string; // AES-GCM nonce (12 bytes)
  ct: string; // AES-GCM ciphertext + tag
  sig: string; // Ed25519 signature over the transcript
  from: string; // sender Ed25519 signing public key
}

function transcript(ephPub: Uint8Array, kemCt: Uint8Array, nonce: Uint8Array, ct: Uint8Array): Uint8Array {
  return sha256(concatBytes(ephPub, kemCt, nonce, ct));
}

export function seal(sender: Identity, recipient: PublicBundle, plaintext: Uint8Array): SealedEnvelope {
  const ephSk = x25519.utils.randomSecretKey();
  const ephPub = x25519.getPublicKey(ephSk);

  const ecdh = x25519.getSharedSecret(ephSk, recipient.kex);
  const { cipherText: kemCt, sharedSecret: kemSecret } = ml_kem768.encapsulate(recipient.kem);

  const salt = concatBytes(ephPub, kemCt);
  const key = deriveKey(ecdh, kemSecret, salt);

  const nonce = randomBytes(12);
  // AAD binds the ciphertext to both parties' signing identities.
  const aad = concatBytes(sender.publicKeys.sign, recipient.sign);
  const ct = gcm(key, nonce, aad).encrypt(plaintext);

  const sig = ed25519.sign(transcript(ephPub, kemCt, nonce, ct), sender.secretKeys.sign);

  return {
    v: 1,
    ephPub: b64uEncode(ephPub),
    kemCt: b64uEncode(kemCt),
    nonce: b64uEncode(nonce),
    ct: b64uEncode(ct),
    sig: b64uEncode(sig),
    from: b64uEncode(sender.publicKeys.sign),
  };
}

/**
 * Open a sealed envelope. `expectedSenderSign`, when provided, is verified against
 * the envelope's `from` field to prevent identity substitution.
 */
export function open(
  recipient: Identity,
  env: SealedEnvelope,
  expectedSenderSign?: Uint8Array,
): { plaintext: Uint8Array; senderSign: Uint8Array } {
  if (env.v !== 1) throw new Error("Unsupported envelope version");

  const ephPub = b64uDecode(env.ephPub);
  const kemCt = b64uDecode(env.kemCt);
  const nonce = b64uDecode(env.nonce);
  const ct = b64uDecode(env.ct);
  const sig = b64uDecode(env.sig);
  const senderSign = b64uDecode(env.from);

  if (expectedSenderSign && !equalBytes(expectedSenderSign, senderSign)) {
    throw new Error("Sender identity mismatch");
  }

  if (!ed25519.verify(sig, transcript(ephPub, kemCt, nonce, ct), senderSign)) {
    throw new Error("Signature verification failed");
  }

  const ecdh = x25519.getSharedSecret(recipient.secretKeys.kex, ephPub);
  const kemSecret = ml_kem768.decapsulate(kemCt, recipient.secretKeys.kem);

  const salt = concatBytes(ephPub, kemCt);
  const key = deriveKey(ecdh, kemSecret, salt);

  const aad = concatBytes(senderSign, recipient.publicKeys.sign);
  const plaintext = gcm(key, nonce, aad).decrypt(ct);

  return { plaintext, senderSign };
}

export function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

/** Detached signature over arbitrary bytes (used for mesh control messages). */
export function signBytes(id: Identity, data: Uint8Array): Uint8Array {
  return ed25519.sign(data, id.secretKeys.sign);
}

export function verifyBytes(signPub: Uint8Array, data: Uint8Array, sig: Uint8Array): boolean {
  return ed25519.verify(sig, data, signPub);
}
