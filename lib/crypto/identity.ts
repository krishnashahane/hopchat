/**
 * Identity: a self-sovereign cryptographic identity. No phone, no email, no server.
 *
 * An identity holds three keypairs:
 *   - Ed25519    : long-term signing key (authenticity / non-repudiation).
 *   - X25519     : classical key-agreement key (ECDH).
 *   - ML-KEM-768 : post-quantum KEM key (NIST FIPS 203).
 *
 * The public address is a Crockford-Base32 fingerprint of the hashed public bundle,
 * so it is short, human-verifiable, and collision-resistant.
 */
import { ed25519, x25519 } from "@noble/curves/ed25519";
import { ml_kem768 } from "@noble/post-quantum/ml-kem";
import { sha256 } from "@noble/hashes/sha2";
import { base32Encode, b64uEncode, b64uDecode, concatBytes } from "./encoding";

export interface PublicBundle {
  /** Ed25519 signing public key. */
  sign: Uint8Array;
  /** X25519 key-agreement public key. */
  kex: Uint8Array;
  /** ML-KEM-768 encapsulation public key. */
  kem: Uint8Array;
}

export interface SecretBundle {
  sign: Uint8Array;
  kex: Uint8Array;
  kem: Uint8Array;
}

export interface Identity {
  publicKeys: PublicBundle;
  secretKeys: SecretBundle;
  /** Human-verifiable address, e.g. "HOP-K3F9-…". */
  address: string;
  /** Full hex fingerprint (SHA-256 of the public bundle). */
  fingerprint: string;
}

function fingerprintBytes(pub: PublicBundle): Uint8Array {
  return sha256(concatBytes(pub.sign, pub.kex, pub.kem));
}

export function deriveAddress(pub: PublicBundle): string {
  const fp = fingerprintBytes(pub);
  // First 15 bytes → 24 base32 chars, grouped for readability.
  const b32 = base32Encode(fp.slice(0, 15));
  const groups = b32.match(/.{1,4}/g) ?? [b32];
  return "HOP-" + groups.join("-");
}

export function fingerprintHex(pub: PublicBundle): string {
  const fp = fingerprintBytes(pub);
  return Array.from(fp)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export function createIdentity(): Identity {
  const signSk = ed25519.utils.randomPrivateKey();
  const signPk = ed25519.getPublicKey(signSk);

  const kexSk = x25519.utils.randomPrivateKey();
  const kexPk = x25519.getPublicKey(kexSk);

  const kem = ml_kem768.keygen();

  const publicKeys: PublicBundle = { sign: signPk, kex: kexPk, kem: kem.publicKey };
  const secretKeys: SecretBundle = { sign: signSk, kex: kexSk, kem: kem.secretKey };

  return {
    publicKeys,
    secretKeys,
    address: deriveAddress(publicKeys),
    fingerprint: fingerprintHex(publicKeys),
  };
}

/** Serialize the public bundle for sharing (contact card / QR). */
export function encodePublicBundle(pub: PublicBundle): string {
  return [b64uEncode(pub.sign), b64uEncode(pub.kex), b64uEncode(pub.kem)].join(".");
}

export function decodePublicBundle(s: string): PublicBundle {
  const parts = s.split(".");
  if (parts.length !== 3) throw new Error("Malformed public bundle");
  return {
    sign: b64uDecode(parts[0]),
    kex: b64uDecode(parts[1]),
    kem: b64uDecode(parts[2]),
  };
}

/** Serialize the full identity (secret) for encrypted at-rest storage only. */
export function serializeSecret(id: Identity): Record<string, string> {
  return {
    sign: b64uEncode(id.secretKeys.sign),
    kex: b64uEncode(id.secretKeys.kex),
    kem: b64uEncode(id.secretKeys.kem),
    signPub: b64uEncode(id.publicKeys.sign),
    kexPub: b64uEncode(id.publicKeys.kex),
    kemPub: b64uEncode(id.publicKeys.kem),
  };
}

export function deserializeSecret(o: Record<string, string>): Identity {
  const publicKeys: PublicBundle = {
    sign: b64uDecode(o.signPub),
    kex: b64uDecode(o.kexPub),
    kem: b64uDecode(o.kemPub),
  };
  const secretKeys: SecretBundle = {
    sign: b64uDecode(o.sign),
    kex: b64uDecode(o.kex),
    kem: b64uDecode(o.kem),
  };
  return {
    publicKeys,
    secretKeys,
    address: deriveAddress(publicKeys),
    fingerprint: fingerprintHex(publicKeys),
  };
}
