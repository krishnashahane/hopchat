import { describe, it, expect } from "vitest";
import { createIdentity } from "./identity";
import { safetyNumber } from "./safety";

describe("safety numbers", () => {
  it("match on both sides and change with either key", () => {
    const a = createIdentity().publicKeys;
    const b = createIdentity().publicKeys;
    const n = safetyNumber(a, b);
    expect(n).toEqual(safetyNumber(b, a));
    expect(n).toHaveLength(12);
    expect(n.every((g) => /^\d{5}$/.test(g))).toBe(true);
    expect(safetyNumber(a, createIdentity().publicKeys)).not.toEqual(n);
  });
});
