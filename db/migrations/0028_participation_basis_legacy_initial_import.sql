BEGIN;

-- 0028 — `participation_basis` + valor 'participated' de `participation_kind`.
--
-- Decisión de negocio EXCLUSIVA de la carga histórica inicial de Gabriel (primer lote `gabriel-historical` y el
-- segundo lote en preparación): para esas fuentes, estar incluido en una actividad se considera participación, no
-- una simple inscripción. Esto NO cambia el comportamiento de reuniones creadas normalmente en el CRM (invitado →
-- participó sí/no después del evento, QR/check-in): esos flujos siguen usando 'invited'/'attended'/'absent' con
-- participation_basis='standard' (el valor por defecto), sin tocar nada de esta migración.
--
-- `participation_basis` identifica CÓMO se estableció el hecho: 'standard' (flujo normal: invitación, check-in,
-- corrección manual) o 'legacy_initial_import' (decisión de negocio SUTECBA 2026-09-22 sobre las bases históricas
-- iniciales). El nuevo valor 'participated' de participation_kind SOLO se usa con basis='legacy_initial_import':
-- nunca reemplaza ni reescribe la fila 'registration' original (se agrega una fila nueva; la original queda intacta
-- como evidencia de fuente — ver lib/interactions/legacy-reconciliation.ts).

ALTER TABLE public.meeting_participations
  ADD COLUMN IF NOT EXISTS participation_basis text NOT NULL DEFAULT 'standard';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'meeting_participations_basis_check' AND conrelid = 'public.meeting_participations'::regclass) THEN
    ALTER TABLE public.meeting_participations
      ADD CONSTRAINT meeting_participations_basis_check
      CHECK (participation_basis IN ('standard', 'legacy_initial_import'));
  END IF;
END $$;

-- Reemplaza el CHECK de participation_kind (nombre autogenerado por Postgres en 0021, confirmado contra el esquema
-- real) para agregar 'participated'.
ALTER TABLE public.meeting_participations
  DROP CONSTRAINT IF EXISTS meeting_participations_participation_kind_check;
ALTER TABLE public.meeting_participations
  ADD CONSTRAINT meeting_participations_participation_kind_check
  CHECK (participation_kind IN ('registration', 'invited', 'attended', 'absent', 'approved', 'unknown', 'participated'));

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'meeting_participations_participated_requires_legacy_basis_check' AND conrelid = 'public.meeting_participations'::regclass) THEN
    ALTER TABLE public.meeting_participations
      ADD CONSTRAINT meeting_participations_participated_requires_legacy_basis_check
      CHECK (participation_kind <> 'participated' OR participation_basis = 'legacy_initial_import');
  END IF;
END $$;

-- Misma ampliación en el staging (import_rows.participation_kind), para que el segundo lote pueda registrar
-- 'participated' en su fila de origen igual que 'registration' hoy.
ALTER TABLE public.import_rows
  DROP CONSTRAINT IF EXISTS import_rows_participation_kind_check;
ALTER TABLE public.import_rows
  ADD CONSTRAINT import_rows_participation_kind_check
  CHECK (participation_kind IS NULL OR participation_kind IN ('registration', 'invited', 'attended', 'absent', 'approved', 'unknown', 'participated'));

COMMIT;
