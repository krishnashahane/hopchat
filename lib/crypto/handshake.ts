/**
 * Hybrid post-quantum session handshake (PQXDH-style).
 *
 * Establishes a shared secret `SK` that seeds a Double Ratchet. Combines:
 *   - DH(EK_A, IK_B)   ephemeral × long-term  → forward secrecy
 *   - DH(IK_A, IK_B)   long-term × long-term   → mutual authentication
 *   - ML-KEM-768        encapsulation to IK_B   → post-quantum confidentiality
 *
 * The responder recomputes the identical `SK` from the initiator's ephemeral
 * public key and the KEM ciphertext. This mirrors Signal's X3DH/PQXDH: a
 * post-quantum-secure agreement up front, then a classical DH ratchet per message.
 */
import { x25519 } from "@noble/curves/ed25519";
import { ml_kem768 } from "@noble/post-quantum/ml-kem";
import { hkdf } from "@noble/hashes/hkdf";
import { sha256 } from "@noble/hashes/sha2";
import type { Identity, PublicBundle } from "./identity";
import { encodePublicBundle } from "./identity";
import { concatBytes, utf8, b64uEncode, b64uDecode } from "./encoding";

const HS_INFO = utf8("hopchat-pqxdh-v1");

export interface HandshakeOffer {
  /** Initiator ephemeral X25519 public key. */
  ek: string;
  /** ML-KEM-768 ciphertext encapsulated to the responder. */
  kemCt: string;
  /** Initiator long-term signing key, so the responder can bind the identity. */
  ik: string;
}

function deriveSK(dh1: Uint8Array, dh2: Uint8Array, kem: Uint8Array): Uint8Array {
  // A leading 0xFF block domain-separates from any raw DH output (X3DH convention).
  const ikm = concatBytes(new Uint8Array(32).fill(0xff), dh1, dh2, kem);
  return hkdf(sha256, ikm, new Uint8Array(32), HS_INFO, 32);
}

/** Initiator side: produce SK and the offer to transmit to the responder. */
export function initiateHandshake(
  self: Identity,
  peer: PublicBundle,
): { sk: Uint8Array; offer: HandshakeOffer } {
  const ekSk = x25519.utils.randomPrivateKey();
  const ekPub = x25519.getPublicKey(ekSk);

  const dh1 = x25519.getSharedSecret(ekSk, peer.kex); // EK_A × IK_B
  const dh2 = x25519.getSharedSecret(self.secretKeys.kex, peer.kex); // IK_A × IK_B
  const { cipherText, sharedSecret } = ml_kem768.encapsulate(peer.kem);

  const sk = deriveSK(dh1, dh2, sharedSecret);
  return {
    sk,
    offer: {
      ek: b64uEncode(ekPub),
      kemCt: b64uEncode(cipherText),
      ik: b64uEncode(self.publicKeys.sign),
    },
  };
}

/** Responder side: recompute SK from the initiator's offer. */
export function respondHandshake(self: Identity, peer: PublicBundle, offer: HandshakeOffer): Uint8Array {
  const ek = b64uDecode(offer.ek);
  const kemCt = b64uDecode(offer.kemCt);

  const dh1 = x25519.getSharedSecret(self.secretKeys.kex, ek); // IK_B × EK_A
  const dh2 = x25519.getSharedSecret(self.secretKeys.kex, peer.kex); // IK_B × IK_A
  const kemSecret = ml_kem768.decapsulate(kemCt, self.secretKeys.kem);

  return deriveSK(dh1, dh2, kemSecret);
}
