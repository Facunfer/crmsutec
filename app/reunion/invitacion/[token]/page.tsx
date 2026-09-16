import { headers } from "next/headers";
import { getInvitationByToken } from "@/lib/meetings/public";
import { ResponseButtons } from "./ResponseButtons";
import { CheckinButton } from "./CheckinButton";

export const metadata = { robots: "noindex, nofollow" };

function formatDateTime(date: Date): string {
  return new Intl.DateTimeFormat("es-AR", {
    dateStyle: "full",
    timeStyle: "short",
    timeZone: "America/Argentina/Buenos_Aires",
  }).format(date);
}

const MESSAGES: Record<string, string> = {
  invalid: "Este enlace no es válido. Si creés que es un error, pedile un enlace nuevo a quien te invitó.",
  rate_limited: "Demasiados intentos desde este lugar. Probá de nuevo en unos minutos.",
  cancelled: "Esta reunión fue cancelada.",
  finished: "Esta reunión ya terminó.",
};

export default async function InvitacionPublicaPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const hdrs = await headers();
  const ip = hdrs.get("x-forwarded-for")?.split(",")[0]?.trim() || "127.0.0.1";

  const view = await getInvitationByToken(token, ip);

  return (
    <main className="flex min-h-screen items-center justify-center bg-brand-50 px-4 py-8">
      <div className="w-full max-w-sm rounded-lg bg-white p-6 shadow-sm">
        {view.kind === "ok" ? (
          <>
            <h1 className="mb-1 text-lg font-semibold text-brand-900">{view.meetingName}</h1>
            <p className="mb-4 text-sm text-brand-500">Hola {view.firstName}, te invitamos a esta reunión.</p>
            <dl className="mb-6 space-y-1 text-sm text-brand-700">
              <div>
                <dt className="inline text-brand-400">Cuándo: </dt>
                <dd className="inline">{formatDateTime(view.startsAt)}</dd>
              </div>
              {view.locationName ? (
                <div>
                  <dt className="inline text-brand-400">Dónde: </dt>
                  <dd className="inline">{view.locationName}</dd>
                </div>
              ) : null}
              {view.address ? (
                <div>
                  <dt className="inline text-brand-400">Dirección: </dt>
                  <dd className="inline">{view.address}</dd>
                </div>
              ) : null}
            </dl>
            <ResponseButtons token={token} currentResponse={view.responseStatus} />
          </>
        ) : view.kind === "checkin" ? (
          <>
            <h1 className="mb-1 text-lg font-semibold text-brand-900">{view.meetingName}</h1>
            <p className="mb-4 text-sm text-brand-500">Hola {view.firstName}, esta reunión ya empezó.</p>
            <CheckinButton token={token} alreadyCheckedIn={view.alreadyCheckedIn} checkedInAt={view.checkedInAt?.toISOString() ?? null} />
          </>
        ) : (
          <p className="text-center text-sm text-brand-700">{MESSAGES[view.kind] ?? "No pudimos mostrar esta invitación."}</p>
        )}
      </div>
    </main>
  );
}
