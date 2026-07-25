/**
 * LocalBusTransport — zero-server mesh across same-origin contexts (tabs, windows,
 * PWAs on one device). Uses BroadcastChannel. Invaluable offline: two people on the
 * same machine, or a device bridging tabs, form an instant mesh with no network.
 */
import type { Transport } from "./router";
import type { MeshPacket } from "@/lib/types";

export class LocalBusTransport implements Transport {
  readonly name = "localbus";
  private readonly channel: BroadcastChannel | null;
  private handler: ((p: MeshPacket, via: string) => void) | null = null;
  private readonly peerIds = new Set<string>();

  constructor(private readonly selfId: string) {
    this.channel =
      typeof BroadcastChannel !== "undefined" ? new BroadcastChannel("hopchat-mesh") : null;
    if (this.channel) {
      this.channel.onmessage = (ev: MessageEvent) => this.receive(ev.data);
      // Announce presence so peers learn about us.
      this.channel.postMessage({ __hop: "hello", id: selfId });
    }
  }

  private receive(data: unknown): void {
    if (data && typeof data === "object" && "__hop" in data) {
      const ctrl = data as { __hop: string; id: string };
      if (ctrl.id && ctrl.id !== this.selfId) {
        this.peerIds.add(ctrl.id);
        if (ctrl.__hop === "hello") this.channel?.postMessage({ __hop: "ack", id: this.selfId });
      }
      return;
    }
    this.handler?.(data as MeshPacket, this.name);
  }

  onPacket(cb: (p: MeshPacket, via: string) => void): void {
    this.handler = cb;
  }

  broadcast(packet: MeshPacket): void {
    this.channel?.postMessage(packet);
  }

  peers(): string[] {
    return [...this.peerIds];
  }

  close(): void {
    this.channel?.postMessage({ __hop: "bye", id: this.selfId });
    this.channel?.close();
  }
}
