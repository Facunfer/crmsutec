import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { sql, type Kysely } from "kysely";

/**
 * Verificación de F0 sobre una COPIA restaurada (PGlite descartable) con el rol de runtime REAL de producción (`SET ROLE sutecba_app`),
 * para que los GRANT y la RLS sí se hagan cumplir. Todo ocurre dentro de UNA transacción que SIEMPRE se revierte: la copia queda
 * exactamente como estaba. Nunca imprime datos personales: solo nombres de verificaciones, roles y cantidades.
 *
 *   1) npm run backup:logical -- --out-dir <fuera del repo> --label pre-f0        (solo lectura sobre producción)
 *   2) npx tsx scripts/restore-logical-backup.ts --backup <carpeta> --keep       (restaura + aplica 0046/0047 SOLO en la copia)
 *   3) npx tsx scripts/verify-f0-copy.ts --data-dir <.../pglite de esa copia> [--backup <carpeta del paso 1>]
 *
 * Es imposible que toque producción: borra las URLs de Postgres del entorno y fuerza SUTECBA_ENV=test antes de abrir la base.
 */

export interface CheckResult {
  name: string;
  ok: boolean;
  detail?: string;
}

const REVOKED = ["anon", "authenticated", "service_role"];
const SENTINEL = "F0_VERIFY_ROLLBACK";

