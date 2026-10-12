BEGIN;

SET LOCAL lock_timeout = '10s';

-- 0043 — Formularios: vínculos con campaña/reunión, políticas de personas, provenance de acciones del operador y capacidad de reuniones.
-- ADITIVA e idempotente. Sin backfill ni cambios de filas existentes (producción tiene 0 formularios y 0 envíos).
--
-- Reglas de negocio aprobadas:
--   · Un formulario público NO crea personas ni completa datos de una persona salvo política explícita por formulario
--     (person_creation_policy / apply_data_policy; ambas «never» por defecto).
--   · Completar un formulario NUNCA inscribe: la inscripción es una acción explícita que reutiliza B4 (meeting_participations).
--     La tabla form_submission_events es solo PROVENANCE (qué respuesta originó qué inscripción); NO es una segunda fuente de verdad.
--   · Las respuestas que no se pueden vincular de forma inequívoca quedan «sin vincular» (match_result = 'unlinked').
--
-- Nota: `forms.update_policy` (0006) queda DEPRECADA: la reemplaza apply_data_policy. No se elimina (sería destructivo).

-- ------------------------------------------------------------------ 1. forms
ALTER TABLE public.forms
  ADD COLUMN IF NOT EXISTS description text,
  ADD COLUMN IF NOT EXISTS campaign_id uuid REFERENCES public.campaigns (id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS meeting_id uuid REFERENCES public.meetings (id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS default_meeting_id uuid REFERENCES public.meetings (id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS person_creation_policy text NOT NULL DEFAULT 'never',
  ADD COLUMN IF NOT EXISTS apply_data_policy text NOT NULL DEFAULT 'never';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.forms'::regclass AND conname = 'forms_person_creation_policy_check') THEN
    ALTER TABLE public.forms ADD CONSTRAINT forms_person_creation_policy_check
      CHECK (person_creation_policy IN ('never', 'when_valid_dni'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.forms'::regclass AND conname = 'forms_apply_data_policy_check') THEN
    ALTER TABLE public.forms ADD CONSTRAINT forms_apply_data_policy_check
      CHECK (apply_data_policy IN ('never', 'fill_empty_only'));
  END IF;
  -- Una reunión fija ES el destino; la jornada por defecto solo tiene sentido dentro de una campaña. Nunca las dos a la vez.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.forms'::regclass AND conname = 'forms_meeting_target_check') THEN
    ALTER TABLE public.forms ADD CONSTRAINT forms_meeting_target_check
      CHECK (default_meeting_id IS NULL OR (campaign_id IS NOT NULL AND meeting_id IS NULL));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS forms_campaign_idx ON public.forms (campaign_id) WHERE campaign_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS forms_meeting_idx ON public.forms (meeting_id) WHERE meeting_id IS NOT NULL;

COMMENT ON COLUMN public.forms.person_creation_policy IS 'never (default) | when_valid_dni: solo con esta política un envío SIN coincidencia y con DNI válido crea una persona.';
COMMENT ON COLUMN public.forms.apply_data_policy IS 'never (default) | fill_empty_only: solo con esta política un envío vinculado completa campos VACÍOS de la persona.';
COMMENT ON COLUMN public.forms.update_policy IS 'DEPRECADA (0043): reemplazada por apply_data_policy. Ya no se lee.';

-- ------------------------------------------------------------------ 2. form_fields
ALTER TABLE public.form_fields
  ADD COLUMN IF NOT EXISTS description text,
  ADD COLUMN IF NOT EXISTS validation jsonb;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.form_fields'::regclass AND conname = 'form_fields_validation_object_check') THEN
    ALTER TABLE public.form_fields ADD CONSTRAINT form_fields_validation_object_check
      CHECK (validation IS NULL OR jsonb_typeof(validation) = 'object');
  END IF;
END $$;

-- ------------------------------------------------------------------ 3. form_submissions
ALTER TABLE public.form_submissions
  ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'public',
  ADD COLUMN IF NOT EXISTS source_import_row_id uuid REFERENCES public.import_rows (id) ON DELETE RESTRICT;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.form_submissions'::regclass AND conname = 'form_submissions_source_check') THEN
    ALTER TABLE public.form_submissions ADD CONSTRAINT form_submissions_source_check
      CHECK (source IN ('public', 'csv_import', 'manual'));
  END IF;
  -- Amplía el vocabulario con 'unlinked' (respuesta sin persona vinculada; el operador decide). No toca filas.
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.form_submissions'::regclass AND conname = 'form_submissions_match_result_check'
             AND pg_get_constraintdef(oid) NOT LIKE '%''unlinked''%') THEN
    ALTER TABLE public.form_submissions DROP CONSTRAINT form_submissions_match_result_check;
    ALTER TABLE public.form_submissions ADD CONSTRAINT form_submissions_match_result_check
      CHECK (match_result IN ('pending', 'created', 'matched', 'needs_review', 'error', 'unlinked'));
  END IF;
END $$;

-- Bandeja «Respuestas sin vincular»: envíos sin persona, por formulario y fecha.
CREATE INDEX IF NOT EXISTS form_submissions_unlinked_idx
  ON public.form_submissions (form_id, created_at DESC)
  WHERE person_id IS NULL;
CREATE INDEX IF NOT EXISTS form_submissions_person_idx
  ON public.form_submissions (person_id)
  WHERE person_id IS NOT NULL;

-- ------------------------------------------------------------------ 4. Historial de acciones sobre respuestas (provenance)
-- Append-only. Registra QUIÉN vinculó, creó una persona, aplicó datos o inscribió a partir de una respuesta, y la inscripción resultante.
-- `enrolled` referencia la fila canónica de meeting_participations (B4) solo como provenance: el estado de la inscripción vive allá.
CREATE TABLE IF NOT EXISTS public.form_submission_events (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  seq              bigint GENERATED ALWAYS AS IDENTITY,
  submission_id    uuid NOT NULL REFERENCES public.form_submissions (id) ON DELETE RESTRICT,
  event_type       text NOT NULL,
  person_id        uuid NOT NULL REFERENCES public.people (id) ON DELETE RESTRICT,
  meeting_id       uuid REFERENCES public.meetings (id) ON DELETE RESTRICT,
  participation_id uuid,
  -- NULL solo en los eventos automáticos (auto_*), que son actos del sistema al procesar el envío.
  recorded_by      uuid REFERENCES public.users (id) ON DELETE RESTRICT,
  reason           text,
  -- Detalle auditable (p. ej. campos aplicados con antes/después). Nunca secretos.
  details          jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT form_submission_events_type_check
    CHECK (event_type IN ('auto_linked', 'auto_person_created', 'auto_data_applied', 'linked', 'person_created', 'data_applied', 'enrolled')),
  CONSTRAINT form_submission_events_actor_check
    CHECK ((event_type LIKE 'auto\_%') = (recorded_by IS NULL)),
  CONSTRAINT form_submission_events_enrolled_check
    CHECK (event_type <> 'enrolled' OR (meeting_id IS NOT NULL AND participation_id IS NOT NULL)),
  CONSTRAINT form_submission_events_details_object_check
    CHECK (jsonb_typeof(details) = 'object'),
  CONSTRAINT form_submission_events_participation_fkey
    FOREIGN KEY (participation_id, person_id)
    REFERENCES public.meeting_participations (id, person_id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS form_submission_events_submission_idx ON public.form_submission_events (submission_id, seq);
CREATE INDEX IF NOT EXISTS form_submission_events_person_idx ON public.form_submission_events (person_id, seq);
-- Idempotencia: una respuesta originó, como máximo, UNA inscripción por reunión (un reintento o doble clic no duplica el evento).
CREATE UNIQUE INDEX IF NOT EXISTS form_submission_events_enrolled_unique_idx
  ON public.form_submission_events (submission_id, meeting_id)
  WHERE event_type = 'enrolled';

CREATE OR REPLACE FUNCTION public.sutecba_block_form_submission_event_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $$
BEGIN
  RAISE EXCEPTION 'form_submission_events es append-only: no se actualiza ni se borra';
END;
$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'form_submission_events_append_only' AND tgrelid = 'public.form_submission_events'::regclass) THEN
    CREATE TRIGGER form_submission_events_append_only
    BEFORE UPDATE OR DELETE ON public.form_submission_events
    FOR EACH ROW
    EXECUTE FUNCTION public.sutecba_block_form_submission_event_mutation();
  END IF;
END $$;

ALTER TABLE public.form_submission_events ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'form_submission_events' AND policyname = 'sutecba_app_all') THEN
    CREATE POLICY sutecba_app_all ON public.form_submission_events FOR ALL TO sutecba_app USING (true) WITH CHECK (true);
  END IF;
END $$;

REVOKE ALL ON TABLE public.form_submission_events FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT ON TABLE public.form_submission_events TO sutecba_app;

-- ------------------------------------------------------------------ 5. Capacidad de reuniones (blanda: solo advierte)
ALTER TABLE public.meetings ADD COLUMN IF NOT EXISTS capacity integer;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.meetings'::regclass AND conname = 'meetings_capacity_positive_check') THEN
    ALTER TABLE public.meetings ADD CONSTRAINT meetings_capacity_positive_check CHECK (capacity IS NULL OR capacity > 0);
  END IF;
END $$;

COMMENT ON COLUMN public.meetings.capacity IS 'Capacidad BLANDA (informativa): superarla advierte pero no bloquea la inscripción de un operador autorizado.';

-- ------------------------------------------------------------------ 6. Canal de inscripción «form» (B4)
-- Una inscripción creada por un operador a partir de una respuesta de formulario usa origin_channel='form' (clase A de B4: operador +
-- canal, sin invitación de origen). Solo AMPLÍA el vocabulario: ninguna fila existente cambia.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.meeting_participations'::regclass AND conname = 'meeting_participations_origin_channel_check'
             AND pg_get_constraintdef(oid) NOT LIKE '%''form''%') THEN
    ALTER TABLE public.meeting_participations DROP CONSTRAINT meeting_participations_origin_channel_check;
    ALTER TABLE public.meeting_participations ADD CONSTRAINT meeting_participations_origin_channel_check
      CHECK (origin_channel IS NULL OR origin_channel IN ('whatsapp', 'email', 'sms', 'phone', 'in_person', 'other', 'form'));
  END IF;
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.meeting_registration_events'::regclass AND conname = 'meeting_registration_events_channel_check'
             AND pg_get_constraintdef(oid) NOT LIKE '%''form''%') THEN
    ALTER TABLE public.meeting_registration_events DROP CONSTRAINT meeting_registration_events_channel_check;
    ALTER TABLE public.meeting_registration_events ADD CONSTRAINT meeting_registration_events_channel_check
      CHECK (origin_channel IS NULL OR origin_channel IN ('whatsapp', 'email', 'sms', 'phone', 'in_person', 'other', 'form'));
  END IF;
END $$;

COMMENT ON COLUMN public.meeting_participations.origin_channel IS 'Canal REAL por el que llegó una inscripción MANUAL (whatsapp | email | sms | phone | in_person | other | form). NULL si nació de una aceptación.';

COMMIT;
