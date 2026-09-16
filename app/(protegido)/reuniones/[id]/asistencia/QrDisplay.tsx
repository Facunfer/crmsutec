"use client";

import { useEffect, useState } from "react";
import { QRCodeSVG } from "qrcode.react";

interface QrResponse {
  token: string;
  mode: "static" | "rotating";
  expiresAt: string;
}

export function QrDisplay({ meetingId }: { meetingId: string }) {
  const [qr, setQr] = useState<QrResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [origin, setOrigin] = useState("");

  useEffect(() => {
    setOrigin(window.location.origin);
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function fetchToken() {
      try {
        const res = await fetch(`/api/reuniones/${meetingId}/qr`, { cache: "no-store" });
        if (!res.ok) throw new Error();
        const data: QrResponse = await res.json();
        if (!cancelled) {
          setQr(data);
          setError(null);
        }
      } catch {
        if (!cancelled) setError("No se pudo actualizar el código QR.");
      }
    }

    fetchToken();
    const interval = setInterval(fetchToken, 20_000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [meetingId]);

  const checkinUrl = qr && origin ? `${origin}/reunion/checkin/${qr.token}` : null;

  return (
    <div className="flex flex-col items-center gap-3">
      {checkinUrl ? (
        <div className="rounded-lg border border-brand-100 bg-white p-4">
          <QRCodeSVG value={checkinUrl} size={260} />
        </div>
      ) : (
        <div className="flex h-[292px] w-[292px] items-center justify-center rounded-lg border border-brand-100 bg-white text-sm text-brand-400">
          Generando código...
        </div>
      )}
      {error ? <p className="text-xs text-estado-riesgo">{error}</p> : null}
      {checkinUrl ? (
        <p className="max-w-xs break-all text-center text-xs text-brand-400">
          Enlace de respaldo: <a href={checkinUrl} className="underline">{checkinUrl}</a>
        </p>
      ) : null}
    </div>
  );
}
