import Link from "next/link";
import { notFound } from "next/navigation";
import { requirePermission } from "@/lib/auth/guard";
import { getCampaignById, listCampaignParticipants } from "@/lib/campaigns/queries";
import { CAMPAIGN_TYPE_LABEL, campaignDatesLabel, campaignStatusLabel, formatDay } from "@/lib/campaigns/labels";

const PAGE_SIZE = 50;

/** Detalle de campaña: datos, jornadas y personas (dentro del alcance del usuario). */
export default async function CampanaPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const actor = await requirePermission("meetings.view");
  const { id } = await params;
  const sp = await searchParams;

  const campaign = await getCampaignById(actor, id);
  if (!campaign) notFound();

  const page = sp.page ? Math.max(1, Number(sp.page) || 1) : 1;
  const search = sp.q?.trim() || undefined;
  const { rows, total } = await listCampaignParticipants(actor, id, { page, pageSize: PAGE_SIZE, search });
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const link = (p: number) => {
    const qs = new URLSearchParams();
    if (search) qs.set("q", search);
    if (p > 1) qs.set("page", String(p));
    const s = qs.toString();
    return `/reuniones/campanas/${id}${s ? `?${s}` : ""}`;
  };

  return (
    <div className="space-y-6">
      <div>
        <Link href="/reuniones" className="text-xs text-brand-500 hover:underline">
          ← Actividades
        </Link>
        <div className="mt-1 flex items-center gap-3">
          <h1 className="text-xl font-semibold text-brand-900">{campaign.name}</h1>
          <span className="rounded-full bg-brand-100 px-3 py-1 text-xs text-brand-700">{CAMPAIGN_TYPE_LABEL[campaign.type]}</span>
          <span className="rounded-full bg-brand-50 px-3 py-1 text-xs text-brand-700">
            {campaignStatusLabel(campaign)}
            {campaign.jornadasCount > 0 ? ` · ${campaign.jornadasCount} jornada${campaign.jornadasCount === 1 ? "" : "s"} registrada${campaign.jornadasCount === 1 ? "" : "s"}` : ""}
          </span>
        </div>
        <p className="mt-1 text-sm text-brand-400">
          {campaignDatesLabel(campaign)} · {campaign.jornadasCount} jornada{campaign.jornadasCount === 1 ? "" : "s"}
        </p>
      </div>

      <section className="rounded-lg bg-white p-4 shadow-sm">
        <h2 className="mb-3 text-sm font-semibold text-brand-900">Resumen (personas distintas, dentro de tu alcance)</h2>
        <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm sm:grid-cols-4">
          <div>
            <dt className="text-brand-400">Participantes registrados</dt>
            <dd className="text-lg font-semibold text-brand-900">{campaign.participatedCount}</dd>
          </div>
          <div>
            <dt className="text-brand-400">Inscriptas</dt>
            <dd className="text-lg font-semibold text-brand-900">{campaign.registeredCount}</dd>
          </div>
          <div>
            <dt className="text-brand-400">Invitaciones</dt>
            <dd className="text-sm text-brand-500">No disponible</dd>
          </div>
          <div>
            <dt className="text-brand-400">Asistencia presencial comprobada</dt>
            <dd className="text-sm text-brand-500">Sin información</dd>
          </div>
        </dl>
        <p className="mt-3 text-xs text-brand-400">
          Una persona se cuenta una sola vez aunque figure a nivel campaña y en una o más jornadas. «Participaron» e «Inscriptas» pueden solaparse: no se suman.
          Participar según la fuente no es asistir: la asistencia solo se registra por check-in real.
        </p>
      </section>

      <section className="rounded-lg bg-white p-4 shadow-sm">
        <h2 className="mb-3 text-sm font-semibold text-brand-900">Jornadas</h2>
        {campaign.jornadas.length === 0 ? (
          <p className="text-sm text-brand-400">Esta campaña no tiene jornadas asociadas (la participación se registra a nivel campaña).</p>
        ) : (
          <table className="min-w-full text-left text-sm">
            <thead>
              <tr className="border-b border-brand-100 text-xs uppercase tracking-wide text-brand-400">
                <th className="py-2 pr-4 font-medium">Jornada</th>
                <th className="py-2 pr-4 font-medium">Fecha</th>
                <th className="py-2 pr-4 font-medium">Personas en esta jornada</th>
              </tr>
            </thead>
            <tbody>
              {campaign.jornadas.map((j) => (
                <tr key={j.id} className="border-b border-brand-50">
                  <td className="py-1.5 pr-4">
                    <Link href={`/reuniones/${j.id}`} className="text-brand-700 hover:underline">
                      {j.name}
                    </Link>
                  </td>
                  <td className="py-1.5 pr-4">{j.day ? formatDay(j.day) : "Fecha no documentada"}</td>
                  <td className="py-1.5 pr-4">{j.participantsCount}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {campaign.jornadas.length > 0 ? (
          <p className="mt-2 text-xs text-brand-400">
            {campaign.campaignLevelOnlyCount} persona(s) participaron a nivel campaña sin jornada asignada: no se les atribuyó ninguna jornada ni fecha.
          </p>
        ) : null}
      </section>

      <section className="rounded-lg bg-white p-4 shadow-sm">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-sm font-semibold text-brand-900">Personas ({total})</h2>
          <form method="get" className="flex items-center gap-2">
            <input name="q" defaultValue={search ?? ""} placeholder="nombre, apellido o DNI" className="rounded-md border border-brand-200 px-2 py-1 text-sm" />
            <button type="submit" className="rounded-md bg-brand-600 px-3 py-1 text-sm text-white hover:bg-brand-700">
              Buscar
            </button>
          </form>
        </div>
        {rows.length === 0 ? (
          <p className="text-sm text-brand-400">Sin personas dentro de tu alcance{search ? " para esa búsqueda" : ""}.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full text-left text-sm">
              <thead>
                <tr className="border-b border-brand-100 text-xs uppercase tracking-wide text-brand-400">
                  <th className="py-2 pr-4 font-medium">Persona</th>
                  <th className="py-2 pr-4 font-medium">DNI</th>
                  <th className="py-2 pr-4 font-medium">Área</th>
                  <th className="py-2 pr-4 font-medium">Repartición</th>
                  <th className="py-2 pr-4 font-medium">Situación</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((p) => (
                  <tr key={p.personId} className="border-b border-brand-50">
                    <td className="py-1.5 pr-4">
                      <Link href={`/personas/${p.personId}`} className="text-brand-700 hover:underline">
                        {[p.lastName, p.firstName].filter(Boolean).join(", ")}
                      </Link>
                    </td>
                    <td className="py-1.5 pr-4">{p.dni ?? "—"}</td>
                    <td className="py-1.5 pr-4">{p.areaName ?? "—"}</td>
                    <td className="py-1.5 pr-4">{p.reparticionName ?? "—"}</td>
                    <td className="py-1.5 pr-4 text-xs text-brand-600">
                      {[p.participated ? "Participó" : null, p.registered ? "Inscripta" : null, p.inJornada ? "con jornada" : "sin jornada determinada"].filter(Boolean).join(" · ")}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {pages > 1 ? (
          <div className="mt-3 flex items-center gap-3 text-sm">
            {page > 1 ? (
              <Link href={link(page - 1)} className="text-brand-700 hover:underline">
                ← Anterior
              </Link>
            ) : null}
            <span className="text-brand-400">
              Página {page} de {pages}
            </span>
            {page < pages ? (
              <Link href={link(page + 1)} className="text-brand-700 hover:underline">
                Siguiente →
              </Link>
            ) : null}
          </div>
        ) : null}
      </section>
    </div>
  );
}
