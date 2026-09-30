# Propuesta de esquema (NO aplicada): base de participación «por regla de negocio de la fuente»

Estado: **propuesta**. No hay migración creada en `db/migrations/` ni aplicada. Se incluye como prerrequisito del dry-run de las tandas 1 y 2 (2026-09-30).

## Problema

Por decisión de negocio, la respuesta de un formulario (o un listado de cursada realizada) de las 22 fuentes acredita **participación efectiva**. El esquema actual solo permite `participation_kind = 'participated'` junto con `participation_basis = 'legacy_initial_import'` (CHECK de 0028), y esa base está prohibida para fuentes nuevas. `attended` queda reservado a asistencia con evidencia (check-in) y genera interacciones «Participó en…»: no se usa.

## Nombre elegido: `source_business_rule`

| Alternativa | Por qué no |
|---|---|
| `business_rule` | No dice de qué evidencia sale la regla. |
| `source_evidence` | Se confunde con la columna `evidence` y sugiere evidencia de asistencia (check-in). |
| `verified_source` | Implica una verificación que no se hace. |
| `form_response_business_rule` | Un valor por tipo de fuente: se fragmenta con cada formulario/lote futuro. |
| **`source_business_rule`** | Expresa «participó según regla de negocio aplicada a una fuente», es genérico y distinto de `standard` (flujo normal: inscripción/invitación/confirmación/check-in) y de `legacy_initial_import` (carga histórica única). |

La regla concreta (p. ej. «respuesta de formulario = participación efectiva», «listado de cursada realizada») y el archivo no van en un valor nuevo por lote: van en `meeting_participations.evidence` (texto obligatorio con esta base) y en la procedencia (`import_row_id` → `import_rows` → `import_files`).

## Migración exacta propuesta (0031, aditiva y reversible con otra migración)

```sql
BEGIN;

ALTER TABLE public.meeting_participations DROP CONSTRAINT IF EXISTS meeting_participations_basis_check;
ALTER TABLE public.meeting_participations
  ADD CONSTRAINT meeting_participations_basis_check
  CHECK (participation_basis IN ('standard', 'legacy_initial_import', 'source_business_rule'));

ALTER TABLE public.meeting_participations DROP CONSTRAINT IF EXISTS meeting_participations_participated_requires_legacy_basis_check;
ALTER TABLE public.meeting_participations
  ADD CONSTRAINT meeting_participations_participated_requires_basis_check
  CHECK (participation_kind <> 'participated' OR participation_basis IN ('legacy_initial_import', 'source_business_rule'));

ALTER TABLE public.meeting_participations
  ADD CONSTRAINT meeting_participations_source_rule_requires_evidence_check
  CHECK (participation_basis <> 'source_business_rule'
         OR (participation_kind = 'participated' AND evidence IS NOT NULL AND btrim(evidence) <> ''));

COMMIT;
```

Las 2.032 filas actuales cumplen los tres CHECK (912 `registration/standard` y 1.120 `participated/legacy_initial_import`); no hay reescritura de datos.

## Estado actual y elementos afectados

- Valores actuales (producción, 2026-09-30): `legacy_initial_import`/`participated` = 1.120; `standard`/`registration` = 912.
- CHECK afectados: `meeting_participations_basis_check`, `meeting_participations_participated_requires_legacy_basis_check` (se reemplaza). Sin triggers propios salvo `meeting_participations_no_delete` (no cambia).
- Trigger de 0029 (`date_basis='legacy_reference'` solo sobre `legacy_initial_import`): no cambia; las nuevas filas nunca reciben fecha referencial.
- Código a tocar: `lib/db/schema.ts` (`ParticipationBasis`), comentarios/etiquetas de `lib/meetings/participants.ts` y `lib/people/queries.ts` (hoy dicen que `participated` es solo legacy).
- Consultas que dependen del campo (sin cambio de comportamiento para lo histórico): `lib/interactions/participation-sync.ts` (`REAL_PARTICIPATION_KIND`), `legacy-reconciliation.ts`, `legacy-reference-interactions.ts` (filtran por `legacy_initial_import`: ignoran las filas nuevas); `lib/analytics/queries.ts:411` (cuenta `attended`/`participated`: las filas nuevas SÍ cuentan como participación, que es lo pretendido).

## ¿Genera `person_interactions`?

**No, por defecto.** `syncParticipationInteractions` solo crea interacciones para `attended` y `participated`+`legacy_initial_import`; con esta migración esa condición no se toca, así que las participaciones `source_business_rule` no crean interacciones ni mueven el semáforo. Motivo: la importación no debe volverse «contacto real» ni asistencia física. Si negocio quiere que cuenten para el semáforo, es un cambio explícito y separado: agregar la base al predicado, solo para participaciones con jornada y fecha real (en este lote serían 35 de Ley 6354 y 35 de Competencias comunicacionales).

## Tests a agregar

1. La migración acepta `participated + source_business_rule + evidence` y rechaza `participated + standard`.
2. Rechaza `source_business_rule` sin evidencia o con `kind <> participated`.
3. Las 2.032 filas históricas siguen válidas.
4. `syncParticipationInteractions` no crea interacciones para `source_business_rule` (y sí para legacy, sin regresión).
5. Reconciliadores legacy no tocan filas `source_business_rule`.
6. Analytics y ficha de persona muestran el estado «Participó» para la nueva base sin fecha inventada.
7. Idempotencia del importador: segunda corrida = 0 participaciones nuevas.
