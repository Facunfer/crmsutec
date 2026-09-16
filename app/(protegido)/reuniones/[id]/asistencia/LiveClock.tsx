"use client";

import { useEffect, useState } from "react";

export function LiveClock() {
  const [now, setNow] = useState<Date | null>(null);

  useEffect(() => {
    setNow(new Date());
    const interval = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(interval);
  }, []);

  return (
    <p className="text-center text-2xl font-semibold tabular-nums text-brand-900">
      {now
        ? new Intl.DateTimeFormat("es-AR", { timeStyle: "medium", timeZone: "America/Argentina/Buenos_Aires" }).format(now)
        : "—"}
    </p>
  );
}
