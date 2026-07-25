# HopChat Protocol Specification (v1)

This is the wire and routing specification for the HopChat mesh. It is transport
independent: the same packet crosses WebRTC data channels, same-device broadcast
today, and Bluetooth LE / Wi-Fi Direct in native builds. Payloads are always
end-to-end sealed; relays are untrusted.

## 1. Layering

```
┌ Application   chat messages, acks, presence (Wire records)
├ Session       Double Ratchet over PQXDH handshake  (RatchetPacket)
├ Mesh          MeshPacket: addressing, TTL, dedup, flood routing
└ Transport     WebRTC · BroadcastChannel · (BLE/Wi-Fi Direct native)
```

Each layer depends only on the one below. The mesh layer treats the session
payload as opaque bytes; the session layer treats transport peers as opaque.

## 2. Mesh packet

```jsonc
MeshPacket {
  id:      string,   // UUID; dedup + replay identity
  to:      string,   // destination address (routing hint only)
  from:    string,   // source address (routing hint only)
  ttl:     number,   // hop budget, 1..32 (default 8)
  ts:      number,   // origin time (ms) — replay window
  kind:    "msg" | "ack" | "presence",
  payload: RatchetPacket   // opaque, end-to-end sealed
}
```

`to`/`from` are **hints**, not trust anchors: routing uses them, but confidentiality
and authenticity come entirely from the session layer. A forged `from` cannot forge
a message, because only the true peer's ratchet keys decrypt the payload.

## 3. Multi-hop routing — controlled flooding

HopChat v1 uses **controlled flooding with deduplication**, chosen over
table-driven routing because mesh peers are mobile and intermittently connected;
maintaining consistent routing tables across such a topology is fragile, whereas
flooding is self-healing and stateless.

On receiving a packet, a node runs:

```
if not valid(packet):            drop        // schema, TTL range, replay window
if seen(packet.id):              drop        // dedup — breaks loops
mark seen(packet.id)                          // bounded LRU (4096)
if packet.to == self:            deliver; stop
if packet.ttl > 1:               rebroadcast(packet with ttl-1) to all transports
                                              // except the one it arrived on
```

**Loop prevention** is guaranteed by two independent mechanisms:
1. **Dedup** — a packet id is processed at most once per node, so a packet cannot
   circulate.
2. **TTL** — every hop decrements TTL; at TTL 1 the packet is delivered/consumed but
   never rebroadcast, bounding propagation to ≤ TTL hops.

**Replay protection** — packets outside a ±5-minute window (`ts`) are rejected, and
the dedup set rejects re-injection of a captured packet id.

**Self-healing / dynamic node selection** — because every neighbour rebroadcasts,
the packet explores all paths simultaneously; if any multi-hop path to the
destination exists within TTL, delivery succeeds. No path state is kept, so link
churn requires no repair.

## 4. Transport layer & handoff

Transports implement one interface (`onPacket`, `broadcast`, `peers`, `close`) and
are registered with the router. Multiple run concurrently; the router floods across
all of them, so a packet can enter on WebRTC and leave on BLE — **automatic
transport bridging** with no extra logic.

| Transport | Discovery | Link | Status |
|---|---|---|---|
| WebRTC | out-of-band invite code (offer/answer SDP, ICE-complete) | ordered/reliable DataChannel | shipped |
| Local bus | `BroadcastChannel` presence ping | same-origin contexts | shipped |
| BLE mesh | GATT advertise/scan | notify characteristic, ~20-byte MTU → fragmentation | native roadmap |
| Wi-Fi Direct/Aware | service discovery | TCP/UDP socket, high bandwidth | native roadmap |
| Internet relay | rendezvous by address hash | store-and-forward, plaintext-blind | roadmap |

**Battery-aware / adaptive selection (native):** transports advertise a cost
(energy, bandwidth, latency); the router prefers the lowest-cost live transport for
origination while still accepting on all. On BLE, packets larger than the MTU are
fragmented with `(msgId, fragIndex, fragCount)` and reassembled before delivery.

## 5. Session handshake — PQXDH

Before the first message, the initiator runs a hybrid post-quantum handshake and
attaches the offer to outgoing packets until the session is confirmed (loss-tolerant).

```jsonc
HandshakeOffer {
  ek:    string,   // initiator ephemeral X25519 public key
  kemCt: string,   // ML-KEM-768 ciphertext encapsulated to responder
  ik:    string    // initiator full public bundle (sign.kex.kem)
}
```

Shared secret: `SK = HKDF( 0xFF^32 ‖ DH(EK_A,IK_B) ‖ DH(IK_A,IK_B) ‖ MLKEM.ss )`.
- `DH(EK_A,IK_B)` → forward secrecy · `DH(IK_A,IK_B)` → mutual authentication ·
  `MLKEM.ss` → post-quantum confidentiality.

**Glare** (both sides initiate at once) is resolved deterministically: the peer with
the lexicographically smaller address is the canonical initiator; the other adopts
the responder role. An established session ignores further offers, preventing
handshake-reset attacks.

## 6. Session payload — Double Ratchet

```jsonc
RatchetPacket {
  hs?: HandshakeOffer,        // present until the initiator's session is confirmed
  msg: {
    header: { dh: string, pn: number, n: number },  // ratchet pub, prev-chain len, msg num
    ct:     string,           // AES-256-GCM ciphertext+tag (AAD = header)
    nonce:  string            // 96-bit nonce
  }
}
```

Each message key is derived by the symmetric ratchet and deleted after use (forward
secrecy). A new ratchet public key triggers a DH ratchet step, healing the session
after any key compromise (post-compromise security). Skipped keys (≤256) are cached
for out-of-order delivery. See `SECURITY.md` for the full cryptographic argument.

## 7. Application records (`Wire`, inside the ratchet)

```jsonc
{ t: "msg", id, body, ts, ex? }               // ex = self-destruct epoch ms
{ t: "ack", id, status: "delivered"|"read" }  // receipt, propagated back over the mesh
```

## 8. Local-first data model & conflict resolution

State is local-first; there is no authoritative server. Records are immutable and
keyed by content id.
- **Messages** are append-only, ordered by `(ts, id)`; identical ids dedup.
- **Edits/deletions** (roadmap) are modeled as a CRDT: a per-message
  last-writer-wins register keyed by an HLC (hybrid logical clock) so concurrent
  edits across devices converge deterministically; a deletion is a tombstone that
  dominates edits. This choice keeps merge O(1) per record and needs no coordination.
- **Sessions** persist their serialized ratchet after every send/receive so a reload
  or crash resumes mid-conversation.
```
