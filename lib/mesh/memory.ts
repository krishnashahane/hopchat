/**
 * InMemoryBus / InMemoryTransport — an in-process mesh link.
 *
 * A bus connects any number of transports; a packet broadcast by one is delivered
 * to every *other* transport on the same bus. Chaining nodes across separate buses
 * builds arbitrary topologies (e.g. a line A—R—B) for deterministic integration
 * testing of real multi-hop routing, and as a loopback transport in embedded hosts.
 */
import type { Transport } from "./router";
import type { MeshPacket } from "@/lib/types";

export class InMemoryBus {
  private readonly members = new Set<InMemoryTransport>();
  /** Optional latency/jitter hook; default is synchronous delivery. */
  constructor(private readonly deliver: (fn: () => void) => void = (fn) => fn()) {}

  attach(t: InMemoryTransport): void {
    this.members.add(t);
  }

  detach(t: InMemoryTransport): void {
    this.members.delete(t);
  }

  publish(from: InMemoryTransport, packet: MeshPacket): void {
    for (const m of this.members) {
      if (m === from) continue;
      this.deliver(() => m.receive(packet));
    }
  }
}

export class InMemoryTransport implements Transport {
  readonly name: string;
  private handler: ((p: MeshPacket, via: string) => void) | null = null;

  constructor(
    private readonly bus: InMemoryBus,
    name = "memory",
  ) {
    this.name = name;
    bus.attach(this);
  }

  onPacket(cb: (p: MeshPacket, via: string) => void): void {
    this.handler = cb;
  }

  broadcast(packet: MeshPacket): void {
    this.bus.publish(this, packet);
  }

  /** Called by the bus when a peer publishes a packet. */
  receive(packet: MeshPacket): void {
    this.handler?.(packet, this.name);
  }

  peers(): string[] {
    return [];
  }

  close(): void {
    this.bus.detach(this);
  }
}
