# HopChat

**Decentralized, offline-first, end-to-end encrypted mesh messaging.**
No phone number. No email. No account. No server that can read your messages.

HopChat is a peer-to-peer messenger. Your identity is a set of cryptographic keys
generated on your device. Messages are sealed end-to-end with a **hybrid
post-quantum** scheme and hop across a self-healing mesh of nearby peers — over
WebRTC data channels and same-device broadcast today, with Bluetooth LE / Wi-Fi
Direct transports planned. Relays only ever see opaque ciphertext.

> Live: **https://hopchat.in**

---

## Why HopChat

- **Offline-first** — the mesh routes messages peer-to-peer; no central server is required to deliver a message.
- **Privacy-first** — no identifiers, no tracking, no ads. History is local-first (IndexedDB), never uploaded.
- **Post-quantum secure** — X25519 **+ ML-KEM-768** (NIST FIPS 203) hybrid key agreement, so messages stay confidential even against future quantum adversaries.
- **Forward secret** — every message uses a fresh ephemeral key.
- **Zero-trust transport** — relays cannot read, forge, or attribute messages; every envelope is signed (Ed25519) and AEAD-sealed (AES-256-GCM).

## Cryptography

| Purpose | Primitive |
|---|---|
| Identity / signatures | Ed25519 |
| Classical key agreement | X25519 (ECDH, ephemeral → forward secrecy) |
| Post-quantum KEM | ML-KEM-768 (FIPS 203) |
| Key derivation | HKDF-SHA-256 |
| Authenticated encryption | AES-256-GCM |
| At-rest vault | scrypt (N=2¹⁶) → AES-256-GCM |
| Address | Crockford-Base32 fingerprint of the public key bundle |

Per message the sender derives `HKDF(X25519(eph, recipient) ‖ ML-KEM.encaps(recipient))`,
AEAD-seals the plaintext (AAD binds both identities), and Ed25519-signs the transcript.
See [`ARCHITECTURE.md`](./ARCHITECTURE.md) and [`SECURITY.md`](./SECURITY.md).

## Mesh networking

A transport-agnostic `MeshRouter` performs controlled-flood multi-hop routing with
per-packet deduplication, TTL, and a replay window. Transports plug in behind a
uniform interface:

- **WebRTC** — direct P2P links, serverless invite-code (offer/answer) handshake.
- **Local bus** — instant same-origin/same-device mesh via `BroadcastChannel`.
- *(roadmap)* Bluetooth LE, Wi-Fi Direct, Wi-Fi Aware, internet relay.

Because payloads are end-to-end sealed, any peer can relay without learning content.

## Develop

```bash
npm install
npm run dev        # http://localhost:3000
npm run build      # production build
npm test           # crypto + mesh router unit tests
npm run typecheck  # strict TypeScript
```

## Project layout

```
app/                 Next.js App Router (client-only UI shell)
components/           Hacker-terminal UI (boot, sidebar, chat, modals)
lib/crypto/          identity · e2e (hybrid PQC) · vault · encoding
lib/mesh/            router · webrtc · localbus transports
lib/storage/         IndexedDB local-first persistence
lib/messenger.ts     application service (seal → route → open)
lib/hooks/useApp.tsx React state/context
```

## Security posture

- Strict Content-Security-Policy, HSTS, `frame-ancestors 'none'`, `Referrer-Policy: no-referrer`, no telemetry.
- No secrets in the repo; identity keys never leave the device.
- Dependencies pinned; `npm audit` clean (0 vulnerabilities).

Report vulnerabilities per [`SECURITY.md`](./SECURITY.md).

## License

MIT — see [`LICENSE`](./LICENSE).
