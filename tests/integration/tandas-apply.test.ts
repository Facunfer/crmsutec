import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Apply de las tandas 1 y 2 con fuentes SINTÉTICAS (sin datos personales reales) sobre PGlite:
 * hash incorrecto, falla parcial + reintento, idempotencia (segunda corrida), copias idénticas, LE/LC/CI bloqueadas,
 * persona con nombre sin separar, etiqueta/observación de abogados, cero interacciones y cero asistencia.
 */
process.env.SUTECBA_ENV = "test";
process.env.SUTECBA_PGLITE_DATA_DIR = `.data/pglite-test-${randomUUID()}`;

const { applyMigrations, parseFlags } = await import("../../scripts/migrate.js");
const { runSeed } = await import("../../scripts/seed.js");
const { closeDb, getDb } = await import("../../lib/db/client.js");
const { createTestOrganization } = await import("../helpers/organization.js");
const { hashPassword } = await import("../../lib/auth/passwords.js");
const { runTandasImport } = await import("../../lib/imports/tandas/apply.js");
const { readTandasSnapshot } = await import("../../lib/imports/tandas/snapshot.js");
const { buildTandasPlan } = await import("../../lib/imports/tandas/plan.js");
const { parseTandaFile } = await import("../../lib/imports/tandas/sources.js");
const { cuilCheckDigit } = await import("../../lib/imports/gabriel/normalize.js");
const { ImportAbortError } = await import("../../lib/imports/gabriel/preflight.js");

const dataDir = process.env.SUTECBA_PGLITE_DATA_DIR!;
let ownerOrgId: string;
let userId: string;

const cuilFor = (dni: string) => {
  const first10 = `20${dni.padStart(8, "0")}`;
  return `${first10}${cuilCheckDigit(first10)}`;
};

const file = (code: string, name: string, sheets: Array<{ name: string; rows: any[][] }>, sha: string) => ({
  fileCode: code,
  fileName: name,
  sha256: sha.repeat(64).slice(0, 64),
  sizeBytes: 1000,
  sheets: sheets.map((s) => ({ name: s.name, rows: s.rows.map((cells, i) => ({ n: i + 1, cells })) })),
});

const listado = (code: string, name: string, course: string, when: string, dnis: string[], sha: string) =>
  file(code, name, [
    {
      name: "Listado alumnos",
      rows: [
        [null, "Descargue el archivo"], [null, "TODOS LOS DATOS"], [null, "ACCESO AL FORMULARIO"], [], [],
        [null, "Número de Cursada", course], [null, "Fecha y hora:", when],
        [null, "CUIL (sin guiones)", "Apellidos", "Nombres", "Fecha de Ingreso", "Modalidad", "Repartición (nombre completo ):", "Área en la que se desempeña (nombre completo)"],
        ...dnis.map((d, i) => [i + 1, Number(cuilFor(d)), `Apellido${d}`, `Nombre${d}`, 2010, "Planta", "Repartición desconocida", "Area"]),
        [dnis.length + 1], [dnis.length + 2],
      ],
    },
    { name: "Hoja 2", rows: [[], [null, "CUIL (sin guiones)"]] },
  ], sha);

const T04 = file("T04", "PADRON.xlsx", [
  {
    name: "Padron definitivo",
    rows: [
      ["Apellido y Nombre", "Tomo", "Folio", "Sexo", "Tipo", "Nro. Doc.", "Colegio donde vota"],
      ["ALVAREZ CID NESTOR EDUARDO", 1, 1, "M", "DNI", 30111111, "CPACF"],
      ["LOPEZ MARIA", 2, 2, "F", "DU", 30111112, "La Plata"],
      ["GOMEZ ANA", 3, 3, "F", "DNI", 30111113, "Rosario"],
      ["RUIZ CARLOS", 4, 4, "M", "DNI", 30111114, "Mendoza"], // contradice a «Perez Juan» ya cargado con ese DNI
      ["SOSA JORGE", 5, 5, "M", "LE", 5111111, "Salta"], // tipo documental no soportado
      [],
    ],
  },
  { name: "Estadisticas", rows: [[], []] },
], "1");

