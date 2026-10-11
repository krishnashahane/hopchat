# HopChat Threat Model

A structured threat model for the HopChat mesh, following an assets → adversaries →
threats → mitigations → residual-risk shape. Read alongside `SECURITY.md` and
`PROTOCOL.md`.

## Assets

- **A1 Message content** — plaintext of one-to-one messages.
- **A2 Identity secret keys** — Ed25519/X25519/ML-KEM private keys on the device.
- **A3 Session state** — Double Ratchet keys (root/chain/message keys).
- **A4 Social graph & metadata** — who talks to whom, when, how often.
- **A5 Availability** — ability to deliver messages across the mesh.

## Adversaries

- **AD1 Passive network/relay** — a mesh node or on-path observer that reads/relays
  ciphertext but follows the protocol.
- **AD2 Active relay** — a malicious relay that drops, reorders, replays, injects, or
  forges packets.
- **AD3 Near-future quantum adversary** — records ciphertext now, decrypts later with
  a quantum computer (harvest-now-decrypt-later).
- **AD4 Device thief** — obtains the physical device (locked, app closed).
- **AD5 Endpoint malware** — code running on an unlocked device with app access.

## Threats & mitigations

| # | Threat | Adversary | Mitigation | Status |
|---|---|---|---|---|
| T1 | Read message content in transit | AD1, AD2 | E2E AES-256-GCM under Double-Ratchet keys; relays see only ciphertext | ✅ |
| T2 | Forge or alter a message | AD2 | AEAD integrity + session keys derived from an authenticated handshake `DH(IK_A,IK_B)`; forged `from` cannot decrypt/encrypt | ✅ |
| T3 | Impersonate a contact | AD2 | Identity = key fingerprint (`HOP-…` address); out-of-band fingerprint verification; handshake binds long-term identity keys | ✅ |
| T4 | Replay a captured packet | AD2 | Per-packet id dedup (LRU) + ±5-min `ts` replay window; ratchet message numbers reject duplicates | ✅ |
| T5 | Decrypt later with a quantum computer | AD3 | Hybrid ML-KEM-768 in the handshake KDF; secure unless **both** X25519 and ML-KEM break | ✅ |
| T6 | Recover past messages after key theft | AD4, AD5 | Per-message forward secrecy; message keys deleted after use | ✅ |
| T7 | Keep reading after a one-time key compromise | AD5 | Post-compromise security: DH ratchet step re-randomizes the root key | ✅ |
| T8 | Read secret keys off a stolen device | AD4 | Identity sealed at rest with Argon2id (19 MiB, t=2) + AES-256-GCM, or a non-extractable WebCrypto key; panic wipe (logo ×3) destroys it | ✅ |
| T9 | Handshake-reset / downgrade | AD2 | Established sessions ignore new offers; deterministic glare tie-break | ✅ |
| T10 | Exhaust memory via skipped-key flood | AD2 | Skipped keys bounded to 256; oversized skips rejected | ✅ |
| T11 | Web injection (XSS) exfiltrating keys | AD1 | Strict CSP (`default-src 'self'`, `object-src 'none'`), no third-party origins, no inline script beyond framework, React auto-escaping | ✅ |
| T12 | Clickjacking / framing | AD1 | `frame-ancestors 'none'`, `X-Frame-Options: DENY` | ✅ |
| T13 | Traffic-analysis of the social graph | AD1, AD2 | Relay: sealed sender (only `to` visible, 1 KiB padding), room posts carry no sender hint; mesh peers still see `to`/`from`; relay sees client IPs and timing — **partial** | ⚠️ |
| T14 | Availability / mesh DoS (flooding) | AD2 | TTL + dedup bound propagation; not eliminated | ⚠️ |

## STRIDE summary

| STRIDE | Where it bites HopChat | Control |
|---|---|---|
| **S**poofing | Fake sender / room author; draining someone's relay inbox; posting to a password room | Address = hash of key bundle; Double Ratchet session from authenticated handshake; room posts Ed25519-signed by author *and* by a room-key-derived write key the relay verifies; relay APIs need a fresh, single-use, scope-bound signature; safety numbers for out-of-band verification |
| **T**ampering | Altered or forged packets on a hop or at the relay | AES-256-GCM everywhere (room AAD = destination); ratchet decrypt is all-or-nothing, so forged packets cannot desync a session; handshake replays are remembered and ignored; router validates shape, TTL, timestamp |
| **R**epudiation | — (deniable by design for 1:1; room posts are signed) | Not a goal; no server logs of content |
| **I**nformation disclosure | Ciphertext at relays, data on disk, auth in URLs | E2E only; vault sealed with Argon2id or non-extractable WebCrypto key; messages/sessions/contacts/room keys sealed at rest; relay auth in headers, never URLs; SW never caches `/api/*` |
| **D**enial of service | Mesh flood, relay spam, file-transfer memory | 7-hop cap + dedup + replay window; relay rate limits and size caps; ≤8 pending transfers, chunk size checked |
| **E**levation of privilege | XSS stealing keys; hostile files | Nonce-based CSP with `'strict-dynamic'` (no inline script), `connect-src` limited to self + Nostr relays; incoming files that are not raster images are stored as `application/octet-stream` and only downloaded |

Location channels are public by design (bitchat-compatible): anyone subscribed to a
geohash cell reads its posts, and Nostr relays see the cell and your IP. They are opt-in
(`/geo`), and the per-cell Schnorr key keeps posts in different cells unlinkable.

Room confidentiality is only as strong as the room password: a room with no password
is public to anyone who knows its name, and Argon2id slows but cannot stop guessing a
weak password from captured ciphertext.

## Residual risk (explicitly out of scope for v1)

- **Metadata privacy (T13).** The internet relay sees only the recipient (sealed sender),
  plus client IPs and timing; direct mesh peers still see `to`/`from`. Push wake-ups reveal
  timing to the browser's push service (opt-in). Roadmap: cover traffic, address rotation,
  onion routing in the native client.
- **Malicious endpoint (AD5).** An unlocked, malware-infected device is game over for
  that device's messages — inherent to any messenger. Roadmap: secure-enclave /
  platform-keystore binding so keys are non-exportable, biometric unlock.
- **Denial of service (T14).** Bounded but not prevented; native builds add
  per-peer rate limiting and proof-of-relay backpressure.
- **Global passive adversary** correlating timing across the whole mesh is not
  defeated without cover traffic (roadmap).

## Verification & process

- Cryptographic primitives are the audited `@noble` implementations; no home-rolled
  primitives. Key generation uses the platform CSPRNG.
- Ratchet correctness (ping-pong, out-of-order, cross-ratchet skips, tamper,
  persistence) and mesh routing (dedup, TTL, replay) are covered by unit tests that
  run in CI on every commit.
- `npm audit` is kept at zero known vulnerabilities.
- Any change touching `lib/crypto/**` or `lib/mesh/**` requires a design note and
  test coverage before merge.
```
