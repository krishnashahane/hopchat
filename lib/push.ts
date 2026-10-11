/**
 * Browser side of Web Push opt-in. The subscription is registered under our address
 * with a signed request; the relay then sends empty wake-ups when our inbox fills.
 */
import { b64uDecode } from "@/lib/crypto/encoding";

type Signer = () => Record<string, string>;

export const pushSupported = (): boolean =>
  typeof window !== "undefined" && "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;

async function registration(): Promise<ServiceWorkerRegistration> {
  const timeout = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error("offline support isn't active yet. reload the app and try again")), 5_000),
  );
  return Promise.race([navigator.serviceWorker.ready, timeout]);
}

export async function enablePush(sign: Signer): Promise<void> {
  const res = await fetch("/api/push", { cache: "no-store" });
  if (!res.ok) throw new Error("notifications aren't available on this server yet");
  const { key } = (await res.json()) as { key: string };
  if ((await Notification.requestPermission()) !== "granted") throw new Error("notification permission was not granted");
  const reg = await registration();
  const sub =
    (await reg.pushManager.getSubscription()) ??
    (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64uDecode(key).slice().buffer as ArrayBuffer }));
  const saved = await fetch("/api/push", {
    method: "POST",
    headers: { ...sign(), "Content-Type": "application/json" },
    body: JSON.stringify({ subscription: sub.toJSON() }),
  });
  if (!saved.ok) {
    await sub.unsubscribe().catch(() => {});
    throw new Error("could not register for notifications. try again");
  }
}

/** Best effort: forget the subscription locally and on the server. */
export async function disablePush(sign: Signer): Promise<void> {
  await fetch("/api/push", { method: "DELETE", headers: sign(), keepalive: true }).catch(() => {});
  const reg = await registration().catch(() => null);
  await (await reg?.pushManager.getSubscription())?.unsubscribe().catch(() => {});
}
