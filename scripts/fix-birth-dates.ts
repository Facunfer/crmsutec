import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { sql } from "kysely";
import { closeDb, getDb } from "../lib/db/client.js";
import { dateOnly } from "../lib/db/date-only.js";
import { loadEnv } from "../lib/db/env.js";
import { assertApplyEnvironment, assertDatabasePreconditions, assertMasterActor, assertRuntimeRole, ImportAbortError } from "../lib/imports/gabriel/preflight.js";
import { parseBirthDateDecisions, type BirthDateDecision, type RawBirthDateDecisionRow } from "../lib/people/birth-date-decisions.js";
import { writeFileSync, mkdirSync } from "node:fs";

/**
 * Corrección puntual de `people.birth_date` absurdas del histórico, a partir de decisiones humanas ya aprobadas
 * (ver birth_dates_historicas_revision.xlsx / tools/birth-date-decisions-extract.py / lib/people/birth-date-decisions.ts).
 *
 * NUNCA reinterpreta un año por su cuenta: aplica EXACTAMENTE la fecha candidata que aprobó una persona para
 * SOURCE_CONFIRMS_CORRECTION, o pone NULL para INVALID_SOURCE (también una decisión humana explícita).
 * AMBIGUOUS_SOURCE y REVIEW_LATER nunca se tocan.
 *
 *   npm run people:fix-birth-dates -- --decisions <json> [--apply --yes --created-by <uuid>]
 *
 * Sin --apply: dry-run (default), no escribe nada. Con --apply: exige --yes y --created-by (MASTER_GLOBAL activo).
 * Control de concurrencia por fila: si el `birth_date` actual no coincide con el que tenía la fila cuando se
 * revisó (y tampoco con la fecha candidata, que indicaría que ya se aplicó antes), se aborta TODO sin escribir nada.
 * Todo corre en una única transacción. Es idempotente: una segunda corrida no vuelve a tocar filas ya corregidas.
 */

interface RunOptions {
  decisionsPath: string;
  apply: boolean;
  yes: boolean;
  createdBy?: string;
}

export interface FixBirthDatesRowOutcome {
  decision: BirthDateDecision["decision"];
  outcome: "would_update" | "updated" | "already_applied" | "skipped_no_action";
}

export interface FixBirthDatesResult {
  mode: "dry_run" | "apply";
  total: number;
  toCorrect: number;
  toNull: number;
  skipped: number;
  updated: number;
  alreadyApplied: number;
  reportPath: string | null;
}

function parseArgs(argv: string[]): RunOptions {
  const value = (n: string) => {
    const i = argv.indexOf(`--${n}`);
    return i !== -1 && argv[i + 1] && !argv[i + 1]!.startsWith("--") ? argv[i + 1] : undefined;
  };
  const decisionsPath = value("decisions");
  if (!decisionsPath) throw new ImportAbortError("Falta --decisions <archivo.json> (extracto de tools/birth-date-decisions-extract.py).");
  return { decisionsPath: resolve(decisionsPath), apply: argv.includes("--apply"), yes: argv.includes("--yes"), createdBy: value("created-by") };
}

