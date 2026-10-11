import { describe, it, expect, vi } from "vitest";
import { MeshRouter, MAX_HOPS, type Transport } from "./router";
import type { MeshPacket } from "@/lib/types";

function mockTransport(name: string) {
  let handler: ((p: MeshPacket, via: string) => void) | null = null;
  const broadcast = vi.fn<(p: MeshPacket) => void>();
  const t: Transport = {
    name,
    onPacket: (cb) => {
      handler = cb;
    },
    broadcast,
    peers: () => ["peer-" + name],
    close: () => {},
  };
  return { t, broadcast, inject: (p: MeshPacket) => handler?.(p, name) };
}

function pkt(over: Partial<MeshPacket>): MeshPacket {
  return {
    id: Math.random().toString(36).slice(2),
    to: "DST",
    from: "SRC",
    ttl: 8,
    ts: Date.now(),
    kind: "msg",
    payload: {},
    ...over,
  };
}

describe("MeshRouter", () => {
  it("delivers packets addressed to self", () => {
    const r = new MeshRouter({ selfId: "ME" });
    const deliver = vi.fn();
    r.onDeliver(deliver);
    const a = mockTransport("a");
    r.addTransport(a.t);
    const p = pkt({ to: "ME" });
    a.inject(p);
    expect(deliver).toHaveBeenCalledOnce();
    expect(a.broadcast).not.toHaveBeenCalled();
  });

  it("relays packets for others with decremented TTL", () => {
    const r = new MeshRouter({ selfId: "ME" });
    const a = mockTransport("a");
    const b = mockTransport("b");
    r.addTransport(a.t);
    r.addTransport(b.t);
    const p = pkt({ to: "OTHER", ttl: 5 });
    a.inject(p);
    // Relayed out of b (not back out of a, its source).
    expect(b.broadcast).toHaveBeenCalledOnce();
    expect(b.broadcast.mock.calls[0][0].ttl).toBe(4);
    expect(a.broadcast).not.toHaveBeenCalled();
  });

  it("deduplicates repeated packet ids", () => {
    const r = new MeshRouter({ selfId: "ME" });
    const deliver = vi.fn();
    r.onDeliver(deliver);
    const a = mockTransport("a");
    r.addTransport(a.t);
    const p = pkt({ to: "ME", id: "dup" });
    a.inject(p);
    a.inject(p);
    a.inject(p);
    expect(deliver).toHaveBeenCalledOnce();
  });

  it("drops packets at TTL 1 (no infinite flood)", () => {
    const r = new MeshRouter({ selfId: "ME" });
    const a = mockTransport("a");
    const b = mockTransport("b");
    r.addTransport(a.t);
    r.addTransport(b.t);
    a.inject(pkt({ to: "OTHER", ttl: 1 }));
    expect(b.broadcast).not.toHaveBeenCalled();
  });

  it("rejects stale packets outside the replay window", () => {
    const r = new MeshRouter({ selfId: "ME", maxAgeMs: 1000 });
    const deliver = vi.fn();
    r.onDeliver(deliver);
    const a = mockTransport("a");
    const b = mockTransport("b");
    r.addTransport(a.t);
    r.addTransport(b.t);
    a.inject(pkt({ to: "OTHER", ts: Date.now() - 10_000 }));
    expect(b.broadcast).not.toHaveBeenCalled();
    a.inject(pkt({ to: "ME", ts: Date.now() - 25 * 3600_000 }));
    expect(deliver).not.toHaveBeenCalled();
  });

  it("accepts direct packets the relay held while we were offline", () => {
    const r = new MeshRouter({ selfId: "ME", maxAgeMs: 1000 });
    const deliver = vi.fn();
    r.onDeliver(deliver);
    const a = mockTransport("a");
    r.addTransport(a.t);
    a.inject(pkt({ to: "ME", ts: Date.now() - 3600_000 }));
    expect(deliver).toHaveBeenCalledOnce();
  });

  it("floods originated packets to all transports", () => {
    const r = new MeshRouter({ selfId: "ME" });
    const a = mockTransport("a");
    const b = mockTransport("b");
    r.addTransport(a.t);
    r.addTransport(b.t);
    r.send({ id: "x1", to: "DST", kind: "msg", payload: { hello: 1 } });
    expect(a.broadcast).toHaveBeenCalledOnce();
    expect(b.broadcast).toHaveBeenCalledOnce();
  });

  it("caps relayed hops at MAX_HOPS", () => {
    const r = new MeshRouter({ selfId: "ME" });
    const a = mockTransport("a");
    const b = mockTransport("b");
    r.addTransport(a.t);
    r.addTransport(b.t);
    a.inject(pkt({ to: "OTHER", ttl: 30 }));
    expect(b.broadcast.mock.calls[0][0].ttl).toBe(MAX_HOPS - 1);
  });

  it("rejects packets with a non-numeric timestamp", () => {
    const r = new MeshRouter({ selfId: "ME" });
    const deliver = vi.fn();
    r.onDeliver(deliver);
    const a = mockTransport("a");
    r.addTransport(a.t);
    a.inject({ ...pkt({ to: "ME" }), ts: undefined as unknown as number });
    expect(deliver).not.toHaveBeenCalled();
  });

  it("delivers and keeps relaying subscribed room packets", () => {
    const r = new MeshRouter({ selfId: "ME" });
    const deliver = vi.fn();
    r.onDeliver(deliver);
    r.subscribe("ROOM-x");
    const a = mockTransport("a");
    const b = mockTransport("b");
    r.addTransport(a.t);
    r.addTransport(b.t);
    a.inject(pkt({ to: "ROOM-x", ttl: 3 }));
    expect(deliver).toHaveBeenCalledOnce();
    expect(b.broadcast).toHaveBeenCalledOnce();
  });
});
