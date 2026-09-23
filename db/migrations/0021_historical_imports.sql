BEGIN;

-- 0021 — Importación histórica (fuentes de Gabriel): identidad por DNI, eventos importados
-- y participaciones históricas.
--
-- Sin operaciones destructivas: agrega columnas, tablas, índices y constraints. Los únicos cambios a
-- lo existente son DROP NOT NULL de meetings.starts_at/ends_at (ver 2) y SET NOT NULL de people.dni (ver 1).
-- Idempotente (IF NOT EXISTS / bloques DO).
--
-- Decisiones (SUTECBA_ARCHITECTURE / docs/importacion-gabriel-mapeo.md):
--  1. DNI = identificador único y OBLIGATORIO de TODA persona (manual, formulario o importación).
--     Formato canónico garantizado por PostgreSQL: solo dígitos, 7 u 8, sin puntos/espacios/guiones.
--     Una sola persona vigente por DNI (índice único parcial de 0003: status <> 'merged'); una
--     persona fusionada conserva su DNI histórico y merged_into_id. CUIL/CUIT es una columna aparte,
--     sensible, nullable y NO única (no identifica ni fusiona); con checksum válido cuando existe.
--     `dni_source` distingue DNI explícito de DNI derivado de un CUIL/CUIT; el origen de la persona
--     (manual/form/import) ya vive en `people.origin`.
--     ATENCIÓN: esta migración endurece `people.dni` (SET NOT NULL + CHECK). Si hubiera personas
--     sin DNI o con DNI no normalizado, la migración ABORTA (nada se aplica): se pensó para una base
--     sin personas cargadas o ya saneada.
--  2. Las actividades históricas son `meetings` con tipo, origen y clave estable de importación.
--  3. Una actividad importada puede no tener fecha u hora: NO se inventa. `schedule_precision`
--     distingue inequívocamente exact_datetime (starts_at/ends_at reales) de date_only (solo el
--     día, en event_date; sin hora) y de unknown (sin fecha). starts_at/ends_at admiten NULL solo
--     para origin='import' y solo si la precisión no es exact_datetime. Nunca se guarda una hora
--     sintética (00:00, 09:00, etc.).
--  4. Inscripción, invitación, asistencia y aprobación son cosas distintas: las participaciones
--     históricas viven en `meeting_participations`, sin timestamp obligatorio y sin fabricar
--     invitaciones. `attended` exige evidencia explícita.
--  5. Una inscripción que no se puede atribuir a una jornada concreta se asocia a una
--     campaña (`campaign_key`) con meeting_id NULL; nunca se adivina la jornada.

-- ---------------------------------------------------------------- 1. people

