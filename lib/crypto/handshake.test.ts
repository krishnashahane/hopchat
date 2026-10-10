import { describe, it, expect } from "vitest";
import { createIdentity, decodePublicBundle, deriveAddress } from "./identity";
import { initiateHandshake, respondHandshake } from "./handshake";

describe("handshake offer", () => {
  it("carries the initiator's full bundle so the responder can resolve and agree", () => {
    const alice = createIdentity();
    const bob = createIdentity();
    const { sk, offer } = initiateHandshake(alice, bob.publicKeys);
    // This is exactly what Messenger.resolveSession does with an incoming offer.
    const peer = decodePublicBundle(offer.ik);
    expect(deriveAddress(peer)).toBe(alice.address);
    expect(respondHandshake(bob, peer, offer)).toEqual(sk);
  });
});
