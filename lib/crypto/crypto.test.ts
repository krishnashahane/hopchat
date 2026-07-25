import { describe, it, expect } from "vitest";
import { createIdentity, encodePublicBundle, decodePublicBundle, deriveAddress } from "./identity";
import { seal, open, equalBytes, signBytes, verifyBytes } from "./e2e";
import { base32Encode, base32Decode, b64uEncode, b64uDecode, utf8, fromUtf8 } from "./encoding";

describe("encoding", () => {
  it("base32 round-trips", () => {
    const data = crypto.getRandomValues(new Uint8Array(30));
    expect(equalBytes(base32Decode(base32Encode(data)), data)).toBe(true);
  });
  it("base64url round-trips arbitrary lengths", () => {
    for (const n of [0, 1, 2, 3, 31, 64, 100]) {
      const data = crypto.getRandomValues(new Uint8Array(n));
      expect(equalBytes(b64uDecode(b64uEncode(data)), data)).toBe(true);
    }
  });
});

describe("identity", () => {
  it("creates distinct identities with stable addresses", () => {
    const a = createIdentity();
    const b = createIdentity();
    expect(a.address).not.toBe(b.address);
    expect(a.address.startsWith("HOP-")).toBe(true);
    expect(deriveAddress(a.publicKeys)).toBe(a.address);
  });
  it("public bundle round-trips", () => {
    const a = createIdentity();
    const decoded = decodePublicBundle(encodePublicBundle(a.publicKeys));
    expect(equalBytes(decoded.sign, a.publicKeys.sign)).toBe(true);
    expect(equalBytes(decoded.kex, a.publicKeys.kex)).toBe(true);
    expect(equalBytes(decoded.kem, a.publicKeys.kem)).toBe(true);
  });
});

describe("e2e hybrid PQC sealing", () => {
  it("seals and opens a message", () => {
    const alice = createIdentity();
    const bob = createIdentity();
    const msg = utf8("hop through the mesh 🛰️");
    const env = seal(alice, bob.publicKeys, msg);
    const { plaintext, senderSign } = open(bob, env, alice.publicKeys.sign);
    expect(fromUtf8(plaintext)).toBe("hop through the mesh 🛰️");
    expect(equalBytes(senderSign, alice.publicKeys.sign)).toBe(true);
  });

  it("rejects tampered ciphertext", () => {
    const alice = createIdentity();
    const bob = createIdentity();
    const env = seal(alice, bob.publicKeys, utf8("secret"));
    const bad = { ...env, ct: b64uEncode(crypto.getRandomValues(new Uint8Array(32))) };
    expect(() => open(bob, bad)).toThrow();
  });

  it("rejects wrong recipient", () => {
    const alice = createIdentity();
    const bob = createIdentity();
    const eve = createIdentity();
    const env = seal(alice, bob.publicKeys, utf8("for bob only"));
    expect(() => open(eve, env)).toThrow();
  });

  it("rejects sender identity substitution", () => {
    const alice = createIdentity();
    const bob = createIdentity();
    const eve = createIdentity();
    const env = seal(alice, bob.publicKeys, utf8("hi"));
    expect(() => open(bob, env, eve.publicKeys.sign)).toThrow("Sender identity mismatch");
  });

  it("produces unique ephemeral keys per message (forward secrecy)", () => {
    const alice = createIdentity();
    const bob = createIdentity();
    const e1 = seal(alice, bob.publicKeys, utf8("m"));
    const e2 = seal(alice, bob.publicKeys, utf8("m"));
    expect(e1.ephPub).not.toBe(e2.ephPub);
    expect(e1.ct).not.toBe(e2.ct);
  });
});

describe("detached signatures", () => {
  it("signs and verifies mesh control bytes", () => {
    const a = createIdentity();
    const data = utf8("ROUTE-ADVERTISE");
    const sig = signBytes(a, data);
    expect(verifyBytes(a.publicKeys.sign, data, sig)).toBe(true);
    expect(verifyBytes(a.publicKeys.sign, utf8("tampered"), sig)).toBe(false);
  });
});
