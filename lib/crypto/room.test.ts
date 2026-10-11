import { describe, it, expect } from "vitest";
import { createIdentity } from "./identity";
import { deriveRoom, normalizeRoom, sealPost, openPost, destForKey, verifyRoomWrite } from "./room";

describe("rooms", () => {
  const post = { id: "p1", ts: 1, nick: "ana", body: "hello mesh" };

  it("normalizes and validates names", () => {
    expect(normalizeRoom("General")).toBe("#general");
    expect(normalizeRoom("#ok_room-1")).toBe("#ok_room-1");
    expect(normalizeRoom("#bad room")).toBeNull();
    expect(normalizeRoom("#")).toBeNull();
  });

  it("same name + password derives the same destination; a different password does not", async () => {
    const a = await deriveRoom("#ops", "pw");
    const b = await deriveRoom("#ops", "pw");
    const c = await deriveRoom("#ops", "other");
    expect(a.dest).toBe(b.dest);
    expect(a.dest).toMatch(/^ROOM-[0-9A-Z]{24}$/);
    expect(c.dest).not.toBe(a.dest);
  });

  it("round-trips a signed post and attributes it to the author", async () => {
    const id = createIdentity();
    const { key, dest } = await deriveRoom("#ops", "pw");
    const out = openPost(key, dest, sealPost(id, key, dest, post));
    expect(out.body).toBe("hello mesh");
    expect(out.address).toBe(id.address);
  });

  it("rejects the wrong room key and tampered ciphertext", async () => {
    const id = createIdentity();
    const right = await deriveRoom("#ops", "pw");
    const wrong = await deriveRoom("#ops", "nope");
    const sealed = sealPost(id, right.key, right.dest, post);
    expect(() => openPost(wrong.key, right.dest, sealed)).toThrow();
    expect(() => openPost(right.key, wrong.dest, sealed)).toThrow();
    const flipped = { ...sealed, c: (sealed.c[0] === "A" ? "B" : "A") + sealed.c.slice(1) };
    expect(() => openPost(right.key, right.dest, flipped)).toThrow();
  });
});

describe("room write authorization", () => {
  const post = { id: "p1", ts: 1, nick: "ana", body: "hi" };

  it("lets the relay verify a post came from a key holder", async () => {
    const id = createIdentity();
    const { key, dest } = await deriveRoom("#ops", "pw");
    expect(destForKey(key)).toBe(dest);
    const sealed = sealPost(id, key, dest, post);
    expect(verifyRoomWrite(dest, sealed)).toBe(true);
    expect(verifyRoomWrite(dest, { ...sealed, c: sealed.c.slice(1) })).toBe(false);
  });

  it("rejects outsiders and cross-room reuse", async () => {
    const id = createIdentity();
    const room = await deriveRoom("#ops", "pw");
    const other = await deriveRoom("#ops", "guess");
    const forged = sealPost(id, other.key, room.dest, post);
    expect(verifyRoomWrite(room.dest, forged)).toBe(false);
    expect(verifyRoomWrite(other.dest, sealPost(id, room.key, room.dest, post))).toBe(false);
    expect(verifyRoomWrite(room.dest, null)).toBe(false);
    expect(verifyRoomWrite(room.dest, { n: "a", c: "b", k: "c", w: "d" })).toBe(false);
  });
});
