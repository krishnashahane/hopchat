import { describe, it, expect, vi, afterEach } from "vitest";
import { RelayTransport } from "./relay";
import { createIdentity } from "@/lib/crypto/identity";
import type { MeshPacket } from "@/lib/types";

const id = createIdentity();
const pkt = (n: number, size = 10): MeshPacket => ({ id: `p${n}`, to: "HOP-ABCD", from: id.address, ttl: 7, ts: Date.now(), kind: "msg", payload: "x".repeat(size) });

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("RelayTransport", () => {
  it("adopts the server clock after a rejected poll", async () => {
    vi.stubGlobal("window", {});
    const ahead = Date.now() + 10 * 60_000;
    const stamps: number[] = [];
    let t: RelayTransport | null = null;
    vi.stubGlobal("fetch", vi.fn(async (_u: string, init: RequestInit) => {
      stamps.push(Number((init.headers as Record<string, string>)["x-hop-ts"]));
      if (stamps.length === 1) return new Response("{}", { status: 401, headers: { date: new Date(ahead).toUTCString() } });
      t?.close();
      return new Response(JSON.stringify({ packets: [] }));
    }));
    vi.useFakeTimers();
    t = new RelayTransport(id);
    t.start();
    await vi.advanceTimersByTimeAsync(3_100);
    expect(stamps).toHaveLength(2);
    expect(Math.abs(stamps[1] - ahead)).toBeLessThan(5_000);
  });

  it("sends in order, text before bulk, and retries rate limits", async () => {
    vi.stubGlobal("window", {});
    const sent: string[] = [];
    let limited = true;
    vi.stubGlobal("fetch", vi.fn(async (_u: string, init: RequestInit) => {
      if (limited) {
        limited = false;
        return new Response("{}", { status: 429 });
      }
      sent.push((JSON.parse(JSON.parse(init.body as string).packet) as MeshPacket).id);
      return new Response("{}");
    }));
    vi.useFakeTimers();
    const t = new RelayTransport(id);
    t.broadcast(pkt(1, 10_000));
    t.broadcast(pkt(2, 10_000));
    t.broadcast(pkt(3));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(sent).toEqual(["p1", "p3", "p2"]);
  });

  it("seals direct packets so the relay never sees the sender", async () => {
    vi.stubGlobal("window", {});
    const bob = createIdentity();
    const bodies: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_u: string, init: RequestInit) => {
      bodies.push(init.body as string);
      return new Response("{}");
    }));
    vi.useFakeTimers();
    const t = new RelayTransport(id);
    t.setRecipientLookup((a) => (a === bob.address ? bob.publicKeys : undefined));
    t.broadcast({ ...pkt(1), to: bob.address });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).not.toContain(id.address);
    const { to, packet } = JSON.parse(bodies[0]);
    expect(to).toBe(bob.address);

    // Bob's transport unwraps it on receipt.
    const got: MeshPacket[] = [];
    let served = false;
    let rx: RelayTransport | null = null;
    vi.stubGlobal("fetch", vi.fn(async () => {
      if (served) rx?.close();
      served = true;
      return new Response(JSON.stringify({ packets: [packet] }));
    }));
    rx = new RelayTransport(bob);
    rx.onPacket((p) => got.push(p));
    rx.start();
    await vi.advanceTimersByTimeAsync(100);
    expect(got[0]?.from).toBe(id.address);
    expect(got[0]?.id).toBe("p1");
  });
});
