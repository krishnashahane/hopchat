import { describe, it, expect } from "vitest";
import { gcm } from "@noble/ciphers/aes.js";
import { scrypt } from "@noble/hashes/scrypt.js";
import { sealVault, openVault, needsUpgrade, needsPassphrase, type SealedVault } from "./vault";
import { b64uEncode, utf8 } from "./encoding";

describe("vault", () => {
  it("seals with Argon2id and opens only with the right passphrase", async () => {
    const v = await sealVault("secret", { passphrase: "correct horse" });
    expect(v.kdf).toBe("argon2id");
    expect(needsPassphrase(v)).toBe(true);
    expect(await openVault(v, { passphrase: "correct horse" })).toBe("secret");
    await expect(openVault(v, { passphrase: "wrong" })).rejects.toThrow();
  });

  it("seals with a non-extractable device key", async () => {
    const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
    const v = await sealVault("secret", { deviceKey: key });
    expect(v.kdf).toBe("webcrypto");
    expect(needsPassphrase(v)).toBe(false);
    expect(await openVault(v, { deviceKey: key })).toBe("secret");
    const other = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
    await expect(openVault(v, { deviceKey: other })).rejects.toThrow();
  });

  it("still opens legacy scrypt vaults and flags them for upgrade", async () => {
    const salt = new Uint8Array(16).fill(7);
    const nonce = new Uint8Array(12).fill(9);
    const key = scrypt(utf8("pw"), salt, { N: 2 ** 16, r: 8, p: 1, dkLen: 32 });
    const legacy: SealedVault = {
      v: 1,
      kdf: "scrypt",
      salt: b64uEncode(salt),
      nonce: b64uEncode(nonce),
      ct: b64uEncode(gcm(key, nonce).encrypt(utf8("old"))),
    };
    expect(needsUpgrade(legacy)).toBe(true);
    expect(await openVault(legacy, { passphrase: "pw" })).toBe("old");
  });
});
