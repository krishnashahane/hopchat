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
 *   - Room ids are hashes of keys derived from Argon2id room keys; the relay learns no
 *     names/passwords, yet checks each post is signed by a room-key holder.
 *   - Every verb is rate-limited and size-capped.
 */
import { NextResponse } from "next/server";
import { relayConfigured, enqueue, drain, waitNext, rateLimit, roomPush, roomRead } from "@/lib/server/redis";
import { ADDR, owner, burn } from "@/lib/server/auth";
import { NO_STORE, err, logFailure, readCapped, clientIp } from "@/lib/server/http";
import { verifyRoomWrite } from "@/lib/crypto/room";
import { wakeLater } from "@/lib/server/push";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

const ROOM = /^ROOM-[0-9A-Z]{24}$/;
const MAX_PACKET = 64 * 1024;
const MAX_ROOM_PACKET = 16 * 1024; // 2,000 chars of 3-byte UTF-8 + author bundle, base64

/** A room post must name this room and be signed with its room-derived write key. */
function roomWriteOk(room: string, packet: string): boolean {
  try {
    const p = JSON.parse(packet) as { to?: unknown; kind?: unknown; payload?: unknown };
    return p.to === room && p.kind === "room" && verifyRoomWrite(room, p.payload);
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

  const addr = req.headers.get("x-hop-addr") ?? "";
  if (!ADDR.test(addr)) return err("bad_addr", 400);
  const me = owner(req, "poll");
  if (!me) return err("unauthorized", 401);
  if (!(await rateLimit(`poll:${addr}`, 40, 60))) return err("rate_limited", 429);

  try {
    if (!(await burn(me))) return err("replayed", 401);
    let items = await drain(addr);
    // `x-hop-wait: 0` asks for an immediate answer (first poll), so the client can
    // show "online" at once instead of after a full long-poll.
    if (items.length === 0 && req.headers.get("x-hop-wait") !== "0") {
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
  // Per IP (carrier NAT puts many users behind one address) and per destination
  // (caps how fast anyone can fill one inbox or room log).
  if (!(await rateLimit(`send:${clientIp(req)}`, 300, 60))) return err("rate_limited", 429);

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
  if (!ROOM.test(to) && !ADDR.test(to)) return err("bad_addr", 400);
  if (!(await rateLimit(`dest:${to}`, 600, 60))) return err("rate_limited", 429);

  try {
    if (ROOM.test(to)) {
      if (packet.length > MAX_ROOM_PACKET) return err("bad_packet", 400);
      if (!roomWriteOk(to, packet)) return err("forbidden", 403);
      return NextResponse.json({ ok: true, s: await roomPush(to, packet) }, { headers: NO_STORE });
    }
    if (!ADDR.test(to)) return err("bad_addr", 400);
    if (packet.length > MAX_PACKET) return err("bad_packet", 400);
    await enqueue(to, packet);
    wakeLater(to);
    return NextResponse.json({ ok: true }, { headers: NO_STORE });
  } catch (e) {
    logFailure("enqueue", e);
    return err("relay_error", 502);
  }
}
