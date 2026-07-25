/** Shared domain types for HopChat. */

export interface Contact {
  address: string;
  fingerprint: string;
  /** Serialized public bundle (sign.kex.kem). */
  bundle: string;
  nickname: string;
  verified: boolean;
  addedAt: number;
}

export type MessageDirection = "in" | "out";
export type MessageStatus = "queued" | "sent" | "delivered" | "read" | "failed";

export interface ChatMessage {
  id: string;
  /** Peer address this message belongs to (the other party). */
  peer: string;
  direction: MessageDirection;
  body: string;
  createdAt: number;
  status: MessageStatus;
  /** Optional self-destruct timestamp (epoch ms). */
  expiresAt?: number;
}

/** Wire-format for a relayed mesh packet. Payload is an opaque sealed envelope. */
export interface MeshPacket {
  /** Packet id (also used for dedup across the mesh). */
  id: string;
  /** Destination address fingerprint (short). */
  to: string;
  /** Source address fingerprint (short). */
  from: string;
  /** Hop counter; decremented at each relay, dropped at 0. */
  ttl: number;
  /** Monotonic-ish timestamp for ordering + replay windows. */
  ts: number;
  kind: "msg" | "ack" | "presence";
  /** Opaque, end-to-end encrypted payload (SealedEnvelope JSON). */
  payload: unknown;
}

export interface PresenceInfo {
  address: string;
  nickname: string;
  lastSeen: number;
}
