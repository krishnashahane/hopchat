import type { NextConfig } from "next";

/**
 * Security-hardened Next.js config. The page CSP is per-request (nonce) and set in
 * proxy.ts; API responses get a deny-all CSP here since they never render.
 */
const ApiCsp = "default-src 'none'; frame-ancestors 'none'";

const securityHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "no-referrer" },
  { key: "Permissions-Policy", value: "camera=(self), microphone=(self), geolocation=(self), interest-cohort=()" },
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
    return [
      { source: "/:path*", headers: securityHeaders },
      { source: "/api/:path*", headers: [{ key: "Content-Security-Policy", value: ApiCsp }] },
    ];
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