export async function verifyF0Copy(db: Kysely<any>, opts: { expectAttemptRows?: number } = {}): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  const check = (name: string, ok: boolean, detail?: string) => results.push({ name, ok, detail });

  try {
    await db.transaction().execute(async (trx) => {
      const rows = async <T extends object>(q: ReturnType<typeof sql<T>>) => (await q.execute(trx)).rows;
      const one = async <T extends object>(q: ReturnType<typeof sql<T>>) => (await rows(q))[0]!;
      let sp = 0;
      /** Ejecuta algo que DEBE ser rechazado; un savepoint evita abortar la transacción. */
      const expectDenied = async (name: string, statement: () => Promise<unknown>, pattern: RegExp) => {
        const label = `v${(sp += 1)}`;
        await sql.raw(`savepoint ${label}`).execute(trx);
        try {
          await statement();
          check(name, false, "NO fue rechazado");
        } catch (e) {
          const message = String((e as Error).message);
          check(name, pattern.test(message), message.slice(0, 100));
        } finally {
          await sql.raw(`rollback to savepoint ${label}`).execute(trx);
        }
      };
      /** Ejecuta algo que DEBE funcionar y lo deshace. */
      const expectAllowed = async (name: string, statement: () => Promise<unknown>) => {
        const label = `v${(sp += 1)}`;
        await sql.raw(`savepoint ${label}`).execute(trx);
        try {
          await statement();
          check(name, true);
        } catch (e) {
          check(name, false, String((e as Error).message).slice(0, 100));
        } finally {
          await sql.raw(`rollback to savepoint ${label}`).execute(trx);
        }
      };
      const roleExists = async (r: string) => (await one(sql<{ x: boolean }>`select exists (select 1 from pg_roles where rolname = ${r}) as x`)).x;

      // ---------------------------------------------------------------- catálogo (como dueño)
      const fn = (await rows(sql<{ definer: boolean; owner: string; cfg: string | null }>`
        select p.prosecdef definer, pg_get_userbyid(p.proowner) owner, array_to_string(p.proconfig, ',') cfg
        from pg_proc p where p.proname = 'purge_public_link_attempts' and p.pronamespace = 'public'::regnamespace`))[0];
      check("0046 aplicada: existe purge_public_link_attempts", !!fn);
      if (fn) {
        check("función: SECURITY DEFINER con search_path fijo", fn.definer && fn.cfg === "search_path=public, pg_temp", `dueño=${fn.owner} config=${fn.cfg}`);
        const tableOwner = (await one(sql<{ o: string }>`select pg_get_userbyid(relowner) o from pg_class where oid = 'public.public_link_attempts'::regclass`)).o;
        check("función: el dueño es el de la tabla (puede borrar con sus privilegios)", fn.owner === tableOwner, `función=${fn.owner} tabla=${tableOwner}`);
        const grantees = (await rows(sql<{ g: string }>`select distinct case a.grantee when 0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end g
          from pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
          where p.proname = 'purge_public_link_attempts' and p.pronamespace = 'public'::regnamespace and a.privilege_type = 'EXECUTE' order by 1`)).map((r) => r.g);
        check("función: EXECUTE solo para el dueño y sutecba_app", JSON.stringify(grantees) === JSON.stringify([fn.owner, "sutecba_app"].sort()), grantees.join(", "));
        for (const r of REVOKED) {
          if (!(await roleExists(r))) continue;
          const can = (await one(sql<{ x: boolean }>`select has_function_privilege(${r}, 'public.purge_public_link_attempts(integer)', 'EXECUTE') as x`)).x;
          check(`función: ${r} NO puede ejecutarla`, !can);
        }
      }
      const cp = async (c: string) => (await one(sql<{ x: boolean }>`select has_column_privilege('sutecba_app', 'public.public_link_attempts', ${c}, 'UPDATE') as x`)).x;
      check("tabla: UPDATE de sutecba_app solo sobre la columna succeeded", (await cp("succeeded")) && !(await cp("identifier")) && !(await cp("ip_address")) && !(await cp("scope")) && !(await cp("created_at")));
      const tp = async (p: string) => (await one(sql<{ x: boolean }>`select has_table_privilege('sutecba_app', 'public.public_link_attempts', ${p}) as x`)).x;
      check("tabla: sutecba_app tiene SELECT e INSERT y NO tiene DELETE ni TRUNCATE ni UPDATE de tabla completa", (await tp("SELECT")) && (await tp("INSERT")) && !(await tp("DELETE")) && !(await tp("TRUNCATE")) && !(await tp("UPDATE")));
      const pol = (await one(sql<{ n: number }>`select count(*)::int n from pg_policies where tablename = 'public_link_attempts' and 'sutecba_app' = any(roles)`)).n;
      check("RLS: política vigente para sutecba_app", pol > 0);

      const unsanitized = (await one(sql<{ n: number }>`select count(*)::int n from public_link_attempts where scope in ('invitation_view','invitation_respond','invitation_checkin','checkin_qr') and identifier not like 'h1:%'`)).n;
      check("0046: no queda ningún token en claro en public_link_attempts", unsanitized === 0, `sin sanear=${unsanitized}`);
      if (opts.expectAttemptRows !== undefined) {
        const n = (await one(sql<{ n: number }>`select count(*)::int n from public_link_attempts`)).n;
        check("0046: no se borró ninguna fila (mismo total que el respaldo)", n === opts.expectAttemptRows, `copia=${n} respaldo=${opts.expectAttemptRows}`);
      }
      const accredit = (await rows(sql<{ k: string }>`select r.key k from role_permissions rp join roles r on r.id = rp.role_id join permissions p on p.id = rp.permission_id where p.key = 'meetings.accredit' order by 1`)).map((r) => r.k);
      check("0047: meetings.accredit en ADMIN, MASTER_GLOBAL, OPERADOR, REUNIONES (y en ningún otro rol)", JSON.stringify(accredit) === JSON.stringify(["ADMIN", "MASTER_GLOBAL", "OPERADOR", "REUNIONES"]), accredit.join(", "));

      // ---------------------------------------------------------------- como sutecba_app (rol de runtime real)
      await sql`set local role sutecba_app`.execute(trx);
      check("sesión como sutecba_app", (await one(sql<{ u: string }>`select current_user u`)).u === "sutecba_app");

      await expectAllowed("sutecba_app: lee public_link_attempts", () => sql`select count(*) from public_link_attempts`.execute(trx));
      await expectAllowed("sutecba_app: inserta un intento", () => sql`insert into public_link_attempts (scope, identifier, ip_address, succeeded) values ('f0_verify', 'x', '10.0.0.1', false)`.execute(trx));
      await expectAllowed("sutecba_app: completa succeeded", async () => {
        await sql`insert into public_link_attempts (scope, identifier, ip_address, succeeded) values ('f0_verify', 'y', '10.0.0.1', false)`.execute(trx);
        await sql`update public_link_attempts set succeeded = true where scope = 'f0_verify'`.execute(trx);
      });
      await expectDenied("sutecba_app: DELETE directo → rechazado", () => sql`delete from public_link_attempts where scope = 'f0_verify'`.execute(trx), /permission denied/i);
      await expectDenied("sutecba_app: UPDATE de identifier → rechazado", () => sql`update public_link_attempts set identifier = 'z' where false`.execute(trx), /permission denied/i);
      await expectDenied("sutecba_app: UPDATE de created_at → rechazado", () => sql`update public_link_attempts set created_at = now() where false`.execute(trx), /permission denied/i);
      await expectDenied("sutecba_app: TRUNCATE → rechazado", () => sql`truncate public_link_attempts`.execute(trx), /permission denied/i);
      await expectAllowed("sutecba_app: toma locks consultivos (límite atómico)", () => sql`select pg_advisory_xact_lock(hashtextextended('f0-verify', 0))`.execute(trx));
      await expectAllowed("sutecba_app: ejecuta la limpieza (SECURITY DEFINER) sin tener DELETE", () => sql`select public.purge_public_link_attempts(30)`.execute(trx));
      await expectDenied("sutecba_app: la limpieza rechaza retención 0", () => sql`select public.purge_public_link_attempts(0)`.execute(trx), /retention_days/);
      await expectAllowed("sutecba_app: lee lo que usan las reglas nuevas (formularios, acciones, asociaciones, árbol de unidades)", async () => {
        await sql`select count(*) from forms`.execute(trx);
        await sql`select count(*) from form_actions`.execute(trx);
        await sql`select count(*) from associations`.execute(trx);
        await sql`select count(*) from people_associations`.execute(trx);
        await sql`select count(*) from organization_descendants((select id from organizations limit 1))`.execute(trx);
      });
      await expectAllowed("sutecba_app: resuelve permisos (role_permissions ↔ permissions)", () => sql`select count(*) from role_permissions rp join permissions p on p.id = rp.permission_id where p.key = 'meetings.accredit'`.execute(trx));

      for (const r of REVOKED) {
        if (!(await roleExists(r))) continue;
        await sql`reset role`.execute(trx);
        await sql.raw(`set local role ${r}`).execute(trx);
        await expectDenied(`${r}: no puede ejecutar la limpieza`, () => sql`select public.purge_public_link_attempts(1)`.execute(trx), /permission denied/i);
        await sql`reset role`.execute(trx);
      }
      throw new Error(SENTINEL); // SIEMPRE se revierte: la copia queda intacta
    });
  } catch (e) {
    if ((e as Error).message !== SENTINEL) check("la verificación terminó sin errores inesperados", false, String((e as Error).message).slice(0, 160));
  }
  return results;
}

