/**
 * Web Push wake-ups. When a sealed packet lands in an inbox whose owner opted in, the
 * relay sends an *empty* push (no payload, no sender) so the device can show "new
 * message" and the app can fetch and decrypt it. The push service learns only that
 * something arrived for this subscription, and when.
 *
 *   VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY   `npx web-push generate-vapid-keys`
 *   VAPID_SUBJECT                          contact URL or mailto: (default https://hopchat.in)
 */
import { after } from "next/server";
import webpush, { WebPushError, type PushSubscription } from "web-push";
import { claimOnce, loadPushSub, deletePushSub } from "@/lib/server/redis";
import { logFailure } from "@/lib/server/http";

const PUBLIC = process.env.VAPID_PUBLIC_KEY ?? "";
const PRIVATE = process.env.VAPID_PRIVATE_KEY ?? "";
export const pushConfigured = Boolean(PUBLIC && PRIVATE);
export const vapidPublicKey = PUBLIC;
if (pushConfigured) webpush.setVapidDetails(process.env.VAPID_SUBJECT || "https://hopchat.in", PUBLIC, PRIVATE);

/** Browser push services only, so a subscription can't aim the server at arbitrary hosts. */
const PUSH_HOSTS = [
  /^fcm\.googleapis\.com$/,
  /^updates\.push\.services\.mozilla\.com$/,
  /^([a-z0-9-]+\.)*push\.apple\.com$/,
  /^([a-z0-9-]+\.)*notify\.windows\.com$/,
];
const B64U = /^[A-Za-z0-9_-]+={0,2}$/;

/** Validate a client-supplied PushSubscription; returns a minimal copy or null. */
export function parseSubscription(x: unknown): PushSubscription | null {
  if (!x || typeof x !== "object") return null;
  const { endpoint, keys } = x as { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } };
  if (typeof endpoint !== "string" || endpoint.length > 1024) return null;
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.port || !PUSH_HOSTS.some((h) => h.test(url.hostname))) return null;
  const { p256dh, auth } = keys ?? {};
  if (typeof p256dh !== "string" || typeof auth !== "string" || !B64U.test(p256dh) || !B64U.test(auth)) return null;
  if (p256dh.length > 128 || auth.length > 64) return null;
  return { endpoint, keys: { p256dh, auth } };
}

/** Wake `addr`'s device, at most once per 20s; drops subscriptions the service has expired. */
export async function wake(addr: string): Promise<void> {
  if (!pushConfigured) return;
  try {
    const raw = await loadPushSub(addr);
    if (!raw || !(await claimOnce(`push:${addr}`, 20))) return;
    await webpush.sendNotification(JSON.parse(raw) as PushSubscription, null, { TTL: 86_400, urgency: "high", topic: "hop", timeout: 5_000 });
  } catch (e) {
    if (e instanceof WebPushError && (e.statusCode === 404 || e.statusCode === 410)) await deletePushSub(addr).catch(() => {});
    else logFailure("push", e);
  }
}

/** Schedule `wake` after the response is sent (inline outside a request, e.g. tests). */
export function wakeLater(addr: string): void {
  if (!pushConfigured) return;
  try {
    after(() => wake(addr));
  } catch {
    void wake(addr);
  }
}
