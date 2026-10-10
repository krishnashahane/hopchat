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
| At-rest | Argon2id (m=19 MiB, t=2, p=1) → AES-256-GCM, or a non-extractable WebCrypto device key; legacy scrypt vaults are re-sealed on unlock |
| Rooms | Argon2id(password, H(name)) → AES-256-GCM; posts Ed25519-signed |
| Local data | AES-256-GCM per row (AAD = store + row id) under a random data key kept inside the vault |
| Location channels | Nostr kind-20000, BIP-340 Schnorr, per-geohash key derived from the identity; **public, not encrypted** |

Primitives come from the audited [`@noble`](https://paulmillr.com/noble/) libraries.
Keys are generated with the platform CSPRNG (`crypto.getRandomValues`) and never
leave the device.

## Transport & web hardening

- Strict Content-Security-Policy with a fresh per-request script nonce + `'strict-dynamic'`
  (no `'unsafe-inline'` scripts), `object-src 'none'`, `frame-ancestors 'none'`, `base-uri 'self'`.
  `connect-src` allows only this origin and bitchat's five Nostr relays (used only after `/geo`).
- HSTS (2 years, preload), `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`,
  `Referrer-Policy: no-referrer`, restrictive `Permissions-Policy`, `powered-by` removed.
- No analytics, telemetry, cookies, or third-party network calls.

## Panic mode

Tap the HOPCHAT logo three times (or type `/panic`). The app deletes the IndexedDB
database (keys, contacts, messages, rooms), localStorage, Cache Storage and the
service worker, then reloads empty. There is no confirmation by design.

## Supply chain

- Dependencies are pinned and `npm audit` is kept at **0 known vulnerabilities**
  (transitive `postcss`/`sharp` advisories are patched via `overrides`).
- CI runs gitleaks (secrets), type check, tests, build and `npm audit` on every push and PR;
  CodeQL (`security-extended`) runs on every push and weekly; Dependabot opens weekly
  dependency and Actions updates.
- Secrets (Upstash Redis token) live only in Vercel environment variables, never in git.

## Incident response

1. **Triage (≤24h):** reproduce, rate severity (CVSS), open a private GitHub advisory.
2. **Contain:** if the relay is implicated, disable it (`vercel env rm KV_REST_API_URL` →
   redeploy). Clients fall back to local mesh; no message content is at risk on the relay.
3. **Fix:** patch on a private branch, add a regression test, ship with `vercel --prod`.
   Critical fixes target 72h; bump the service-worker `VERSION` so clients refresh.
4. **Rotate:** rotate the Upstash token in the Vercel dashboard if it may have leaked.
5. **Disclose:** publish the advisory and credit the reporter.

## Not covered by this codebase

- **TLS 1.3:** terminated by Vercel's edge (TLS 1.2/1.3); HSTS preload is sent.
- **Passwords + MFA:** HopChat has no accounts, so there is nothing to log in to. The
  local passphrase uses Argon2id. Enable MFA on the GitHub, Vercel and GoDaddy accounts.
- **Pen test / bug bounty:** no paid third-party pen test or bounty programme yet. Automated
  checks run instead: OWASP ZAP baseline (weekly, `dast.yml`), uptime/TLS/header probe every 30
  minutes (`uptime.yml`), CodeQL, gitleaks. Reports: `/.well-known/security.txt` → GitHub advisories.
- **Signed commits:** commits in this repo are SSH-signed; `main` requires signed commits and passing CI.
- **Logging & alerts:** relay errors are logged as structured JSON (never packets or keys) to Vercel
  logs; failing uptime/DAST workflows email the repo owner.
