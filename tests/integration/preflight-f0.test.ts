import { randomUUID } from "node:crypto";
import { readdirSync, rmSync } from "node:fs";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

process.env.SUTECBA_ENV = "test";
process.env.SUTECBA_PGLITE_DATA_DIR = `.data/pglite-test-${randomUUID()}`;
process.env.SUTECBA_QR_SECRET = "test-qr-secret-".padEnd(48, "x");

const { applyMigrations, parseFlags } = await import("../../scripts/migrate.js");
const { runSeed } = await import("../../scripts/seed.js");
const { closeDb, getDb } = await import("../../lib/db/client.js");
const { hashPassword } = await import("../../lib/auth/passwords.js");
const { createSession, loadSessionUser } = await import("../../lib/auth/session.js");
const formCommands = await import("../../lib/forms/commands.js");
const { runF0Preflight } = await import("../../scripts/preflight-f0.js");

const dataDir = process.env.SUTECBA_PGLITE_DATA_DIR!;
const onDisk = readdirSync("db/migrations").filter((f) => f.endsWith(".sql")).sort();
let db: Awaited<ReturnType<typeof getDb>>;
let master: any;
let orgA: string;
let orgB: string;

/** Como en producción: todo dentro de una transacción de SOLO LECTURA. Si el preflight intentara escribir, fallaría. */
async function preflight() {
  await sql`begin read only`.execute(db);
  try {
    return await runF0Preflight(async (text) => (await sql.raw(text).execute(db)).rows as Record<string, unknown>[], onDisk);
  } finally {
    await sql`rollback`.execute(db);
  }
}

/** Deja la base como estaría ANTES de desplegar F0: las dos migraciones figuran como pendientes. */
async function markPending() {
  await sql`delete from sutecba_migrations where filename in ('0046_public_link_attempts_hardening.sql', '0047_meetings_accredit_permission.sql')`.execute(db);
}
async function markApplied() {
  for (const filename of ["0046_public_link_attempts_hardening.sql", "0047_meetings_accredit_permission.sql"]) {
    await sql`insert into sutecba_migrations (filename) values (${filename}) on conflict do nothing`.execute(db);
  }
}

async function formWithAction(slug: string, owner: string, associationId: string, publish: boolean) {
  const { id } = await formCommands.createForm(master, { name: slug, slug, ownerOrganizationId: owner });
  await formCommands.updateFormMeta(master, id, { name: slug, slug, consentText: "", successMessage: "", opensAt: "", closesAt: "", matchFields: ["dni"], personCreationPolicy: "never", applyDataPolicy: "never" } as any);
  for (const k of ["first_name", "last_name", "dni"]) {
    await formCommands.upsertField(master, id, null, { key: k, label: k, fieldType: k === "dni" ? "dni" : "text", required: true, visible: true, personFieldMapping: k } as any);
  }
  await db.insertInto("form_actions").values({ form_id: id, action_type: "add_to_association", config: JSON.stringify({ associationId }) as never, sort_order: 1 }).execute();
  if (publish) {
    // F0 impide publicar esta configuración; se simula una versión publicada antes de F0 insertando el snapshot a mano.
    await db.insertInto("form_versions").values({ form_id: id, version: 1, schema: JSON.stringify({ name: slug, consentText: null, successMessage: null, identificationPolicy: { matchFields: ["dni"] }, fields: [], actions: [{ actionType: "add_to_association", config: { associationId } }] }) as never }).execute();
    await sql`update forms set status = 'published', published_version = 1 where id = ${id}::uuid`.execute(db);
  }
  return id;
}

beforeAll(async () => {
  await applyMigrations(parseFlags(["--allow-destructive"]));
  await runSeed();
  db = await getDb();
  const type = await db.selectFrom("organization_types").select("id").where("key", "=", "reparticion").executeTakeFirstOrThrow();
  orgA = (await db.insertInto("organizations").values({ name: "A", type_id: type.id }).returning("id").executeTakeFirstOrThrow()).id;
  orgB = (await db.insertInto("organizations").values({ name: "B", type_id: type.id }).returning("id").executeTakeFirstOrThrow()).id;
  const role = await db.selectFrom("roles").select("id").where("key", "=", "MASTER_GLOBAL").executeTakeFirstOrThrow();
  const u = await db.insertInto("users").values({ email: "m@sutecba.local", password_hash: await hashPassword("x-password-123"), full_name: "Master", role_id: role.id }).returning("id").executeTakeFirstOrThrow();
  master = (await loadSessionUser((await createSession(u.id)).token))!;
});

