import { describe, it, expect } from "vitest";
import { createIdentity } from "./identity";
import { deriveRoom, normalizeRoom, sealPost, openPost } from "./room";

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
