import { requirePermission } from "@/lib/auth/guard";
import { getDb } from "@/lib/db/client";

export default async function DashboardPage() {
  await requirePermission("dashboard.view");

  const db = await getDb();
  const { count: userCount } = await db
    .selectFrom("users")
    .select(({ fn }) => fn.count<number>("id").as("count"))
    .executeTakeFirstOrThrow();
  const { count: peopleCount } = await db
    .selectFrom("people")
    .select(({ fn }) => fn.count<number>("id").as("count"))
    .executeTakeFirstOrThrow();
  const { count: associationCount } = await db
    .selectFrom("associations")
    .select(({ fn }) => fn.count<number>("id").as("count"))
    .executeTakeFirstOrThrow();
  const { count: meetingCount } = await db
    .selectFrom("meetings")
    .select(({ fn }) => fn.count<number>("id").as("count"))
    .executeTakeFirstOrThrow();
  const { count: invitedCount } = await db
    .selectFrom("meeting_invitations")
    .select(({ fn }) => fn.count<number>("id").as("count"))
    .where("withdrawn_at", "is", null)
    .executeTakeFirstOrThrow();
  const { count: confirmedCount } = await db
    .selectFrom("meeting_invitations")
    .select(({ fn }) => fn.count<number>("id").as("count"))
    .where("withdrawn_at", "is", null)
    .where("response_status", "=", "confirmed")
    .executeTakeFirstOrThrow();

  return (
    <div>
      <h1 className="mb-6 text-xl font-semibold text-brand-900">Dashboard</h1>
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        <div className="rounded-lg bg-white p-4 shadow-sm">
          <div className="text-2xl font-semibold text-brand-700">{userCount}</div>
          <div className="text-sm text-brand-500">Usuarios del sistema</div>
        </div>
        <div className="rounded-lg bg-white p-4 shadow-sm">
          <div className="text-2xl font-semibold text-brand-700">{peopleCount}</div>
          <div className="text-sm text-brand-500">Personas cargadas</div>
        </div>
        <div className="rounded-lg bg-white p-4 shadow-sm">
          <div className="text-2xl font-semibold text-brand-700">{associationCount}</div>
          <div className="text-sm text-brand-500">Asociaciones</div>
        </div>
        <div className="rounded-lg bg-white p-4 shadow-sm">
          <div className="text-2xl font-semibold text-brand-700">{meetingCount}</div>
          <div className="text-sm text-brand-500">Reuniones</div>
        </div>
        <div className="rounded-lg bg-white p-4 shadow-sm">
          <div className="text-2xl font-semibold text-brand-700">{invitedCount}</div>
          <div className="text-sm text-brand-500">Invitaciones vigentes</div>
        </div>
        <div className="rounded-lg bg-white p-4 shadow-sm">
          <div className="text-2xl font-semibold text-brand-700">{confirmedCount}</div>
          <div className="text-sm text-brand-500">Confirmaciones</div>
        </div>
      </div>
      <p className="mt-8 text-sm text-brand-400">
        Formularios y Visualización todavía no están disponibles — se construyen en las próximas
        etapas.
      </p>
    </div>
  );
}
