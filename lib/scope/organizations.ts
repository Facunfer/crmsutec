import { sql, type RawBuilder } from "kysely";
import { getDb } from "../db/client.js";
import { assertServerOnly } from "../server-only.js";
import { isMasterGlobal, type SessionUser } from "../permissions/can.js";

assertServerOnly("lib/scope/organizations.ts");

/**
 * Alcance organizativo: fuente única de "qué unidades puede ver este usuario".
 *
 * Acceso efectivo = usuario activo + módulo + permiso (todo eso ya lo resuelve
 * `can()`) + organización accesible (esto). La fuente de verdad es la función
 * SQL `user_accessible_organizations(user_id)` (migración 0012): alcances
 * vigentes del usuario, con sus dependientes cuando `include_descendants`.
 * MASTER_GLOBAL ve todo sin filas en `user_scopes`, así que para él no se
 * consulta nada. Ningún módulo debe armar su propio filtro: todo pasa por acá.
 *
 * Convención de denegación: lo que está fuera del alcance se trata como "no
 * existe" (las consultas por id devuelven null / las operaciones fallan con el
 * error "no existe" del módulo), sin revelar que el registro existe.
 */

/** ¿Ve este usuario todas las unidades sin restricción? (MASTER_GLOBAL) */
export function hasGlobalScope(user: SessionUser): boolean {
  return isMasterGlobal(user);
}

/**
 * Condición SQL para filtrar una columna que apunta a `organizations.id`.
 * Para MASTER_GLOBAL es `true` (sin filtro, incluidos los NULL); para el resto,
 * la columna debe estar entre las unidades accesibles, y un NULL nunca cumple.
 * Con `includeNull` (p. ej. etiquetas globales) un NULL también pasa.
 *
 * `column` es siempre un literal del código (`"people.organization_id"`),
 * nunca texto del usuario.
 */
export function orgScope(
  user: SessionUser,
  column: string,
  options: { includeNull?: boolean } = {}
): RawBuilder<boolean> {
  if (hasGlobalScope(user)) return sql<boolean>`true`;

  const inScope = sql<boolean>`${sql.ref(column)} in (
    select organization_id from user_accessible_organizations(${user.id}::uuid)
  )`;
  return options.includeNull ? sql<boolean>`(${sql.ref(column)} is null or ${inScope})` : inScope;
}

/** IDs de las unidades accesibles; `null` significa "todas" (MASTER_GLOBAL). */
export async function getAccessibleOrganizationIds(user: SessionUser): Promise<string[] | null> {
  if (hasGlobalScope(user)) return null;
  const db = await getDb();
  const result = await sql<{ organization_id: string }>`
    select organization_id from user_accessible_organizations(${user.id}::uuid)
  `.execute(db);
  return result.rows.map((r) => r.organization_id);
}

/**
 * ¿Puede el usuario operar sobre esta unidad? Un `null` (registro sin
 * organización, p. ej. una persona pendiente de clasificar) solo lo ve
 * MASTER_GLOBAL.
 */
export async function canAccessOrganization(user: SessionUser, organizationId: string | null): Promise<boolean> {
  if (hasGlobalScope(user)) return true;
  if (organizationId === null) return false;

  const db = await getDb();
  const result = await sql<{ ok: boolean }>`
    select exists (
      select 1 from user_accessible_organizations(${user.id}::uuid) a
      where a.organization_id = ${organizationId}::uuid
    ) as ok
  `.execute(db);
  return result.rows[0]?.ok === true;
}

async function existsInScope(
  user: SessionUser,
  table: "people" | "associations" | "meetings" | "forms",
  column: string,
  id: string
): Promise<boolean> {
  if (!isUuid(id)) return false;
  const db = await getDb();
  const result = await sql<{ ok: boolean }>`
    select exists (
      select 1 from ${sql.table(table)}
      where id = ${id}::uuid and ${orgScope(user, `${table}.${column}`)}
    ) as ok
  `.execute(db);
  return result.rows[0]?.ok === true;
}

// Compuertas por id (IDOR): existe Y está dentro del alcance del usuario.
// Cada operación sobre un registro conocido por UUID debe pasar por una de estas
// antes de leer o mutar; la denegación se reporta como "no existe".
export const canAccessPerson = (user: SessionUser, personId: string) =>
  existsInScope(user, "people", "organization_id", personId);
