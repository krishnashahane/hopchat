# HopChat

**Private, offline-first messaging over a peer-to-peer mesh.**

HopChat is an account-free messaging app with local-first storage, direct WebRTC connections, and an optional store-and-forward relay. The web client is built with Next.js and TypeScript; a separate native iOS/macOS client lives in [`hopchat-native/`](./hopchat-native).

**Live web app:** [hopchat.in](https://hopchat.in)

> **Security note:** HopChat implements end-to-end encryption, but this repository has not had a full independent security audit. Do not treat any implementation as invulnerable. Review [SECURITY.md](./SECURITY.md) and [THREATMODEL.md](./THREATMODEL.md) before using it for high-risk communications.

## Features

- **No account required.** Identity keys are generated on-device.
- **End-to-end encryption.** The web implementation uses a hybrid X25519 and ML-KEM-768 handshake, Ed25519 signatures, AES-GCM, and ratcheted 1:1 sessions.
- **Peer-to-peer mesh.** Same-origin BroadcastChannel and WebRTC transports route packets through a bounded multi-hop mesh.
- **Optional internet relay.** A serverless API stores opaque packets in Upstash Redis to help deliver messages when peers are offline. Relay operation requires configuration.
- **Rooms and file transfer.** Password-derived room keys, signed room posts, and bounded encrypted file transfers.
- **Local-first history.** IndexedDB stores conversations and contacts; sensitive fields are encrypted at rest.
- **Optional location channels.** `/geo` uses public Nostr relays. These posts are public and should not be treated as private messages.
- **Panic mode.** Removes local application data when explicitly triggered.
- **Native client.** Bluetooth LE mesh features are in `hopchat-native/`; these are not available to ordinary browser JavaScript.

See [ARCHITECTURE.md](./ARCHITECTURE.md), [PROTOCOL.md](./PROTOCOL.md), [SECURITY.md](./SECURITY.md), and [THREATMODEL.md](./THREATMODEL.md) for implementation details and limitations.

## Requirements

- Node.js 24 or newer
- npm (the version bundled with your Node.js installation is recommended)
- An up-to-date desktop browser for development; HTTPS is required for several browser APIs in deployed environments

## Run locally

```bash
git clone https://github.com/krishnashahane/hopchat.git
cd hopchat
npm ci
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

### Verify before deploying

```bash
npm run typecheck
npm test
npm run build
npm audit --audit-level=high
```

All four commands should complete successfully before release. Tests requiring a live Redis instance may be skipped unless the relevant environment variables are present.

## Optional relay configuration

Without Redis credentials, the app can still run with local and direct WebRTC transports; relay-backed delivery is unavailable.

Configure these environment variables in your local untracked `.env.local` file or deployment provider:

| Variable | Purpose |
|---|---|
| `KV_REST_API_URL` | Upstash Redis REST endpoint |
| `KV_REST_API_TOKEN` | Upstash Redis REST token |

The legacy `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` names are also supported by the relay client.

Never commit real environment files, access tokens, private keys, or production credentials. The root `.gitignore` excludes environment files. For deployed configuration, use the provider's secret/environment-variable interface.

Other optional services may require additional environment variables; check the relevant source in `lib/server/` and the API routes before enabling them. Do not assume an optional service is configured merely because the UI exposes a control.

## Production build and deployment

```bash
npm ci
npm run typecheck
npm test
npm run build
npm start
```

Deploy the web app with a platform compatible with Next.js 16 and Node.js 24. Set required environment variables in the deployment environment, not in source control. After deployment, check the home page and relay endpoints in an environment with the expected service configuration.

The native app has its own toolchain and build instructions in [`hopchat-native/README.md`](./hopchat-native/README.md); web commands above do not build the native app.

## Project layout

```
app/                 Next.js routes, metadata, and relay API
components/          Web UI components
lib/crypto/          Identity, handshakes, encryption, ratchet, vault
lib/mesh/            Mesh router and WebRTC/local/relay transports
lib/server/          Server-side relay and service helpers
lib/storage/         IndexedDB persistence and at-rest encryption
lib/messenger.ts     Application messaging service
public/              Icons, service worker, security.txt
hopchat-native/      Native iOS/macOS application and tests
mobile/              Separate React Native/Expo scaffold
```

## Security and privacy

- Relay-backed messaging depends on server configuration and service availability.
- A relay may observe connection metadata such as IP address, timing, and destination information; encryption does not eliminate traffic analysis.
- Location-channel posts are public to the chosen Nostr relays.
- Device compromise, malicious browser extensions, weak passphrases, relay abuse, metadata leakage, and denial-of-service remain relevant risks.
- Automated tests and scanners are useful safeguards, not proof of security.

To report a vulnerability privately, follow [SECURITY.md](./SECURITY.md) or use [GitHub Security Advisories](https://github.com/krishnashahane/hopchat/security/advisories/new).

## License

The web project is licensed under the [MIT License](./LICENSE). The native subtree includes its own license file; consult [`hopchat-native/LICENSE`](./hopchat-native/LICENSE) before redistributing that component.
