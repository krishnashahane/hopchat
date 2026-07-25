"use client";

import { useEffect, useState } from "react";
import QRCode from "qrcode";

export function QR({ data, size = 180 }: { data: string; size?: number }) {
  const [url, setUrl] = useState<string | null>(null);
  const [tooLong, setTooLong] = useState(false);

  useEffect(() => {
    let active = true;
    setTooLong(false);
    QRCode.toDataURL(data, {
      errorCorrectionLevel: "M",
      margin: 1,
      width: size,
      color: { dark: "#00ff9c", light: "#05070a" },
    })
      .then((u) => active && setUrl(u))
      .catch(() => active && setTooLong(true));
    return () => {
      active = false;
    };
  }, [data, size]);

  if (tooLong)
    return (
      <div
        className="panel flex items-center justify-center text-center p-3"
        style={{ width: size, height: size, color: "var(--fg-dim)", fontSize: 11 }}
      >
        payload too large for QR — use the code
      </div>
    );

  return url ? (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      alt="QR code"
      src={url}
      width={size}
      height={size}
      style={{ imageRendering: "pixelated", border: "1px solid var(--line)" }}
    />
  ) : (
    <div className="panel" style={{ width: size, height: size }} />
  );
}
