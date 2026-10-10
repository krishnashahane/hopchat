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

## Features

- **No registration** — no email, phone or account. Your identity is a keypair made on your device.
- **Multi-hop mesh** — packets are relayed peer-to-peer up to **7 hops**, deduplicated and replay-checked.
- **End-to-end encryption** — 1:1 chats use a post-quantum handshake + Double Ratchet; relays only see ciphertext.
- **IRC-style commands** — `/join #room [password]`, `/leave`, `/msg`, `/nick`, `/who`, `/clear`, `/panic`, `/help`.
- **Password-protected rooms** — room key = Argon2id(password, name); posts are signed by their author.
- **Panic mode** — tap the HOPCHAT logo 3 times to wipe keys, contacts, messages and caches instantly.
- **Works when the internet doesn't** — same-device and direct WebRTC links need no server; the optional
  internet relay bridges distant peers and can be switched off.

Bluetooth LE mesh (30–100 m, no network at all) needs native radio access that browsers don't expose; it
lives in the native iOS/macOS client in [`hopchat-native/`](./hopchat-native), which is wire-compatible with bitchat.

## Cryptography

| Purpose | Primitive |
|---|---|
| Identity / signatures | Ed25519 |
| Classical key agreement | X25519 (ECDH, ephemeral → forward secrecy) |
| Post-quantum KEM | ML-KEM-768 (FIPS 203) |
| Key derivation | HKDF-SHA-256 |
| Authenticated encryption | AES-256-GCM |
| At-rest vault | Argon2id → AES-256-GCM, or a non-extractable WebCrypto key |
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
- **Internet relay** — store-and-forward of sealed packets (Upstash Redis); user can switch it off.
- *(native client)* Bluetooth LE. *(roadmap)* Wi-Fi Direct, Wi-Fi Aware.

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
