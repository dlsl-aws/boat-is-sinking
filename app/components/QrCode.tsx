"use client";

import { useEffect, useState } from "react";
import QRCode from "qrcode";

/**
 * The join QR.
 *
 * Rendered white-on-transparent-white rather than the usual black-on-white
 * because the whole app is dark; a scanner needs the contrast, so the code
 * itself sits on a solid light tile.
 *
 * High error correction is deliberate — this gets photographed at an angle,
 * from the back of a room, off a projector that may be washing out.
 */
export function QrCode({ url, size = 320 }: { url: string; size?: number }) {
  const [dataUrl, setDataUrl] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void QRCode.toDataURL(url, {
      errorCorrectionLevel: "H",
      margin: 2,
      width: size * 2,
      color: { dark: "#04121f", light: "#ffffff" },
    }).then((value) => {
      if (!cancelled) setDataUrl(value);
    });
    return () => {
      cancelled = true;
    };
  }, [url, size]);

  if (!dataUrl) {
    return (
      <div
        className="animate-pulse rounded-2xl bg-white/10"
        style={{ width: size, height: size }}
      />
    );
  }

  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={dataUrl}
      alt={`QR code to join at ${url}`}
      width={size}
      height={size}
      className="rounded-2xl bg-white p-2"
    />
  );
}
