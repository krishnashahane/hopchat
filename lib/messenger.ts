/**
 * Messenger — application service binding identity, ratcheted crypto, mesh, storage.
 *
 * Every conversation runs a Double Ratchet session seeded by a hybrid post-quantum
 * handshake (PQXDH). The initiator attaches its handshake offer to outgoing packets
 * until the session is confirmed (surviving mesh packet loss). Relays only ever see
 * opaque ratchet ciphertext; the routing hints (to/from) are the only cleartext.
 */
import type { Identity } from "@/lib/crypto/identity";
import { decodePublicBundle, deriveAddress, fingerprintHex, encodePublicBundle } from "@/lib/crypto/identity";
import { initiateHandshake, respondHandshake, type HandshakeOffer } from "@/lib/crypto/handshake";
import { DoubleRatchet, type RatchetMessage } from "@/lib/crypto/ratchet";
import { utf8, fromUtf8 } from "@/lib/crypto/encoding";
import { MeshRouter } from "@/lib/mesh/router";
import { LocalBusTransport } from "@/lib/mesh/localbus";
import { WebRTCMeshTransport } from "@/lib/mesh/webrtc";
import { RelayTransport } from "@/lib/mesh/relay";
import type { Contact, ChatMessage, MeshPacket } from "@/lib/types";
import * as db from "@/lib/storage/db";

type Wire =
  | { t: "msg"; id: string; body: string; ts: number; ex?: number }
  | { t: "ack"; id: string; status: "delivered" | "read" };

interface RatchetPacket {
  hs?: HandshakeOffer;
  msg: RatchetMessage;
}

interface Session {
  peer: string;
  role: "initiator" | "responder";
  established: boolean;
  ratchet: DoubleRatchet;
  offer?: HandshakeOffer;
}

export type MessengerEvent =
  | { type: "message"; message: ChatMessage }
  | { type: "status"; message: ChatMessage }
  | { type: "contact"; contact: Contact }
  | { type: "peers"; count: number };

export class Messenger {
  private readonly router: MeshRouter;
  readonly webrtc: WebRTCMeshTransport;
  private readonly localbus: LocalBusTransport;
  private readonly relay: RelayTransport;
  private readonly listeners = new Set<(e: MessengerEvent) => void>();
  private readonly contacts = new Map<string, Contact>();
  private readonly sessions = new Map<string, Session>();

  constructor(private readonly identity: Identity) {
    this.router = new MeshRouter({ selfId: identity.address, defaultTtl: 8 });
    this.localbus = new LocalBusTransport(identity.address);
    this.webrtc = new WebRTCMeshTransport();
    this.relay = new RelayTransport(identity.address);
    const onLink = () => this.emit({ type: "peers", count: this.peerCount() });
    this.webrtc.onStatusChange(onLink);
    this.relay.onStatusChange(onLink);
    this.router.addTransport(this.localbus);
    this.router.addTransport(this.webrtc);
    this.router.addTransport(this.relay);
    this.router.onDeliver((p) => void this.handleDeliver(p));
    this.relay.start();
  }

  async load(): Promise<void> {
    for (const c of await db.listContacts()) this.contacts.set(c.address, c);
    for (const s of await db.loadSessions()) {
      this.sessions.set(s.peer, {
        peer: s.peer,
        role: s.role,
        established: s.established,
        ratchet: DoubleRatchet.deserialize(s.ratchet),
        offer: s.offer ? (JSON.parse(s.offer) as HandshakeOffer) : undefined,
      });
    }
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
    this.contacts.set(c.address, c);
  }

  private async persist(s: Session): Promise<void> {
    await db.saveSession({
      peer: s.peer,
      role: s.role,
      established: s.established,
      ratchet: s.ratchet.serialize(),
      offer: s.offer ? JSON.stringify(s.offer) : undefined,
    });
  }

  private senderSession(contact: Contact): Session {
    const existing = this.sessions.get(contact.address);
    if (existing) return existing;
    const bundle = decodePublicBundle(contact.bundle);
    const { sk, offer } = initiateHandshake(this.identity, bundle);
    const session: Session = {
      peer: contact.address,
      role: "initiator",
      established: false,
      ratchet: DoubleRatchet.initSender(sk, bundle.kex),
      offer,
    };
    this.sessions.set(contact.address, session);
    return session;
  }

