/**
 * File transfer over the mesh — chunking + reassembly.
 *
 * A file is announced with a metadata record, then streamed as fixed-size chunks.
 * Each chunk rides the normal end-to-end-sealed message path (Double Ratchet), so
 * files are as private as text. Chunks are small enough to fit the relay's per-packet
 * limit even after base64 expansion. Reassembly tolerates out-of-order arrival.
 */
import { b64uEncode, b64uDecode } from "./crypto/encoding";

/** 16 KiB raw → ~22 KB base64, comfortably under the 64 KB relay packet cap. */
export const CHUNK_SIZE = 16 * 1024;
/** Hard cap to keep memory and mesh load reasonable. */
export const MAX_FILE_SIZE = 8 * 1024 * 1024;

export interface FileMeta {
  id: string;
  name: string;
  mime: string;
  size: number;
  chunks: number;
  chunkSize: number;
}

export function fileMeta(id: string, name: string, mime: string, size: number, chunkSize = CHUNK_SIZE): FileMeta {
  return { id, name, mime: mime || "application/octet-stream", size, chunks: Math.max(1, Math.ceil(size / chunkSize)), chunkSize };
}

export function chunkBytes(bytes: Uint8Array, chunkSize = CHUNK_SIZE): Uint8Array[] {
  const out: Uint8Array[] = [];
  for (let off = 0; off < bytes.length; off += chunkSize) {
    out.push(bytes.subarray(off, Math.min(off + chunkSize, bytes.length)));
  }
  // A zero-length file still produces one empty chunk so the transfer completes.
  return out.length ? out : [new Uint8Array(0)];
}

export const encodeChunk = (b: Uint8Array): string => b64uEncode(b);
export const decodeChunk = (s: string): Uint8Array => b64uDecode(s);

/** Reassembles a single incoming transfer, tolerating duplicate/out-of-order chunks. */
export class TransferAssembler {
  private readonly parts: (Uint8Array | undefined)[];
  private have = 0;

  constructor(readonly meta: FileMeta) {
    this.parts = new Array(meta.chunks);
  }

  /** Add a chunk; returns true once every chunk has arrived. */
  add(index: number, data: Uint8Array): boolean {
    if (index < 0 || index >= this.meta.chunks) return this.isComplete();
    if (this.parts[index] === undefined) {
      this.parts[index] = data;
      this.have += 1;
    }
    return this.isComplete();
  }

  progress(): number {
    return this.meta.chunks === 0 ? 1 : this.have / this.meta.chunks;
  }

  isComplete(): boolean {
    return this.have >= this.meta.chunks;
  }

  assemble(): Uint8Array {
    if (!this.isComplete()) throw new Error("Transfer incomplete");
    const total = this.parts.reduce((n, p) => n + (p?.length ?? 0), 0);
    const out = new Uint8Array(total);
    let off = 0;
    for (const p of this.parts) {
      if (p) {
        out.set(p, off);
        off += p.length;
      }
    }
    return out;
  }
}
