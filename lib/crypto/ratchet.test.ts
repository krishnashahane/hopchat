import { describe, it, expect } from "vitest";
import { createIdentity, decodePublicBundle, deriveAddress } from "./identity";
import { initiateHandshake, respondHandshake } from "./handshake";
import { DoubleRatchet } from "./ratchet";
import { utf8, fromUtf8, b64uEncode } from "./encoding";

function equal(a: Uint8Array, b: Uint8Array) {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

/** Establish a live Alice/Bob ratchet pair via the hybrid PQ handshake. */
function establish() {
  const alice = createIdentity();
  const bob = createIdentity();
  const { sk: skA, offer } = initiateHandshake(alice, bob.publicKeys);
  const peerBundle = decodePublicBundle(offer.ik);
  const skB = respondHandshake(bob, peerBundle, offer);
  expect(equal(skA, skB)).toBe(true);

  const a = DoubleRatchet.initSender(skA, bob.publicKeys.kex);
  const b = DoubleRatchet.initReceiver(skB, { sk: bob.secretKeys.kex, pk: bob.publicKeys.kex });
  return { a, b };
}

describe("hybrid PQ handshake", () => {
  it("includes a decodable full identity bundle in the offer", () => {
    const alice = createIdentity();
    const bob = createIdentity();
    const { offer } = initiateHandshake(alice, bob.publicKeys);
    const bundledIdentity = decodePublicBundle(offer.ik);

    expect(deriveAddress(bundledIdentity)).toBe(alice.address);
    expect(equal(bundledIdentity.sign, alice.publicKeys.sign)).toBe(true);
    expect(equal(bundledIdentity.kex, alice.publicKeys.kex)).toBe(true);
    expect(equal(bundledIdentity.kem, alice.publicKeys.kem)).toBe(true);
  });

  it("derives an identical shared secret on both sides", () => {
    const alice = createIdentity();
    const bob = createIdentity();
    const { sk: skA, offer } = initiateHandshake(alice, bob.publicKeys);
    const skB = respondHandshake(bob, decodePublicBundle(offer.ik), offer);
    expect(equal(skA, skB)).toBe(true);
    expect(skA.length).toBe(32);
  });

  it("produces different secrets for different sessions", () => {
    const alice = createIdentity();
    const bob = createIdentity();
    const s1 = initiateHandshake(alice, bob.publicKeys).sk;
    const s2 = initiateHandshake(alice, bob.publicKeys).sk;
    expect(equal(s1, s2)).toBe(false);
  });
});

describe("DoubleRatchet", () => {
  it("encrypts and decrypts a first message", () => {
    const { a, b } = establish();
    const msg = a.encrypt(utf8("first contact"));
    expect(fromUtf8(b.decrypt(msg))).toBe("first contact");
  });

  it("ratchets across a full ping-pong conversation", () => {
    const { a, b } = establish();
    expect(fromUtf8(b.decrypt(a.encrypt(utf8("a1"))))).toBe("a1");
    expect(fromUtf8(a.decrypt(b.encrypt(utf8("b1"))))).toBe("b1");
    expect(fromUtf8(b.decrypt(a.encrypt(utf8("a2"))))).toBe("a2");
    expect(fromUtf8(a.decrypt(b.encrypt(utf8("b2"))))).toBe("b2");
    expect(fromUtf8(b.decrypt(a.encrypt(utf8("a3"))))).toBe("a3");
  });

  it("uses a unique key per message (forward secrecy)", () => {
    const { a } = establish();
    const m1 = a.encrypt(utf8("x"));
    const m2 = a.encrypt(utf8("x"));
    expect(m1.ct).not.toBe(m2.ct);
    expect(m1.nonce).not.toBe(m2.nonce);
  });

  it("handles out-of-order delivery within a chain", () => {
    const { a, b } = establish();
    const m1 = a.encrypt(utf8("one"));
    const m2 = a.encrypt(utf8("two"));
    const m3 = a.encrypt(utf8("three"));
    expect(fromUtf8(b.decrypt(m3))).toBe("three");
    expect(fromUtf8(b.decrypt(m1))).toBe("one");
    expect(fromUtf8(b.decrypt(m2))).toBe("two");
  });

  it("handles skipped messages across a DH ratchet step", () => {
    const { a, b } = establish();
    const a1 = a.encrypt(utf8("a1"));
    b.decrypt(a1);
    const b1 = b.encrypt(utf8("b1"));
    a.decrypt(b1);
    const a2 = a.encrypt(utf8("a2"));
    const a3 = a.encrypt(utf8("a3"));
    expect(fromUtf8(b.decrypt(a3))).toBe("a3");
    expect(fromUtf8(b.decrypt(a2))).toBe("a2");
  });

  it("rejects tampered ciphertext", () => {
    const { a, b } = establish();
    const m = a.encrypt(utf8("secret"));
    const tampered = { ...m, ct: b64uEncode(new Uint8Array(40)) };
    expect(() => b.decrypt(tampered)).toThrow();
  });

  it("survives serialization mid-conversation", () => {
    const { a, b } = establish();
    b.decrypt(a.encrypt(utf8("a1")));
    a.decrypt(b.encrypt(utf8("b1")));
    const aResumed = DoubleRatchet.deserialize(JSON.parse(JSON.stringify(a.serialize())));
    const bResumed = DoubleRatchet.deserialize(JSON.parse(JSON.stringify(b.serialize())));
    expect(fromUtf8(bResumed.decrypt(aResumed.encrypt(utf8("after reload"))))).toBe("after reload");
  });
});
