import { Pool } from "pg";
import { loadEnv } from "../lib/db/env.js";

/**
 * Preflight de F0 (migraciones 0046 y 0047 + formularios). SOLO LECTURA: sesión `read only`, ningún INSERT/UPDATE/DELETE/DDL.
 * Nunca imprime personas, emails, DNI ni contenidos: solo cantidades, ids internos de formularios/acciones, slugs públicos,
 * nombres de roles y de migraciones.
 *
 *   npx tsx scripts/preflight-f0.ts            (usa SUTECBA_MIGRATION_DATABASE_URL del .env)
 *
 * Qué comprueba y por qué (cada BLOCKER explica qué haría fallar o qué cambiaría el comportamiento):
 *  - Que las únicas migraciones pendientes sean la 0046 y la 0047 (y que no haya aplicadas desconocidas).
 *  - Que el rol que va a migrar sea dueño de `public_link_attempts` (o pueda borrar de ella): si no, la verificación interna de la
 *    0046 abortaría la migración (transaccional: no queda nada a medias).
 *  - Que los privilegios por defecto de funciones del rol migrador no den EXECUTE a roles que la 0046 no revoca (la 0046 revoca
 *    PUBLIC, anon, authenticated y service_role): si hubiera otro, la verificación abortaría.
 *  - Formularios publicados o configurados con acciones «sumar a asociación» fuera del alcance (cambiaría el comportamiento).
 *  - Cuántas filas históricas de `public_link_attempts` va a sanear/limpiar la migración y cuán grande es la tabla.
 */

type Row = Record<string, unknown>;
export type QueryFn = (text: string) => Promise<Row[]>;

const EXPECTED_PENDING = ["0046_public_link_attempts_hardening.sql", "0047_meetings_accredit_permission.sql"];
const REVOKED_BY_0046 = ["anon", "authenticated", "service_role", "sutecba_app"];
const TOKEN_SCOPES = "('invitation_view', 'invitation_respond', 'invitation_checkin', 'checkin_qr')";
const UUID_RE = "'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'";

const MOTIVO = (col: string) => `CASE
  WHEN ${col} IS NULL OR ${col} !~ ${UUID_RE} THEN 'id ausente o mal formado'
  WHEN NOT EXISTS (SELECT 1 FROM associations a WHERE a.id::text = ${col}) THEN 'asociación inexistente'
  WHEN EXISTS (SELECT 1 FROM associations a WHERE a.id::text = ${col} AND a.status <> 'active') THEN 'asociación inactiva'
  ELSE 'asociación de otra unidad' END`;

/** (A) acciones configuradas hoy en form_actions (lo que se copiaría al volver a publicar). */
export const FORMS_CONFIGURED_SQL = `
  WITH cfg AS (
    SELECT fa.id AS action_id, f.id AS form_id, f.slug, f.status, f.owner_organization_id, fa.config->>'associationId' AS assoc_text
    FROM form_actions fa JOIN forms f ON f.id = fa.form_id WHERE fa.action_type = 'add_to_association')
  SELECT action_id::text, form_id::text, slug, status, ${MOTIVO("assoc_text")} AS motivo
  FROM cfg c
  WHERE NOT EXISTS (SELECT 1 FROM associations a WHERE a.id::text = c.assoc_text AND a.status = 'active'
    AND a.owner_organization_id IN (SELECT organization_id FROM organization_descendants(c.owner_organization_id)))
  ORDER BY slug`;

/** (B) lo realmente publicado: acciones dentro del snapshot de la versión vigente (es lo que se ejecuta con cada respuesta). */
export const FORMS_PUBLISHED_SQL = `
  WITH snap AS (
    SELECT f.id AS form_id, f.slug, f.status, f.published_version, f.owner_organization_id,
           act->>'actionType' AS action_type, act->'config'->>'associationId' AS assoc_text
    FROM forms f JOIN form_versions fv ON fv.form_id = f.id AND fv.version = f.published_version
    CROSS JOIN LATERAL jsonb_array_elements(COALESCE(fv.schema->'actions', '[]'::jsonb)) AS act
    WHERE f.published_version IS NOT NULL)
  SELECT form_id::text, slug, status, published_version, ${MOTIVO("assoc_text")} AS motivo
  FROM snap s
  WHERE s.action_type = 'add_to_association'
    AND NOT EXISTS (SELECT 1 FROM associations a WHERE a.id::text = s.assoc_text AND a.status = 'active'
      AND a.owner_organization_id IN (SELECT organization_id FROM organization_descendants(s.owner_organization_id)))
  ORDER BY slug`;

