/**
 * MeshRouter — transport-agnostic multi-hop packet router.
 *
 * Responsibilities:
 *   - Deduplicate packets across the mesh (each packet id is delivered once).
 *   - Deliver packets addressed to us to the local application.
 *   - Relay packets addressed to others by decrementing TTL and re-flooding,
 *     giving controlled-flood multi-hop routing (self-healing: any path works).
 *
 * The router knows nothing about *how* bytes move; it drives a set of Transports.
 * Payloads are opaque (end-to-end encrypted), so relays never see plaintext.
 */
import type { MeshPacket } from "@/lib/types";

/** Hop budget: a packet crosses at most this many links (bitchat-compatible). */
export const MAX_HOPS = 7;

export interface Transport {
  readonly name: string;
  /** Register a handler for packets arriving on this transport. */
  onPacket(cb: (packet: MeshPacket, via: string) => void): void;
  /** Broadcast a packet to all peers reachable on this transport. */
  broadcast(packet: MeshPacket): void;
  /** Currently connected peer identifiers (best-effort). */
  peers(): string[];
  /** Tear down the transport. */
  close(): void;
}

/** Bounded LRU set for packet-id dedup and replay protection. */
class SeenSet {
  private readonly map = new Map<string, number>();
  constructor(private readonly capacity = 4096) {}

  has(id: string): boolean {
    return this.map.has(id);
  }

  add(id: string, ts = Date.now()): void {
    if (this.map.size >= this.capacity) {
      const oldest = this.map.keys().next().value;
      if (oldest !== undefined) this.map.delete(oldest);
    }
    this.map.set(id, ts);
  }
}

export interface RouterOptions {
  /** Our own short address fingerprint. */
  selfId: string;
  /** Default TTL for originated packets. */
  defaultTtl?: number;
  /** Accept packets at most this old (ms) — replay window. */
  maxAgeMs?: number;
}

export class MeshRouter {
  private readonly transports: Transport[] = [];
  private readonly seen = new SeenSet();
  private deliver: ((p: MeshPacket) => void) | null = null;
  /** Group destinations (rooms) we are subscribed to; delivered *and* relayed. */
  private readonly groups = new Set<string>();
  private readonly selfId: string;
  private readonly defaultTtl: number;
  private readonly maxAgeMs: number;

  constructor(opts: RouterOptions) {
    this.selfId = opts.selfId;
    this.defaultTtl = Math.min(opts.defaultTtl ?? MAX_HOPS, MAX_HOPS);
    this.maxAgeMs = opts.maxAgeMs ?? 5 * 60_000;
  }

  addTransport(t: Transport): void {
    t.onPacket((packet, via) => this.ingest(packet, via));
    this.transports.push(t);
  }

  /** Register the local delivery sink (packets addressed to us). */
  onDeliver(cb: (p: MeshPacket) => void): void {
    this.deliver = cb;
  }

  subscribe(group: string): void {
    this.groups.add(group);
  }

  unsubscribe(group: string): void {
    this.groups.delete(group);
  }

  /** Originate a new packet into the mesh. */
  send(partial: Omit<MeshPacket, "ttl" | "ts" | "from"> & { ttl?: number }): MeshPacket {
    const packet: MeshPacket = {
      ...partial,
      from: this.selfId,
      ttl: Math.min(partial.ttl ?? this.defaultTtl, MAX_HOPS),
      ts: Date.now(),
    };
    this.seen.add(packet.id);
    this.flood(packet, null);
    return packet;
  }

  /** Handle a packet arriving from a transport. Returns true if it was new. */
  ingest(packet: MeshPacket, via: string | null): boolean {
    if (!this.isValid(packet)) return false;
    if (this.seen.has(packet.id)) return false;
    this.seen.add(packet.id);

    if (packet.to === this.selfId) {
      this.deliver?.(packet);
      return true;
    }
    // Room traffic: deliver locally, then keep flooding for other members.
    if (this.groups.has(packet.to)) this.deliver?.(packet);

    // Relay: decrement TTL and re-flood to every transport except the source.
    if (packet.ttl > 1) {
      this.flood({ ...packet, ttl: Math.min(packet.ttl, MAX_HOPS) - 1 }, via);
    }
    return true;
  }

  private isValid(packet: MeshPacket): boolean {
    if (!packet || typeof packet !== "object") return false;
    if (typeof packet.id !== "string" || packet.id.length === 0 || packet.id.length > 64) return false;
    if (typeof packet.to !== "string" || typeof packet.from !== "string") return false;
    if (!Number.isInteger(packet.ttl) || packet.ttl <= 0 || packet.ttl > 32) return false;
    if (!Number.isFinite(packet.ts)) return false;
    const age = Date.now() - packet.ts;
    if (age > this.maxAgeMs || age < -this.maxAgeMs) return false;
    return true;
  }

  private flood(packet: MeshPacket, exclude: string | null): void {
    for (const t of this.transports) {
      if (t.name === exclude) continue;
      try {
        t.broadcast(packet);
      } catch {
        // A failing transport must never break the mesh; self-healing by design.
      }
    }
  }

  peerCount(): number {
    const set = new Set<string>();
    for (const t of this.transports) for (const p of t.peers()) set.add(p);
    return set.size;
  }

  close(): void {
    for (const t of this.transports) t.close();
  }
}
