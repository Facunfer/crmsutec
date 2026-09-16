import type { Metadata } from "next";
import { cookies } from "next/headers";
import { getCheckinMeetingName } from "@/lib/attendance/checkin";
import { verifyCheckinSession } from "@/lib/attendance/session-tokens";
import { CHECKIN_SESSION_COOKIE } from "@/lib/attendance/constants";
import { IdentifyForm } from "./IdentifyForm";

export const metadata: Metadata = {
  title: "Acreditación",
  robots: { index: false, follow: false },
};

const ERROR_MESSAGES: Record<string, string> = {
  invalid: "Este código no es válido. Pedile a la mesa de acreditación que te muestre el QR actual.",
  expired: "Este código ya venció. Escaneá el QR que está en pantalla ahora.",
  cancelled: "Esta reunión fue cancelada.",
  not_active: "La acreditación para esta reunión no está abierta en este momento.",
  rate_limited: "Demasiados intentos. Esperá un momento y volvé a escanear el QR.",
};

export default async function CheckinPage({
  searchParams,
}: {
  searchParams: Promise<{ e?: string }>;
}) {
  const { e } = await searchParams;
  const store = await cookies();
  const token = store.get(CHECKIN_SESSION_COOKIE)?.value;
  const session = token ? verifyCheckinSession(token) : null;

  if (!session) {
    const message = (e && ERROR_MESSAGES[e]) || "Escaneá el código QR que está en pantalla para acreditarte.";
    return (
      <main className="mx-auto flex min-h-screen max-w-sm flex-col items-center justify-center gap-4 px-4 text-center">
        <p className="text-base text-brand-700">{message}</p>
      </main>
    );
  }

  const meetingName = await getCheckinMeetingName(session.m);
  if (!meetingName) {
    return (
      <main className="mx-auto flex min-h-screen max-w-sm flex-col items-center justify-center gap-4 px-4 text-center">
        <p className="text-base text-brand-700">Esta reunión ya no está disponible.</p>
      </main>
    );
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center gap-6 px-4 py-8">
      <h1 className="text-center text-lg font-semibold text-brand-900">Acreditación</h1>
      <IdentifyForm meetingName={meetingName} />
    </main>
  );
}
