import { NextResponse, type NextRequest } from "next/server";
import { NOSTR_RELAYS } from "@/lib/nostrRelays";

/**
 * Per-request nonce CSP. Scripts run only if they carry this request's nonce
 * ('strict-dynamic' extends trust to the chunks they load), so injected inline
 * script cannot execute. Inline style attributes are used across the UI, so
 * styles stay 'unsafe-inline' — they cannot run code.
 */
export function proxy(request: NextRequest) {
  const nonce = Buffer.from(crypto.randomUUID()).toString("base64");
  const dev = process.env.NODE_ENV === "development";
  const csp = [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${dev ? " 'unsafe-eval'" : ""}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    // Same-origin relay + bitchat's Nostr relays (opt-in /geo channels only).
    // WebRTC data channels are not governed by connect-src.
    `connect-src 'self' ${NOSTR_RELAYS.join(" ")}${dev ? " ws:" : ""}`,
    "media-src 'self' blob:",
    "worker-src 'self' blob:",
    "manifest-src 'self'",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "object-src 'none'",
    "upgrade-insecure-requests",
  ].join("; ");

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("Content-Security-Policy", csp);
  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set("Content-Security-Policy", csp);
  return response;
}

export const config = {
  matcher: [
    {
      source: "/((?!api|_next/static|_next/image).*)",
      missing: [
        { type: "header", key: "next-router-prefetch" },
        { type: "header", key: "purpose", value: "prefetch" },
      ],
    },
  ],
};
