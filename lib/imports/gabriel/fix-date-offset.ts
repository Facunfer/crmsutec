import { sql, type Kysely, type Transaction } from "kysely";
import type { Database } from "../../db/schema.js";
import { acquireImportLock, assertMasterActor, ImportAbortError } from "./preflight.js";
import type { ImportPlan } from "./plan.js";

/**
 * CORRECCIÓN de las fechas sin hora del primer import histórico.
 *
 * Defecto: el importador escribía `birth_date` y `meetings.event_date` (columnas `date`) pasando un `Date` a `pg`, que lo
 * serializa en la hora LOCAL del proceso. Desde una máquina en UTC-3 cada fecha llegaba UN DÍA ANTES (2026-03-10 → 2026-03-09).
 * En producción: 681 fechas de nacimiento y 22 fechas de reuniones (todas). El código ya no lo hace (lib/db/date-only.ts).
 *
 * Esta corrección es DIRIGIDA y verificable contra la fuente:
 *   - la fecha esperada sale del mismo plan que se aplicó (origen de verdad = los archivos originales);
 *   - solo se toca una fila si su valor actual es EXACTAMENTE «esperada − 1 día» (el desfase conocido);
 *   - una fila ya correcta, editada después o distinta por otro motivo NO se toca (se informa);
 *   - solo `origin = 'import'`; nada más que esas dos columnas; idempotente (una segunda corrida no cambia nada).
 */
export interface DateOffsetFinding {
  people: { expected: number; toFix: number; alreadyCorrect: number; other: number };
  meetings: { expected: number; toFix: number; alreadyCorrect: number; other: number };
}

interface Targets {
  people: Array<{ dni: string; date: string }>;
  meetings: Array<{ key: string; date: string }>;
}

export function expectedDateTargets(plan: ImportPlan): Targets {
  return {
    people: plan.people.toCreate.filter((p) => p.birthDate).map((p) => ({ dni: p.dni, date: p.birthDate! })),
    meetings: plan.events.toCreate.filter((e) => e.schedulePrecision !== "exact_datetime" && e.eventDate).map((e) => ({ key: e.key, date: e.eventDate! })),
  };
}

type Trx = Transaction<Database> | Kysely<Database>;

async function classify(db: Trx, targets: Targets): Promise<DateOffsetFinding & { fixPeople: Targets["people"]; fixMeetings: Targets["meetings"] }> {
  const peopleRows = await sql<{ dni: string; d: string }>`
    select dni, to_char(birth_date, 'YYYY-MM-DD') as d from people where origin = 'import' and birth_date is not null and dni = any(${targets.people.map((p) => p.dni)}::text[])
  `.execute(db);
  const meetingRows = await sql<{ key: string; d: string }>`
    select source_event_key as key, to_char(event_date, 'YYYY-MM-DD') as d from meetings where origin = 'import' and event_date is not null and source_event_key = any(${targets.meetings.map((m) => m.key)}::text[])
  `.execute(db);
  const dayBefore = (iso: string) => new Date(Date.parse(`${iso}T00:00:00Z`) - 86400000).toISOString().slice(0, 10);
  const run = <K extends "dni" | "key">(expected: Array<{ date: string } & Record<K, string>>, key: K, rows: Array<{ d: string } & Record<string, string>>) => {
    const byKey = new Map(rows.map((r) => [r[key]!, r.d]));
    const fix: typeof expected = [];
    let correct = 0;
    let other = 0;
    for (const e of expected) {
      const current = byKey.get(e[key]);
      if (current === undefined) continue; // no está en la base (no importada / sin fecha): fuera del alcance
      if (current === e.date) correct += 1;
      else if (current === dayBefore(e.date)) fix.push(e);
      else other += 1;
    }
    return { fix, correct, other };
  };
  const p = run(targets.people, "dni", peopleRows.rows);
  const m = run(targets.meetings, "key", meetingRows.rows);
  return {
    people: { expected: targets.people.length, toFix: p.fix.length, alreadyCorrect: p.correct, other: p.other },
    meetings: { expected: targets.meetings.length, toFix: m.fix.length, alreadyCorrect: m.correct, other: m.other },
    fixPeople: p.fix,
    fixMeetings: m.fix,
  };
}

/** Solo lectura: qué se corregiría. */
export async function findDateOffset(db: Kysely<Database>, plan: ImportPlan): Promise<DateOffsetFinding> {
  const { fixPeople: _p, fixMeetings: _m, ...finding } = await db.transaction().execute(async (trx) => {
    await sql`set transaction read only`.execute(trx);
    return classify(trx, expectedDateTargets(plan));
  });
  return finding;
}

export interface FixOptions {
  createdBy: string;
  /** Si se indica, se ABORTA si la cantidad a corregir no es exactamente esta (evita corregir de más). */
  expectPeople?: number;
  expectMeetings?: number;
}

export async function applyDateOffsetFix(db: Kysely<Database>, plan: ImportPlan, options: FixOptions): Promise<DateOffsetFinding & { fixedPeople: number; fixedMeetings: number }> {
  return db.transaction().execute(async (trx) => {
    await acquireImportLock(trx);
    await assertMasterActor(trx, options.createdBy);
    const found = await classify(trx, expectedDateTargets(plan));
    if (options.expectPeople !== undefined && found.people.toFix !== options.expectPeople) throw new ImportAbortError(`Se esperaban ${options.expectPeople} fechas de personas a corregir y hay ${found.people.toFix}: no se corrige nada.`);
    if (options.expectMeetings !== undefined && found.meetings.toFix !== options.expectMeetings) throw new ImportAbortError(`Se esperaban ${options.expectMeetings} fechas de reuniones a corregir y hay ${found.meetings.toFix}: no se corrige nada.`);

    let fixedPeople = 0;
    for (let i = 0; i < found.fixPeople.length; i += 500) {
      const chunk = found.fixPeople.slice(i, i + 500);
      const r = await sql<{ id: string }>`
        update people p set birth_date = v.d::date
        from unnest(${chunk.map((c) => c.dni)}::text[], ${chunk.map((c) => c.date)}::text[]) as v(dni, d)
        where p.dni = v.dni and p.origin = 'import' and p.birth_date = v.d::date - 1
        returning p.id
      `.execute(trx);
      fixedPeople += r.rows.length;
    }
    let fixedMeetings = 0;
    for (let i = 0; i < found.fixMeetings.length; i += 500) {
      const chunk = found.fixMeetings.slice(i, i + 500);
      const r = await sql<{ id: string }>`
        update meetings m set event_date = v.d::date
        from unnest(${chunk.map((c) => c.key)}::text[], ${chunk.map((c) => c.date)}::text[]) as v(k, d)
        where m.source_event_key = v.k and m.origin = 'import' and m.event_date = v.d::date - 1
        returning m.id
      `.execute(trx);
      fixedMeetings += r.rows.length;
    }
    if (fixedPeople !== found.people.toFix || fixedMeetings !== found.meetings.toFix) {
      throw new ImportAbortError("La cantidad realmente corregida no coincide con la detectada: se revierte todo.");
    }
    const { fixPeople: _p, fixMeetings: _m, ...finding } = found;
    return { ...finding, fixedPeople, fixedMeetings };
  });
}
