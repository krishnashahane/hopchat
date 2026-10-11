import type { Metadata, Viewport } from "next";
import { headers } from "next/headers";
import "./globals.css";
import { ServiceWorker } from "@/components/ServiceWorker";

export const metadata: Metadata = {
  title: "HopChat — Encrypted Mesh Messaging",
  description:
    "Decentralized, offline-first, end-to-end encrypted messaging over a peer-to-peer mesh. No phone number. No account. No servers reading your messages.",
  applicationName: "HopChat",
  robots: { index: true, follow: true },
  authors: [{ name: "HopChat" }],
  metadataBase: new URL("https://hopchat.in"),
  openGraph: {
    title: "HopChat — Encrypted Mesh Messaging",
    description:
      "Peer-to-peer, post-quantum encrypted messaging that works without the internet.",
    type: "website",
    url: "https://hopchat.in",
  },
};

export const viewport: Viewport = {
  themeColor: "#05070a",
  width: "device-width",
  initialScale: 1,
  // No maximumScale: pinch-zoom must stay available (WCAG 1.4.4); inputs are 16px on
  // phones so iOS doesn't auto-zoom on focus.
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // Reading the request makes the page dynamic so Next can stamp the CSP nonce
  // from proxy.ts onto its scripts.
  await headers();
  return (
    <html lang="en">
      <body>
        {children}
        <ServiceWorker />
      </body>
    </html>
  );
}
