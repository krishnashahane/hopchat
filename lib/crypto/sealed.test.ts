import { describe, it, expect } from "vitest";
import { createIdentity } from "./identity";
import { sealSender, openSender, isSealedSender } from "./sealed";

describe("sealed sender", () => {
  it("round-trips, hides the sender and pads to 1 KiB buckets", () => {
    const bob = createIdentity();
    const text = JSON.stringify({ from: "HOP-ALICE", to: bob.address, payload: "x" });
    const box = sealSender(bob.address, bob.publicKeys.kex, text);
    expect(isSealedSender(box)).toBe(true);
    expect(JSON.stringify(box)).not.toContain("HOP-ALICE");
    const out = openSender(bob, box);
    expect(out.length % 1024).toBe(0);
    expect(JSON.parse(out)).toEqual(JSON.parse(text));
  });

  it("only the addressee can open it", () => {
    const bob = createIdentity();
    const eve = createIdentity();
    const box = sealSender(bob.address, bob.publicKeys.kex, "{}");
    expect(() => openSender(eve, box)).toThrow();
    expect(() => openSender(bob, { ...box, c: box.c.slice(2) })).toThrow();
  });
});