export async function runFixBirthDates(options: RunOptions): Promise<FixBirthDatesResult> {
  const env = loadEnv();
  if (options.apply) {
    assertApplyEnvironment({ env, yes: options.yes });
    if (!options.yes) throw new ImportAbortError("--apply exige --yes explícito.");
    if (!options.createdBy) throw new ImportAbortError("--apply exige --created-by <uuid>.");
  }

  const raw = JSON.parse(readFileSync(options.decisionsPath, "utf-8")) as { source_file: string; source_sha256: string; rows: RawBirthDateDecisionRow[] };

  const db = await getDb();
  const runtime = await assertRuntimeRole(db, env);
  await assertDatabasePreconditions(db, env);

  const decisions = parseBirthDateDecisions(raw.rows);

  const outcomes: Array<{ dni_suffix: string } & FixBirthDatesRowOutcome> = [];
  let updated = 0;
  let alreadyApplied = 0;

  class DryRunRollback extends Error {}

  const apply = async () => {
    return db.transaction().execute(async (trx) => {
      await sql`select pg_advisory_xact_lock(hashtext('sutecba:maintenance:fix-birth-dates'))`.execute(trx);
      if (options.createdBy) await assertMasterActor(trx, options.createdBy);

      for (const d of decisions) {
        if (d.decision === "AMBIGUOUS_SOURCE" || d.decision === "REVIEW_LATER") {
          outcomes.push({ dni_suffix: d.dni.slice(-3), decision: d.decision, outcome: "skipped_no_action" });
          continue;
        }
        const person = await trx.selectFrom("people").select(["id"]).where("dni", "=", d.dni).where("status", "!=", "merged").executeTakeFirst();
        if (!person) throw new ImportAbortError(`DNI ***${d.dni.slice(-3)}: no existe en people (o está fusionado). Se revierte todo: repetí la revisión.`);

        const target = d.decision === "SOURCE_CONFIRMS_CORRECTION" ? d.candidateBirthDate! : null;
        const current = await trx.selectFrom("people").select(["id"]).where("dni", "=", d.dni).where("status", "!=", "merged").where((eb) => (target ? eb("birth_date", "=", dateOnly(target)!) : eb("birth_date", "is", null))).executeTakeFirst();
        if (current) {
          // Ya tiene exactamente el valor objetivo: corrida anterior ya lo aplicó (o coincide por otra vía). Idempotente: no hace nada más.
          outcomes.push({ dni_suffix: d.dni.slice(-3), decision: d.decision, outcome: "already_applied" });
          alreadyApplied += 1;
          continue;
        }
        const expected = await trx.selectFrom("people").select(["id"]).where("dni", "=", d.dni).where("status", "!=", "merged").where("birth_date", "=", dateOnly(d.expectedCurrentBirthDate)!).executeTakeFirst();
        if (!expected) {
          throw new ImportAbortError(`DNI ***${d.dni.slice(-3)}: birth_date cambió desde la revisión (no coincide ni con el valor esperado ni con el objetivo). Se revierte todo: repetí la revisión.`);
        }
        if (options.apply) {
          await trx
            .updateTable("people")
            .set({ birth_date: target ? dateOnly(target) : null, updated_by: options.createdBy })
            .where("id", "=", expected.id)
            .where("birth_date", "=", dateOnly(d.expectedCurrentBirthDate)!)
            .execute();
        }
        outcomes.push({ dni_suffix: d.dni.slice(-3), decision: d.decision, outcome: options.apply ? "updated" : "would_update" });
        updated += 1;
      }
      if (!options.apply) throw new DryRunRollback();
    });
  };

  try {
    await apply();
  } catch (err) {
    if (!(err instanceof DryRunRollback)) throw err;
  }

  const toCorrect = decisions.filter((d) => d.decision === "SOURCE_CONFIRMS_CORRECTION").length;
  const toNull = decisions.filter((d) => d.decision === "INVALID_SOURCE").length;
  const skipped = decisions.filter((d) => d.decision === "AMBIGUOUS_SOURCE" || d.decision === "REVIEW_LATER").length;

  let reportPath: string | null = null;
  if (options.apply) {
    const dir = resolve("data/people/reports");
    mkdirSync(dir, { recursive: true });
    reportPath = resolve(dir, `fix-birth-dates-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
    writeFileSync(
      reportPath,
      JSON.stringify(
        {
          generado: new Date().toISOString(),
          modo: "apply",
          entorno: env.SUTECBA_ENV,
          runtime_role: runtime.role,
          decisions_file: { archivo: raw.source_file, sha256: raw.source_sha256 },
          created_by: options.createdBy,
          resultados: outcomes,
          resumen: { total: decisions.length, actualizados: updated, ya_aplicados: alreadyApplied, sin_accion: skipped },
        },
        null,
        2
      ),
      "utf-8"
    );
  }

  return { mode: options.apply ? "apply" : "dry_run", total: decisions.length, toCorrect, toNull, skipped, updated, alreadyApplied, reportPath };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const result = await runFixBirthDates(options);
  console.log(JSON.stringify(result, null, 2));
  await closeDb();
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().catch((err: unknown) => {
    console.error(`[people:fix-birth-dates] ${err instanceof ImportAbortError ? "ABORTADO" : "error"}: ${String((err as Error).message ?? err).replace(/postgres(ql)?:\/\/\S+/gi, "[url]")}`);
    process.exitCode = 1;
  });
}
