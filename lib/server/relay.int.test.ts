/** Live relay test against Upstash. Runs only when KV_REST_API_URL is set (vercel env pull). */
import { describe, it, expect } from "vitest";
import { createIdentity, encodePublicBundle } from "@/lib/crypto/identity";
import { signBytes } from "@/lib/crypto/e2e";
import { utf8, b64uEncode } from "@/lib/crypto/encoding";
import { deriveRoom, sealPost } from "@/lib/crypto/room";

const live = Boolean(process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN);

describe.skipIf(!live)("relay route (live Redis)", async () => {
  const { GET, POST } = await import("@/app/api/relay/route");
  const id = createIdentity();
  const post = (to: string, packet: string) =>
    POST(new Request("http://x/api/relay", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ to, packet }) }));
  const signed = (ts = Date.now().toString()) => ({
    "x-hop-addr": id.address,
    "x-hop-ts": ts,
    "x-hop-sig": b64uEncode(signBytes(id, utf8(`hop-poll:${id.address}:${ts}`))),
    "x-hop-bundle": encodePublicBundle(id.publicKeys),
  });

  it("delivers inbox packets only to the signed owner, once", async () => {
    expect((await post(id.address, "p1")).status).toBe(200);
    expect((await post(id.address, "p2")).status).toBe(200);
    const headers = signed();
    const res = await GET(new Request("http://x/api/relay", { headers }));
    expect(res.status).toBe(200);
    expect((await res.json()).packets).toEqual(["p1", "p2"]);
    const replay = await GET(new Request("http://x/api/relay", { headers }));
    expect(replay.status).toBe(401);
    const forged = await GET(new Request("http://x/api/relay", { headers: { ...signed(), "x-hop-sig": b64uEncode(new Uint8Array(64)) } }));
    expect(forged.status).toBe(401);
  });

  it("keeps an ordered room log readable by cursor", async () => {
    const { key, dest: room } = await deriveRoom("#int-" + crypto.randomUUID().slice(0, 8), crypto.randomUUID());
    const roomPkt = (body: string) =>
      JSON.stringify({ id: body, to: room, from: "-", ttl: 7, ts: Date.now(), kind: "room", payload: sealPost(id, key, room, { id: body, ts: 1, nick: "t", body }) });
    const a = roomPkt("a");
    const b = roomPkt("b");
    expect((await post(room, a)).status).toBe(200);
    expect((await post(room, b)).status).toBe(200);
    const all = await (await GET(new Request(`http://x/api/relay?room=${room}&after=0`))).json();
    expect(all.packets.map((x: { p: string }) => x.p)).toEqual([a, b]);
    const after = await (await GET(new Request(`http://x/api/relay?room=${room}&after=${all.packets[0].s}`))).json();
    expect(after.packets.map((x: { p: string }) => x.p)).toEqual([b]);
    expect(after.head).toBe(all.packets[1].s);
    // Unsigned or wrongly-keyed posts are refused.
    expect((await post(room, "x")).status).toBe(403);
    const other = await deriveRoom("#int-other", "nope");
    const forged = JSON.stringify({ id: "f", to: room, from: "-", ttl: 7, ts: Date.now(), kind: "room", payload: sealPost(id, other.key, room, { id: "f", ts: 1, nick: "t", body: "f" }) });
    expect((await post(room, forged)).status).toBe(403);
  });

  it("rejects malformed input", async () => {
    expect((await post("not-an-addr", "x")).status).toBe(400);
    expect((await GET(new Request("http://x/api/relay?room=evil"))).status).toBe(400);
  });
});
