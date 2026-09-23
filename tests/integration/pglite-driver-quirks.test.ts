import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

process.env.SUTECBA_ENV = "test";
process.env.SUTECBA_PGLITE_DATA_DIR = `.data/pglite-test-${randomUUID()}`;

const { applyMigrations, parseFlags } = await import("../../scripts/migrate.js");
const { closeDb, getDb } = await import("../../lib/db/client.js");

const dataDir = process.env.SUTECBA_PGLITE_DATA_DIR!;

beforeAll(async () => {
  await applyMigrations(parseFlags(["--allow-destructive"]));
});

afterAll(async () => {
  await closeDb();
  await new Promise((resolve) => setTimeout(resolve, 100));
  rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

/**
 * Encontrado probando bloqueo optimista en Personas (Etapa 4): con
 * PGlite (vía kysely-pglite), `UpdateResult.numUpdatedRows` viene en 0n
 * aunque el UPDATE sí haya afectado la fila. `.returning()` sí refleja
 * el estado real. Este test deja registrado el bug del driver — si algún
 * día se corrige, hay que revisar por qué falla y podés volver a usar
 * numUpdatedRows con confianza.
 */
describe("cuidado: numUpdatedRows no es confiable con PGlite", () => {
  it("un UPDATE que sí matchea reporta numUpdatedRows=0n de todas formas", async () => {
    const db = await getDb();
    const created = await db
      .insertInto("people")
      .values({ first_name: "Quirk", last_name: "Test", dni: "50000001" })
      .returning("id")
      .executeTakeFirstOrThrow();

    const result = await db
      .updateTable("people")
      .set({ first_name: "Actualizado" })
      .where("id", "=", created.id)
      .executeTakeFirst();

    const row = await db.selectFrom("people").select("first_name").where("id", "=", created.id).executeTakeFirstOrThrow();

    expect(row.first_name).toBe("Actualizado"); // el update SÍ pasó...
    expect(Number(result.numUpdatedRows)).toBe(0); // ...pero esto miente. Usar siempre .returning().
  });

  it("en cambio, .returning() sí refleja si el WHERE matcheó", async () => {
    const db = await getDb();
    const created = await db
      .insertInto("people")
      .values({ first_name: "Quirk2", last_name: "Test", dni: "50000002" })
      .returning("id")
      .executeTakeFirstOrThrow();

    const matched = await db
      .updateTable("people")
      .set({ first_name: "Sí matcheó" })
      .where("id", "=", created.id)
      .returning("id")
      .executeTakeFirst();
    expect(matched).toBeDefined();

    const notMatched = await db
      .updateTable("people")
      .set({ first_name: "No debería aplicar" })
      .where("id", "=", created.id)
      .where("version", "=", 999999)
      .returning("id")
      .executeTakeFirst();
    expect(notMatched).toBeUndefined();
  });
});
