/**
 * Address ownership for relay APIs. The caller signs `hop-{scope}:{addr}:{ts}` with the
 * identity key whose public bundle hashes to `addr`. Headers, not URLs, carry the proof
 * so it never lands in access logs; each signature is accepted once.
 */
import { decodePublicBundle, deriveAddress } from "@/lib/crypto/identity";
import { verifyBytes } from "@/lib/crypto/e2e";
import { utf8, b64uDecode } from "@/lib/crypto/encoding";
import { claimOnce } from "@/lib/server/redis";

export const ADDR = /^HOP-[0-9A-Z-]{4,64}$/;
export const CLOCK_SKEW_MS = 60_000;

export type Scope = "poll" | "ice" | "push";

/** Signature-valid ownership of `addr` (no replay check). */
export function verifyOwnership(scope: Scope, addr: string, ts: string, sig: string, bundle: string): boolean {
  const t = Number(ts);
  if (!ADDR.test(addr) || !Number.isFinite(t) || Math.abs(Date.now() - t) > CLOCK_SKEW_MS) return false;
  try {
    const pub = decodePublicBundle(bundle);
    if (deriveAddress(pub) !== addr) return false;
    return verifyBytes(pub.sign, utf8(`hop-${scope}:${addr}:${ts}`), b64uDecode(sig));
  } catch {
    return false;
  }
}

export type Owner = { addr: string; sig: string };

/** Read and verify the signed headers; null when missing, invalid or stale. */
export function owner(req: Request, scope: Scope): Owner | null {
  const h = req.headers;
  const addr = h.get("x-hop-addr") ?? "";
  const sig = h.get("x-hop-sig") ?? "";
  const ok = verifyOwnership(scope, addr, h.get("x-hop-ts") ?? "", sig, h.get("x-hop-bundle") ?? "");
  return ok ? { addr, sig } : null;
}

/** Burn the signature so a captured request cannot be replayed inside the skew window. */
export const burn = (o: Owner): Promise<boolean> => claimOnce(o.sig, Math.ceil((2 * CLOCK_SKEW_MS) / 1000));
