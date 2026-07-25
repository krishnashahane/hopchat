/**
 * Internet-relay endpoint — store-and-forward for end-to-end-sealed packets.
 *
 *   POST /api/relay   { to, packet }                  enqueue an opaque packet
 *   GET  /api/relay?addr&ts&sig&bundle                authenticated long-poll drain
 *
 * Security:
 *   - The relay stores only ciphertext keyed by address; it holds no keys and cannot
 *     read message content (confidentiality/authenticity come from the Double Ratchet).
 *   - Draining an inbox requires proving ownership of the address: the caller signs
 *     `hop-poll:{addr}:{ts}` with the identity key whose public bundle hashes to that
 *     address. This stops anyone from reading/deleting another user's queued packets.
 *   - Both verbs are rate-limited to blunt spam and DoS.
 */
import { NextResponse } from "next/server";
import { relayConfigured, enqueue, drain, waitNext, rateLimit } from "@/lib/server/redis";
import { decodePublicBundle, deriveAddress } from "@/lib/crypto/identity";
import { verifyBytes } from "@/lib/crypto/e2e";
import { utf8, b64uDecode } from "@/lib/crypto/encoding";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

const ADDR = /^HOP-[0-9A-Z-]{4,64}$/;
const MAX_PACKET = 64 * 1024; // 64 KB per packet
const CLOCK_SKEW_MS = 60_000;

function clientIp(req: Request): string {
  return (req.headers.get("x-forwarded-for") ?? "unknown").split(",")[0].trim();
}

/** Verify the caller owns `addr` by checking a fresh signature over the poll challenge. */
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
  if (!(await rateLimit(`send:${clientIp(req)}`, 120, 60))) {
    return NextResponse.json({ error: "rate_limited" }, { status: 429 });
  }

  let body: { to?: string; packet?: string };
  try {
    body = (await req.json()) as { to?: string; packet?: string };
  } catch {
    return NextResponse.json({ error: "bad_json" }, { status: 400 });
  }
  const { to, packet } = body;
  if (!to || !ADDR.test(to)) return NextResponse.json({ error: "bad_addr" }, { status: 400 });
  if (!packet || typeof packet !== "string" || packet.length > MAX_PACKET) {
    return NextResponse.json({ error: "bad_packet" }, { status: 400 });
  }

  try {
    await enqueue(to, packet);
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ error: "relay_error" }, { status: 502 });
  }
}
