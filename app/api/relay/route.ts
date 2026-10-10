/**
 * Internet-relay endpoint — store-and-forward for end-to-end-sealed packets.
 *
 *   POST /api/relay   { to, packet }          enqueue an opaque packet for an address or room
 *   GET  /api/relay                           authenticated long-poll drain of our inbox
 *        headers: x-hop-addr, x-hop-ts, x-hop-sig, x-hop-bundle
 *   GET  /api/relay?room=ROOM-…&after=N       read a room's rolling ciphertext log
 *
 * Security:
 *   - The relay stores only ciphertext; it holds no keys and cannot read content.
 *   - Draining an inbox requires proving ownership of the address: the caller signs
 *     `hop-poll:{addr}:{ts}` with the identity key whose public bundle hashes to that
 *     address. Each signature is accepted once (replay guard) and travels in headers,
 *     never the URL, so it does not land in access logs.
 *   - Room ids are hashes of Argon2id-derived keys; the relay learns no names/passwords.
 *   - Every verb is rate-limited and size-capped.
 */
import { NextResponse } from "next/server";
import {
  relayConfigured,
  enqueue,
  drain,
  waitNext,
  rateLimit,
  claimOnce,
  roomPush,
  roomRead,
} from "@/lib/server/redis";
import { decodePublicBundle, deriveAddress } from "@/lib/crypto/identity";
import { verifyBytes } from "@/lib/crypto/e2e";
import { utf8, b64uDecode } from "@/lib/crypto/encoding";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

const ADDR = /^HOP-[0-9A-Z-]{4,64}$/;
const ROOM = /^ROOM-[0-9A-Z]{24}$/;
const MAX_PACKET = 64 * 1024;
const MAX_ROOM_PACKET = 8 * 1024;
const CLOCK_SKEW_MS = 60_000;
const NO_STORE = { "cache-control": "no-store" };

const err = (error: string, status: number) => NextResponse.json({ error }, { status, headers: NO_STORE });

/** Structured log line for Vercel log drains / alerts. Never includes packets or keys. */
function logFailure(op: string, e: unknown): void {
  console.error(JSON.stringify({ at: "relay", op, level: "error", msg: e instanceof Error ? e.message : String(e) }));
}

/** Read at most `limit` bytes of the body, even when no Content-Length is sent. */
async function readCapped(req: Request, limit: number): Promise<string | null> {
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

function clientIp(req: Request): string {
  return req.headers.get("x-real-ip") ?? (req.headers.get("x-forwarded-for") ?? "unknown").split(",")[0].trim();
}

/** Verify the caller owns `addr` by checking a fresh signature over the poll challenge. */
function verifyOwnership(addr: string, ts: string, sig: string, bundle: string): boolean {
  const t = Number(ts);
  if (!Number.isFinite(t) || Math.abs(Date.now() - t) > CLOCK_SKEW_MS) return false;
  try {
    const pub = decodePublicBundle(bundle);
    if (deriveAddress(pub) !== addr) return false;
    return verifyBytes(pub.sign, utf8(`hop-poll:${addr}:${ts}`), b64uDecode(sig));
  } catch {
    return false;
  }
}

async function readRoom(req: Request, room: string, afterRaw: string | null) {
  if (!ROOM.test(room)) return err("bad_room", 400);
  const after = Number(afterRaw ?? 0);
  if (!Number.isSafeInteger(after) || after < 0) return err("bad_cursor", 400);
  if (!(await rateLimit(`room:${clientIp(req)}`, 120, 60))) return err("rate_limited", 429);
  try {
    return NextResponse.json(await roomRead(room, after), { headers: NO_STORE });
  } catch (e) {
    logFailure("room_read", e);
    return err("relay_error", 502);
  }
}

export async function GET(req: Request) {
  if (!relayConfigured) return err("relay_unconfigured", 503);
  const q = new URL(req.url).searchParams;
  const room = q.get("room");
  if (room !== null) return readRoom(req, room, q.get("after"));

  const h = req.headers;
  const addr = h.get("x-hop-addr") ?? "";
  const ts = h.get("x-hop-ts") ?? "";
  const sig = h.get("x-hop-sig") ?? "";
  const bundle = h.get("x-hop-bundle") ?? "";

  if (!ADDR.test(addr)) return err("bad_addr", 400);
  if (!verifyOwnership(addr, ts, sig, bundle)) return err("unauthorized", 401);
  if (!(await rateLimit(`poll:${addr}`, 40, 60))) return err("rate_limited", 429);

  try {
    if (!(await claimOnce(sig, Math.ceil((2 * CLOCK_SKEW_MS) / 1000)))) return err("replayed", 401);
    let items = await drain(addr);
    if (items.length === 0) {
      const next = await waitNext(addr, 20);
      if (next) items = [next, ...(await drain(addr))];
    }
    return NextResponse.json({ packets: items }, { headers: NO_STORE });
  } catch (e) {
    logFailure("drain", e);
    return err("relay_error", 502);
  }
}

export async function POST(req: Request) {
  if (!relayConfigured) return err("relay_unconfigured", 503);
  if (!(req.headers.get("content-type") ?? "").startsWith("application/json")) return err("bad_type", 415);
  if (Number(req.headers.get("content-length") ?? 0) > MAX_PACKET + 1024) return err("too_large", 413);
  if (!(await rateLimit(`send:${clientIp(req)}`, 120, 60))) return err("rate_limited", 429);

  const raw = await readCapped(req, MAX_PACKET + 1024);
  if (raw === null) return err("too_large", 413);
  let body: { to?: unknown; packet?: unknown };
  try {
    body = JSON.parse(raw) as { to?: unknown; packet?: unknown };
  } catch {
    return err("bad_json", 400);
  }
  if (!body || typeof body !== "object") return err("bad_json", 400);
  const { to, packet } = body;
  if (typeof to !== "string" || typeof packet !== "string") return err("bad_request", 400);

  try {
    if (ROOM.test(to)) {
      if (packet.length > MAX_ROOM_PACKET) return err("bad_packet", 400);
      return NextResponse.json({ ok: true, s: await roomPush(to, packet) }, { headers: NO_STORE });
    }
    if (!ADDR.test(to)) return err("bad_addr", 400);
    if (packet.length > MAX_PACKET) return err("bad_packet", 400);
    await enqueue(to, packet);
    return NextResponse.json({ ok: true }, { headers: NO_STORE });
  } catch (e) {
    logFailure("enqueue", e);
    return err("relay_error", 502);
  }
}
