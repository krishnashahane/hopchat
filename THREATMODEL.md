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
| T8 | Read secret keys off a stolen device | AD4 | Identity sealed at rest with scrypt(N=2¹⁶)+AES-256-GCM; passphrase never stored | ✅ |
| T9 | Handshake-reset / downgrade | AD2 | Established sessions ignore new offers; deterministic glare tie-break | ✅ |
| T10 | Exhaust memory via skipped-key flood | AD2 | Skipped keys bounded to 256; oversized skips rejected | ✅ |
| T11 | Web injection (XSS) exfiltrating keys | AD1 | Strict CSP (`default-src 'self'`, `object-src 'none'`), no third-party origins, no inline script beyond framework, React auto-escaping | ✅ |
| T12 | Clickjacking / framing | AD1 | `frame-ancestors 'none'`, `X-Frame-Options: DENY` | ✅ |
| T13 | Traffic-analysis of the social graph | AD1, AD2 | Content protected; `to`/`from` hints are cleartext — **partial** | ⚠️ |
| T14 | Availability / mesh DoS (flooding) | AD2 | TTL + dedup bound propagation; not eliminated | ⚠️ |

## Residual risk (explicitly out of scope for v1)

- **Metadata privacy (T13).** Routing hints reveal sender/recipient to relays.
  Roadmap: sealed-sender (encrypt `from`), constant-rate cover traffic, and address
  rotation for unlinkability.
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
