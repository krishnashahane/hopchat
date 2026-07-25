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

export class RelayTransport implements Transport {
  readonly name = "relay";
  private handler: ((p: MeshPacket, via: string) => void) | null = null;
  private abort: AbortController | null = null;
  private running = false;
  private online = false;
  private onStatus: ((online: boolean) => void) | null = null;

  constructor(private readonly selfId: string) {}

  onStatusChange(cb: (online: boolean) => void): void {
    this.onStatus = cb;
  }

  onPacket(cb: (p: MeshPacket, via: string) => void): void {
    this.handler = cb;
  }

  /** Begin the long-poll receive loop. Safe to call once, browser-only. */
  start(): void {
    if (this.running || typeof window === "undefined") return;
    this.running = true;
    void this.loop();
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
        const res = await fetch(`/api/relay?addr=${encodeURIComponent(this.selfId)}`, {
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
    if (typeof window === "undefined") return;
    void fetch("/api/relay", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ to: packet.to, packet: JSON.stringify(packet) }),
      keepalive: true,
    }).catch(() => {
      /* delivery retried by the app/mesh; never throw into the router */
    });
  }

  peers(): string[] {
    return this.online ? ["relay"] : [];
  }

  close(): void {
    this.running = false;
    this.abort?.abort();
  }
}
