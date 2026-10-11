/**
 * GET /api/ice — ICE servers (STUN, plus short-lived TURN credentials when configured).
 * Signed like an inbox poll (scope "ice") so TURN bandwidth is only handed to HopChat
 * identities, and rate-limited per address and IP.
 */
import { NextResponse } from "next/server";
import { rateLimit, relayConfigured } from "@/lib/server/redis";
import { owner, burn } from "@/lib/server/auth";
import { NO_STORE, err, logFailure, clientIp } from "@/lib/server/http";
import { iceServers, ICE_TTL_SEC, STUN } from "@/lib/server/ice";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const me = owner(req, "ice");
  if (!me) return err("unauthorized", 401);
  // Without Redis there is no replay guard or limiter; STUN is public anyway.
  if (!relayConfigured) return NextResponse.json({ iceServers: STUN, ttl: ICE_TTL_SEC }, { headers: NO_STORE });
  try {
    if (!(await rateLimit(`ice:${me.addr}`, 10, 60)) || !(await rateLimit(`ice-ip:${clientIp(req)}`, 60, 60))) {
      return err("rate_limited", 429);
    }
    if (!(await burn(me))) return err("replayed", 401);
    return NextResponse.json({ iceServers: iceServers(me.addr), ttl: ICE_TTL_SEC }, { headers: NO_STORE });
  } catch (e) {
    logFailure("ice", e);
    return err("relay_error", 502);
  }
}
