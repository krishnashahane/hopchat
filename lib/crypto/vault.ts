/**
 * At-rest encryption vault. The identity secret keys are never persisted in the
 * clear. They are sealed with AES-256-GCM under either:
 *   - a key derived from a user passphrase with Argon2id (OWASP params), or
 *   - a non-extractable WebCrypto device key held by the browser (no passphrase).
 *
 * Legacy vaults (scrypt / user-agent "device" key) still open and are re-sealed
 * with the current scheme on unlock — see `needsUpgrade`.
 */
import { argon2idAsync } from "@noble/hashes/argon2.js";
import { scrypt } from "@noble/hashes/scrypt.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { gcm } from "@noble/ciphers/aes.js";
import { b64uEncode, b64uDecode, utf8, concatBytes } from "./encoding";

export interface SealedVault {
  v: 1;
  kdf: "argon2id" | "webcrypto" | "scrypt" | "device";
  salt: string;
  nonce: string;
  ct: string;
  /** Argon2id cost parameters, stored so they can be raised later. */
  cost?: { m: number; t: number; p: number };
}

export interface VaultKeys {
  passphrase?: string;
  deviceKey?: CryptoKey;
}

/** OWASP 2024 minimum for Argon2id: 19 MiB, 2 passes, 1 lane. */
const ARGON2 = { m: 19_456, t: 2, p: 1 } as const;
const SCRYPT_PARAMS = { N: 2 ** 16, r: 8, p: 1, dkLen: 32 } as const;

function randomBytes(n: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(n));
}

export function argon2Key(
  secret: string,
  salt: Uint8Array,
  cost: { m: number; t: number; p: number } = ARGON2,
): Promise<Uint8Array> {
  return argon2idAsync(utf8(secret.normalize("NFKC")), salt, { ...cost, dkLen: 32 });
}

/** Legacy key: derived from the user agent, so it breaks on browser updates. */
function legacyDeviceKey(salt: Uint8Array): Uint8Array {
  const seed = `${navigator.userAgent}|${navigator.language}|hopchat-device`;
  return sha256(concatBytes(utf8(seed), salt));
}

const buf = (b: Uint8Array): ArrayBuffer => b.slice().buffer as ArrayBuffer;

export async function sealVault(plaintext: string, keys: VaultKeys): Promise<SealedVault> {
  const salt = randomBytes(16);
  const nonce = randomBytes(12);
  let ct: Uint8Array;
  let kdf: SealedVault["kdf"];
  if (keys.passphrase) {
    kdf = "argon2id";
    ct = gcm(await argon2Key(keys.passphrase, salt), nonce).encrypt(utf8(plaintext));
  } else if (keys.deviceKey) {
    kdf = "webcrypto";
    ct = new Uint8Array(
      await crypto.subtle.encrypt({ name: "AES-GCM", iv: buf(nonce) }, keys.deviceKey, buf(utf8(plaintext))),
    );
  } else {
    throw new Error("sealVault needs a passphrase or a device key");
  }
  return {
    v: 1,
    kdf,
    salt: b64uEncode(salt),
    nonce: b64uEncode(nonce),
    ct: b64uEncode(ct),
    ...(kdf === "argon2id" ? { cost: { ...ARGON2 } } : {}),
  };
}

export async function openVault(vault: SealedVault, keys: VaultKeys): Promise<string> {
  const salt = b64uDecode(vault.salt);
  const nonce = b64uDecode(vault.nonce);
  const ct = b64uDecode(vault.ct);
  let pt: Uint8Array;
  switch (vault.kdf) {
    case "argon2id":
      pt = gcm(await argon2Key(keys.passphrase ?? "", salt, vault.cost ?? ARGON2), nonce).decrypt(ct);
      break;
    case "webcrypto":
      if (!keys.deviceKey) throw new Error("Device key missing");
      pt = new Uint8Array(
        await crypto.subtle.decrypt({ name: "AES-GCM", iv: buf(nonce) }, keys.deviceKey, buf(ct)),
      );
      break;
    case "scrypt":
      pt = gcm(scrypt(utf8((keys.passphrase ?? "").normalize("NFKC")), salt, SCRYPT_PARAMS), nonce).decrypt(ct);
      break;
    case "device":
      pt = gcm(legacyDeviceKey(salt), nonce).decrypt(ct);
      break;
    default:
      throw new Error("Unknown vault format");
  }
  return new TextDecoder().decode(pt);
}

/** Whether a vault should be re-sealed with the current scheme after opening. */
export const needsUpgrade = (v: SealedVault): boolean => v.kdf === "scrypt" || v.kdf === "device";

/** Whether opening this vault requires the user's passphrase. */
export const needsPassphrase = (v: SealedVault): boolean => v.kdf === "argon2id" || v.kdf === "scrypt";
