/**
 * Location channels over Nostr — bitchat-compatible, opt-in, internet-only.
 *
 * A channel is a geohash cell. Posts are NIP-01 kind-20000 (ephemeral) events
 * tagged ["g", geohash] and ["n", nick], exactly as bitchat sends them, so both
 * apps share the same channels. Posts are PUBLIC: anyone subscribed to the cell
 * can read them. Each geohash gets its own Nostr key derived from our identity,
 * so posts in different places cannot be linked to each other or to our address.
 *
 * Relays are untrusted: every incoming event's id and Schnorr signature is checked.
 */
import { schnorr } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { concatBytes, utf8 } from "@/lib/crypto/encoding";
import type { Identity } from "@/lib/crypto/identity";

import { NOSTR_RELAYS } from "./nostrRelays";

export const GEO_KIND = 20000;
export const MAX_GEO_BODY = 1000;

// ── geohash ──────────────────────────────────────────────────────────────────

const B32 = "0123456789bcdefghjkmnpqrstuvwxyz";
export const GEOHASH = /^[0123456789bcdefghjkmnpqrstuvwxyz]{2,8}$/;

/** bitchat precision levels. */
export const GEO_LEVELS: Record<string, number> = { region: 2, province: 4, city: 5, neighborhood: 6, block: 7 };

export function encodeGeohash(lat: number, lon: number, precision: number): string {
  let latR = [-90, 90];
  let lonR = [-180, 180];
  let out = "";
  let bit = 0;
  let ch = 0;
  let even = true;
  while (out.length < precision) {
    const r = even ? lonR : latR;
    const v = even ? lon : lat;
    const mid = (r[0] + r[1]) / 2;
    ch <<= 1;
    if (v >= mid) {
      ch |= 1;
      r[0] = mid;
    } else {
      r[1] = mid;
    }
    if (even) lonR = r;
    else latR = r;
    even = !even;
    if (++bit === 5) {
      out += B32[ch];
      bit = 0;
      ch = 0;
    }
  }
  return out;
}

// ── events ───────────────────────────────────────────────────────────────────

export interface NostrEvent {
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
  sig: string;
}

export interface GeoPost {
  id: string;
  geohash: string;
  pubkey: string;
  nick: string;
  body: string;
  ts: number;
}

/** Unlinkable per-cell signing key: H(domain ‖ geohash ‖ identity signing secret). */
export function geoKey(identity: Identity, geohash: string): Uint8Array {
  let sk = sha256(concatBytes(utf8(`hopchat-nostr-geo:${geohash}:`), identity.secretKeys.sign));
  while (!validScalar(sk)) sk = sha256(sk); // out-of-range hash: astronomically rare
  return sk;
}

export const geoPubkey = (identity: Identity, geohash: string): string =>
  bytesToHex(schnorr.getPublicKey(geoKey(identity, geohash)));

function validScalar(sk: Uint8Array): boolean {
  try {
    schnorr.getPublicKey(sk);
    return true;
  } catch {
    return false;
  }
}

const eventId = (e: Omit<NostrEvent, "id" | "sig">): string =>
  bytesToHex(sha256(utf8(JSON.stringify([0, e.pubkey, e.created_at, e.kind, e.tags, e.content]))));

export function signGeoEvent(sk: Uint8Array, geohash: string, nick: string, body: string, now = Date.now()): NostrEvent {
  const unsigned = {
    pubkey: bytesToHex(schnorr.getPublicKey(sk)),
    created_at: Math.floor(now / 1000),
    kind: GEO_KIND,
    tags: [["g", geohash], ["n", nick]],
    content: body,
  };
  const id = eventId(unsigned);
  return { ...unsigned, id, sig: bytesToHex(schnorr.sign(hexToBytes(id), sk)) };
}