const T05 = file("T05", "Oftalmo Teatro Colon.xlsx", [
  {
    name: "Respuestas de formulario 1",
    rows: [
      ["Marca temporal", "Dirección de correo electrónico", "Apellido", "Nombre", "Correo Electrónico", "DNI", "Fecha de Nacimiento", "Edad", "Obra Social/Prepaga", "Número de Afiliado", "Es afiliado a SUTECBA", "Cel de Contacto", "Ministerio "],
      [{ $datetime: "2026-03-18T16:30:49" }, "a@x.com", "Gomez", "Ana", "a@x.com", 30111113, { $date: "1981-05-22" }, 44, "ObsBA", "0", "SI", 1155551111, "Cultura"],
      [{ $datetime: "2026-03-18T16:31:49" }, "m@x.com", "Lopez", "Maria", "m@x.com", 30111112, { $date: "1979-06-07" }, 46, "Otra", "0", "NO", 1155552222, "Cultura"],
    ],
  },
], "2");

const T01 = file("T01", "Dengue.xlsx", [{ name: "Respuestas de formulario 1", rows: [["Marca temporal", "Apellido", "Nombre", "Edad", "DNI", "Celular", "Repartición en la que presta servicios"], [{ $datetime: "2026-08-13T10:30:12" }, "Lopez", "Maria", 46, 30111112, 1155552222, "Jefatura"]] }], "3");
const T15 = file("T15", "Antigripal.xlsx", [{ name: "Respuestas de formulario 1", rows: [["Marca temporal", "Repartición", "NOMBRE Y APELLIDO", "CELULAR", "DOCUMENTO", "EDAD", "FECHA DE NACIMIENTO", "ES AFILIADO A SUTECBA?", "MAIL", "VACUNA ANTIGRIPAL", "VAC. ANTIGRIPAL MAYOR DE 65 AÑOS", "VAC. PREVENAR 20", "VA. COVID"], [{ $datetime: "2026-03-30T09:49:18" }, "Salud", "LOPEZ MARIA", 1155552222, 30111112, 46, { $date: "1979-06-07" }, "SI", "m@x.com", "ANTIGRIPAL", null, null, "COVID"], [{ $datetime: "2026-03-30T09:59:18" }, "Salud", "PEREZ PEDRO", 1144443333, 30111115, 50, { $date: "1975-01-01" }, "NO", "p@x.com", "ANTIGRIPAL", null, null, null]] }], "4");
const T20 = listado("T20", "52016 a.xlsx", "52016", "30/09/2026 10 a 13 hs.", ["30222221", "30222222"], "5");
const T21 = listado("T21", "52016 b.xlsx", "52016", "30/09/2026 10 a 13 hs.", ["30222221", "30222222"], "5"); // copia idéntica (mismo sha)

// NOTA: T21 comparte sha256 con T20 (misma copia física): el apply guarda ambas procedencias solo si hay 2 archivos distintos.
const T21b = { ...T21, sha256: "6".repeat(64) };
const FILES = [T01, T04, T05, T15, T20, T21b] as any[];

const count = async (table: string) => {
  const db = await getDb();
  return Number(((await (db as any).selectFrom(table).select((eb: any) => eb.fn.countAll().as("n")).executeTakeFirstOrThrow()) as any).n);
};
const snapshotCounts = async () => ({
  people: await count("people"), meetings: await count("meetings"), participations: await count("meeting_participations"), interactions: await count("person_interactions"),
  attendance: await count("meeting_attendance"), batches: await count("import_batches"), rows: await count("import_rows"), obs: await count("person_observations"), tags: await count("person_tags"),
});

const planHash = async () => {
  const db = await getDb();
  const { snap } = await db.transaction().execute(async (trx) => readTandasSnapshot(trx));
  return buildTandasPlan(FILES.map((f) => parseTandaFile(f)), snap);
};

beforeAll(async () => {
  await applyMigrations(parseFlags(["--allow-destructive"]));
  await runSeed();
  ownerOrgId = await createTestOrganization();
  const db = await getDb();
  const role = await db.selectFrom("roles").select("id").where("key", "=", "MASTER_GLOBAL").executeTakeFirstOrThrow();
  const user = await db.insertInto("users").values({ email: "tandas-apply@sutecba.local", password_hash: await hashPassword("x-password-123"), full_name: "Actor", role_id: role.id, status: "active" } as never).returning("id").executeTakeFirstOrThrow();
  userId = user.id;
  // Estado previo: Ana Gomez y Juan Perez ya cargados; Ana ya participó de la campaña de Teatro Colón (histórico).
  const ana = await db.insertInto("people").values({ first_name: "Ana", last_name: "Gomez", dni: "30111113", email: "ana@old.com" } as never).returning("id").executeTakeFirstOrThrow();
  await db.insertInto("people").values({ first_name: "Juan", last_name: "Perez", dni: "30111114" } as never).execute();
  await db.insertInto("meeting_participations").values({ person_id: ana.id, campaign_key: "ophthalmology:teatro-colon", participation_kind: "participated", participation_basis: "legacy_initial_import" } as never).execute();
});

