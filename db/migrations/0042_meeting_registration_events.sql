BEGIN;

SET LOCAL lock_timeout = '10s';

-- 0042 — Historial append-only de inscripciones (B4). ADITIVA e idempotente.
--
-- meeting_participations (la fila 'registration') es el ESTADO ACTUAL; meeting_registration_events es el historial de las
-- mutaciones OPERATIVAS nuevas. No hay event sourcing y las 961 inscripciones históricas NO reciben eventos retroactivos: su
-- procedencia sigue siendo import_row_id. Cada evento guarda los valores NUEVOS del hecho (columnas relacionales, sin JSON).
--
-- Eventos:
--   · registered — alta operativa (manual con canal, o desde aceptación con invitación de origen).
--   · voided     — anulación (usuario + motivo). No toca participación, asistencia, invitación ni respuesta.
--   · restored   — restauración de una anulada (usuario + motivo). Misma fila, sin segunda fila.
--   · corrected  — corrección de fecha/precisión/canal de una inscripción OPERATIVA (usuario + motivo). Nunca persona, reunión, tipo,
--                  base, import_row_id ni la invitación de origen.
-- recorded_by es siempre un usuario: todas las mutaciones de este historial son actos de un operador.
--
-- INVARIANTE DE INTEGRIDAD (aplicación, no de base): ver lib/meetings/registrations.ts.

CREATE TABLE IF NOT EXISTS public.meeting_registration_events (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Orden de inserción real (las transacciones sobre una misma inscripción se serializan con FOR UPDATE).
  seq                    bigint GENERATED ALWAYS AS IDENTITY,
  participation_id       uuid NOT NULL,
  person_id              uuid NOT NULL,
  event_type             text NOT NULL,
  -- Cuándo lo registró el sistema; la toma el comando DESPUÉS de bloquear.
  occurred_at            timestamptz NOT NULL DEFAULT now(),
  recorded_by            uuid NOT NULL REFERENCES public.users (id) ON DELETE RESTRICT,
  reason                 text,
  origin_channel         text,
  origin_invitation_id   uuid REFERENCES public.meeting_invitations (id) ON DELETE RESTRICT,
  registered_at          timestamptz,
  registered_at_precision text,
  CONSTRAINT meeting_registration_events_participation_fkey
    FOREIGN KEY (participation_id, person_id)
    REFERENCES public.meeting_participations (id, person_id) ON DELETE RESTRICT,
  CONSTRAINT meeting_registration_events_type_check
    CHECK (event_type IN ('registered', 'voided', 'restored', 'corrected')),
  CONSTRAINT meeting_registration_events_channel_check
    CHECK (origin_channel IS NULL OR origin_channel IN ('whatsapp', 'email', 'sms', 'phone', 'in_person', 'other')),
  CONSTRAINT meeting_registration_events_precision_check
    CHECK (registered_at_precision IS NULL OR registered_at_precision IN ('exact_datetime', 'date_only')),
  CONSTRAINT meeting_registration_events_pair_check
    CHECK ((registered_at IS NULL) = (registered_at_precision IS NULL)),
  -- registered: o canal (manual) o invitación de origen (desde aceptación), nunca ambos ni ninguno.
  CONSTRAINT meeting_registration_events_registered_check
    CHECK (event_type <> 'registered' OR ((origin_channel IS NOT NULL) <> (origin_invitation_id IS NOT NULL))),
  -- voided / restored: acto administrativo con motivo; no cambian fecha, canal ni origen.
  CONSTRAINT meeting_registration_events_void_restore_check
    CHECK (event_type NOT IN ('voided', 'restored') OR (
      reason IS NOT NULL AND btrim(reason) <> ''
      AND origin_channel IS NULL AND origin_invitation_id IS NULL AND registered_at IS NULL AND registered_at_precision IS NULL
    )),
  -- corrected: motivo obligatorio; el origen (invitación) no se corrige por esta vía.
  CONSTRAINT meeting_registration_events_corrected_check
    CHECK (event_type <> 'corrected' OR (reason IS NOT NULL AND btrim(reason) <> '' AND origin_invitation_id IS NULL))
);

CREATE INDEX IF NOT EXISTS meeting_registration_events_participation_idx
  ON public.meeting_registration_events (participation_id, seq);

-- Append-only: ni UPDATE ni DELETE para ningún rol (la app además solo tiene SELECT/INSERT).
CREATE OR REPLACE FUNCTION public.sutecba_block_registration_event_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $$
BEGIN
  RAISE EXCEPTION 'meeting_registration_events es append-only: no se actualiza ni se borra';
END;
$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'meeting_registration_events_append_only' AND tgrelid = 'public.meeting_registration_events'::regclass) THEN
    CREATE TRIGGER meeting_registration_events_append_only
    BEFORE UPDATE OR DELETE ON public.meeting_registration_events
    FOR EACH ROW
    EXECUTE FUNCTION public.sutecba_block_registration_event_mutation();
  END IF;
END $$;

ALTER TABLE public.meeting_registration_events ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'meeting_registration_events' AND policyname = 'sutecba_app_all') THEN
    CREATE POLICY sutecba_app_all ON public.meeting_registration_events FOR ALL TO sutecba_app USING (true) WITH CHECK (true);
  END IF;
END $$;

REVOKE ALL ON TABLE public.meeting_registration_events FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT ON TABLE public.meeting_registration_events TO sutecba_app;

COMMIT;
