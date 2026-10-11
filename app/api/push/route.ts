/**
 * Web Push opt-in.
 *   GET    /api/push            { key }  VAPID public key (503 when push isn't configured)
 *   POST   /api/push            { subscription }  store for the signed address (scope "push")
 *   DELETE /api/push            forget the signed address's subscription
 */
import { NextResponse } from "next/server";
import { rateLimit, relayConfigured, savePushSub, deletePushSub } from "@/lib/server/redis";
import { owner, burn } from "@/lib/server/auth";
import { NO_STORE, err, logFailure, readCapped, clientIp } from "@/lib/server/http";
import { pushConfigured, vapidPublicKey, parseSubscription } from "@/lib/server/push";

export const dynamic = "force-dynamic";

export function GET() {
  if (!pushConfigured || !relayConfigured) return err("push_unconfigured", 503);
  return NextResponse.json({ key: vapidPublicKey }, { headers: NO_STORE });
}

async function authorize(req: Request) {
  if (!pushConfigured || !relayConfigured) return { res: err("push_unconfigured", 503) };
  const me = owner(req, "push");
  if (!me) return { res: err("unauthorized", 401) };
  if (!(await rateLimit(`push:${me.addr}`, 10, 60)) || !(await rateLimit(`push-ip:${clientIp(req)}`, 60, 60))) {
    return { res: err("rate_limited", 429) };
  }
  if (!(await burn(me))) return { res: err("replayed", 401) };
  return { addr: me.addr };
}

export async function POST(req: Request) {
  if (!(req.headers.get("content-type") ?? "").startsWith("application/json")) return err("bad_type", 415);
  try {
    const a = await authorize(req);
    if (!a.addr) return a.res;
    const raw = await readCapped(req, 4096);
    if (raw === null) return err("too_large", 413);
    let body: { subscription?: unknown };
    try {
      body = JSON.parse(raw) as { subscription?: unknown };
    } catch {
      return err("bad_json", 400);
    }
    const sub = parseSubscription(body?.subscription);
    if (!sub) return err("bad_subscription", 400);
    await savePushSub(a.addr, JSON.stringify(sub));
    return NextResponse.json({ ok: true }, { headers: NO_STORE });
  } catch (e) {
    logFailure("push_subscribe", e);
    return err("relay_error", 502);
  }
}

export async function DELETE(req: Request) {
  try {
    const a = await authorize(req);
    if (!a.addr) return a.res;
    await deletePushSub(a.addr);
    return NextResponse.json({ ok: true }, { headers: NO_STORE });
  } catch (e) {
    logFailure("push_unsubscribe", e);
    return err("relay_error", 502);
  }
}
