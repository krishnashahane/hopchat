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

  constructor(private readonly identity: Identity) {
    this.selfId = identity.address;
    this.bundle = encodePublicBundle(identity.publicKeys);
  }

  /** Build an authenticated poll URL proving ownership of our address. */
  private pollUrl(): string {
    const ts = Date.now().toString();
    const sig = b64uEncode(signBytes(this.identity, utf8(`hop-poll:${this.selfId}:${ts}`)));
    const p = new URLSearchParams({ addr: this.selfId, ts, sig, bundle: this.bundle });
    return `/api/relay?${p.toString()}`;
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
        const res = await fetch(this.pollUrl(), {
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
      body: JSON.stringify({ to: packet.to, packet: JSON.stringify(packet) }),
      keepalive: true,
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
    this.setOnline(false);
  }
}