export interface F0Report {
  ok: boolean;
  entorno: { base: string; rol: string };
  blockers: string[];
  warnings: string[];
  migraciones: { pendientes: string[]; aplicadas_desconocidas: string[] };
  formularios: {
    publicados_total: number;
    con_acciones_de_asociacion: number;
    publicado_con_accion_fuera_de_alcance: Row[];
    configurado_con_accion_fuera_de_alcance: Row[];
  };
  public_link_attempts: { filas: number; a_sanear_por_0046: number; mas_viejas_que_30_dias: number; rls_activa: boolean | null; politicas_para_sutecba_app: number };
  privilegios: {
    roles_presentes: string[];
    dueno_tabla: string;
    rol_que_migra: string;
    grantees_previstos_de_la_funcion: string[];
    sutecba_app_puede_borrar_hoy: boolean;
  };
  permisos: { roles_destino_presentes: string[]; meetings_accredit_ya_existe: boolean };
}

export async function runF0Preflight(one: QueryFn, onDisk: string[]): Promise<F0Report> {
  const blockers: string[] = [];
  const warnings: string[] = [];
  const num = (v: unknown) => Number(v ?? 0);

  const who = (await one("select current_database() as db, current_user as usr"))[0]!;
  const rolMigra = String(who.usr);

  // ---- migraciones ----
  const applied = (await one("select filename from sutecba_migrations order by filename")).map((r) => String(r.filename));
  const pending = onDisk.filter((f) => !applied.includes(f));
  const unknownApplied = applied.filter((f) => !onDisk.includes(f));
  if (JSON.stringify(pending) !== JSON.stringify(EXPECTED_PENDING)) {
    blockers.push(`Las migraciones pendientes no son exactamente 0046 y 0047 (pendientes: ${pending.join(", ") || "ninguna"}). Este preflight es para ese salto.`);
  }
  if (unknownApplied.length) blockers.push(`Hay migraciones aplicadas que este repositorio no tiene: ${unknownApplied.join(", ")}.`);

  // ---- formularios ----
  const published = await one(FORMS_PUBLISHED_SQL);
  const configured = await one(FORMS_CONFIGURED_SQL);
  const formStats = (
    await one(`SELECT count(*) FILTER (WHERE status = 'published')::int AS publicados,
      count(*) FILTER (WHERE EXISTS (SELECT 1 FROM form_actions fa WHERE fa.form_id = forms.id AND fa.action_type = 'add_to_association'))::int AS con_acciones FROM forms`)
  )[0]!;
  if (published.length) {
    blockers.push(`${published.length} acción(es) de asociación en versiones PUBLICADAS están fuera del alcance de su formulario: tras el despliegue dejarían de sumar personas (el envío se procesa igual). Decidir qué hacer ANTES de desplegar.`);
  }
  const onlyConfigured = configured.filter((c) => !published.some((p) => p.form_id === c.form_id));
  if (onlyConfigured.length) {
    warnings.push(`${onlyConfigured.length} acción(es) configuradas (no publicadas) están fuera de alcance: la próxima publicación de esos formularios será rechazada con un error claro hasta corregirlas.`);
  }

  // ---- tabla de intentos ----
  const pla = (
    await one(`SELECT (SELECT count(*) FROM public_link_attempts)::int AS filas,
      (SELECT count(*) FROM public_link_attempts WHERE scope IN ${TOKEN_SCOPES} AND identifier NOT LIKE 'h1:%')::int AS a_sanear,
      (SELECT count(*) FROM public_link_attempts WHERE created_at < now() - interval '30 days')::int AS viejas,
      (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.public_link_attempts'::regclass) AS rls,
      (SELECT count(*) FROM pg_policies WHERE schemaname = 'public' AND tablename = 'public_link_attempts' AND 'sutecba_app' = ANY(roles))::int AS politicas`)
  )[0]!;
  if (num(pla.filas) > 1_000_000) warnings.push(`public_link_attempts tiene ${num(pla.filas)} filas: el saneamiento y el índice de la 0046 toman un lock; hacerlo en una ventana tranquila.`);
  if (pla.rls !== true || num(pla.politicas) === 0) warnings.push("public_link_attempts no tiene RLS con política para sutecba_app (revisar contra la 0019).");

  // ---- privilegios (predicción de lo que verificará la propia 0046) ----
  const rolesPresentes = (await one(`SELECT rolname FROM pg_roles WHERE rolname IN ('sutecba_app','anon','authenticated','service_role') ORDER BY 1`)).map((r) => String(r.rolname));
  if (!rolesPresentes.includes("sutecba_app")) blockers.push("No existe el rol sutecba_app (la 0046 lo necesita).");
  const owner = (await one(`SELECT pg_get_userbyid(relowner) AS dueno, has_table_privilege(current_user, 'public.public_link_attempts', 'DELETE') AS migra_puede_borrar
    FROM pg_class WHERE oid = 'public.public_link_attempts'::regclass`))[0]!;
  const duenoTabla = String(owner.dueno);
  if (duenoTabla !== rolMigra && owner.migra_puede_borrar !== true) {
    blockers.push(`El rol que migra (${rolMigra}) no es dueño de public_link_attempts (${duenoTabla}) ni puede borrar de ella: la verificación de la 0046 abortaría. Migrar con el rol dueño.`);
  }
  // Privilegios por defecto para funciones nuevas del rol migrador en public: quién recibiría EXECUTE al crear la función.
  const defaults = await one(`
    SELECT DISTINCT CASE a.grantee WHEN 0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END AS grantee
    FROM pg_default_acl d, aclexplode(d.defaclacl) a
    WHERE d.defaclobjtype = 'f' AND d.defaclrole = (SELECT oid FROM pg_roles WHERE rolname = current_user)
      AND d.defaclnamespace IN (0, 'public'::regnamespace) AND a.privilege_type = 'EXECUTE'`);
  const granteesPrevistos = defaults.map((r) => String(r.grantee));
  const inesperados = granteesPrevistos.filter((g) => g !== "PUBLIC" && g !== rolMigra && !REVOKED_BY_0046.includes(g));
  if (inesperados.length) {
    blockers.push(`Los privilegios por defecto darían EXECUTE de la función de limpieza a roles que la 0046 no revoca (${inesperados.join(", ")}): la verificación de la 0046 abortaría. Revisar con el titular de la base.`);
  }
  const puedeBorrar = (await one(`SELECT has_table_privilege('sutecba_app', 'public.public_link_attempts', 'DELETE') AS x`))[0]!.x === true;
  if (puedeBorrar) warnings.push("sutecba_app ya tiene DELETE sobre public_link_attempts (la 0019 no se lo daba): revisar por qué.");

  // ---- permisos de la 0047 ----
  const roles = (await one(`SELECT key FROM roles WHERE key IN ('MASTER_GLOBAL','ADMIN','OPERADOR','REUNIONES') ORDER BY key`)).map((r) => String(r.key));
  if (roles.length !== 4) warnings.push(`La 0047 asigna meetings.accredit a 4 roles y solo existen: ${roles.join(", ") || "ninguno"}.`);
  const yaExiste = num((await one(`SELECT count(*)::int AS n FROM permissions WHERE key = 'meetings.accredit'`))[0]!.n) > 0;
  if (yaExiste) warnings.push("meetings.accredit ya existe en permissions (¿se aplicó algo antes?). La 0047 es idempotente.");

  return {
    ok: blockers.length === 0,
    entorno: { base: String(who.db), rol: rolMigra },
    blockers,
    warnings,
    migraciones: { pendientes: pending, aplicadas_desconocidas: unknownApplied },
    formularios: {
      publicados_total: num(formStats.publicados),
      con_acciones_de_asociacion: num(formStats.con_acciones),
      publicado_con_accion_fuera_de_alcance: published,
      configurado_con_accion_fuera_de_alcance: configured,
    },
    public_link_attempts: { filas: num(pla.filas), a_sanear_por_0046: num(pla.a_sanear), mas_viejas_que_30_dias: num(pla.viejas), rls_activa: pla.rls === null ? null : pla.rls === true, politicas_para_sutecba_app: num(pla.politicas) },
    privilegios: { roles_presentes: rolesPresentes, dueno_tabla: duenoTabla, rol_que_migra: rolMigra, grantees_previstos_de_la_funcion: granteesPrevistos, sutecba_app_puede_borrar_hoy: puedeBorrar },
    permisos: { roles_destino_presentes: roles, meetings_accredit_ya_existe: yaExiste },
  };
}

