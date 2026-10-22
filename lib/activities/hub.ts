import { sql } from "kysely";
import { getDb } from "../db/client.js";
import { assertServerOnly } from "../server-only.js";
import type { SessionUser } from "../permissions/can.js";
import { getCampaignById } from "../campaigns/queries.js";
import { getMeetingById } from "../meetings/queries.js";
import { STATUS_LABEL } from "../meetings/state-machine.js";
import { canAccessForm, isUuid, meetingVisibility, orgScope } from "../scope/organizations.js";
import type { FormEnrollmentMode, FormStatus, MeetingStatus } from "../db/schema.js";

assertServerOnly("lib/activities/hub.ts");

/**
 * Tablero de UNA actividad (reunión de un día o campaña con varias fechas): sus fechas, cada una con su QR de asistencia, y su formulario de
 * inscripción. Es el lugar donde se unifican reuniones, campañas y formularios (Etapa 1e). Todo respeta el alcance del usuario: lo que está fuera
 * de él se trata como «no existe» (null), sin revelar que existe.
 */
export type ActivityKind = "reunion" | "campana";

export interface ActivityDate {
  id: string;
  /** 1..N en orden cronológico. */
  number: number;
  name: string;
  startsAt: Date | null;
  endsAt: Date | null;
  locationName: string | null;
  status: MeetingStatus;
  qrMode: "static" | "rotating";
  /** La unidad propietaria está en el alcance del usuario: puede operar (QR, check-in). Si no, solo la ve. */
  canOperate: boolean;
}

export interface ActivityForm {
  id: string;
  name: string;
  slug: string;
  status: FormStatus;
  enrollmentMode: FormEnrollmentMode;
  publicPath: string;
}

export interface ActivityHub {
  kind: ActivityKind;
  id: string;
  name: string;
  description: string | null;
  /** Estado de la actividad: el de la reunión, o el de la campaña (borrador / programada / en curso…). */
  statusLabel: string;
  /** Solo reunión de un día: la campaña a la que pertenece, si la hay. */
  campaign: { id: string; name: string } | null;
  dates: ActivityDate[];
  forms: ActivityForm[];
}

const CAMPAIGN_STATUS_LABEL: Record<string, string> = {
  draft: "Borrador",
  scheduled: "Programada",
  active: "En curso",
  finalized: "Finalizada",
  cancelled: "Cancelada",
};

export async function getActivityHub(actor: SessionUser, kind: ActivityKind, id: string): Promise<ActivityHub | null> {
  if (!isUuid(id)) return null;
  const db = await getDb();

  let name: string;
  let description: string | null;
  let statusLabel: string;
  let campaign: ActivityHub["campaign"] = null;

  if (kind === "campana") {
    const c = await getCampaignById(actor, id);
    if (!c) return null;
    name = c.name;
    description = null;
    statusLabel = c.status ? (CAMPAIGN_STATUS_LABEL[c.status] ?? c.status) : "Sin gestionar";
  } else {
    const m = await getMeetingById(actor, id);
    if (!m) return null;
    name = m.name;
    description = m.description;
    statusLabel = STATUS_LABEL[m.displayStatus];
    campaign = m.campaign;
  }

  const datesQuery =
    kind === "campana"
      ? sql<DateRow>`
          select m.id, m.name, m.status, m.starts_at, m.ends_at, m.location_name, m.qr_mode, ${orgScope(actor, "m.owner_organization_id")} as can_operate
          from meetings m
          where m.campaign_id = ${id}::uuid and ${meetingVisibility(actor, "m.id", "m.owner_organization_id")}
          order by m.starts_at asc nulls last, m.name`
      : sql<DateRow>`
          select m.id, m.name, m.status, m.starts_at, m.ends_at, m.location_name, m.qr_mode, ${orgScope(actor, "m.owner_organization_id")} as can_operate
          from meetings m
          where m.id = ${id}::uuid`;
  const formsQuery =
    kind === "campana"
      ? db.selectFrom("forms").select(["id", "name", "slug", "status", "enrollment_mode"]).where("campaign_id", "=", id).orderBy("created_at", "asc").execute()
      : db.selectFrom("forms").select(["id", "name", "slug", "status", "enrollment_mode"]).where("meeting_id", "=", id).orderBy("created_at", "asc").execute();
  const [dateRows, formRows] = await Promise.all([datesQuery.execute(db), formsQuery]);

  const visibleForms: ActivityForm[] = [];
  for (const f of formRows) {
    if (await canAccessForm(actor, f.id)) {
      visibleForms.push({ id: f.id, name: f.name, slug: f.slug, status: f.status, enrollmentMode: f.enrollment_mode, publicPath: `/f/${f.slug}` });
    }
  }

  return {
    kind,
    id,
    name,
    description,
    statusLabel,
    campaign,
    dates: dateRows.rows.map((r, i) => ({
      id: r.id,
      number: i + 1,
      name: r.name,
      startsAt: r.starts_at,
      endsAt: r.ends_at,
      locationName: r.location_name,
      status: r.status,
      qrMode: r.qr_mode,
      canOperate: r.can_operate === true,
    })),
    forms: visibleForms,
  };
}

interface DateRow {
  id: string;
  name: string;
  status: MeetingStatus;
  starts_at: Date | null;
  ends_at: Date | null;
  location_name: string | null;
  qr_mode: "static" | "rotating";
  can_operate: boolean;
}