/** Validate an untrusted relay event; returns the post or null. */
export function readGeoEvent(e: unknown, geohash: string): GeoPost | null {
  if (!e || typeof e !== "object") return null;
  const ev = e as NostrEvent;
  if (ev.kind !== GEO_KIND || typeof ev.content !== "string" || ev.content.length > MAX_GEO_BODY) return null;
  if (!Array.isArray(ev.tags) || !ev.tags.every((t) => Array.isArray(t) && t.every((x) => typeof x === "string"))) return null;
  if (!ev.tags.some((t) => t[0] === "g" && t[1] === geohash)) return null;
  if (!/^[0-9a-f]{64}$/.test(ev.id) || !/^[0-9a-f]{64}$/.test(ev.pubkey) || !/^[0-9a-f]{128}$/.test(ev.sig)) return null;
  if (!Number.isInteger(ev.created_at)) return null;
  if (eventId(ev) !== ev.id) return null;
  try {
    if (!schnorr.verify(hexToBytes(ev.sig), hexToBytes(ev.id), hexToBytes(ev.pubkey))) return null;
  } catch {
    return null;
  }
  const nick = (ev.tags.find((t) => t[0] === "n")?.[1] ?? "").slice(0, 24) || `anon-${ev.pubkey.slice(-4)}`;
  return { id: ev.id, geohash, pubkey: ev.pubkey, nick, body: ev.content, ts: ev.created_at * 1000 };
}

// ── relay pool ───────────────────────────────────────────────────────────────

/** Minimal NIP-01 relay pool: one socket per relay, resubscribes on reconnect. */
export class GeoRelayPool {
  private readonly sockets = new Map<string, WebSocket>();
  private readonly subs = new Set<string>();
  private readonly seen = new Set<string>();
  private readonly backoff = new Map<string, number>();
  private closed = false;

  constructor(private readonly onPost: (p: GeoPost) => void) {}

  subscribe(geohash: string): void {
    this.subs.add(geohash);
    this.closed = false;
    for (const url of NOSTR_RELAYS) {
      const ws = this.sockets.get(url);
      if (!ws) this.connect(url);
      else if (ws.readyState === WebSocket.OPEN) this.req(ws, geohash);
    }
  }

  unsubscribe(geohash: string): void {
    this.subs.delete(geohash);
    for (const ws of this.sockets.values()) if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(["CLOSE", `g:${geohash}`]));
    if (this.subs.size === 0) this.close();
  }

  /** Publish to every connected relay. Returns how many accepted the send. */
  publish(ev: NostrEvent): number {
    this.seen.add(ev.id);
    let n = 0;
    for (const ws of this.sockets.values()) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(["EVENT", ev]));
        n++;
      }
    }
    return n;
  }

  connected(): number {
    return [...this.sockets.values()].filter((ws) => ws.readyState === WebSocket.OPEN).length;
  }

  close(): void {
    this.closed = true;
    for (const ws of this.sockets.values()) ws.close();
    this.sockets.clear();
  }

  private req(ws: WebSocket, geohash: string): void {
    const since = Math.floor(Date.now() / 1000) - 3600;
    ws.send(JSON.stringify(["REQ", `g:${geohash}`, { kinds: [GEO_KIND], "#g": [geohash], since, limit: 200 }]));
  }

  private connect(url: string): void {
    let ws: WebSocket;
    try {
      ws = new WebSocket(url);
    } catch {
      return;
    }
    this.sockets.set(url, ws);
    ws.onopen = () => {
      this.backoff.set(url, 1_000);
      for (const g of this.subs) this.req(ws, g);
    };
    ws.onmessage = (m) => {
      if (typeof m.data !== "string" || m.data.length > 64 * 1024) return;
      let msg: unknown;
      try {
        msg = JSON.parse(m.data);
      } catch {
        return;
      }
      if (!Array.isArray(msg) || msg[0] !== "EVENT" || typeof msg[1] !== "string") return;
      const geohash = msg[1].startsWith("g:") ? msg[1].slice(2) : "";
      if (!this.subs.has(geohash)) return;
      const ev = msg[2] as NostrEvent;
      if (!ev || this.seen.has(ev.id)) return;
      const post = readGeoEvent(ev, geohash);
      if (!post) return;
      this.seen.add(post.id);
      if (this.seen.size > 5000) this.seen.delete(this.seen.values().next().value!);
      this.onPost(post);
    };
    ws.onclose = () => {
      if (this.sockets.get(url) === ws) this.sockets.delete(url);
      if (this.closed || this.subs.size === 0) return;
      const wait = Math.min(this.backoff.get(url) ?? 1_000, 60_000);
      this.backoff.set(url, wait * 2);
      setTimeout(() => !this.closed && !this.sockets.has(url) && this.connect(url), wait);
    };
    ws.onerror = () => ws.close();
  }
}
