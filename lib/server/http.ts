/** Shared helpers for the JSON API routes. */
import { NextResponse } from "next/server";

export const NO_STORE = { "cache-control": "no-store" };

export const err = (error: string, status: number) => NextResponse.json({ error }, { status, headers: NO_STORE });

/** Structured log line for Vercel log drains / alerts. Never includes packets or keys. */
export function logFailure(op: string, e: unknown): void {
  console.error(JSON.stringify({ at: "api", op, level: "error", msg: e instanceof Error ? e.message : String(e) }));
}

/** Read at most `limit` bytes of the body, even when no Content-Length is sent. */
export async function readCapped(req: Request, limit: number): Promise<string | null> {
  if (!req.body) return "";
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

export function clientIp(req: Request): string {
  return req.headers.get("x-real-ip") ?? (req.headers.get("x-forwarded-for") ?? "unknown").split(",")[0].trim();
}