export const canAccessAssociation = (user: SessionUser, associationId: string) =>
  existsInScope(user, "associations", "owner_organization_id", associationId);
export const canAccessMeeting = (user: SessionUser, meetingId: string) =>
  existsInScope(user, "meetings", "owner_organization_id", meetingId);
export const canAccessForm = (user: SessionUser, formId: string) =>
  existsInScope(user, "forms", "owner_organization_id", formId);

/**
 * Condición SQL: la columna `personIdColumn` (un id de persona) pertenece a una persona DENTRO del alcance del usuario.
 * MASTER_GLOBAL: `true`. Es la base de todo conteo o listado de participantes: nunca se cuentan ni se muestran
 * personas de otras áreas.
 */
export function personInScope(user: SessionUser, personIdColumn: string): RawBuilder<boolean> {
  if (hasGlobalScope(user)) return sql<boolean>`true`;
  return sql<boolean>`${sql.ref(personIdColumn)} in (
    select p.id from people p
    where p.organization_id in (select organization_id from user_accessible_organizations(${user.id}::uuid))
  )`;
}

/**
 * VISIBILIDAD de una reunión (solo lectura): el usuario la ve si la unidad propietaria está en su alcance, O si la
 * reunión tiene al menos un participante (participación, invitación vigente o asistencia) dentro de su alcance, o inscriptos
 * suyos a nivel de campaña de esa actividad. Las
 * actividades históricas tienen a SUTECBA como propietaria: sin esta regla un usuario de un área no vería ninguna, y
 * darle alcance sobre SUTECBA no serviría (SUTECBA no contiene personas de ningún área).
 *
 * Esta regla es SOLO de lectura. Editar, invitar, cambiar estado o registrar asistencia siguen exigiendo que la
 * reunión sea del alcance propietario (`canAccessMeeting`).
 */
export function meetingVisibility(user: SessionUser, meetingIdColumn = "meetings.id", ownerColumn = "meetings.owner_organization_id"): RawBuilder<boolean> {
  if (hasGlobalScope(user)) return sql<boolean>`true`;
  const acc = sql`select organization_id from user_accessible_organizations(${user.id}::uuid)`;
  return sql<boolean>`(
    ${sql.ref(ownerColumn)} in (${acc})
    or exists (
      select 1 from meeting_participations mp
      join people pp on pp.id = mp.person_id
      where mp.meeting_id = ${sql.ref(meetingIdColumn)} and pp.organization_id in (${acc})
    )
    or exists (
      select 1 from meeting_invitations mi
      join people pi on pi.id = mi.person_id
      where mi.meeting_id = ${sql.ref(meetingIdColumn)} and mi.withdrawn_at is null and pi.organization_id in (${acc})
    )
    or exists (
      select 1 from meeting_attendance ma
      join people pa on pa.id = ma.person_id
      where ma.meeting_id = ${sql.ref(meetingIdColumn)} and pa.organization_id in (${acc})
    )
    -- Participantes GENERALES de la campaña de la actividad (inscriptos sin jornada probada): la reunión se ve para
    -- poder mostrarlos en «Sin jornada asignada». Siguen sin asignarse a ninguna jornada.
    or exists (
      select 1 from meeting_participations mc
      join people pc on pc.id = mc.person_id
      where mc.meeting_id is null
        and mc.campaign_key = 'ophthalmology:' || (
          select (regexp_match(mm.source_event_key, '^ophthalmology:(?:[0-9]{4}-[0-9]{2}-[0-9]{2}|sin-fecha):(.+)$'))[1]
          from meetings mm where mm.id = ${sql.ref(meetingIdColumn)}
        )
        and pc.organization_id in (${acc})
    )
  )`;
}

/** ¿Puede el usuario VER esta reunión (propietaria en su alcance o con participantes suyos)? Solo lectura. */
export async function canViewMeeting(user: SessionUser, meetingId: string): Promise<boolean> {
  if (!isUuid(meetingId)) return false;
  const db = await getDb();
  const result = await sql<{ ok: boolean }>`
    select exists (
      select 1 from meetings where id = ${meetingId}::uuid and ${meetingVisibility(user)}
    ) as ok
  `.execute(db);
  return result.rows[0]?.ok === true;
}

/** ¿Es un uuid bien formado? Evita que un id malformado llegue a un cast SQL y rompa con un error de base. */
export function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}
