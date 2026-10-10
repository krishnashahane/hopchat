import { describe, it, expect } from "vitest";
import { createIdentity } from "@/lib/crypto/identity";
import { encodeGeohash, geoKey, signGeoEvent, readGeoEvent } from "./nostr";

describe("nostr location channels", () => {
  it("encodes geohashes (reference values)", () => {
    expect(encodeGeohash(57.64911, 10.40744, 11)).toBe("u4pruydqqvj");
    expect(encodeGeohash(48.8584, 2.2945, 5)).toBe("u09tu");
  });

  it("signs bitchat-format events that verify, and rejects tampering", () => {
    const id = createIdentity();
    const ev = signGeoEvent(geoKey(id, "u09tu"), "u09tu", "ana", "hello paris");
    expect(ev.kind).toBe(20000);
    expect(ev.tags).toEqual([["g", "u09tu"], ["n", "ana"]]);
    expect(readGeoEvent(ev, "u09tu")?.body).toBe("hello paris");
    expect(readGeoEvent({ ...ev, content: "edited" }, "u09tu")).toBeNull();
    expect(readGeoEvent(ev, "u09tv")).toBeNull();
  });

  it("uses a different, unlinkable key per cell", () => {
    const id = createIdentity();
    const a = signGeoEvent(geoKey(id, "u09tu"), "u09tu", "x", "1");
    const b = signGeoEvent(geoKey(id, "u4pru"), "u4pru", "x", "1");
    expect(a.pubkey).not.toBe(b.pubkey);
  });
});
