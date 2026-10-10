import { describe, it, expect, vi } from "vitest";
import { MeshRouter } from "./router";
import { InMemoryBus, InMemoryTransport } from "./memory";
import { createIdentity, decodePublicBundle } from "@/lib/crypto/identity";
import { initiateHandshake, respondHandshake, type HandshakeOffer } from "@/lib/crypto/handshake";
import { DoubleRatchet, type RatchetMessage } from "@/lib/crypto/ratchet";
import { utf8, fromUtf8 } from "@/lib/crypto/encoding";
import type { MeshPacket } from "@/lib/types";

interface RatchetPacket {
  hs?: HandshakeOffer;
  msg: RatchetMessage;
}

/**
 * End-to-end mesh integration: a line topology  Alice — Relay — Bob.
 * Alice and Bob share NO transport; only the relay bridges the two buses, so any
 * delivery proves genuine multi-hop routing. The payload is sealed with the real
 * hybrid-PQ Double Ratchet, so the relay forwards bytes it cannot read.
 */
function buildMesh() {
  const alice = createIdentity();
  const relay = createIdentity();
  const bob = createIdentity();

  const busAR = new InMemoryBus(); // Alice ↔ Relay
  const busRB = new InMemoryBus(); // Relay ↔ Bob

  const aliceRouter = new MeshRouter({ selfId: alice.address });
  const relayRouter = new MeshRouter({ selfId: relay.address });
  const bobRouter = new MeshRouter({ selfId: bob.address });

  aliceRouter.addTransport(new InMemoryTransport(busAR, "ar"));
  relayRouter.addTransport(new InMemoryTransport(busAR, "ar"));
  relayRouter.addTransport(new InMemoryTransport(busRB, "rb"));
  bobRouter.addTransport(new InMemoryTransport(busRB, "rb"));

  const aliceInbox: MeshPacket[] = [];
  const relayInbox: MeshPacket[] = [];
  const bobInbox: MeshPacket[] = [];
  aliceRouter.onDeliver((p) => aliceInbox.push(p));
  relayRouter.onDeliver((p) => relayInbox.push(p));
  bobRouter.onDeliver((p) => bobInbox.push(p));

  return { alice, relay, bob, aliceRouter, bobRouter, aliceInbox, relayInbox, bobInbox };
}

describe("mesh integration: Alice → Relay → Bob (multi-hop, E2E)", () => {
  it("delivers an encrypted message across a relay that cannot read it", () => {
    const m = buildMesh();

    // Alice establishes a session to Bob and seals the message.
    const { sk, offer } = initiateHandshake(m.alice, m.bob.publicKeys);
    const ratchetA = DoubleRatchet.initSender(sk, m.bob.publicKeys.kex);
    const payload: RatchetPacket = { hs: offer, msg: ratchetA.encrypt(utf8("meet at the docks, 0300")) };

    m.aliceRouter.send({ id: "msg-1", to: m.bob.address, kind: "msg", payload });

    // Multi-hop delivery: Bob received it; the relay never delivered it to itself.
    expect(m.bobInbox).toHaveLength(1);
    expect(m.relayInbox).toHaveLength(0);

    // Bob decrypts successfully.
    const received = m.bobInbox[0].payload as RatchetPacket;
    const skB = respondHandshake(m.bob, decodePublicBundle(received.hs!.ik), received.hs!);
    const ratchetB = DoubleRatchet.initReceiver(skB, {
      sk: m.bob.secretKeys.kex,
      pk: m.bob.publicKeys.kex,
    });
    expect(fromUtf8(ratchetB.decrypt(received.msg))).toBe("meet at the docks, 0300");

    // The relay is cryptographically unable to read the payload: with its own keys,
    // the handshake yields a different secret and decryption fails.
    const skRelay = respondHandshake(m.relay, m.alice.publicKeys, received.hs!);
    const ratchetRelay = DoubleRatchet.initReceiver(skRelay, {
      sk: m.relay.secretKeys.kex,
      pk: m.relay.publicKeys.kex,
    });
    expect(() => ratchetRelay.decrypt(received.msg)).toThrow();

    // Delivery ack flows back Bob → Relay → Alice and Alice decrypts it.
    const ack: RatchetPacket = { msg: ratchetB.encrypt(utf8(JSON.stringify({ t: "ack", id: "msg-1" }))) };
    m.bobRouter.send({ id: "ack-1", to: m.alice.address, kind: "ack", payload: ack });

    expect(m.aliceInbox).toHaveLength(1);
    const ackPkt = m.aliceInbox[0].payload as RatchetPacket;
    expect(JSON.parse(fromUtf8(ratchetA.decrypt(ackPkt.msg)))).toEqual({ t: "ack", id: "msg-1" });
  });

  it("respects TTL: a 1-hop budget cannot cross the relay", () => {
    const m = buildMesh();
    const { sk, offer } = initiateHandshake(m.alice, m.bob.publicKeys);
    const ratchetA = DoubleRatchet.initSender(sk, m.bob.publicKeys.kex);
    const payload: RatchetPacket = { hs: offer, msg: ratchetA.encrypt(utf8("too far")) };

    // ttl=1 is consumed at the relay and never rebroadcast.
    m.aliceRouter.send({ id: "ttl-1", to: m.bob.address, kind: "msg", payload, ttl: 1 });
    expect(m.bobInbox).toHaveLength(0);
  });

  it("deduplicates a packet that reaches a node by two paths", () => {
    // Triangle: Alice connects to Bob both directly and via Relay.
    const alice = createIdentity();
    const relay = createIdentity();
    const bob = createIdentity();
    const busDirect = new InMemoryBus();
    const busVia1 = new InMemoryBus();
    const busVia2 = new InMemoryBus();

    const aliceR = new MeshRouter({ selfId: alice.address });
    const relayR = new MeshRouter({ selfId: relay.address });
    const bobR = new MeshRouter({ selfId: bob.address });

    aliceR.addTransport(new InMemoryTransport(busDirect, "d"));
    aliceR.addTransport(new InMemoryTransport(busVia1, "v1"));
    relayR.addTransport(new InMemoryTransport(busVia1, "v1"));
    relayR.addTransport(new InMemoryTransport(busVia2, "v2"));
    bobR.addTransport(new InMemoryTransport(busDirect, "d"));
    bobR.addTransport(new InMemoryTransport(busVia2, "v2"));

    const bobInbox: MeshPacket[] = [];
    bobR.onDeliver((p) => bobInbox.push(p));

    aliceR.send({ id: "dup-1", to: bob.address, kind: "msg", payload: { msg: {} } });

    // Reaches Bob directly AND via the relay, but is delivered exactly once.
    expect(bobInbox).toHaveLength(1);
  });
});
