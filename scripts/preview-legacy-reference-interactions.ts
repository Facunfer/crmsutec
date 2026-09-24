import { closeDb, getDb } from "../lib/db/client.js";
import { loadEnv } from "../lib/db/env.js";
import { previewLegacyReferenceCandidates, previewTrafficProjection } from "../lib/interactions/legacy-reference-interactions.js";
import { assertRuntimeRole } from "../lib/imports/gabriel/preflight.js";

/**
 * Vista previa de SOLO LECTURA de las interacciones históricas faltantes (ver
 * lib/interactions/legacy-reference-interactions.ts), compatible con el esquema de HOY (sin la migración 0029/0030
 * aplicada todavía). A diferencia de `npm run legacy:reconcile-interactions` (que exige 0 migraciones pendientes,
 * porque su modo --apply sí necesita date_basis), esto NO exige eso: sirve exactamente para el caso de "quiero ver
 * los números reales contra producción antes de decidir si aplico la migración". No escribe nada bajo ninguna
 * circunstancia: no tiene modo --apply.
 *
 *   npm run legacy:preview-interactions
 */
async function main() {
  const env = loadEnv();
  const db = await getDb();
  await assertRuntimeRole(db, env);

  const preview = await previewLegacyReferenceCandidates(db);
  const traffic = await previewTrafficProjection(db, preview.affectedPeopleIds);
  const byBatch = new Map<string, number>();
  for (const r of preview.rows) {
    const key = r.batchSourceSystem ?? "(sin procedencia)";
    byBatch.set(key, (byBatch.get(key) ?? 0) + 1);
  }
  console.log(
    JSON.stringify(
      {
        modo: "preview_solo_lectura",
        entorno: env.SUTECBA_ENV,
        ...preview,
        affectedPeopleIds: undefined,
        rows: undefined,
        porLote: Object.fromEntries(byBatch),
        semaforoAntes: traffic.before,
        semaforoDespuesProyectado: traffic.after,
      },
      null,
      2
    )
  );

  await closeDb();
}

main().catch((err: unknown) => {
  console.error(`[legacy:preview-interactions] error: ${String((err as Error).message ?? err).replace(/postgres(ql)?:\/\/\S+/gi, "[url]")}`);
  process.exitCode = 1;
});
