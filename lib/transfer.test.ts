import { describe, it, expect } from "vitest";
import { chunkBytes, fileMeta, TransferAssembler, CHUNK_SIZE, encodeChunk, decodeChunk } from "./transfer";

function randomBytes(n: number): Uint8Array {
  const b = new Uint8Array(n);
  for (let i = 0; i < n; i += 65536) crypto.getRandomValues(b.subarray(i, Math.min(i + 65536, n)));
  return b;
}
const eq = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i]);

describe("file transfer chunking", () => {
  it("chunks and reassembles an exact-multiple file", () => {
    const data = randomBytes(CHUNK_SIZE * 3);
    const meta = fileMeta("f1", "a.bin", "application/octet-stream", data.length);
    expect(meta.chunks).toBe(3);
    const chunks = chunkBytes(data);
    const asm = new TransferAssembler(meta);
    chunks.forEach((c, i) => asm.add(i, c));
    expect(asm.isComplete()).toBe(true);
    expect(eq(asm.assemble(), data)).toBe(true);
  });

  it("handles a non-multiple size with a partial last chunk", () => {
    const data = randomBytes(CHUNK_SIZE * 2 + 123);
    const meta = fileMeta("f2", "b.bin", "", data.length);
    expect(meta.chunks).toBe(3);
    const chunks = chunkBytes(data);
    expect(chunks[2].length).toBe(123);
    const asm = new TransferAssembler(meta);
    chunks.forEach((c, i) => asm.add(i, c));
    expect(eq(asm.assemble(), data)).toBe(true);
  });

  it("reassembles out-of-order and ignores duplicates", () => {
    const data = randomBytes(CHUNK_SIZE * 4 + 10);
    const meta = fileMeta("f3", "c.bin", "", data.length);
    const chunks = chunkBytes(data);
    const asm = new TransferAssembler(meta);
    for (const i of [4, 2, 2, 0, 3]) asm.add(i, chunks[i]);
    expect(asm.isComplete()).toBe(false);
    expect(asm.progress()).toBeCloseTo(4 / 5, 5);
    asm.add(1, chunks[1]);
    expect(asm.isComplete()).toBe(true);
    expect(eq(asm.assemble(), data)).toBe(true);
  });

  it("survives base64 chunk encoding round-trip", () => {
    const data = randomBytes(CHUNK_SIZE + 7);
    const meta = fileMeta("f4", "d.bin", "", data.length);
    const asm = new TransferAssembler(meta);
    chunkBytes(data).forEach((c, i) => asm.add(i, decodeChunk(encodeChunk(c))));
    expect(eq(asm.assemble(), data)).toBe(true);
  });

  it("handles an empty file as a single empty chunk", () => {
    const meta = fileMeta("f5", "empty", "", 0);
    expect(meta.chunks).toBe(1);
    const asm = new TransferAssembler(meta);
    asm.add(0, new Uint8Array(0));
    expect(asm.isComplete()).toBe(true);
    expect(asm.assemble().length).toBe(0);
  });
});
