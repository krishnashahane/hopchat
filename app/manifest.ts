import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "HopChat — Encrypted Mesh Messaging",
    short_name: "HopChat",
    description:
      "Decentralized, offline-first, end-to-end encrypted mesh messaging. No phone number. No account. No servers.",
    start_url: "/",
    display: "standalone",
    background_color: "#05070a",
    theme_color: "#05070a",
    orientation: "portrait-primary",
    categories: ["communication", "social", "productivity"],
    icons: [
      { src: "/icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" },
      { src: "/icon.svg", sizes: "any", type: "image/svg+xml", purpose: "maskable" },
    ],
  };
}
