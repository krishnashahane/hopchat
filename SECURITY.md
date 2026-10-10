# Security Policy

## Reporting a vulnerability

Please report security issues privately through a GitHub Security Advisory or by
contacting the maintainer. Include a description, reproduction steps, and impact.
Do not publish an undisclosed vulnerability in a public issue.

## Security status and important limitations

HopChat is an experimental project and has **not** received an independent security
audit. Passing CI or a dependency audit does not establish that the overall protocol
or implementation is secure. Do not rely on it for high-risk communications.

The current web client stores conversation message bodies and serialized Double
Ratchet session keys in browser IndexedDB. Those records are **not encrypted at
rest**. The identity vault supports a passphrase-derived key, but the optional
`device` mode derives a key from browser/device attributes and is not strong
protection against a determined local attacker. Do not treat the current web client
as providing comprehensive at-rest protection.

## Threat model

**In scope**
- Confidentiality and integrity of message contents in transit, subject to the
  correctness of the project-specific handshake and ratchet implementation.
- Malicious relay behavior such as dropping, delaying, or replaying opaque packets.
- Rate-limiting and bounded queue behavior for the optional internet relay.

**Known residual risks**
- Local browser history and ratchet session state are persisted without at-rest
  encryption.
- Sender/recipient addresses and routing metadata are visible to relays.
- The relay send endpoint accepts opaque packets without sender authentication;
  IP-based rate limiting and per-recipient queue caps reduce abuse but cannot
  eliminate distributed denial of service.
- The device-mode vault key is derived from browser/device attributes rather than
  protected by a hardware-backed secret.
- The cryptographic protocol and implementation have not been independently
  reviewed. JavaScript cryptographic code also has runtime and side-channel limits.
- A compromised or unlocked endpoint can expose messages and keys.

## Cryptographic components

| Property | Mechanism in code |
| --- | --- |
| Signatures | Ed25519 |
| Classical key agreement | X25519 |
| Post-quantum KEM | ML-KEM-768 (FIPS 203) |
| Key derivation | HKDF-SHA-256 |
| Authenticated encryption | AES-256-GCM |
| Passphrase-protected identity vault | scrypt (N=2¹⁶, r=8, p=1) + AES-256-GCM |

The web app uses implementations from the `@noble` libraries. This does not mean
that HopChat's protocol or specific composition has been independently audited.
Private identity material is intended to remain on the device, but sensitive ratchet
state and message history are currently stored in browser IndexedDB without
at-rest encryption.

## Transport and web hardening

The web configuration sends baseline security headers including a Content Security
Policy, HSTS, `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`,
`Referrer-Policy: no-referrer`, and a restrictive Permissions Policy. The current
CSP allows inline scripts for framework compatibility and should not be described as
a strict nonce-based CSP. WebRTC connectivity uses public Google STUN servers by
default. The app does not include analytics or advertising telemetry.

The optional relay stores opaque packets in Redis with a queue limit and expiry.
Inbox draining uses an atomic Redis operation so concurrent polling cannot delete
packets enqueued during a read. Rate limiting fails closed when Redis cannot enforce
a limit. These controls reduce some abuse modes but do not guarantee availability.

## Supply chain and verification

- The lockfile records resolved dependency versions; update dependencies deliberately
  and review release notes and security advisories.
- CI runs TypeScript checks, unit/integration tests, a production build, and
  `npm audit --audit-level=high`.
- Audit results describe known dependency advisories at the time CI runs; they do
  not prove the application is free of vulnerabilities.

## License

MIT. See [`LICENSE`](./LICENSE).
