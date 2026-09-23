import { getDb } from "../db/client.js";
import { assertServerOnly } from "../server-only.js";
import { can, type SessionUser } from "../permissions/can.js";
import { orgScope } from "../scope/organizations.js";
import type { ImportBatchStatus, ImportRowStatus } from "../db/schema.js";

assertServerOnly("lib/imports/queries.ts");

/**
 * Importaciones (migración 0018). El alcance lo define
 * `import_batches.owner_organization_id`: un lote, y todo lo que cuelga de él
 * (archivos vinculados, filas, incidencias), solo se ve dentro de ese alcance.
 * Requieren `imports.view` (con su módulo `importaciones`), vía `can()`.
 *
 * `raw_data` puede traer DNI/email/teléfono: se trata como dato sensible y solo
 * se entrega con `people.view_sensitive`. Todavía no hay UI: son las consultas
 * listas para cuando exista.
 */

export interface ImportBatchItem {
  id: string;
  ownerOrganizationId: string;
  status: ImportBatchStatus;
  createdAt: Date;
  notes: string | null;
}

export async function listImportBatches(actor: SessionUser): Promise<ImportBatchItem[]> {
  if (!can(actor, "imports.view")) return [];

  const db = await getDb();
  const rows = await db
    .selectFrom("import_batches")
    .select(["id", "owner_organization_id", "status", "created_at", "notes"])
    .where(orgScope(actor, "import_batches.owner_organization_id"))
    .orderBy("created_at", "desc")
    .execute();

  return rows.map((r) => ({
    id: r.id,
    ownerOrganizationId: r.owner_organization_id,
    status: r.status,
    createdAt: r.created_at,
    notes: r.notes,
  }));
}

export interface ImportRowItem {
  id: string;
  fileId: string;
  sheet: string;
  rowNumber: number;
  status: ImportRowStatus;
  /** null salvo que el usuario tenga `people.view_sensitive`. */
  rawData: unknown;
  normalizedData: unknown;
}

/** Filas de un lote del alcance del usuario; lote ajeno o inexistente → lista vacía. */
export async function listImportRows(actor: SessionUser, batchId: string): Promise<ImportRowItem[]> {
  if (!can(actor, "imports.view")) return [];
  const canSeeSensitive = can(actor, "people.view_sensitive");

  const db = await getDb();
  const rows = await db
    .selectFrom("import_rows")
    .innerJoin("import_batch_files", "import_batch_files.file_id", "import_rows.file_id")
    .innerJoin("import_batches", "import_batches.id", "import_batch_files.batch_id")
    .select([
      "import_rows.id",
      "import_rows.file_id",
      "import_rows.sheet",
      "import_rows.row_number",
      "import_rows.status",
      "import_rows.raw_data",
      "import_rows.normalized_data",
    ])
    .where("import_batches.id", "=", batchId)
    .where(orgScope(actor, "import_batches.owner_organization_id"))
    .orderBy("import_rows.sheet")
    .orderBy("import_rows.row_number")
    .execute();

  return rows.map((r) => ({
    id: r.id,
    fileId: r.file_id,
    sheet: r.sheet,
    rowNumber: r.row_number,
    status: r.status,
    rawData: canSeeSensitive ? r.raw_data : null,
    normalizedData: canSeeSensitive ? r.normalized_data : null,
  }));
}
