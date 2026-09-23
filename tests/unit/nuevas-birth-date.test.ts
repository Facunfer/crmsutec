import { describe, expect, it } from "vitest";
import { buildNuevasPlan, type NuevasContext } from "../../lib/imports/gabriel/nuevas.js";
import type { ExtractedFile } from "../../lib/imports/gabriel/types.js";

/**
 * Caso sintético (sin datos reales): una persona NUEVA cuya única fecha de nacimiento en la fuente es implausible
 * ("0099", año de 2 dígitos mal expandido). Verifica lo pedido para el segundo lote: el DNI inválido de nacimiento
 * NO bloquea la creación de la persona, pero birth_date nunca se completa a partir de un valor implausible.
 */
function n02File(rows: unknown[][]): ExtractedFile {
  return {
    fileCode: "N02" as never,
    fileName: "sintetico.pdf",
    sha256: "0".repeat(64),
    sizeBytes: 1,
    sheets: [{ name: "p1", rows: rows.map((cells, i) => ({ n: i + 1, cells: cells as never })) }],
  };
}

const HEADER = ["Marca temporal", "Apellido", "Nombre", "Correo electronico", "DNI", "Fecha de nacimiento", "Celular", "Ministerio", "Column"];

const emptyCtx: NuevasContext = { people: [], meetings: [], participations: new Set(), aliases: [], organizationParents: new Map(), f07: null };

describe("buildNuevasPlan: nacimiento implausible en una persona nueva", () => {
  it("crea la persona con birthDate null y registra la incidencia, sin bloquearla", () => {
    const file = n02File([HEADER, ["2026-04-01T00:00:00", "Perez", "Juana", "juana@example.com", "88877766", "20/5/0099", "1122334455", "MSGC", "lunes 1"]]);
    const plan = buildNuevasPlan([file], emptyCtx);

    expect(plan.blocked).toHaveLength(0);
    const created = plan.peopleToCreate.find((p) => p.dni === "88877766");
    expect(created).toBeDefined();
    expect(created!.birthDate).toBeNull(); // nunca se inventa ni se guarda el año implausible

    const row = plan.rows.find((r) => r.dni === "88877766")!;
    expect(row.birthDateIssue).toBe("AMBIGUOUS_BIRTH_YEAR");
    expect(plan.incidents.AMBIGUOUS_BIRTH_YEAR).toBe(1);
  });

  it("una fecha de nacimiento plausible SÍ se completa normalmente (control)", () => {
    const file = n02File([HEADER, ["2026-04-01T00:00:00", "Gomez", "Luis", "luis@example.com", "77766655", "20/5/1990", "1122334455", "MSGC", "lunes 1"]]);
    const plan = buildNuevasPlan([file], emptyCtx);
    const created = plan.peopleToCreate.find((p) => p.dni === "77766655");
    expect(created!.birthDate).toBe("1990-05-20");
  });
});
