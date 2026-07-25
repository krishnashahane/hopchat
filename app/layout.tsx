import type { Metadata, Viewport } from "next";
import "./globals.css";

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
  maximumScale: 1,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
