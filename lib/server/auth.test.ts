import { describe, it, expect } from "vitest";
import { createIdentity, encodePublicBundle } from "@/lib/crypto/identity";
import { signBytes } from "@/lib/crypto/e2e";
import { utf8, b64uEncode } from "@/lib/crypto/encoding";
import { verifyOwnership } from "./auth";

describe("address ownership", () => {
  const id = createIdentity();
  const bundle = encodePublicBundle(id.publicKeys);
  const sign = (scope: string, ts: string) => b64uEncode(signBytes(id, utf8(`hop-${scope}:${id.address}:${ts}`)));

  it("accepts a fresh signature for its own scope only", () => {
    const ts = Date.now().toString();
    expect(verifyOwnership("poll", id.address, ts, sign("poll", ts), bundle)).toBe(true);
    expect(verifyOwnership("ice", id.address, ts, sign("poll", ts), bundle)).toBe(false);
  });

  it("rejects stale timestamps and someone else's bundle", () => {
    const old = (Date.now() - 120_000).toString();
    expect(verifyOwnership("poll", id.address, old, sign("poll", old), bundle)).toBe(false);
    const ts = Date.now().toString();
    const other = encodePublicBundle(createIdentity().publicKeys);
    expect(verifyOwnership("poll", id.address, ts, sign("poll", ts), other)).toBe(false);
  });
});