async function main() {
  const argv = process.argv.slice(2);
  const value = (n: string) => {
    const i = argv.indexOf(`--${n}`);
    return i !== -1 && argv[i + 1] && !argv[i + 1]!.startsWith("--") ? argv[i + 1] : undefined;
  };
  const dataDir = value("data-dir");
  if (!dataDir || !existsSync(resolve(dataDir))) throw new Error("Falta --data-dir <carpeta pglite de la copia restaurada> (la que dejó restore-logical-backup.ts --keep).");
  // Imposible tocar producción: sin URLs de Postgres y en modo test, antes de abrir nada.
  delete process.env.SUTECBA_DATABASE_URL;
  delete process.env.SUTECBA_MIGRATION_DATABASE_URL;
  process.env.SUTECBA_ENV = "test";
  process.env.SUTECBA_PGLITE_DATA_DIR = resolve(dataDir);

  let expectAttemptRows: number | undefined;
  if (value("backup")) {
    const manifest = JSON.parse(readFileSync(join(resolve(value("backup")!), "MANIFEST.json"), "utf-8")) as { tablas: Record<string, { filas: number }> };
    expectAttemptRows = manifest.tablas.public_link_attempts?.filas;
  }
  const { getDb, closeDb } = await import("../lib/db/client.js");
  try {
    const results = await verifyF0Copy(await getDb(), { expectAttemptRows });
    for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.detail ? "  — " + r.detail : ""}`);
    const failed = results.filter((r) => !r.ok);
    console.log(`\nRESUMEN: ${results.length - failed.length}/${results.length} PASS, ${failed.length} FAIL → ${failed.length ? "BLOCKER" : "PASS"}`);
    process.exitCode = failed.length ? 2 : 0;
  } finally {
    await closeDb();
  }
}

if (process.argv[1] && /verify-f0-copy\.(ts|js)$/.test(process.argv[1])) {
  main().catch((err) => {
    console.error("verify-f0-copy:", String((err as Error).message).replace(/postgres(ql)?:\/\/\S+/gi, "[url]"));
    process.exit(1);
  });
}
