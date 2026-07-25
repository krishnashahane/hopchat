/**
 * Messenger — application service binding identity, crypto, mesh and storage.
 *
 * Flow:
 *   send:    plaintext → seal (hybrid PQC E2E) → MeshPacket → flood over transports.
 *   receive: MeshPacket → open envelope → persist → emit → return delivery ack.
 *
 * Relays only ever see opaque sealed envelopes. Only endpoints hold the keys.
 */
import type { Identity } from "@/lib/crypto/identity";
import { decodePublicBundle } from "@/lib/crypto/identity";
import { seal, open, type SealedEnvelope } from "@/lib/crypto/e2e";
import { utf8, fromUtf8 } from "@/lib/crypto/encoding";
import { MeshRouter } from "@/lib/mesh/router";
import { LocalBusTransport } from "@/lib/mesh/localbus";
import { WebRTCMeshTransport } from "@/lib/mesh/webrtc";
import type { Contact, ChatMessage, MeshPacket } from "@/lib/types";
import * as db from "@/lib/storage/db";

type Wire =
  | { t: "msg"; id: string; body: string; ts: number; ex?: number }
  | { t: "ack"; id: string; status: "delivered" | "read" };

export type MessengerEvent =
  | { type: "message"; message: ChatMessage }
  | { type: "status"; message: ChatMessage }
  | { type: "peers"; count: number };

export class Messenger {
  private readonly router: MeshRouter;
  readonly webrtc: WebRTCMeshTransport;
  private readonly localbus: LocalBusTransport;
  private readonly listeners = new Set<(e: MessengerEvent) => void>();
  private readonly contactsByAddr = new Map<string, Contact>();

  constructor(private readonly identity: Identity) {
    this.router = new MeshRouter({ selfId: identity.address, defaultTtl: 8 });
    this.localbus = new LocalBusTransport(identity.address);
    this.webrtc = new WebRTCMeshTransport();
    this.webrtc.onStatusChange(() => this.emit({ type: "peers", count: this.peerCount() }));
    this.router.addTransport(this.localbus);
    this.router.addTransport(this.webrtc);
    this.router.onDeliver((p) => void this.handleDeliver(p));
  }

  async loadContacts(): Promise<void> {
    const list = await db.listContacts();
    for (const c of list) this.contactsByAddr.set(c.address, c);
  }

  subscribe(cb: (e: MessengerEvent) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  private emit(e: MessengerEvent): void {
    for (const l of this.listeners) l(e);
  }

  peerCount(): number {
    return this.router.peerCount();
  }

  registerContact(c: Contact): void {
    this.contactsByAddr.set(c.address, c);
  }

  /** Encrypt and flood a chat message to a contact. Persists an outbound record. */
  async sendMessage(contact: Contact, body: string, selfDestructMs?: number): Promise<ChatMessage> {
    const id = crypto.randomUUID();
    const now = Date.now();
    const expiresAt = selfDestructMs ? now + selfDestructMs : undefined;
    const wire: Wire = { t: "msg", id, body, ts: now, ex: expiresAt };

    const bundle = decodePublicBundle(contact.bundle);
    const envelope = seal(this.identity, bundle, utf8(JSON.stringify(wire)));

    const record: ChatMessage = {
      id,
      peer: contact.address,
      direction: "out",
      body,
      createdAt: now,
      status: "sent",
      expiresAt,
    };
    await db.addMessage(record);

    this.route(contact.address, "msg", envelope, id);
    return record;
  }

  private route(to: string, kind: MeshPacket["kind"], payload: SealedEnvelope, id?: string): void {
    this.router.send({ id: id ?? crypto.randomUUID(), to, kind, payload });
  }

  private async handleDeliver(packet: MeshPacket): Promise<void> {
    let opened: { wire: Wire; senderAddr: string };
    try {
      const env = packet.payload as SealedEnvelope;
      const { plaintext, senderSign } = open(this.identity, env);
      const wire = JSON.parse(fromUtf8(plaintext)) as Wire;
      opened = { wire, senderAddr: packet.from };
      // Bind the on-wire sender to a known contact's signing key when possible.
      const contact = this.contactsByAddr.get(packet.from);
      if (contact) {
        const known = decodePublicBundle(contact.bundle).sign;
        if (known.length !== senderSign.length || !known.every((b, i) => b === senderSign[i])) {
          return; // signing key does not match claimed contact — drop.
        }
      }
    } catch {
      return; // not for us, or tampered — silently drop.
    }

    const { wire, senderAddr } = opened;
    if (wire.t === "msg") {
      const record: ChatMessage = {
        id: wire.id,
        peer: senderAddr,
        direction: "in",
        body: wire.body,
        createdAt: wire.ts,
        status: "delivered",
        expiresAt: wire.ex,
      };
      await db.addMessage(record);
      this.emit({ type: "message", message: record });

      // Return a delivery ack (encrypted) if we know how to reach the sender.
      const contact = this.contactsByAddr.get(senderAddr);
      if (contact) {
        const ack: Wire = { t: "ack", id: wire.id, status: "delivered" };
        const env = seal(this.identity, decodePublicBundle(contact.bundle), utf8(JSON.stringify(ack)));
        this.route(senderAddr, "ack", env);
      }
    } else if (wire.t === "ack") {
      const existing = await db.listMessages(senderAddr);
      const msg = existing.find((m) => m.id === wire.id);
      if (msg && msg.status !== "read") {
        msg.status = wire.status;
        await db.updateMessage(msg);
        this.emit({ type: "status", message: msg });
      }
    }
  }

  destroy(): void {
    this.router.close();
  }
}
