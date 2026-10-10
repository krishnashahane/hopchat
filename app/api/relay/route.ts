/**
 * Internet relay for end-to-end-sealed packets.
 *
 * POST /api/relay accepts a recipient address and opaque packet.
 * GET /api/relay authenticates the recipient before draining that inbox.
 */
import { NextResponse } from "next/server";
import { relayConfigured, enqueue, drain, waitNext, rateLimit } from "@/lib/server/redis";
import { decodePublicBundle, deriveAddress } from "@/lib/crypto/identity";
import { verifyBytes } from "@/lib/crypto/e2e";
import { utf8, b64uDecode } from "@/lib/crypto/encoding";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

const ADDR = /^HOP-[0-9A-Z-]{4,64}$/;
const MAX_PACKET = 64 * 1024;
// A JSON-escaped string may be several times larger than the decoded packet.
const MAX_REQUEST_BYTES = MAX_PACKET * 6 + 2_048;
const CLOCK_SKEW_MS = 60_000;

function clientIp(req: Request): string {
  // Prefer the deployment platform's normalized client-IP header. Do not trust the
  // first X-Forwarded-For value, which callers can spoof on some proxy setups.
  return req.headers.get("x-real-ip")?.trim().slice(0, 128) || "unknown";
}

/** Verify ownership of addr using a fresh signature over the polling challenge. */
function verifyOwnership(addr: string, ts: string, sig: string, bundle: string): boolean {
  const t = Number(ts);
  if (!Number.isFinite(t) || Math.abs(Date.now() - t) > CLOCK_SKEW_MS) return false;
  let pub;
  try {
    pub = decodePublicBundle(bundle);
  } catch {
    return false;
  }
  if (deriveAddress(pub) !== addr) return false;
  try {
    return verifyBytes(pub.sign, utf8(`hop-poll:${addr}:${ts}`), b64uDecode(sig));
  } catch {
    return false;
  }
}

export async function GET(req: Request) {
  if (!relayConfigured) return NextResponse.json({ error: "relay_unconfigured" }, { status: 503 });
  const q = new URL(req.url).searchParams;
  const addr = q.get("addr") ?? "";
  const ts = q.get("ts") ?? "";
  const sig = q.get("sig") ?? "";
  const bundle = q.get("bundle") ?? "";

  if (!ADDR.test(addr)) return NextResponse.json({ error: "bad_addr" }, { status: 400 });
  if (!verifyOwnership(addr, ts, sig, bundle)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  if (!(await rateLimit(`poll:${addr}`, 40, 60))) {
    return NextResponse.json({ error: "rate_limited" }, { status: 429 });
  }

  try {
    let items = await drain(addr);
    if (items.length === 0) {
      const next = await waitNext(addr, 20);
      if (next) items = [next, ...(await drain(addr))];
    }
    return NextResponse.json({ packets: items }, { headers: { "cache-control": "no-store" } });
  } catch {
    return NextResponse.json({ error: "relay_error" }, { status: 502 });
  }
}

export async function POST(req: Request) {
  if (!relayConfigured) return NextResponse.json({ error: "relay_unconfigured" }, { status: 503 });

  const contentLength = Number(req.headers.get("content-length") ?? "0");
  if (Number.isFinite(contentLength) && contentLength > MAX_REQUEST_BYTES) {
    return NextResponse.json({ error: "request_too_large" }, { status: 413 });
  }

  if (!(await rateLimit(`send:${clientIp(req)}`, 120, 60))) {
    return NextResponse.json({ error: "rate_limited" }, { status: 429 });
  }

  let body: { to?: unknown; packet?: unknown };
  try {
    body = (await req.json()) as { to?: unknown; packet?: unknown };
  } catch {
    return NextResponse.json({ error: "bad_json" }, { status: 400 });
  }

  const { to, packet } = body;
  if (typeof to !== "string" || !ADDR.test(to)) {
    return NextResponse.json({ error: "bad_addr" }, { status: 400 });
  }
  if (typeof packet !== "string" || packet.length === 0 || packet.length > MAX_PACKET) {
    return NextResponse.json({ error: "bad_packet" }, { status: 400 });
  }

  try {
    await enqueue(to, packet);
    return NextResponse.json({ ok: true }, { headers: { "cache-control": "no-store" } });
  } catch {
    return NextResponse.json({ error: "relay_error" }, { status: 502 });
  }
}