async function main() {
  const env = loadEnv();
  if (!env.SUTECBA_MIGRATION_DATABASE_URL) throw new Error("Falta SUTECBA_MIGRATION_DATABASE_URL (solo lectura).");
  const pool = new Pool({ connectionString: env.SUTECBA_MIGRATION_DATABASE_URL, max: 1 });
  try {
    await pool.query("set default_transaction_read_only = on");
    await pool.query("begin isolation level repeatable read read only");
    const { readdirSync } = await import("node:fs");
    const { join } = await import("node:path");
    const onDisk = readdirSync(join(process.cwd(), "db", "migrations")).filter((f) => f.endsWith(".sql")).sort();
    const report = await runF0Preflight(async (text) => (await pool.query(text)).rows as Row[], onDisk);
    await pool.query("rollback");
    console.log(JSON.stringify(report, null, 2));
    if (!report.ok) process.exitCode = 2;
  } finally {
    await pool.end();
  }
}

// Se ejecuta solo como script (no al importarlo desde las pruebas).
if (process.argv[1] && /preflight-f0\.(ts|js)$/.test(process.argv[1])) {
  main().catch((err) => {
    console.error("preflight-f0:", (err as Error).message.replace(/postgres(ql)?:\/\/\S+/gi, "[url]"));
    process.exit(1);
  });
}
