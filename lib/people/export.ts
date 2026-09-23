import { assertServerOnly } from "../server-only.js";
import { assertPermission } from "../auth/guard.js";
import { can, type SessionUser } from "../permissions/can.js";
import type { Json } from "../db/schema.js";
import { applyMasking } from "./masking.js";
import { computeDisplayAge, listAllMatching, type PeopleFilterSpec, type PeopleSort } from "./queries.js";

assertServerOnly("lib/people/export.ts");

const CSV_HEADER = ["Nombre", "Apellido", "DNI", "Email", "Teléfono", "Área", "Repartición", "Última interacción", "Semáforo", "Edad", "Estado", "Alta"];

const TRAFFIC_CSV: Record<string, string> = { green: "Verde", yellow: "Amarillo", red: "Rojo", gray: "Gris" };

const STATUS_LABEL: Record<string, string> = { active: "Activa", inactive: "Inactiva", merged: "Fusionada" };

/**
 * Protección contra CSV/formula injection (sección 9 del prompt): si una
 * celda empieza con `=`, `+`, `-` o `@`, Excel/Sheets puede interpretarla
 * como fórmula al abrir el archivo. Se le antepone una comilla simple para
 * que quede como texto literal.
 */
export function sanitizeCsvCell(value: string): string {
  const dangerous = /^[=+\-@]/.test(value);
  const safe = dangerous ? `'${value}` : value;
  const escaped = safe.replace(/"/g, '""');
  return `"${escaped}"`;
}

export async function exportPeopleCsv(
  actor: SessionUser,
  filter: PeopleFilterSpec,
  sort: PeopleSort
): Promise<string> {
  assertPermission(actor, "people.export");

  const rows = await listAllMatching(actor, filter, sort);
  const canSeeSensitive = can(actor, "people.view_sensitive");

  const lines = [CSV_HEADER.map(sanitizeCsvCell).join(",")];
  for (const row of rows) {
    const masked = applyMasking(row, canSeeSensitive);
    const { age } = computeDisplayAge(row);
    lines.push(
      [
        masked.firstName,
        masked.lastName,
        masked.dni ?? "",
        masked.email ?? "",
        masked.phone ?? "",
        masked.areaName ?? "",
        masked.reparticionName ?? "",
        masked.lastInteractionDate ?? "",
        TRAFFIC_CSV[masked.trafficLight] ?? "",
        age !== null ? String(age) : "",
        STATUS_LABEL[masked.status] ?? masked.status,
        masked.createdAt.toISOString().slice(0, 10),
      ]
        .map(sanitizeCsvCell)
        .join(",")
    );
  }

  // BOM para que Excel detecte UTF-8 y no rompa acentos/ñ.
  const csv = `﻿${lines.join("\r\n")}`;


  return csv;
}
