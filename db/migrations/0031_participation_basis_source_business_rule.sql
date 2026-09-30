BEGIN;

-- 0031 — Base de participación «source_business_rule».
--
-- Representa: participación efectiva acreditada por una FUENTE y una REGLA DE NEGOCIO explícita (p. ej. «la respuesta del
-- formulario X acredita participación», «el listado de cursada realizada acredita participación»). Es distinta de:
--   · 'standard'             (flujo normal: inscripción, invitación, confirmación, check-in);
--   · 'legacy_initial_import' (decisión exclusiva de la carga histórica inicial);
--   · asistencia/check-in    (participation_kind='attended' / meeting_attendance).
-- La regla concreta y el archivo van en `evidence` (obligatoria con esta base) y en la procedencia (import_row_id).
-- NO se crea un valor por formulario o lote. NO genera person_interactions: lib/interactions/participation-sync.ts solo
-- considera 'attended' y 'participated'+'legacy_initial_import'; esta base queda fuera a propósito.
-- Aditiva: no reescribe ninguna fila (las 912 'standard' y 1.120 'legacy_initial_import' siguen válidas).

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
  CHECK (
    participation_basis <> 'source_business_rule'
    OR (participation_kind = 'participated' AND evidence IS NOT NULL AND btrim(evidence) <> '')
  );

COMMIT;
