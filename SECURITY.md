# Security Policy

## Reporting a vulnerability

Please report security issues privately. Open a GitHub security advisory, or email
the maintainer, with a description, reproduction steps, and impact. Do not open a
public issue for undisclosed vulnerabilities. We aim to acknowledge within 72 hours.

## Threat model

**In scope**
- Confidentiality, integrity, and authenticity of message content against network
  and relay-node adversaries (including malicious relays).
- Post-quantum confidentiality (harvest-now-decrypt-later).
- Forward secrecy across messages (ephemeral key agreement).
- At-rest protection of identity secret keys on the device.

**Explicitly out of scope (v1, documented in ARCHITECTURE.md)**
- Metadata unlinkability of sender/recipient (routing hints are cleartext for
  flooding). Sealed-sender and cover traffic are on the roadmap.
- A fully compromised endpoint (malware with the unlocked vault key).
- Denial of service via mesh flooding (bounded by TTL + dedup, not eliminated).

## Cryptographic design

| Property | Mechanism |
|---|---|
| Authenticity | Ed25519 signature over each envelope transcript |
| Confidentiality | AES-256-GCM under an HKDF-SHA-256 derived key |
| Key agreement | X25519 (ephemeral) **+** ML-KEM-768 (FIPS 203), combined in the KDF |
| Forward secrecy | fresh ephemeral X25519 key per message |
| Identity binding | AEAD AAD binds sender + recipient signing keys |
| At-rest | scrypt(N=2¹⁶, r=8, p=1) → AES-256-GCM vault |

Primitives come from the audited [`@noble`](https://paulmillr.com/noble/) libraries.
Keys are generated with the platform CSPRNG (`crypto.getRandomValues`) and never
leave the device.

## Transport & web hardening

- Strict Content-Security-Policy: `default-src 'self'`, no third-party origins,
  `object-src 'none'`, `frame-ancestors 'none'`, `base-uri 'self'`.
- HSTS (2 years, preload), `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`,
  `Referrer-Policy: no-referrer`, restrictive `Permissions-Policy`, `powered-by` removed.
- No analytics, telemetry, cookies, or third-party network calls.

## Supply chain

- Dependencies are pinned and `npm audit` is kept at **0 known vulnerabilities**
  (transitive `postcss`/`sharp` advisories are patched via `overrides`).
- CI should run `npm audit`, `npm run typecheck`, and `npm test` on every change.
