# HopChat Architecture

HopChat is built in clean, testable layers. Lower layers never depend on higher
ones; the UI depends on the service, the service on the mesh + crypto + storage,
and crypto/mesh have no app dependencies at all.

```
┌───────────────────────────────────────────────────────────┐
│ UI            app/ + components/ (hacker terminal, React)  │
├───────────────────────────────────────────────────────────┤
│ State         lib/hooks/useApp.tsx (context, lifecycle)    │
├───────────────────────────────────────────────────────────┤
│ Service       lib/messenger.ts (seal → route → open, acks) │
├─────────────────────────────┬─────────────────────────────┤
│ Mesh  lib/mesh/             │ Crypto  lib/crypto/          │
│  router (flood/TTL/dedup)   │  identity (Ed25519/X25519/   │
│  webrtc  · localbus         │           ML-KEM-768)        │
│                             │  e2e (hybrid seal/open)      │
│                             │  vault (scrypt at-rest)      │
├─────────────────────────────┴─────────────────────────────┤
│ Storage       lib/storage/db.ts (IndexedDB, local-first)   │
└───────────────────────────────────────────────────────────┘
```

## Message lifecycle

1. **Compose** → `Messenger.sendMessage` builds a `Wire` record `{t:"msg", id, body, ts}`.
2. **Seal** → `e2e.seal` derives a per-message key from ephemeral X25519 ECDH **and**
   an ML-KEM-768 encapsulation, AEAD-encrypts, and Ed25519-signs the transcript.
3. **Route** → the sealed envelope becomes a `MeshPacket`; `MeshRouter.send` floods
   it to every transport with a TTL.
4. **Relay** → each peer's router dedups by packet id, decrements TTL, and re-floods
   packets not addressed to it. Payloads stay opaque.
5. **Deliver** → the recipient's router hands the packet to `Messenger`, which
   `e2e.open`s it, verifies the signature, persists the message, and returns an
   encrypted delivery ack.

## Design decisions (ADRs, condensed)

- **Hybrid PQC over classical-only.** ML-KEM-768 is combined with X25519 so a break
  of *either* primitive (including a future quantum break of X25519) does not reveal
  plaintext. Cost is ~1 KB extra per message — acceptable.
- **Controlled flooding over table routing (v1).** With intermittent, mobile peers,
  maintaining routing tables is fragile. Bounded-TTL flooding with dedup is
  self-healing and needs no shared state. Route optimization is a later milestone.
- **Serverless WebRTC signaling.** Invite codes (ICE-complete SDP) remove the central
  signaling server, matching the "no server controls messages" principle. A future
  optional relay can automate discovery without weakening E2E.
- **Local-first storage.** All history lives in IndexedDB; there is no server copy.
  Identity secrets are only ever persisted inside an Argon2id (or non-extractable WebCrypto) AES-GCM vault.
- **Metadata.** Mesh peers see the `to`/`from` routing hints. Over the internet relay,
  direct packets are sealed-sender wrapped (relay sees only `to`) and room posts carry no
  sender hint. Cover traffic is tracked for a later milestone.

## Roadmap

- Double Ratchet for per-message ratcheting PFS + post-compromise security.
- Group chat via sender-keys; broadcast channels and communities.
- Additional transports: Bluetooth LE mesh, Wi-Fi Direct/Aware, optional internet relay.
- Cover traffic for metadata privacy.
- Voice/video over WebRTC media channels.
- On-device AI (summarize, translate, spam/scam detection).
