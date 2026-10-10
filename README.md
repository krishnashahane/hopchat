# HopChat

**Offline-first, peer-to-peer messaging with end-to-end encryption.**

HopChat is an experimental messenger built around device-generated cryptographic identities. The web client supports encrypted messaging over a local same-origin bus and WebRTC peer connections. An optional internet relay can queue encrypted packets for offline recipients; it cannot decrypt their contents.

Live web app: https://hopchat.in

> **Security notice:** HopChat has not undergone an independent security audit. Do not rely on it for high-risk communications. Review [SECURITY.md](./SECURITY.md) and [THREATMODEL.md](./THREATMODEL.md) before using it for sensitive data. Local chat history and ratchet session state are currently stored in browser IndexedDB; do not assume that all local data is encrypted at rest.

## Features

- Device-generated identities without a phone number, email address, or account.
- End-to-end message encryption using Ed25519 signatures, X25519, ML-KEM-768, HKDF-SHA-256, and AES-256-GCM components.
- A transport-agnostic mesh router with packet deduplication, time checks, TTL limits, and WebRTC transport.
- Local-first contacts and conversation history in IndexedDB.
- Optional store-and-forward relay backed by Upstash Redis REST.
- Separate Swift/Xcode project under `hopchat-native/` for Apple platforms.

Bluetooth LE and Wi-Fi Direct are roadmap items, not transports currently provided by the web client. The `mobile/` directory is a minimal Expo starter rather than a complete mobile messaging client.

## Requirements

- Node.js 22 or newer recommended (Node.js 20+ is declared in `package.json`).
- npm.
- For the optional hosted relay: an Upstash Redis REST database.

## Run locally

From the repository root:

```bash
npm ci
npm run dev
```

Open http://localhost:3000.

Useful checks:

```bash
npm run typecheck
npm test
npm run build
npm audit --audit-level=high
```

The web TypeScript configuration intentionally excludes `mobile/`; install and run the Expo project independently from that directory. The Apple client has its own build instructions in [`hopchat-native/README.md`](./hopchat-native/README.md).

## Optional internet relay

Without Redis credentials, the relay API returns `503 relay_unconfigured`; local and direct peer-to-peer features can still be used where their transports are available.

Set **one** supported pair of environment variables in `.env.local` for local development, or in your deployment provider's secret/environment-variable settings:

```dotenv
KV_REST_API_URL=https://your-database.upstash.io
KV_REST_API_TOKEN=replace-with-your-secret-token
```

Alternatively, use `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN`. Never commit real tokens. Relay packets expire after 24 hours, and each recipient inbox is bounded to 500 queued packets. Requests are rate-limited; the limiter rejects traffic when Redis cannot enforce its limits.

## Project layout

```text
app/                  Next.js App Router UI and relay API
components/           Web interface components
lib/crypto/           Identity, encryption, vault, and ratchet code
lib/mesh/             Mesh router and WebRTC/local transports
lib/server/redis.ts   Upstash relay storage and rate limiting
lib/storage/          IndexedDB persistence
lib/messenger.ts      Messaging service
hopchat-native/       Separate Swift/Xcode Apple client
mobile/               Minimal Expo starter
```

## Cryptographic components

| Purpose | Primitive |
| --- | --- |
| Signatures and identity | Ed25519 |
| Classical key agreement | X25519 |
| Post-quantum KEM | ML-KEM-768 (FIPS 203) |
| Key derivation | HKDF-SHA-256 |
| Authenticated encryption | AES-256-GCM |
| Passphrase-protected identity vault | scrypt + AES-256-GCM |

These are the primitives used in the code, not a certification that the overall protocol is secure. JavaScript implementations are subject to runtime and side-channel limitations, and the protocol has not been independently audited. For the current security assumptions and residual risks, see [`SECURITY.md`](./SECURITY.md), [`THREATMODEL.md`](./THREATMODEL.md), [`ARCHITECTURE.md`](./ARCHITECTURE.md), and [`PROTOCOL.md`](./PROTOCOL.md).

## Contributing

Before submitting changes that affect `lib/crypto/`, `lib/mesh/`, or the relay, add focused regression tests and explain any protocol or security implications. CI runs type checking, tests, a production build, and an npm security audit.

## License

MIT. See [`LICENSE`](./LICENSE).
