BEGIN;

SET LOCAL lock_timeout = '10s';

-- 0040 — Historial append-only de asistencia (B3). ADITIVA e idempotente.
--
-- meeting_attendance es el ESTADO ACTUAL; meeting_attendance_events es el historial. No hay event sourcing. Cada evento guarda los
-- valores NUEVOS del hecho (columnas relacionales, sin JSON): el estado anterior es el evento anterior de la misma asistencia.
--
-- Eventos:
--   · checked_in  — alta de la asistencia (QR, enlace personal o carga manual).
--   · revoked     — undo auditable (usuario + motivo obligatorios). La fila deja de ser vigente.
--   · restored    — restauración administrativa (usuario + motivo obligatorios). Solo la hace un operador; el QR nunca restaura.
--   · corrected   — corrección de la HORA/PRECISIÓN de una asistencia MANUAL (usuario + motivo). Nada más es corregible.
-- recorded_by NULL solo en un check-in hecho por la propia persona (QR / enlace).
--
-- INVARIANTE DE INTEGRIDAD (aplicación, no de base): toda mutación de estado de meeting_attendance pasa exclusivamente por los
-- comandos transaccionales de lib/attendance/ (check-in, registro manual, revocar, restaurar, corregir), que actualizan la fila Y
-- registran el evento en la MISMA transacción, con la fila bloqueada (FOR UPDATE) cuando corresponde. La base impone combinaciones
-- imposibles y que el historial sea append-only; no impone que exista un evento por cada cambio.

CREATE TABLE IF NOT EXISTS public.meeting_attendance_events (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Orden de inserción real (las transacciones sobre una misma asistencia se serializan).
  seq                bigint GENERATED ALWAYS AS IDENTITY,
  attendance_id      uuid NOT NULL,
  meeting_id         uuid NOT NULL,
  person_id          uuid NOT NULL,
  event_type         text NOT NULL,
  -- Cuándo lo registró el sistema; la toma el comando DESPUÉS de bloquear.
  occurred_at        timestamptz NOT NULL DEFAULT now(),
  recorded_by        uuid REFERENCES public.users (id) ON DELETE RESTRICT,
  attendance_method  text,
  identification     text,
  reason             text,
  checked_in_at      timestamptz,
  occurred_precision text,
  CONSTRAINT meeting_attendance_events_attendance_fkey
    FOREIGN KEY (attendance_id, meeting_id, person_id)
    REFERENCES public.meeting_attendance (id, meeting_id, person_id) ON DELETE RESTRICT,
  CONSTRAINT meeting_attendance_events_type_check
    CHECK (event_type IN ('checked_in', 'revoked', 'restored', 'corrected')),
  CONSTRAINT meeting_attendance_events_method_check
    CHECK (attendance_method IS NULL OR attendance_method IN ('qr', 'invitation_link', 'manual', 'invitation_token', 'dni', 'email', 'phone')),
  CONSTRAINT meeting_attendance_events_identification_check
    CHECK (identification IS NULL OR identification IN ('dni', 'email', 'phone', 'invitation_token')),
  CONSTRAINT meeting_attendance_events_precision_check
    CHECK (occurred_precision IS NULL OR occurred_precision IN ('exact_datetime', 'date_only', 'unknown')),
  -- checked_in: método y tiempo; precisión desconocida ⇔ sin hora; solo lo manual es inexacto; lo manual lo hace un usuario con motivo.
  CONSTRAINT meeting_attendance_events_checked_in_check
    CHECK (event_type <> 'checked_in' OR (
      attendance_method IS NOT NULL AND occurred_precision IS NOT NULL
      AND ((occurred_precision = 'unknown') = (checked_in_at IS NULL))
      AND (occurred_precision = 'exact_datetime' OR attendance_method = 'manual')
      AND (attendance_method <> 'manual' OR (recorded_by IS NOT NULL AND reason IS NOT NULL AND btrim(reason) <> '' AND identification IS NULL))
    )),
  -- revoked / restored: acto administrativo (usuario + motivo); no cambian método ni tiempos.
  CONSTRAINT meeting_attendance_events_revoked_restored_check
    CHECK (event_type NOT IN ('revoked', 'restored') OR (
      recorded_by IS NOT NULL AND reason IS NOT NULL AND btrim(reason) <> ''
      AND attendance_method IS NULL AND identification IS NULL AND checked_in_at IS NULL AND occurred_precision IS NULL
    )),
  -- corrected: solo hora/precisión de una asistencia manual (usuario + motivo); el método no se toca.
  CONSTRAINT meeting_attendance_events_corrected_check
    CHECK (event_type <> 'corrected' OR (
      recorded_by IS NOT NULL AND reason IS NOT NULL AND btrim(reason) <> ''
      AND attendance_method IS NULL AND identification IS NULL AND occurred_precision IS NOT NULL
      AND ((occurred_precision = 'unknown') = (checked_in_at IS NULL))
    ))
);

CREATE INDEX IF NOT EXISTS meeting_attendance_events_attendance_idx
  ON public.meeting_attendance_events (attendance_id, seq);

-- Append-only: ni UPDATE ni DELETE para ningún rol (la app además solo tiene SELECT/INSERT).
CREATE OR REPLACE FUNCTION public.sutecba_block_attendance_event_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $$
BEGIN
  RAISE EXCEPTION 'meeting_attendance_events es append-only: no se actualiza ni se borra';
END;
$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'meeting_attendance_events_append_only' AND tgrelid = 'public.meeting_attendance_events'::regclass) THEN
    CREATE TRIGGER meeting_attendance_events_append_only
    BEFORE UPDATE OR DELETE ON public.meeting_attendance_events
    FOR EACH ROW
    EXECUTE FUNCTION public.sutecba_block_attendance_event_mutation();
  END IF;
END $$;

ALTER TABLE public.meeting_attendance_events ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'meeting_attendance_events' AND policyname = 'sutecba_app_all') THEN
    CREATE POLICY sutecba_app_all ON public.meeting_attendance_events FOR ALL TO sutecba_app USING (true) WITH CHECK (true);
  END IF;
END $$;

REVOKE ALL ON TABLE public.meeting_attendance_events FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT ON TABLE public.meeting_attendance_events TO sutecba_app;

COMMIT;
