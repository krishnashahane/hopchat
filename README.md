# HopChat

**Private, offline-first messaging over a peer-to-peer mesh.**

HopChat is an account-free messaging app with local-first storage, direct WebRTC connections, and an optional store-and-forward relay. The web client uses Next.js and TypeScript. A separate native iOS/macOS client lives in [`hopchat-native/`](./hopchat-native).

**Live web app:** [https://hopchat.in](https://hopchat.in)

> **Security note:** HopChat implements end-to-end encryption, but this repository has not had a full independent security audit. No implementation should be treated as invulnerable. Read [SECURITY.md](./SECURITY.md) and [THREATMODEL.md](./THREATMODEL.md) before using it for high-risk communications.

## Features

- **No account required.** Identity keys are generated on-device.
- **End-to-end encryption.** The web implementation uses a hybrid X25519 + ML-KEM-768 handshake, Ed25519 signatures, AES-GCM, and ratcheted 1:1 sessions.
- **Peer-to-peer mesh.** BroadcastChannel and WebRTC transports route packets through a bounded multi-hop mesh.
- **Optional internet relay.** A serverless API stores opaque packets in Upstash Redis for store-and-forward delivery. Relay-backed delivery requires configuration.
- **Rooms and file transfer.** Password-derived room keys, signed room posts, and bounded encrypted file transfers.
- **Safety numbers and encrypted backups.** Verify a contact out of band and export an encrypted backup for transfer to another device.
- **Optional Web Push.** Notifications are generic wake-ups; message content is not included in the push payload.
- **Local-first history.** IndexedDB stores conversations and contacts; sensitive fields are encrypted at rest.
- **Optional location channels.** `/geo` uses public Nostr relays. Posts are public and should not be treated as private messages.
- **Panic mode.** Removes local app data when explicitly triggered.
- **Native client.** Bluetooth LE mesh is implemented in `hopchat-native/`; ordinary browser JavaScript cannot access Bluetooth mesh APIs.

See [ARCHITECTURE.md](./ARCHITECTURE.md) and [PROTOCOL.md](./PROTOCOL.md) for implementation details.

## Requirements

- Node.js 24 or newer
- npm
- A modern browser; HTTPS is required for some production browser APIs

## Run locally

```bash
git clone https://github.com/krishnashahane/hopchat.git
cd hopchat
npm ci
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

## Verify before deploying

```bash
npm run typecheck
npm test
npm run build
npm audit --audit-level=high
```

Run all checks before release. Live-service integration tests are skipped unless their required environment variables are present.

## Optional services

Without Redis credentials, the app can still run with local and direct WebRTC transports, but relay-backed delivery and relay-dependent services are unavailable.

Create a local `.env.local` file (never commit it) or configure variables in the deployment provider:

| Variable | Purpose |
|---|---|
| `KV_REST_API_URL`, `KV_REST_API_TOKEN` | Upstash Redis REST for relay, replay protection, rate limits, and stored subscriptions |
| `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` | Optional Web Push notifications |
| `TURN_URLS`, `TURN_SECRET` | Optional short-lived TURN credentials, when using coturn REST authentication |
| `TURN_USERNAME`, `TURN_CREDENTIAL` | Alternative static TURN credentials where supported by the deployment configuration |

The legacy `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` environment names are also supported. Check `lib/server/` for the exact behaviour of optional services before enabling them.

Never store secrets in source files, commit environment files, or paste production credentials into issue reports. The root `.gitignore` excludes environment files.

## Production build and deployment

```bash
npm ci
npm run typecheck
npm test
npm run build
npm start
```

Use a host compatible with Next.js 16 and Node.js 24. Add service credentials through the host's secret/environment-variable controls. After deployment, verify the home page and the API routes that correspond to the features you enabled.

The web commands above do not build the native app. Follow [`hopchat-native/README.md`](./hopchat-native/README.md) for its separate toolchain and build/test instructions.

## Project layout

```
app/                 Next.js routes, metadata, and relay APIs
components/          Web UI components
lib/crypto/          Identity, handshake, encryption, ratchet, vault
lib/mesh/            Mesh router and WebRTC/local/relay transports
lib/server/          Relay and optional service helpers
lib/storage/         IndexedDB persistence and at-rest encryption
lib/messenger.ts     Application messaging service
public/              Icons, service worker, security.txt
hopchat-native/      Native iOS/macOS app and tests
mobile/              Separate React Native/Expo scaffold
```

## Security and privacy limits

- Encryption protects message content; it does not eliminate traffic analysis. Relays or peers may observe IP addresses, timing, or routing metadata.
- Relay delivery depends on deployment configuration, network access, and service availability.
- Location-channel posts are public to the selected Nostr relays.
- A compromised device/browser, malicious extension, weak passphrase, denial-of-service attack, or implementation defect can undermine security.
- Automated tests, dependency checks, and scanners reduce risk but do not prove that the system is secure.

Report vulnerabilities privately using [GitHub Security Advisories](https://github.com/krishnashahane/hopchat/security/advisories/new) or the process in [SECURITY.md](./SECURITY.md).

## License

The web project uses the [MIT License](./LICENSE). The native subtree has a separate license; read [`hopchat-native/LICENSE`](./hopchat-native/LICENSE) before redistributing that component.
