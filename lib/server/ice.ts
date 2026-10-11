/**
 * ICE servers for WebRTC links. STUN always; TURN when configured, so peers behind
 * symmetric NAT or strict firewalls can still link (TURN relays only DTLS-encrypted
 * data channel bytes, which carry already end-to-end-sealed packets).
 *
 *   TURN_URLS        comma-separated, e.g. "turn:turn.example.com:3478,turns:turn.example.com:5349"
 *   TURN_SECRET      coturn `use-auth-secret` shared secret → short-lived credentials (preferred)
 *   TURN_USERNAME / TURN_CREDENTIAL   static credentials, if the provider issues those instead
 */
import { createHmac, createHash } from "node:crypto";

export const STUN: RTCIceServer[] = [{ urls: ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"] }];
export const ICE_TTL_SEC = 6 * 3600;

const urls = (process.env.TURN_URLS ?? "")
  .split(",")
  .map((u) => u.trim())
  .filter((u) => /^turns?:[^\s]+$/.test(u));

export const turnConfigured = urls.length > 0 && Boolean(process.env.TURN_SECRET || (process.env.TURN_USERNAME && process.env.TURN_CREDENTIAL));

export function iceServers(addr: string, now = Date.now()): RTCIceServer[] {
  if (!turnConfigured) return STUN;
  const secret = process.env.TURN_SECRET;
  if (secret) {
    // coturn REST API: username "<expiry>:<id>", credential = base64(HMAC-SHA1(secret, username)).
    // The id is a hash so the TURN server's logs never hold HopChat addresses.
    const id = createHash("sha256").update(addr).digest("hex").slice(0, 16);
    const username = `${Math.floor(now / 1000) + ICE_TTL_SEC}:${id}`;
    const credential = createHmac("sha1", secret).update(username).digest("base64");
    return [...STUN, { urls, username, credential }];
  }
  return [...STUN, { urls, username: process.env.TURN_USERNAME, credential: process.env.TURN_CREDENTIAL }];
}