-- Checksum de CUIL/CUIT (mismo algoritmo que la aplicación): pesos 5,4,3,2,7,6,5,4,3,2 sobre los
-- 10 primeros dígitos; resto 11 → 0, 10 → 9.
CREATE OR REPLACE FUNCTION public.cuil_cuit_checksum_ok(cuil text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT CASE
    WHEN cuil ~ '^[0-9]{11}$' THEN
      (SELECT CASE q.m WHEN 11 THEN 0 WHEN 10 THEN 9 ELSE q.m END
         FROM (
           SELECT (11 - (sum(substr(cuil, t.i::int, 1)::int * t.w) % 11))::int AS m
           FROM unnest(ARRAY[5, 4, 3, 2, 7, 6, 5, 4, 3, 2]) WITH ORDINALITY AS t(w, i)
         ) q) = substr(cuil, 11, 1)::int
    ELSE false
  END
$$;

REVOKE ALL ON FUNCTION public.cuil_cuit_checksum_ok(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.cuil_cuit_checksum_ok(text) TO sutecba_app;

ALTER TABLE public.people
  ADD COLUMN IF NOT EXISTS cuil_cuit text,
  ADD COLUMN IF NOT EXISTS dni_source text NOT NULL DEFAULT 'explicit';

-- DNI obligatorio para toda persona. Falla (y revierte la migración) si hay filas sin DNI.
ALTER TABLE public.people ALTER COLUMN dni SET NOT NULL;

DO $$
BEGIN
  -- DNI canónico: solo dígitos, 7 u 8. Nada de puntos, espacios ni guiones.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'people_dni_format_check' AND conrelid = 'public.people'::regclass) THEN
    ALTER TABLE public.people
      ADD CONSTRAINT people_dni_format_check
      CHECK (dni ~ '^[0-9]{7,8}$');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'people_cuil_cuit_format_check' AND conrelid = 'public.people'::regclass) THEN
    ALTER TABLE public.people
      ADD CONSTRAINT people_cuil_cuit_format_check
      CHECK (cuil_cuit IS NULL OR (cuil_cuit ~ '^[0-9]{11}$' AND public.cuil_cuit_checksum_ok(cuil_cuit)));
  END IF;

  -- Procedencia del DNI: solo explícito o derivado de un CUIL/CUIT. El origen de la persona (manual,
  -- form, import) está en people.origin; no se mezcla acá.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'people_dni_source_check' AND conrelid = 'public.people'::regclass) THEN
    ALTER TABLE public.people
      ADD CONSTRAINT people_dni_source_check
      CHECK (dni_source IN ('explicit', 'derived_from_cuil'));
  END IF;

  -- Un DNI derivado siempre conserva el CUIL/CUIT del que salió, y coincide con él (sin el 0 de relleno).
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'people_dni_derived_from_cuil_check' AND conrelid = 'public.people'::regclass) THEN
    ALTER TABLE public.people
      ADD CONSTRAINT people_dni_derived_from_cuil_check
      CHECK (dni_source <> 'derived_from_cuil' OR (cuil_cuit IS NOT NULL AND ltrim(substr(cuil_cuit, 3, 8), '0') = dni));
  END IF;

  -- Fusión: la persona fusionada apunta a la vigente (historial) y nunca a sí misma.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'people_merged_has_target_check' AND conrelid = 'public.people'::regclass) THEN
    ALTER TABLE public.people
      ADD CONSTRAINT people_merged_has_target_check
      CHECK (status <> 'merged' OR (merged_into_id IS NOT NULL AND merged_into_id <> id));
  END IF;

  -- Unicidad de DNI entre personas vigentes: el índice de 0003 (people_dni_unique_idx, único parcial
  -- WHERE status <> 'merged') ya lo garantiza y, con dni NOT NULL, cubre a TODAS las personas no fusionadas.
  -- Se verifica acá para que esta migración no pueda aplicarse si ese índice faltara o fuera distinto.
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'public' AND tablename = 'people' AND indexname = 'people_dni_unique_idx'
      AND indexdef ILIKE 'CREATE UNIQUE INDEX%' AND indexdef ILIKE '%(dni)%' AND indexdef ILIKE '%merged%'
  ) THEN
    RAISE EXCEPTION 'Falta el índice único parcial people_dni_unique_idx (dni WHERE status <> merged).';
  END IF;
END $$;

-- El CUIL/CUIT no es único: dos personas con el mismo CUIL y DNI distintos es un conflicto de
-- alta severidad para revisar, no algo que la base deba impedir (ni fusionar).
CREATE INDEX IF NOT EXISTS people_cuil_cuit_idx ON public.people (cuil_cuit) WHERE cuil_cuit IS NOT NULL;

-- ---------------------------------------------------------------- 2. meetings

ALTER TABLE public.meetings
  ADD COLUMN IF NOT EXISTS meeting_type text NOT NULL DEFAULT 'reunion',
  ADD COLUMN IF NOT EXISTS meeting_subtype text,
  ADD COLUMN IF NOT EXISTS origin text NOT NULL DEFAULT 'manual',
  ADD COLUMN IF NOT EXISTS source_event_key text,
  ADD COLUMN IF NOT EXISTS import_batch_id uuid REFERENCES public.import_batches (id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS schedule_precision text NOT NULL DEFAULT 'exact_datetime',
  ADD COLUMN IF NOT EXISTS event_date date,
  ADD COLUMN IF NOT EXISTS source_time_note text;

-- Fechas nulas solo para lo importado (ver el bloque DO de constraints).
ALTER TABLE public.meetings
  ALTER COLUMN starts_at DROP NOT NULL,
  ALTER COLUMN ends_at DROP NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'meetings_type_check' AND conrelid = 'public.meetings'::regclass) THEN
    ALTER TABLE public.meetings
      ADD CONSTRAINT meetings_type_check
      CHECK (meeting_type IN ('reunion', 'capacitacion', 'operativo_salud', 'jornada', 'evento', 'otro'));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'meetings_origin_check' AND conrelid = 'public.meetings'::regclass) THEN
    ALTER TABLE public.meetings
      ADD CONSTRAINT meetings_origin_check CHECK (origin IN ('manual', 'import'));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'meetings_schedule_precision_check' AND conrelid = 'public.meetings'::regclass) THEN
    ALTER TABLE public.meetings
      ADD CONSTRAINT meetings_schedule_precision_check CHECK (schedule_precision IN ('exact_datetime', 'date_only', 'unknown'));
  END IF;

  -- Una reunión manual siempre tiene fecha/hora completas.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'meetings_manual_requires_dates_check' AND conrelid = 'public.meetings'::regclass) THEN
    ALTER TABLE public.meetings
      ADD CONSTRAINT meetings_manual_requires_dates_check
      CHECK (origin = 'import' OR (starts_at IS NOT NULL AND ends_at IS NOT NULL AND schedule_precision = 'exact_datetime'));
  END IF;

  -- Coherencia de schedule_precision con lo que efectivamente hay guardado.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'meetings_schedule_precision_consistency_check' AND conrelid = 'public.meetings'::regclass) THEN
    ALTER TABLE public.meetings
      ADD CONSTRAINT meetings_schedule_precision_consistency_check
      CHECK (
        (schedule_precision = 'exact_datetime' AND starts_at IS NOT NULL AND ends_at IS NOT NULL)
        OR (schedule_precision = 'date_only' AND event_date IS NOT NULL AND starts_at IS NULL AND ends_at IS NULL)
        OR (schedule_precision = 'unknown' AND event_date IS NULL AND starts_at IS NULL AND ends_at IS NULL)
      );
  END IF;

  -- Todo evento importado lleva su clave estable de importación.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'meetings_import_requires_key_check' AND conrelid = 'public.meetings'::regclass) THEN
    ALTER TABLE public.meetings
      ADD CONSTRAINT meetings_import_requires_key_check
      CHECK (origin = 'manual' OR (source_event_key IS NOT NULL AND btrim(source_event_key) <> ''));
  END IF;
