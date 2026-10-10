/**
 * Hybrid post-quantum session handshake (PQXDH-style).
 *
 * Establishes a shared secret `SK` that seeds a Double Ratchet. It combines
 * ephemeral/static X25519 agreement with ML-KEM-768 encapsulation. This is a
 * project-specific protocol implementation and has not been independently audited.
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
  /** Encoded initiator public bundle (signing, X25519, and ML-KEM keys). */
  ik: string;
}

function deriveSK(dh1: Uint8Array, dh2: Uint8Array, kem: Uint8Array): Uint8Array {
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

  const dh1 = x25519.getSharedSecret(ekSk, peer.kex);
  const dh2 = x25519.getSharedSecret(self.secretKeys.kex, peer.kex);
  const { cipherText, sharedSecret } = ml_kem768.encapsulate(peer.kem);

  const sk = deriveSK(dh1, dh2, sharedSecret);
  return {
    sk,
    offer: {
      ek: b64uEncode(ekPub),
      kemCt: b64uEncode(cipherText),
      // The responder calls decodePublicBundle(offer.ik); sending only the signing
      // key here breaks every real first-contact handshake.
      ik: encodePublicBundle(self.publicKeys),
    },
  };
}

/** Responder side: recompute SK from the initiator's offer. */
export function respondHandshake(self: Identity, peer: PublicBundle, offer: HandshakeOffer): Uint8Array {
  const ek = b64uDecode(offer.ek);
  const kemCt = b64uDecode(offer.kemCt);

  const dh1 = x25519.getSharedSecret(self.secretKeys.kex, ek);
  const dh2 = x25519.getSharedSecret(self.secretKeys.kex, peer.kex);
  const kemSecret = ml_kem768.decapsulate(kemCt, self.secretKeys.kem);

  return deriveSK(dh1, dh2, kemSecret);
}
