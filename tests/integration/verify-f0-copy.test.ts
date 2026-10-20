import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

process.env.SUTECBA_ENV = "test";
process.env.SUTECBA_PGLITE_DATA_DIR = `.data/pglite-test-${randomUUID()}`;
process.env.SUTECBA_QR_SECRET = "test-qr-secret-".padEnd(48, "x");

const { applyMigrations, parseFlags } = await import("../../scripts/migrate.js");
const { runSeed } = await import("../../scripts/seed.js");
const { closeDb, getDb } = await import("../../lib/db/client.js");
const { verifyF0Copy } = await import("../../scripts/verify-f0-copy.js");

const dataDir = process.env.SUTECBA_PGLITE_DATA_DIR!;
let db: Awaited<ReturnType<typeof getDb>>;

const failures = (results: Array<{ name: string; ok: boolean }>) => results.filter((r) => !r.ok).map((r) => r.name);
const snapshot = async () =>
  (await sql<{ a: number; b: number; c: number }>`select (select count(*) from public_link_attempts)::int a, (select count(*) from role_permissions)::int b, (select count(*) from people)::int c`.execute(db)).rows[0];

beforeAll(async () => {
  await applyMigrations(parseFlags(["--allow-destructive"]));
  await runSeed();
  db = await getDb();
});

afterAll(async () => {
  await closeDb();
  await new Promise((r) => setTimeout(r, 100));
  rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

describe("verify-f0-copy: verificación con el rol real sutecba_app sobre una copia migrada", () => {
  it("sobre el estado correcto: todo PASS, y la copia queda EXACTAMENTE como estaba (se revierte siempre)", async () => {
    await sql`insert into public_link_attempts (scope, identifier, ip_address, succeeded, created_at) values ('form_submit', 'viejo', '10.0.0.5', true, now() - interval '90 days'), ('invitation_view', 'h1:0123456789abcdef0123456789abcdef', '10.0.0.5', true, now())`.execute(db);
    const before = await snapshot();
    const results = await verifyF0Copy(db, { expectAttemptRows: 2 });
    expect(failures(results)).toEqual([]);
    expect(results.length).toBeGreaterThanOrEqual(25);
    expect(await snapshot()).toEqual(before); // la limpieza de prueba (borró la fila de 90 días) y los inserts se revirtieron
    // y sigue siendo así si se vuelve a correr
    expect(failures(await verifyF0Copy(db, { expectAttemptRows: 2 }))).toEqual([]);
  });

  it("detecta que sutecba_app tenga DELETE directo sobre la tabla de intentos", async () => {
    await sql`grant delete on public_link_attempts to sutecba_app`.execute(db);
    try {
      const failed = failures(await verifyF0Copy(db));
      expect(failed).toContain("sutecba_app: DELETE directo → rechazado");
      expect(failed.some((n) => n.startsWith("tabla: sutecba_app tiene SELECT e INSERT"))).toBe(true);
    } finally {
      await sql`revoke delete on public_link_attempts from sutecba_app`.execute(db);
    }
    expect(failures(await verifyF0Copy(db))).toEqual([]);
  });

  it("detecta que anon (o PUBLIC) pueda ejecutar la limpieza", async () => {
    await sql`grant execute on function public.purge_public_link_attempts(integer) to anon`.execute(db);
    try {
      const failed = failures(await verifyF0Copy(db));
      expect(failed).toContain("función: anon NO puede ejecutarla");
      expect(failed).toContain("anon: no puede ejecutar la limpieza");
      expect(failed).toContain("función: EXECUTE solo para el dueño y sutecba_app");
    } finally {
      await sql`revoke all on function public.purge_public_link_attempts(integer) from anon`.execute(db);
    }
    await sql`grant execute on function public.purge_public_link_attempts(integer) to public`.execute(db);
    try {
      expect(failures(await verifyF0Copy(db))).toContain("función: EXECUTE solo para el dueño y sutecba_app");
    } finally {
      await sql`revoke all on function public.purge_public_link_attempts(integer) from public`.execute(db);
    }
    expect(failures(await verifyF0Copy(db))).toEqual([]);
  });

  it("detecta tokens sin sanear, filas perdidas y un permiso mal asignado", async () => {
    await sql`insert into public_link_attempts (scope, identifier, ip_address, succeeded) values ('invitation_view', 'token-en-claro', '10.0.0.6', true)`.execute(db);
    expect(failures(await verifyF0Copy(db))).toContain("0046: no queda ningún token en claro en public_link_attempts");
    await sql`delete from public_link_attempts where identifier = 'token-en-claro'`.execute(db);

    expect(failures(await verifyF0Copy(db, { expectAttemptRows: 999 }))).toContain("0046: no se borró ninguna fila (mismo total que el respaldo)");

    await sql`delete from role_permissions where role_id = (select id from roles where key = 'REUNIONES') and permission_id = (select id from permissions where key = 'meetings.accredit')`.execute(db);
    expect(failures(await verifyF0Copy(db))).toContain("0047: meetings.accredit en ADMIN, MASTER_GLOBAL, OPERADOR, REUNIONES (y en ningún otro rol)");
    await sql`insert into role_permissions (role_id, permission_id) select r.id, p.id from roles r, permissions p where r.key = 'REUNIONES' and p.key = 'meetings.accredit'`.execute(db);
    expect(failures(await verifyF0Copy(db))).toEqual([]);
  });
});