END $$;

-- Clave estable de importación (p. ej. training:52010, ophthalmology:2026-04-01:educacion):
-- reimportar no duplica eventos, sin depender del nombre visible.
CREATE UNIQUE INDEX IF NOT EXISTS meetings_source_event_key_unique_idx
  ON public.meetings (source_event_key)
  WHERE source_event_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS meetings_type_idx ON public.meetings (meeting_type);

-- ---------------------------------------------------------------- 3. import_rows (staging ampliado)

ALTER TABLE public.import_rows
  ADD COLUMN IF NOT EXISTS source_file_code text,
  ADD COLUMN IF NOT EXISTS normalized_dni text,
  ADD COLUMN IF NOT EXISTS dni_source text,
  ADD COLUMN IF NOT EXISTS normalized_cuil_cuit text,
  ADD COLUMN IF NOT EXISTS person_id uuid REFERENCES public.people (id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS meeting_id uuid REFERENCES public.meetings (id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS campaign_key text,
  ADD COLUMN IF NOT EXISTS participation_kind text;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'import_rows_normalized_dni_check' AND conrelid = 'public.import_rows'::regclass) THEN
    ALTER TABLE public.import_rows
      ADD CONSTRAINT import_rows_normalized_dni_check
      CHECK (normalized_dni IS NULL OR normalized_dni ~ '^[0-9]{7,8}$');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'import_rows_normalized_cuil_check' AND conrelid = 'public.import_rows'::regclass) THEN
    ALTER TABLE public.import_rows
      ADD CONSTRAINT import_rows_normalized_cuil_check
      CHECK (normalized_cuil_cuit IS NULL OR normalized_cuil_cuit ~ '^[0-9]{11}$');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'import_rows_dni_source_check' AND conrelid = 'public.import_rows'::regclass) THEN
    ALTER TABLE public.import_rows
      ADD CONSTRAINT import_rows_dni_source_check
      CHECK (dni_source IS NULL OR dni_source IN ('explicit', 'derived_from_cuil'));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'import_rows_participation_kind_check' AND conrelid = 'public.import_rows'::regclass) THEN
    ALTER TABLE public.import_rows
      ADD CONSTRAINT import_rows_participation_kind_check
      CHECK (participation_kind IS NULL OR participation_kind IN ('registration', 'invited', 'attended', 'absent', 'approved', 'unknown'));
  END IF;

  -- Un DNI normalizado siempre tiene su procedencia.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'import_rows_dni_has_source_check' AND conrelid = 'public.import_rows'::regclass) THEN
    ALTER TABLE public.import_rows
      ADD CONSTRAINT import_rows_dni_has_source_check
      CHECK (normalized_dni IS NULL OR dni_source IS NOT NULL);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS import_rows_normalized_dni_idx ON public.import_rows (normalized_dni) WHERE normalized_dni IS NOT NULL;
CREATE INDEX IF NOT EXISTS import_rows_person_idx ON public.import_rows (person_id) WHERE person_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS import_rows_meeting_idx ON public.import_rows (meeting_id) WHERE meeting_id IS NOT NULL;

-- ---------------------------------------------------------------- 3b. import_batches (auditoría del apply)
-- Un lote aplicado se distingue de cualquier otra cosa por execution_mode='apply' + status='applied'
-- + plan_hash. `summary` guarda solo conteos y códigos: nunca datos personales.

