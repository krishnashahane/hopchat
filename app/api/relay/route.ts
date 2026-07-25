/**
 * Internet-relay endpoint — store-and-forward for end-to-end-sealed packets.
 *
 *   POST /api/relay   { to, packet }        enqueue an opaque packet for a recipient
 *   GET  /api/relay?addr=HOP-…              long-poll: drain queued packets, else block
 *                                           up to ~20s for the next one (near-instant)
 *
 * The relay stores only ciphertext keyed by address. It holds no keys and cannot read
 * message content — confidentiality/authenticity come entirely from the Double Ratchet.
 */
import { NextResponse } from "next/server";
import { relayConfigured, enqueue, drain, waitNext } from "@/lib/server/redis";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

const ADDR = /^HOP-[0-9A-Z-]{4,64}$/;
const MAX_PACKET = 64 * 1024; // 64 KB per packet

export async function GET(req: Request) {
  if (!relayConfigured) return NextResponse.json({ error: "relay_unconfigured" }, { status: 503 });
  const addr = new URL(req.url).searchParams.get("addr") ?? "";
  if (!ADDR.test(addr)) return NextResponse.json({ error: "bad_addr" }, { status: 400 });

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
