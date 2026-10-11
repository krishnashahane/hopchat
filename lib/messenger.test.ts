/**
 * Two (then three) Messenger instances talking over the same-device bus, each with
 * its own in-memory store. Covers first contact, replies, and a peer that restores
 * its identity on a fresh device (no sessions) and must re-handshake.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { createIdentity, encodePublicBundle, type Identity } from "@/lib/crypto/identity";
import type { Contact, ChatMessage } from "@/lib/types";

function memoryDb() {
  const messages = new Map<string, ChatMessage>();
  const sessions = new Map<string, unknown>();
  const contacts = new Map<string, Contact>();
  return {
    listContacts: async () => [...contacts.values()],
    loadSessions: async () => [...sessions.values()],
    saveSession: async (s: { peer: string }) => void sessions.set(s.peer, structuredClone(s)),
    upsertContact: async (c: Contact) => void contacts.set(c.address, c),
    addMessage: async (m: ChatMessage) => void messages.set(m.id, m),
    updateMessage: async (m: ChatMessage) => void messages.set(m.id, m),
    hasMessage: async (id: string) => messages.has(id),
    listMessages: async (peer: string) => [...messages.values()].filter((m) => m.peer === peer),
    messages,
  };
}

async function node(id: Identity) {
  vi.resetModules();
  const store = memoryDb();
  vi.doMock("@/lib/storage/db", () => store);
  const { Messenger } = await import("@/lib/messenger");
  const m = new Messenger(id);
  await m.load();
  return { m, store };
}

const contactOf = (id: Identity): Contact => ({
  address: id.address,
  fingerprint: id.fingerprint,
  bundle: encodePublicBundle(id.publicKeys),
  nickname: "x",
  verified: false,
  addedAt: 0,
});

const inbox = (s: ReturnType<typeof memoryDb>, peer: string) =>
  [...s.messages.values()].filter((x) => x.peer === peer && x.direction === "in").map((x) => x.body);

const live: { destroy(): void }[] = [];
afterEach(() => {
  for (const m of live.splice(0)) m.destroy();
  vi.doUnmock("@/lib/storage/db");
});

describe("Messenger sessions", () => {
  it("delivers both ways and recovers after a peer restores on a new device", async () => {
    const aliceId = createIdentity();
    const bobId = createIdentity();
    const alice = await node(aliceId);
    const bob = await node(bobId);
    live.push(alice.m, bob.m);
    alice.m.registerContact(contactOf(bobId));

    await alice.m.sendMessage(contactOf(bobId), "hi bob");
    await vi.waitFor(() => expect(inbox(bob.store, aliceId.address)).toEqual(["hi bob"]));
    await bob.m.sendMessage(contactOf(aliceId), "hi alice");
    await vi.waitFor(() => expect(inbox(alice.store, bobId.address)).toEqual(["hi alice"]));

    // Alice moves to a new device: same identity, no sessions.
    alice.m.destroy();
    const alice2 = await node(aliceId);
    live.push(alice2.m);
    alice2.m.registerContact(contactOf(bobId));
    await alice2.m.greet(contactOf(bobId));
    await alice2.m.sendMessage(contactOf(bobId), "new phone");
    await vi.waitFor(() => expect(inbox(bob.store, aliceId.address)).toContain("new phone"));
    await bob.m.sendMessage(contactOf(aliceId), "got it");
    await vi.waitFor(() => expect(inbox(alice2.store, bobId.address)).toEqual(["got it"]));
  });

  it("ignores a replayed handshake after the session moved on", async () => {
    const tap = new BroadcastChannel("hopchat-mesh");
    const seen: Record<string, unknown>[] = [];
    tap.onmessage = (e) => seen.push(e.data);
    const aliceId = createIdentity();
    const bobId = createIdentity();
    const alice = await node(aliceId);
    const bob = await node(bobId);
    live.push(alice.m, bob.m);
    alice.m.registerContact(contactOf(bobId));

    await alice.m.sendMessage(contactOf(bobId), "one");
    await vi.waitFor(() => expect(inbox(bob.store, aliceId.address)).toEqual(["one"]));
    await bob.m.sendMessage(contactOf(aliceId), "two");
    await vi.waitFor(() => expect(inbox(alice.store, bobId.address)).toEqual(["two"]));

    const first = seen.find((p) => p.from === aliceId.address && (p.payload as { hs?: unknown })?.hs);
    expect(first).toBeDefined();
    tap.postMessage({ ...first, id: "replay-1", ts: Date.now() });
    await new Promise((r) => setTimeout(r, 50));

    await alice.m.sendMessage(contactOf(bobId), "three");
    await vi.waitFor(() => expect(inbox(bob.store, aliceId.address)).toEqual(["one", "three"]));
    tap.close();
  });
});