ALTER TABLE public.import_batches
  ADD COLUMN IF NOT EXISTS execution_mode text,
  ADD COLUMN IF NOT EXISTS plan_hash text,
  ADD COLUMN IF NOT EXISTS source_system text,
  ADD COLUMN IF NOT EXISTS sutecba_env text,
  ADD COLUMN IF NOT EXISTS applied_at timestamptz,
  ADD COLUMN IF NOT EXISTS summary jsonb;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'import_batches_execution_mode_check' AND conrelid = 'public.import_batches'::regclass) THEN
    ALTER TABLE public.import_batches
      ADD CONSTRAINT import_batches_execution_mode_check
      CHECK (execution_mode IS NULL OR execution_mode IN ('dry_run', 'apply'));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'import_batches_plan_hash_check' AND conrelid = 'public.import_batches'::regclass) THEN
    ALTER TABLE public.import_batches
      ADD CONSTRAINT import_batches_plan_hash_check
      CHECK (plan_hash IS NULL OR plan_hash ~ '^[0-9a-f]{64}$');
  END IF;

  -- Un lote 'applied' es siempre un apply completo, con su plan aprobado y su momento de aplicación.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'import_batches_applied_traceable_check' AND conrelid = 'public.import_batches'::regclass) THEN
    ALTER TABLE public.import_batches
      ADD CONSTRAINT import_batches_applied_traceable_check
      CHECK (status <> 'applied' OR (execution_mode = 'apply' AND plan_hash IS NOT NULL AND applied_at IS NOT NULL AND summary IS NOT NULL));
  END IF;
END $$;

-- ---------------------------------------------------------------- 4. meeting_participations

CREATE TABLE IF NOT EXISTS public.meeting_participations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  meeting_id uuid REFERENCES public.meetings (id) ON DELETE RESTRICT,
  campaign_key text,
  person_id uuid NOT NULL REFERENCES public.people (id) ON DELETE RESTRICT,
  participation_kind text NOT NULL
    CHECK (participation_kind IN ('registration', 'invited', 'attended', 'absent', 'approved', 'unknown')),
  evidence text,
  import_row_id uuid REFERENCES public.import_rows (id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT meeting_participations_target_check
    CHECK (meeting_id IS NOT NULL OR (campaign_key IS NOT NULL AND btrim(campaign_key) <> '')),
  -- La asistencia nunca se infiere: exige evidencia explícita.
  CONSTRAINT meeting_participations_attended_evidence_check
    CHECK (participation_kind <> 'attended' OR (evidence IS NOT NULL AND btrim(evidence) <> ''))
);

-- Unicidad lógica: reimportar no duplica participaciones. Si dos fuentes prueban la misma
-- inscripción, hay UNA participación y las demás filas se vinculan por import_entity_links.
CREATE UNIQUE INDEX IF NOT EXISTS meeting_participations_meeting_unique_idx
  ON public.meeting_participations (meeting_id, person_id, participation_kind)
  WHERE meeting_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS meeting_participations_campaign_unique_idx
  ON public.meeting_participations (campaign_key, person_id, participation_kind)
  WHERE meeting_id IS NULL;

CREATE INDEX IF NOT EXISTS meeting_participations_person_idx ON public.meeting_participations (person_id);
CREATE INDEX IF NOT EXISTS meeting_participations_meeting_idx ON public.meeting_participations (meeting_id) WHERE meeting_id IS NOT NULL;

-- Historial: no se borra (mismo trigger de 0014).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'meeting_participations_no_delete' AND tgrelid = 'public.meeting_participations'::regclass) THEN
    CREATE TRIGGER meeting_participations_no_delete
    BEFORE DELETE ON public.meeting_participations
    FOR EACH ROW
    EXECUTE FUNCTION public.sutecba_block_delete();
  END IF;
END $$;

-- Seguridad, igual que 0019: RLS default-deny + política y grants mínimos para sutecba_app.
ALTER TABLE public.meeting_participations ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'meeting_participations' AND policyname = 'sutecba_app_all'
  ) THEN
    CREATE POLICY sutecba_app_all ON public.meeting_participations
      FOR ALL TO sutecba_app
      USING (true)
      WITH CHECK (true);
  END IF;
END $$;

GRANT SELECT, INSERT ON TABLE public.meeting_participations TO sutecba_app;

COMMIT;

-- VERIFICACIÓN (ejecutar aparte):
-- SELECT column_name FROM information_schema.columns WHERE table_name = 'people' AND column_name IN ('cuil_cuit','dni_source');
-- SELECT column_name, is_nullable FROM information_schema.columns WHERE table_name = 'meetings' AND column_name IN ('starts_at','ends_at','schedule_precision','event_date','source_event_key');
-- SELECT relrowsecurity FROM pg_class WHERE relname = 'meeting_participations';
--
-- ROLLBACK CONSERVADOR (no hay DROP ejecutable): los objetos nuevos son inertes si no se usan.
-- No se restaura NOT NULL en meetings.starts_at/ends_at mientras existan eventos importados sin fecha.
