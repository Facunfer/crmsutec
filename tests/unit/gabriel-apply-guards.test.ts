import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { assertApplyEnvironment, assertUuid, ImportAbortError, verifySourceFiles } from "../../lib/imports/gabriel/preflight.js";
import { FILE_CODES, type ExtractedFile } from "../../lib/imports/gabriel/types.js";
import { formatMeetingWhen } from "../../lib/meetings/when.js";
import type { SutecbaEnv } from "../../lib/db/env.js";
import { agendaFile, f09File, f10File, cuilFor } from "../helpers/gabriel-fixtures.js";
import { planFromSources } from "../../lib/imports/gabriel/plan-hash.js";

// El script es un módulo con main() condicionado a ser el entry point: importar no ejecuta nada.
const { redact, toSafeReport } = await import("../../scripts/import-gabriel.js");

const sha = (content: string) => createHash("sha256").update(content).digest("hex");

describe("verificación de los originales (SHA-256)", () => {
  const dir = mkdtempSync(join(tmpdir(), "gabriel-raw-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  const build = (): ExtractedFile[] =>
    FILE_CODES.map((code) => {
      const content = `contenido-${code}`;
      writeFileSync(join(dir, `${code}.bin`), content);
      return { fileCode: code, fileName: `${code}.bin`, sha256: sha(content), sizeBytes: content.length, sheets: [] };
    });

  it("pasa si el conjunto es exacto y cada hash coincide", () => {
    expect(() => verifySourceFiles(dir, build())).not.toThrow();
  });

  it("aborta si un original cambió desde el dry-run", () => {
    const files = build();
    writeFileSync(join(dir, "F03.bin"), "modificado");
    expect(() => verifySourceFiles(dir, files)).toThrow(/F03 cambió/);
  });

  it("aborta si falta un original o el conjunto no es exactamente F01–F10", () => {
    const files = build();
    rmSync(join(dir, "F05.bin"));
    expect(() => verifySourceFiles(dir, files)).toThrow(/Falta el original de F05/);
    expect(() => verifySourceFiles(dir, build().slice(0, 9))).toThrow(ImportAbortError);
    expect(() => verifySourceFiles(dir, [...build(), build()[0]!])).toThrow(/conjunto de archivos/);
  });
});

describe("entorno del apply", () => {
  const env = (over: Partial<SutecbaEnv>): SutecbaEnv => ({ SUTECBA_ENV: "local", SUTECBA_TZ: "America/Argentina/Buenos_Aires", ...over });

  it("production exige --yes además de todo lo demás", () => {
    const production = env({ SUTECBA_ENV: "production", SUTECBA_DATABASE_URL: "postgresql://sutecba_app@db.example/postgres" });
    expect(() => assertApplyEnvironment({ env: production, yes: false })).toThrow(/--yes/);
    expect(() => assertApplyEnvironment({ env: production, yes: true })).not.toThrow();
  });

  it("un entorno remoto sin SUTECBA_DATABASE_URL no cae a PGlite local en silencio", () => {
    expect(() => assertApplyEnvironment({ env: env({ SUTECBA_ENV: "production" }), yes: true })).toThrow(/SUTECBA_DATABASE_URL/);
    expect(() => assertApplyEnvironment({ env: env({ SUTECBA_ENV: "staging" }), yes: true })).toThrow(/SUTECBA_DATABASE_URL/);
  });

  it("rechaza destinos de otros proyectos", () => {
    const blocked = env({ SUTECBA_ENV: "production", SUTECBA_DATABASE_URL: "postgresql://x@db.dxoarslfifotigcgokmf.supabase.co/postgres" });
    expect(() => assertApplyEnvironment({ env: blocked, yes: true })).toThrow(/bloqueado/);
  });

  it("los UUID de --created-by / --owner-organization-id se validan", () => {
    expect(() => assertUuid("no-es-uuid", "--created-by")).toThrow(ImportAbortError);
    expect(() => assertUuid(undefined, "--created-by")).toThrow(ImportAbortError);
    expect(assertUuid("123e4567-e89b-12d3-a456-426614174000", "x")).toBeTruthy();
  });
});

describe("seguridad de logs", () => {
  it("redact elimina cualquier número largo o email de un mensaje de error", () => {
    const text = redact("Key (dni)=(30111222) ya existe; cuil 20-30111222-3; contacto juan.perez@example.com tel 011 5555-1111");
    expect(text).not.toMatch(/\d{6,}/);
    expect(text).not.toContain("@");
    expect(text).not.toContain("30111222");
  });

  it("el informe del dry-run no contiene datos personales", () => {
    const dni = "43111222";
    const files = [
      f09File([{ last: "Perezoso", first: "Juanito", dni, email: "juanito.perezoso@example.com", phone: "1155559999" }]),
      f10File([{ last: "Gomez", first: "Luisa", cuil: cuilFor("43111333") }]),
      agendaFile([["martes", "2026-03-10", "Procuración"]]),
    ];
    const { plan, planHash } = planFromSources(files);
    const text = JSON.stringify(toSafeReport(plan, planHash));
    for (const forbidden of [dni, "43111333", cuilFor("43111333"), "Perezoso", "Juanito", "Gomez", "Luisa", "juanito.perezoso", "1155559999"]) {
      expect(text).not.toContain(forbidden);
    }
    expect(text).toContain(planHash);
  });
});

describe("cuándo ocurre una reunión (UI)", () => {
  const eventDate = new Date("2026-03-10T00:00:00Z");

  it("date_only muestra solo el día, sin ninguna hora, y nunca corre de día", () => {
    const text = formatMeetingWhen({ startsAt: null, endsAt: null, schedulePrecision: "date_only", eventDate });
    expect(text).toMatch(/10\/3\/(20)?26/);
    expect(text).not.toMatch(/\d{1,2}:\d{2}/);
  });

  it("exact_datetime muestra fecha y hora como siempre", () => {
    const text = formatMeetingWhen({ startsAt: new Date("2026-03-10T13:00:00Z"), endsAt: new Date("2026-03-10T16:00:00Z"), schedulePrecision: "exact_datetime", eventDate: null }, { withEnd: true });
    expect(text).toMatch(/10\/3\/(20)?26,? 10:00/);
    expect(text).toMatch(/1:00/);
  });

  it("unknown no inventa ninguna fecha", () => {
    expect(formatMeetingWhen({ startsAt: null, endsAt: null, schedulePrecision: "unknown", eventDate: null })).toBe("Fecha pendiente");
  });
});