afterAll(async () => {
  await closeDb();
  await new Promise((resolve) => setTimeout(resolve, 100));
  rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

describe("apply de las tandas 1 y 2", () => {
  let hash: string;
  const opts = () => ({ ownerOrganizationId: ownerOrgId, createdBy: userId, confirmedPlanHash: hash });

  it("el dry-run clasifica lo esperado: 3 altas + matches, 1 conflicto de nombre, 1 LE bloqueada, hecho ya existente reutilizado", async () => {
    const plan = await planHash();
    hash = plan.planHash;
    expect(plan.blockCounts).toEqual({ NAME_CONFLICT_WITH_EXISTING_PERSON: 1 });
    expect(plan.blocked.some((b) => b.reason === "DOC_TYPE_NOT_DNI")).toBe(true);
    expect(plan.persons.matches).toBe(1); // solo Ana; Perez (30111114) queda bloqueado por conflicto de nombre
    expect(plan.newPersonSpecs.find((p) => p.dni === "30111111")).toMatchObject({ unsplit: true, first: "", last: "ALVAREZ CID NESTOR EDUARDO", fullOriginal: "ALVAREZ CID NESTOR EDUARDO" });
    expect(plan.newPersonSpecs.find((p) => p.dni === "30111112")).toMatchObject({ unsplit: false, first: "Maria", last: "Lopez" });
    const ana = plan.facts.find((f) => f.dni === "30111113" && f.dest.startsWith("campaign|ophthalmology:teatro-colon"));
    expect(ana?.existing).toBe(true);
    expect(plan.facts.find((f) => f.dni === "30111112" && f.dest === "campaign|vaccination:2026")?.vaccines.size).toBe(3); // antigripal + covid (T15) + dengue (T01)
  });

  it("hash incorrecto aborta ANTES de escribir", async () => {
    const before = await snapshotCounts();
    await expect(runTandasImport(await getDb(), FILES, { ...opts(), confirmedPlanHash: "0".repeat(64) })).rejects.toThrow(ImportAbortError);
    expect(await snapshotCounts()).toEqual(before);
  });

  it("falla parcial tras las participaciones: el lote queda 'processing' y NO se cierra", async () => {
    await expect(runTandasImport(await getDb(), FILES, { ...opts(), failAfterPhase: "3" })).rejects.toThrow(/Falla simulada/);
    const db = await getDb();
    const batch = await db.selectFrom("import_batches").select(["status", "plan_hash"]).where("source_system", "=", "tandas-1-2-2026-09").executeTakeFirstOrThrow();
    expect(batch).toEqual({ status: "processing", plan_hash: hash });
    expect(await count("person_interactions")).toBe(0);
  });

  it("el hash del plan es el MISMO tras un apply parcial (estado deseado) y el reintento completa sin duplicar", async () => {
    expect((await planHash()).planHash).toBe(hash);
    const result = await runTandasImport(await getDb(), FILES, opts());
    expect(result.outcome).toBe("applied");
    const db = await getDb();
    const batches = await db.selectFrom("import_batches").select(["id", "status"]).where("source_system", "=", "tandas-1-2-2026-09").execute();
    expect(batches).toHaveLength(1);
    expect(batches[0]!.status).toBe("applied");
  });

  it("resultado: personas, nombre sin separar íntegro, etiqueta y observaciones, participaciones con base explícita, cero interacciones/asistencia", async () => {
    const db = await getDb();
    const alvarez = await db.selectFrom("people").selectAll().where("dni", "=", "30111111").executeTakeFirstOrThrow();
    expect(alvarez).toMatchObject({ first_name: "", last_name: "ALVAREZ CID NESTOR EDUARDO", name_split_status: "unsplit", full_name_original: "ALVAREZ CID NESTOR EDUARDO", origin: "import" });
    const ana = await db.selectFrom("people").selectAll().where("dni", "=", "30111113").executeTakeFirstOrThrow();
    expect(ana).toMatchObject({ first_name: "Ana", last_name: "Gomez", email: "ana@old.com" }); // no se pisa nada
    const juan = await db.selectFrom("people").selectAll().where("dni", "=", "30111114").executeTakeFirstOrThrow();
    expect(juan).toMatchObject({ first_name: "Juan", last_name: "Perez" }); // conflicto: intacto
    expect(await db.selectFrom("people").select("id").where("dni", "=", "5111111").execute()).toHaveLength(0);

    const tags = await db.selectFrom("tags").select(["id", "name"]).execute();
    expect(tags.map((t) => t.name)).toEqual(["abogado"]);
    expect(await count("person_tags")).toBe(3); // Álvarez, López, Gómez (Ruiz bloqueado, Sosa LE bloqueado)
    const obs = await db.selectFrom("person_observations").select(["category", "value"]).orderBy("value").execute();
    expect(obs).toEqual([{ category: "colegio_votacion", value: "CPACF" }, { category: "colegio_votacion", value: "La Plata" }, { category: "colegio_votacion", value: "Rosario" }]);

    const parts = await sql<{ dest: string; kind: string; basis: string; n: number }>`
      select coalesce(mp.campaign_key, m.source_event_key) dest, mp.participation_kind kind, mp.participation_basis basis, count(*)::int n
      from meeting_participations mp left join meetings m on m.id = mp.meeting_id group by 1,2,3 order by 1,2,3`.execute(db);
    expect(parts.rows).toEqual([
      { dest: "ophthalmology:teatro-colon", kind: "participated", basis: "legacy_initial_import", n: 1 }, // Ana: reutilizada, sin fila nueva
      { dest: "ophthalmology:teatro-colon", kind: "participated", basis: "source_business_rule", n: 1 }, // María
      { dest: "training:52016", kind: "registration", basis: "standard", n: 2 }, // inscripción: una por persona aunque haya 2 copias
      { dest: "vaccination:2026", kind: "participated", basis: "source_business_rule", n: 2 }, // María (T01+T15) y Pedro: una por persona
    ]);
    const vaccineEvidence = await db.selectFrom("meeting_participations").select("evidence").where("campaign_key", "=", "vaccination:2026").execute();
    expect(vaccineEvidence.some((e) => /Vacunas: antigripal, covid, dengue/.test(e.evidence ?? ""))).toBe(true);
    expect(await count("person_interactions")).toBe(0);
    expect(await count("meeting_attendance")).toBe(0);

    const meeting = await db.selectFrom("meetings").select(["schedule_precision", "meeting_type", "origin", "status"]).where("source_event_key", "=", "training:52016").executeTakeFirstOrThrow();
    expect(meeting).toMatchObject({ schedule_precision: "exact_datetime", meeting_type: "capacitacion", origin: "import" });
  });

  it("trazabilidad: ambas copias de 52016 quedan como procedencia de UNA participación; las filas bloqueadas quedan en revisión con incidencia", async () => {
    const db = await getDb();
    const links = await sql<{ pid: string; rows: number; files: number }>`
      select l.entity_id pid, count(*)::int rows, count(distinct r.file_id)::int files
      from import_entity_links l join import_rows r on r.id = l.import_row_id
      join meeting_participations mp on mp.id = l.entity_id join meetings m on m.id = mp.meeting_id
      where l.entity_type = 'meeting_participation' and m.source_event_key = 'training:52016' group by 1`.execute(db);
    expect(links.rows).toHaveLength(2);
    expect(links.rows.every((r) => r.rows === 2 && r.files === 2)).toBe(true);
    const inReview = await sql<{ code: string }>`select code from import_issues order by code`.execute(db);
    expect(inReview.rows.map((r) => r.code)).toEqual(["DOC_TYPE_NOT_DNI", "NAME_CONFLICT_WITH_EXISTING_PERSON"]);
    const status = await sql<{ status: string; n: number }>`select status, count(*)::int n from import_rows group by 1 order by 1`.execute(db);
    expect(status.rows.find((r) => r.status === "in_review")?.n).toBe(2);
    expect(status.rows.find((r) => r.status === "staged")).toBeUndefined();
  });

  it("segunda corrida: idempotente (mismo lote, 0 escrituras nuevas) y una copia adicional del archivo tampoco duplica hechos", async () => {
    const before = await snapshotCounts();
    const again = await runTandasImport(await getDb(), FILES, opts());
    expect(again.outcome).toBe("noop_idempotent");
    expect(await snapshotCounts()).toEqual(before);
    const withCopy = [...FILES, { ...T20, fileName: "52016 copia 3.xlsx", sha256: "7".repeat(64) }] as any[];
    const plan = buildTandasPlan(withCopy.map((f) => parseTandaFile(f)), (await (await getDb()).transaction().execute(async (t) => readTandasSnapshot(t))).snap);
    expect(plan.facts.filter((f) => !f.existing)).toHaveLength(0);
  });
});