afterAll(async () => {
  await closeDb();
  await new Promise((r) => setTimeout(r, 100));
  rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

describe("preflight F0 (solo lectura)", () => {
  it("estado limpio antes de desplegar: ok, sin bloqueos, con las dos migraciones como pendientes", async () => {
    await markPending();
    const r = await preflight();
    expect(r.blockers).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.migraciones.pendientes).toEqual(["0046_public_link_attempts_hardening.sql", "0047_meetings_accredit_permission.sql"]);
    expect(r.privilegios.roles_presentes).toContain("sutecba_app");
    expect(r.privilegios.dueno_tabla).toBe(r.privilegios.rol_que_migra);
    expect(r.permisos.roles_destino_presentes).toEqual(["ADMIN", "MASTER_GLOBAL", "OPERADOR", "REUNIONES"]);
    expect(r.public_link_attempts.rls_activa).toBe(true);
    expect(r.public_link_attempts.politicas_para_sutecba_app).toBeGreaterThan(0);
  });

  it("detecta filas históricas a sanear y filas viejas (solo cantidades, nunca valores)", async () => {
    await markPending();
    const token = "tok-SECRETO-" + randomUUID();
    await sql`insert into public_link_attempts (scope, identifier, ip_address, succeeded, created_at) values
      ('invitation_view', ${token}, '10.9.9.9', true, now() - interval '40 days'),
      ('checkin_qr', 'eyJtIjoi', '10.9.9.9', true, now()),
      ('form_submit', 'mi-form', '10.9.9.9', true, now()),
      ('invitation_view', 'h1:0123456789abcdef0123456789abcdef', '10.9.9.9', true, now())`.execute(db);
    const r = await preflight();
    expect(r.public_link_attempts.a_sanear_por_0046).toBe(2);
    expect(r.public_link_attempts.mas_viejas_que_30_dias).toBe(1);
    expect(JSON.stringify(r)).not.toContain(token);
  });

  it("formularios: una acción PUBLICADA fuera de alcance es BLOCKER; una solo configurada es WARNING; las válidas no aparecen", async () => {
    await markPending();
    const at = await db.selectFrom("association_types").select("id").limit(1).executeTakeFirstOrThrow();
    const mk = async (name: string, org: string, status = "active") =>
      (await db.insertInto("associations").values({ name, type_id: at.id, owner_organization_id: org, status } as never).returning("id").executeTakeFirstOrThrow()).id;
    const good = await mk("propia", orgA);
    const other = await mk("ajena", orgB);
    const goodForm = await formWithAction("pf-ok", orgA, good, true);
    const badPublished = await formWithAction("pf-publicado-malo", orgA, other, true);
    const badDraft = await formWithAction("pf-borrador-malo", orgA, other, false);

    const r = await preflight();
    expect(r.ok).toBe(false);
    expect(r.formularios.publicado_con_accion_fuera_de_alcance.map((x) => x.slug)).toEqual(["pf-publicado-malo"]);
    expect(r.formularios.publicado_con_accion_fuera_de_alcance[0]).toMatchObject({ form_id: badPublished, motivo: "asociación de otra unidad" });
    expect(r.formularios.configurado_con_accion_fuera_de_alcance.map((x) => x.slug).sort()).toEqual(["pf-borrador-malo", "pf-publicado-malo"]);
    expect(r.blockers.join(" ")).toMatch(/PUBLICADAS/);
    expect(r.warnings.join(" ")).toMatch(/próxima publicación/);
    expect(JSON.stringify(r)).not.toContain(goodForm);
    // ids internos y slug público, nada de personas
    expect(Object.keys(r.formularios.publicado_con_accion_fuera_de_alcance[0]!).sort()).toEqual(["form_id", "motivo", "published_version", "slug", "status"]);
    expect(badDraft).toBeTruthy();

    // limpiar para no afectar a los demás casos
    await sql`delete from form_actions`.execute(db);
    await sql`update forms set published_version = null, status = 'draft'`.execute(db);
    await sql`delete from form_versions`.execute(db);
  });

  it("predice el aborto de la 0046: otro rol con EXECUTE por defecto en funciones nuevas es BLOCKER; los que la 0046 revoca no", async () => {
    await markPending();
    await sql`do $$ begin if not exists (select 1 from pg_roles where rolname = 'f0_extra') then create role f0_extra nologin; end if; end $$`.execute(db);
    try {
      await sql`alter default privileges in schema public grant execute on functions to anon, authenticated`.execute(db);
      expect((await preflight()).blockers).toEqual([]); // anon/authenticated los revoca la 0046
      await sql`alter default privileges in schema public grant execute on functions to f0_extra`.execute(db);
      const r = await preflight();
      expect(r.ok).toBe(false);
      expect(r.privilegios.grantees_previstos_de_la_funcion).toContain("f0_extra");
      expect(r.blockers.join(" ")).toMatch(/f0_extra/);
    } finally {
      await sql`alter default privileges in schema public revoke execute on functions from anon, authenticated, f0_extra`.execute(db);
    }
    expect((await preflight()).ok).toBe(true);
  });

  it("migraciones: distinta de «exactamente 0046 y 0047 pendientes» es BLOCKER (ya aplicadas, o una desconocida)", async () => {
    await markApplied();
    const applied = await preflight();
    expect(applied.ok).toBe(false);
    expect(applied.blockers.join(" ")).toMatch(/pendientes no son exactamente 0046 y 0047/);

    await markPending();
    await sql`insert into sutecba_migrations (filename) values ('9999_desconocida.sql')`.execute(db);
    const unknown = await preflight();
    expect(unknown.ok).toBe(false);
    expect(unknown.migraciones.aplicadas_desconocidas).toEqual(["9999_desconocida.sql"]);
    await sql`delete from sutecba_migrations where filename = '9999_desconocida.sql'`.execute(db);
  });

  it("es de SOLO LECTURA y no filtra datos personales", async () => {
    await markPending();
    await db.insertInto("people").values({ first_name: "Zoraida", last_name: "Confidencial", dni: "59999999", email: "zoraida.confidencial@example.test", organization_id: orgA }).execute();
    const before = (await sql<{ n: number }>`select (select count(*) from people)::int + (select count(*) from public_link_attempts)::int + (select count(*) from form_actions)::int as n`.execute(db)).rows[0]!.n;
    const r = await preflight(); // dentro de «begin read only»: cualquier escritura habría fallado
    const after = (await sql<{ n: number }>`select (select count(*) from people)::int + (select count(*) from public_link_attempts)::int + (select count(*) from form_actions)::int as n`.execute(db)).rows[0]!.n;
    expect(after).toBe(before);
    const text = JSON.stringify(r);
    for (const secret of ["Zoraida", "Confidencial", "59999999", "zoraida"]) expect(text).not.toContain(secret);
    await markApplied();
  });
});
