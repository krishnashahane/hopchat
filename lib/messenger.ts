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
import { MeshRouter, MAX_HOPS } from "@/lib/mesh/router";
import { sealPost, openPost, MAX_ROOM_BODY, type SealedPost } from "@/lib/crypto/room";
import { b64uDecode } from "@/lib/crypto/encoding";
import { LocalBusTransport } from "@/lib/mesh/localbus";
import { WebRTCMeshTransport } from "@/lib/mesh/webrtc";
import { RelayTransport } from "@/lib/mesh/relay";
import type { Contact, ChatMessage, MeshPacket } from "@/lib/types";
import * as db from "@/lib/storage/db";
import type { StoredRoom } from "@/lib/storage/db";
import {
  fileMeta,
  chunkBytes,
  encodeChunk,
  decodeChunk,
  TransferAssembler,
  MAX_FILE_SIZE,
  type FileMeta,
} from "@/lib/transfer";

/** Incoming files keep their type only if it is a raster image; all else downloads as bytes. */
const SAFE_IMAGE = /^image\/(png|jpeg|gif|webp|avif|bmp)$/;
const MAX_PENDING_TRANSFERS = 8;
/** Keeps a sealed message well under the relay's 64 KB packet cap, even for 4-byte UTF-8. */
export const MAX_BODY = 8_000;
/** Peer-chosen ids become storage keys, so they must look like ours (UUIDs). */
const MSG_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const validMsg = (w: { id: unknown; body: unknown; ts: unknown; ex?: unknown }): boolean =>
  typeof w.id === "string" &&
  MSG_ID.test(w.id) &&
  typeof w.body === "string" &&
  w.body.length <= MAX_BODY &&
  Number.isFinite(w.ts) &&
  (w.ex === undefined || Number.isFinite(w.ex));

interface JoinedRoom {
  name: string;
  key: Uint8Array;
}

type Wire =
  | { t: "msg"; id: string; body: string; ts: number; ex?: number }
  | { t: "ack"; id: string; status: "delivered" | "read" }
  | { t: "fmeta"; meta: FileMeta; ts: number }
  | { t: "fchunk"; id: string; i: number; data: string };

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
  | { type: "peers"; count: number }
  | { type: "net"; online: boolean }
  | { type: "room"; message: ChatMessage };

export class Messenger {
  private readonly router: MeshRouter;
  readonly webrtc: WebRTCMeshTransport;
  private readonly localbus: LocalBusTransport;
  private readonly relay: RelayTransport;
  private readonly listeners = new Set<(e: MessengerEvent) => void>();
  private readonly contacts = new Map<string, Contact>();
  private readonly sessions = new Map<string, Session>();
  private readonly assemblers = new Map<string, TransferAssembler>();
  private readonly rooms = new Map<string, JoinedRoom>();

