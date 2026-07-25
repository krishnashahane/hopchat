/**
 * At-rest encryption vault. The identity secret keys are never persisted in the
 * clear. They are sealed with AES-256-GCM under a key derived from a user
 * passphrase (scrypt) or, if the user opts out, an unextractable device key.
 */
import { scrypt } from "@noble/hashes/scrypt";
import { sha256 } from "@noble/hashes/sha2";
import { gcm } from "@noble/ciphers/aes";
import { b64uEncode, b64uDecode, utf8, concatBytes } from "./encoding";

export interface SealedVault {
  v: 1;
  kdf: "scrypt" | "device";
  salt: string;
  nonce: string;
  ct: string;
}

const SCRYPT_PARAMS = { N: 2 ** 16, r: 8, p: 1, dkLen: 32 } as const;

function randomBytes(n: number): Uint8Array {
  const b = new Uint8Array(n);
  crypto.getRandomValues(b);
  return b;
}

function deriveFromPassphrase(passphrase: string, salt: Uint8Array): Uint8Array {
  return scrypt(utf8(passphrase.normalize("NFKC")), salt, SCRYPT_PARAMS);
}

/** A stable but non-secret device key: hardens against casual disk inspection. */
function deviceKey(salt: Uint8Array): Uint8Array {
  const seed = `${navigator.userAgent}|${navigator.language}|hopchat-device`;
  return sha256(concatBytes(utf8(seed), salt));
}

export function sealVault(plaintext: string, passphrase?: string): SealedVault {
  const salt = randomBytes(16);
  const nonce = randomBytes(12);
  const kdf = passphrase ? "scrypt" : "device";
  const key = passphrase ? deriveFromPassphrase(passphrase, salt) : deviceKey(salt);
  const ct = gcm(key, nonce).encrypt(utf8(plaintext));
  return {
    v: 1,
    kdf,
    salt: b64uEncode(salt),
    nonce: b64uEncode(nonce),
    ct: b64uEncode(ct),
  };
}

export function openVault(vault: SealedVault, passphrase?: string): string {
  const salt = b64uDecode(vault.salt);
  const nonce = b64uDecode(vault.nonce);
  const key =
    vault.kdf === "scrypt"
      ? deriveFromPassphrase(passphrase ?? "", salt)
      : deviceKey(salt);
  const pt = gcm(key, nonce).decrypt(b64uDecode(vault.ct));
  return new TextDecoder().decode(pt);
}
