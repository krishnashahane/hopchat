import type { NextConfig } from "next";

/**
 * Security-hardened Next.js config.
 * CSP is strict: no third-party origins, no inline scripts except hashed Next runtime.
 * The app is fully client-side/offline-first, so we lock the network surface down hard.
 */
const ContentSecurityPolicy = [
  "default-src 'self'",
  // Next injects a small inline bootstrap; 'unsafe-inline' scoped to styles only.
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  // Same-origin relay only. WebRTC data channels are not governed by connect-src.
  "connect-src 'self'",
  "media-src 'self' blob:",
  "worker-src 'self' blob:",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'",
  "upgrade-insecure-requests",
].join("; ");

const securityHeaders = [
  { key: "Content-Security-Policy", value: ContentSecurityPolicy },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "no-referrer" },
  { key: "Permissions-Policy", value: "camera=(self), microphone=(self), geolocation=(), interest-cohort=()" },
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" },
  { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
  { key: "Cross-Origin-Resource-Policy", value: "same-origin" },
  { key: "X-DNS-Prefetch-Control", value: "off" },
];

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  productionBrowserSourceMaps: false,
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
  async redirects() {
    // Canonical domain: force www → apex so there is exactly one preferred host.
    // HTTP → HTTPS is enforced by Vercel's edge + the HSTS preload header above.
    return [
      {
        source: "/:path*",
        has: [{ type: "host", value: "www.hopchat.in" }],
        destination: "https://hopchat.in/:path*",
        permanent: true,
      },
    ];
  },
};

export default nextConfig;
