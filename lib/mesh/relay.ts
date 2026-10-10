/**
 * RelayTransport — internet-relay link so peers reach each other across any network
 * (wifi, mobile data, different ISPs, symmetric NAT) on any OS/browser, with no
 * manual pairing. Store-and-forward: messages queue for offline peers and arrive on
 * reconnect. Payloads are end-to-end sealed, so the relay only ever sees ciphertext.
 *
 * Receive path: HTTP long-poll (GET) — near-instant, few requests.
 * Send path:    HTTP POST to the recipient's address inbox.
 */
import type { Transport } from "./router";
import type { MeshPacket } from "@/lib/types";
import type { Identity } from "@/lib/crypto/identity";
import { encodePublicBundle } from "@/lib/crypto/identity";
import { signBytes } from "@/lib/crypto/e2e";
import { utf8, b64uEncode } from "@/lib/crypto/encoding";

export class RelayTransport implements Transport {
  readonly name = "relay";
  private handler: ((p: MeshPacket, via: string) => void) | null = null;
  private abort: AbortController | null = null;
  private running = false;
  private online = false;
  private enabled = true;
  private onStatus: ((online: boolean) => void) | null = null;
  private readonly selfId: string;
  private readonly bundle: string;
  /** Joined rooms → last seen log sequence. */
  private readonly rooms = new Map<string, number>();
  private roomTimer: ReturnType<typeof setTimeout> | null = null;
  /** Bumped whenever the room loop restarts so a stale in-flight loop exits. */
  private roomGen = 0;
  private roomLoopActive = false;

  constructor(private readonly identity: Identity) {
    this.selfId = identity.address;
    this.bundle = encodePublicBundle(identity.publicKeys);
  }

  /** Signed, single-use headers proving ownership of our address (kept out of URLs/logs). */
  private pollHeaders(): Record<string, string> {
    const ts = Date.now().toString();
    const sig = b64uEncode(signBytes(this.identity, utf8(`hop-poll:${this.selfId}:${ts}`)));
    return { "x-hop-addr": this.selfId, "x-hop-ts": ts, "x-hop-sig": sig, "x-hop-bundle": this.bundle };
  }

  /** Follow these rooms' relay logs (in addition to our private inbox). */
  setRooms(dests: string[]): void {
    for (const d of [...this.rooms.keys()]) if (!dests.includes(d)) this.rooms.delete(d);
    for (const d of dests) if (!this.rooms.has(d)) this.rooms.set(d, 0);
    if (this.running && !this.roomLoopActive) this.startRooms();
  }

  private startRooms(): void {
    if (this.rooms.size === 0) return;
    this.roomLoopActive = true;
    void this.pollRooms(++this.roomGen);
  }

  private async pollRooms(gen: number): Promise<void> {
    this.roomTimer = null;
    for (const [dest, after] of [...this.rooms]) {
      if (gen !== this.roomGen || !this.running) return;
      try {
        const res = await fetch(`/api/relay?room=${dest}&after=${after}`, { cache: "no-store" });
        if (!res.ok) continue;
        const { head, packets } = (await res.json()) as { head: number; packets: { s: number; p: string }[] };
        if (!this.rooms.has(dest)) continue;
        // Log expired and restarted: rewind so new posts are not skipped.
        this.rooms.set(dest, head < after ? 0 : Math.max(after, ...packets.map((x) => x.s)));
        for (const { p } of packets) {
          try {
            this.handler?.(JSON.parse(p) as MeshPacket, this.name);
          } catch {
            /* skip malformed */
          }
        }
      } catch {
        /* offline — retry next tick */
      }
    }
    if (gen !== this.roomGen) return;
    if (this.running && this.rooms.size > 0) this.roomTimer = setTimeout(() => void this.pollRooms(gen), 3_000);
    else this.roomLoopActive = false;
  }

  onStatusChange(cb: (online: boolean) => void): void {
    this.onStatus = cb;
  }

  onPacket(cb: (p: MeshPacket, via: string) => void): void {
    this.handler = cb;
  }

  /** Begin the long-poll receive loop. Safe to call once, browser-only. */
  start(): void {
    if (this.running || !this.enabled || typeof window === "undefined") return;
    this.running = true;
    void this.loop();
    this.startRooms();
  }

  /** User-facing toggle: enable/disable the internet relay transport at runtime. */
  setEnabled(on: boolean): void {
    this.enabled = on;
    if (on) this.start();
    else this.close();
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  private setOnline(v: boolean): void {
    if (this.online !== v) {
      this.online = v;
      this.onStatus?.(v);
    }
  }

  private async loop(): Promise<void> {
    while (this.running) {
      this.abort = new AbortController();
      try {
        const res = await fetch("/api/relay", {
          headers: this.pollHeaders(),
          signal: this.abort.signal,
          cache: "no-store",
        });
        if (res.status === 503) {
          // Relay not provisioned yet — back off long, keep the app fully functional.
          this.setOnline(false);
          await this.sleep(30_000);
          continue;
        }
        if (!res.ok) throw new Error(`relay ${res.status}`);
        this.setOnline(true);
        const { packets } = (await res.json()) as { packets: string[] };
        for (const raw of packets ?? []) {
          try {
            this.handler?.(JSON.parse(raw) as MeshPacket, this.name);
          } catch {
            /* skip malformed */
          }
        }
      } catch {
        if (!this.running) break;
        this.setOnline(false);
        await this.sleep(3_000); // transient error — reconnect
      }
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
  }

  broadcast(packet: MeshPacket): void {
    if (!this.enabled || typeof window === "undefined") return;
    void fetch("/api/relay", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // No `keepalive`: browsers cap in-flight keepalive bodies at 64 KB total,
      // which silently dropped file chunks.
      body: JSON.stringify({ to: packet.to, packet: JSON.stringify(packet) }),
    }).catch(() => {
      /* delivery retried by the app/mesh; never throw into the router */
    });
  }

  isOnline(): boolean {
    return this.online;
  }

  peers(): string[] {
    // The relay is infrastructure, not a peer; connectivity is reported via status.
    return [];
  }

  close(): void {
    this.running = false;
    this.abort?.abort();
    if (this.roomTimer) clearTimeout(this.roomTimer);
    this.roomTimer = null;
    this.roomGen++;
    this.roomLoopActive = false;
    this.setOnline(false);
  }
}
