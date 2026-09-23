import { randomUUID } from "node:crypto";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

process.env.SUTECBA_ENV = "test";
process.env.SUTECBA_PGLITE_DATA_DIR = `.data/pglite-test-${randomUUID()}`;

const { applyMigrations, parseFlags } = await import("../../scripts/migrate.js");
const { closeDb, execRawSql, getDb } = await import("../../lib/db/client.js");
const { assertNoDestructiveWithoutFlag } = await import("../../lib/db/guards.js");

const dataDir = process.env.SUTECBA_PGLITE_DATA_DIR!;
const MIGRATION = "0026_revoke_public_meeting_participation_privileges.sql";
const migrationSql = readFileSync(join(process.cwd(), "db", "migrations", MIGRATION), "utf-8");

beforeAll(async () => {
  await applyMigrations(parseFlags(["--allow-destructive"]));
});

afterAll(async () => {
  await closeDb();
  await new Promise((resolve) => setTimeout(resolve, 100));
  rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

/** Privilegios de PUBLIC / anon / authenticated sobre cualquier tabla o secuencia de `public`. */
async function exposures() {
  const db = await getDb();
  const r = await sql<{ obj: string; grantee: string; priv: string }>`
    select c.relname as obj, case when a.grantee = 0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end as grantee, a.privilege_type as priv
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    cross join lateral aclexplode(c.relacl) a
    where n.nspname = 'public' and c.relkind in ('r', 'p', 'v', 'm', 'S')
      and (a.grantee = 0 or pg_get_userbyid(a.grantee) in ('anon', 'authenticated'))
    order by 1, 2, 3`.execute(db);
  return r.rows;
}

async function appPrivileges(table: string): Promise<string[]> {
  const db = await getDb();
  const r = await sql<{ p: string }>`
    select a.privilege_type as p from pg_class c cross join lateral aclexplode(c.relacl) a
    where c.oid = ${`public.${table}`}::regclass and pg_get_userbyid(a.grantee) = 'sutecba_app' order by 1`.execute(db);
  return r.rows.map((x) => x.p);
}

async function asRole<T>(role: string, run: () => Promise<T>): Promise<T> {
  const db = await getDb();
  await sql.raw(`set role ${role}`).execute(db);
  try {
    return await run();
  } finally {
    await sql`reset role`.execute(db);
  }
}

describe("0026: ningún privilegio para PUBLIC / anon / authenticated en las tablas del CRM", () => {
  it("la migración solo revoca: no otorga nada y no es destructiva para el runner", () => {
    expect(migrationSql).not.toMatch(/\bGRANT\b/i);
    expect(migrationSql).not.toMatch(/\b(INSERT|UPDATE|DELETE)\s+(INTO|FROM)\b/i);
    expect(() => assertNoDestructiveWithoutFlag(MIGRATION, migrationSql, false)).not.toThrow();
  });

  it("tras todas las migraciones no queda NINGÚN privilegio de PUBLIC/anon/authenticated (tablas ni secuencias)", async () => {
    expect(await exposures()).toEqual([]);
    const db = await getDb();
    const noRls = await sql<{ relname: string }>`
      select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity`.execute(db);
    expect(noRls.rows).toEqual([]);
  });

  it("sutecba_app conserva SOLO lo necesario: meeting_participations sin UPDATE ni borrado; asistencia y reuniones sin borrado", async () => {
    expect(await appPrivileges("meeting_participations")).toEqual(["INSERT", "SELECT"]);
    expect(await appPrivileges("meeting_attendance")).toEqual(["INSERT", "SELECT", "UPDATE"]);
    expect(await appPrivileges("meetings")).toEqual(["INSERT", "SELECT", "UPDATE"]);
    // Ninguna tabla del CRM le da a sutecba_app TRUNCATE, TRIGGER ni REFERENCES.
    const db = await getDb();
    const extra = await sql<{ obj: string; priv: string }>`
      select c.relname as obj, a.privilege_type as priv from pg_class c join pg_namespace n on n.oid = c.relnamespace
      cross join lateral aclexplode(c.relacl) a
      where n.nspname = 'public' and c.relkind = 'r' and pg_get_userbyid(a.grantee) = 'sutecba_app' and a.privilege_type in ('TRUNCATE', 'TRIGGER', 'REFERENCES')`.execute(db);
    expect(extra.rows).toEqual([]);
  });

  it("reproduce el defecto real (privilegios por defecto de Supabase + tabla expuesta) y 0026 lo cierra; es idempotente", async () => {
    const db = await getDb();
    // Lo que trae Supabase para tablas creadas por `postgres` en `public`, y la exposición que se detectó en producción.
    await sql`alter default privileges for role postgres in schema public grant truncate, references, trigger on tables to anon, authenticated`.execute(db);
    await sql`grant truncate, references, trigger on table public.meeting_participations to anon, authenticated`.execute(db);
    expect((await exposures()).length).toBeGreaterThan(0);
    expect((await sql<{ ok: boolean }>`select has_table_privilege('anon', 'public.meeting_participations', 'TRUNCATE') as ok`.execute(db)).rows[0]!.ok).toBe(true);

    await execRawSql(migrationSql);
    expect(await exposures()).toEqual([]);
    expect((await sql<{ ok: boolean }>`select has_table_privilege('anon', 'public.meeting_participations', 'TRUNCATE') as ok`.execute(db)).rows[0]!.ok).toBe(false);

    await execRawSql(migrationSql); // segunda corrida: sin efecto ni error
    expect(await exposures()).toEqual([]);
    expect(await appPrivileges("meeting_participations")).toEqual(["INSERT", "SELECT"]);
  });

  it("una tabla FUTURA creada por el rol de las migraciones ya no nace expuesta", async () => {
    const db = await getDb();
    await sql`create table public._probe_future_table (id int)`.execute(db);
    try {
      const acl = await sql<{ grantee: string; priv: string }>`
        select case when a.grantee = 0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end as grantee, a.privilege_type as priv
        from pg_class c cross join lateral aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a
        where c.oid = 'public._probe_future_table'::regclass and (a.grantee = 0 or pg_get_userbyid(a.grantee) in ('anon', 'authenticated'))`.execute(db);
      expect(acl.rows).toEqual([]);
    } finally {
      await sql`drop table public._probe_future_table`.execute(db);
    }
  });

  it("efecto real: anon y authenticated no pueden vaciar, leer ni escribir meeting_participations; sutecba_app tampoco vacía ni actualiza", async () => {
    const db = await getDb();
    for (const role of ["anon", "authenticated"]) {
      await expect(asRole(role, () => sql`truncate table public.meeting_participations`.execute(db))).rejects.toThrow(/permission denied/i);
      await expect(asRole(role, () => sql`select * from public.meeting_participations limit 1`.execute(db))).rejects.toThrow(/permission denied/i);
      await expect(asRole(role, () => sql`delete from public.meeting_participations`.execute(db))).rejects.toThrow(/permission denied/i);
    }
    await expect(asRole("sutecba_app", () => sql`truncate table public.meeting_participations`.execute(db))).rejects.toThrow(/permission denied/i);
    await expect(asRole("sutecba_app", () => sql`update public.meeting_participations set evidence = 'x'`.execute(db))).rejects.toThrow(/permission denied/i);
    await expect(asRole("sutecba_app", () => sql`select count(*) from public.meeting_participations`.execute(db))).resolves.toBeDefined();
  });
});