  constructor(private readonly identity: Identity) {
    this.router = new MeshRouter({ selfId: identity.address, defaultTtl: MAX_HOPS });
    this.localbus = new LocalBusTransport(identity.address);
    this.webrtc = new WebRTCMeshTransport();
    this.relay = new RelayTransport(identity);
    this.webrtc.onStatusChange(() => this.emit({ type: "peers", count: this.peerCount() }));
    this.relay.onStatusChange((online) => this.emit({ type: "net", online }));
    this.router.addTransport(this.localbus);
    this.router.addTransport(this.webrtc);
    this.router.addTransport(this.relay);
    this.router.onDeliver((p) => void this.handleDeliver(p));
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
    // Start draining the relay only once sessions exist: a drained packet that
    // finds no session is dropped, and the relay will not resend it.
    this.relay.start();
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

  /** Toggle the internet-relay transport (user-controlled). */
  setRelayEnabled(on: boolean): void {
    this.relay.setEnabled(on);
    if (!on) this.emit({ type: "net", online: false });
  }

  isRelayEnabled(): boolean {
    return this.relay.isEnabled();
  }

  registerContact(c: Contact): void {
    this.contacts.set(c.address, c);
  }

  joinRoom(r: StoredRoom): void {
    this.rooms.set(r.dest, { name: r.name, key: b64uDecode(r.key) });
    this.router.subscribe(r.dest);
    this.relay.setRooms([...this.rooms.keys()]);
  }

  leaveRoom(dest: string): void {
    this.rooms.delete(dest);
    this.router.unsubscribe(dest);
    this.relay.setRooms([...this.rooms.keys()]);
  }

  /** Seal, sign, and flood a post to everyone in a room. */
  async sendRoom(dest: string, nick: string, body: string): Promise<ChatMessage> {
    const room = this.rooms.get(dest);
    if (!room) throw new Error("Not in that room");
    if (body.length > MAX_ROOM_BODY) throw new Error("Message too long");
    const id = crypto.randomUUID();
    const ts = Date.now();
    const sealed = sealPost(this.identity, room.key, dest, { id, ts, nick, body });
    const record: ChatMessage = {
      id,
      peer: room.name,
      direction: "out",
      body,
      createdAt: ts,
      status: "sent",
      author: { nick, address: this.identity.address },
    };
    await db.addMessage(record);
    this.router.send({ id, to: dest, kind: "room", payload: sealed });
    return record;
  }

  private async handleRoom(packet: MeshPacket): Promise<void> {
    const room = this.rooms.get(packet.to);
    if (!room) return;
    let post;
    try {
      post = openPost(room.key, packet.to, packet.payload as SealedPost);
    } catch {
      return; // wrong password, tampered, or forged — drop silently.
    }
    if (post.address === this.identity.address) return; // our own post echoed back
    if (!MSG_ID.test(post.id) || (await db.hasMessage(post.id))) return; // replay, or an id aimed at another row
    const record: ChatMessage = {
      id: post.id,
      peer: room.name,
      direction: "in",
      body: post.body,
      createdAt: post.ts,
      status: "delivered",
      author: { nick: post.nick, address: post.address },
    };
    await db.addMessage(record);
    this.emit({ type: "room", message: record });
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
    if (body.length > MAX_BODY) throw new Error(`Message too long (max ${MAX_BODY} characters)`);
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

  /** Encrypt one wire record for a contact and flood it as a mesh packet. */
  private emitRatchet(session: Session, to: string, wire: Wire): void {
    const msg = session.ratchet.encrypt(utf8(JSON.stringify(wire)));
    const packet: RatchetPacket = { msg, hs: session.established ? undefined : session.offer };
    this.router.send({ id: crypto.randomUUID(), to, kind: "msg", payload: packet });
  }

  /** Chunk, encrypt, and stream a file/image to a contact over the mesh. */
  async sendFile(contact: Contact, file: File): Promise<ChatMessage> {
    if (file.size > MAX_FILE_SIZE) throw new Error("File too large (max 8 MB).");
    const bytes = new Uint8Array(await file.arrayBuffer());
    const id = crypto.randomUUID();
    const now = Date.now();
    const meta = fileMeta(id, file.name, file.type, bytes.length);

    const session = this.senderSession(contact);
    this.emitRatchet(session, contact.address, { t: "fmeta", meta, ts: now });
    chunkBytes(bytes).forEach((c, i) =>
      this.emitRatchet(session, contact.address, { t: "fchunk", id, i, data: encodeChunk(c) }),
    );
    await this.persist(session);

    const record: ChatMessage = {
      id,
      peer: contact.address,
      direction: "out",
      body: file.name,
      createdAt: now,
      status: "sent",
      file: { name: meta.name, mime: meta.mime, size: meta.size },
      blob: file,
    };
    await db.addMessage(record);
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
    if (peerAddr !== from) return null; // routing hint must match the handshake identity
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
    if (packet.kind === "room") return this.handleRoom(packet);
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
      if (!validMsg(wire) || (await db.hasMessage(wire.id))) return;
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
    } else if (wire.t === "fmeta") {
      const m = wire.meta;
      const valid =
        typeof m?.id === "string" &&
        MSG_ID.test(m.id) &&
        Number.isInteger(m.size) && m.size >= 0 && m.size <= MAX_FILE_SIZE &&
        Number.isInteger(m.chunkSize) && m.chunkSize > 0 &&
        m.chunks === Math.max(1, Math.ceil(m.size / m.chunkSize));
      if (!valid || this.assemblers.size >= MAX_PENDING_TRANSFERS || (await db.hasMessage(m.id))) return;
      const meta: FileMeta = {
        ...m,
        name: String(m.name).replace(/[\/\\\u0000-\u001f]/g, "_").slice(0, 120) || "file",
        mime: SAFE_IMAGE.test(m.mime) ? m.mime : "application/octet-stream",
      };
      this.assemblers.set(`${session.peer}:${meta.id}`, new TransferAssembler(meta));
    } else if (wire.t === "fchunk") {
      const key = `${session.peer}:${wire.id}`;
      const asm = this.assemblers.get(key);
      if (!asm) return; // chunk arrived before its metadata — sender resends on retry
      const chunk = decodeChunk(wire.data);
      if (chunk.length > asm.meta.chunkSize) return;
      const complete = asm.add(wire.i, chunk);
      if (!complete) return;
      this.assemblers.delete(key);

      const bytes = asm.assemble();
      const blob = new Blob([bytes.buffer as ArrayBuffer], { type: asm.meta.mime });
      const record: ChatMessage = {
        id: asm.meta.id,
        peer: session.peer,
        direction: "in",
        body: asm.meta.name,
        createdAt: Date.now(),
        status: "delivered",
        file: { name: asm.meta.name, mime: asm.meta.mime, size: asm.meta.size },
        blob,
      };
      await db.addMessage(record);
      this.emit({ type: "message", message: record });

      const contact = this.contacts.get(session.peer);
      if (contact) {
        const ack: Wire = { t: "ack", id: asm.meta.id, status: "delivered" };
        const ackMsg = session.ratchet.encrypt(utf8(JSON.stringify(ack)));
        await this.persist(session);
        this.router.send({ id: crypto.randomUUID(), to: session.peer, kind: "ack", payload: { msg: ackMsg } });
      }
    }
  }

  destroy(): void {
    this.router.close();
  }
}
