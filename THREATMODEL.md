# HopChat Threat Model

This document records assets, adversaries, mitigations, and residual risks for the
current implementation. Read it alongside [`SECURITY.md`](./SECURITY.md),
[`ARCHITECTURE.md`](./ARCHITECTURE.md), and [`PROTOCOL.md`](./PROTOCOL.md).

## Assets

- **A1 Message content** — plaintext conversation history and in-flight messages.
- **A2 Identity secret keys** — Ed25519/X25519/ML-KEM private keys.
- **A3 Session state** — Double Ratchet root, chain, skipped-message, and DH keys.
- **A4 Social graph and metadata** — who communicates with whom, when, and how often.
- **A5 Availability** — ability to exchange and deliver packets.

## Adversaries

- **AD1 Network observer or relay** — observes or forwards traffic.
- **AD2 Active relay** — drops, reorders, replays, injects, or floods packets.
- **AD3 Future quantum adversary** — records ciphertext for possible later analysis.
- **AD4 Device thief** — obtains local device or browser data.
- **AD5 Endpoint malware** — executes with access to an unlocked client.

## Threats and mitigations

| # | Threat | Mitigation in the current design | Status |
| --- | --- | --- | --- |
| T1 | Read message content in transit | Encrypted message payloads; relay stores opaque packets | Designed, not independently audited |
| T2 | Alter encrypted message contents | AES-GCM authentication and ratchet-derived keys | Designed, not independently audited |
| T3 | Impersonate a contact | Public-key identity/address and optional out-of-band fingerprint verification | Partial; contact verification is a user action |
| T4 | Replay packets | Router deduplication, timestamp window, ratchet state | Partial; relay may still replay or drop traffic |
| T5 | Future quantum attacks | X25519 and ML-KEM-768 are combined in the key agreement path | Unverified protocol claim; no independent review |
| T6 | Recover prior plaintext after device compromise | Ratchet message keys advance and are not retained after normal use | Partial; local message history is stored as plaintext in IndexedDB |
| T7 | Continue reading after a key compromise | DH ratchet steps derive fresh root/chain material | Unverified protocol claim; no independent review |
| T8 | Read identity/session secrets from a stolen device | Optional passphrase-protected identity vault | Partial; device-key mode is weak and session state is stored unencrypted |
| T9 | Exhaust memory using skipped keys | Skipped-message storage is bounded | Partial; resource exhaustion is not eliminated |
| T10 | Browser injection or XSS | CSP, React escaping, framing restrictions | Partial; CSP permits inline scripts |
| T11 | Clickjacking | `frame-ancestors 'none'` and `X-Frame-Options: DENY` | Mitigated by response headers |
| T12 | Traffic analysis of social graph | Payload encryption | Not mitigated; routing addresses are visible |
| T13 | Relay flooding or service disruption | Request rate limits, bounded inbox, TTL, atomic drain | Partial; distributed DoS remains possible |

## Residual risks

- **Local data at rest:** Message bodies and serialized ratchet keys in IndexedDB are
  not encrypted. Anyone who can read the browser database may recover them.
- **Weak device mode:** The no-passphrase vault key depends on browser/device
  attributes, not a hardware-backed secret.
- **Metadata privacy:** Routing hints reveal sender and recipient addresses to relays.
  Sealed sender, cover traffic, and address rotation are not implemented.
- **Relay abuse:** Sending packets does not require sender authentication. Rate limits
  depend on Redis and a trusted deployment IP header; determined distributed abuse
  can still reduce availability.
- **Endpoint compromise:** Malware running within an unlocked client can access data
  available to that client.
- **Cryptographic assurance:** These are project-specific cryptographic compositions.
  Passing tests is not equivalent to a formal protocol review or independent audit.

## Verification process

Changes to `lib/crypto/**`, `lib/mesh/**`, or relay code should include focused
regression tests. CI runs the current unit/integration suite, TypeScript checks,
production build, and dependency audit on pull requests.
