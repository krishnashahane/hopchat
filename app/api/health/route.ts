/**
 * GET /api/health — liveness for uptime checks. Round-trips Redis and reports which
 * optional services are configured (booleans only; never values).
 */
import { NextResponse } from "next/server";
import { relayConfigured, ping } from "@/lib/server/redis";
import { turnConfigured } from "@/lib/server/ice";
import { pushConfigured } from "@/lib/server/push";
import { NO_STORE, logFailure } from "@/lib/server/http";

export const dynamic = "force-dynamic";

export async function GET() {
  let redis = false;
  if (relayConfigured) {
    try {
      redis = await ping();
    } catch (e) {
      logFailure("health", e);
    }
  }
  const ok = relayConfigured && redis;
  return NextResponse.json(
    { ok, relay: redis, turn: turnConfigured, push: pushConfigured },
    { status: ok ? 200 : 503, headers: NO_STORE },
  );
}
