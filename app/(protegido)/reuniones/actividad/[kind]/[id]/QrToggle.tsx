"use client";

import { useState } from "react";
import { QrDisplay } from "@/app/(protegido)/reuniones/[id]/asistencia/QrDisplay";

/**
 * Muestra el QR de una fecha SOLO cuando se pide: una campaña puede tener decenas de fechas y un QR rotativo se renueva cada pocos segundos,
 * así que no se montan todos a la vez. Mientras está oculto no se hace ningún pedido al servidor.
 */
export function QrToggle({ meetingId }: { meetingId: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button type="button" onClick={() => setOpen((v) => !v)} className="rounded-md border border-brand-300 px-3 py-1.5 text-xs text-brand-700 hover:bg-brand-50">
        {open ? "Ocultar QR" : "Mostrar QR"}
      </button>
      {open ? (
        <div className="mt-3">
          <QrDisplay meetingId={meetingId} />
        </div>
      ) : null}
    </div>
  );
}