  /** Encrypt and flood a chat message to a contact. */
  async sendMessage(contact: Contact, body: string, selfDestructMs?: number): Promise<ChatMessage> {
    const id = crypto.randomUUID();
    const now = Date.now();
    const expiresAt = selfDestructMs ? now + selfDestructMs : undefined;
    const wire: Wire = { t: "msg", id, body, ts: now, ex: expiresAt };

    const session = this.senderSession(contact);
    const msg = session.ratchet.encrypt(utf8(JSON.stringify(wire)));
    const packet: RatchetPacket = { msg, hs: session.established ? undefined : session.offer };
    await this.persist(session);

    const record: ChatMessage = { id, peer: contact.address, direction: "out", body, createdAt: now, status: "sent", expiresAt };
    await db.addMessage(record);
    this.router.send({ id, to: contact.address, kind: "msg", payload: packet });
    return record;
  }

  private async resolveSession(from: string, hs?: HandshakeOffer): Promise<Session | null> {
    const existing = this.sessions.get(from);
    if (!hs) return existing ?? null;

    // Adopt a responder session from the handshake when we have none, or when a
    // simultaneous-initiation (glare) tie-break makes the peer the canonical initiator.
    const glareYield =
      existing?.role === "initiator" && !existing.established && from < this.identity.address;
    if (existing && !glareYield) return existing;

    const peerBundle = decodePublicBundle(hs.ik);
    const peerAddr = deriveAddress(peerBundle);
    const sk = respondHandshake(this.identity, peerBundle, hs);
    const session: Session = {
      peer: peerAddr,
      role: "responder",
      established: true,
      ratchet: DoubleRatchet.initReceiver(sk, {
        sk: this.identity.secretKeys.kex,
        pk: this.identity.publicKeys.kex,
      }),
    };
    this.sessions.set(peerAddr, session);

    if (!this.contacts.has(peerAddr)) {
      const contact: Contact = {
        address: peerAddr,
        fingerprint: fingerprintHex(peerBundle),
        bundle: encodePublicBundle(peerBundle),
        nickname: peerAddr.replace("HOP-", "").slice(0, 9),
        verified: false,
        addedAt: Date.now(),
      };
      await db.upsertContact(contact);
      this.contacts.set(peerAddr, contact);
      this.emit({ type: "contact", contact });
    }
    return session;
  }

  private async handleDeliver(packet: MeshPacket): Promise<void> {
    const payload = packet.payload as RatchetPacket;
    if (!payload || typeof payload !== "object" || !payload.msg) return;

    let session: Session | null;
    try {
      session = await this.resolveSession(packet.from, payload.hs);
    } catch {
      return; // unresolvable handshake — drop.
    }
    if (!session) return;

    let wire: Wire;
    try {
      wire = JSON.parse(fromUtf8(session.ratchet.decrypt(payload.msg))) as Wire;
    } catch {
      return; // not for us, out-of-session, or tampered — drop.
    }

    if (session.role === "initiator" && !session.established) session.established = true;
    await this.persist(session);

    if (wire.t === "msg") {
      const record: ChatMessage = {
        id: wire.id,
        peer: session.peer,
        direction: "in",
        body: wire.body,
        createdAt: wire.ts,
        status: "delivered",
        expiresAt: wire.ex,
      };
      await db.addMessage(record);
      this.emit({ type: "message", message: record });

      const contact = this.contacts.get(session.peer);
      if (contact) {
        const ack: Wire = { t: "ack", id: wire.id, status: "delivered" };
        const ackMsg = session.ratchet.encrypt(utf8(JSON.stringify(ack)));
        await this.persist(session);
        this.router.send({ id: crypto.randomUUID(), to: session.peer, kind: "ack", payload: { msg: ackMsg } });
      }
    } else if (wire.t === "ack") {
      const list = await db.listMessages(session.peer);
      const msg = list.find((m) => m.id === wire.id);
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
