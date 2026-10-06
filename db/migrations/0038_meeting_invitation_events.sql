BEGIN;

SET LOCAL lock_timeout = '10s';

-- 0038 — Historial append-only de invitaciones y respuestas (B2). ADITIVA e idempotente.
--
-- meeting_invitations sigue siendo el ESTADO ACTUAL; meeting_invitation_events es el historial. No hay event sourcing: el
-- estado no se reconstruye desde los eventos. Cada evento guarda los valores NUEVOS del hecho (columnas relacionales, sin
-- JSON); el estado anterior es el evento anterior de la misma invitación.
--
-- INVARIANTE DE INTEGRIDAD (aplicación, no de base): toda mutación de estado o de metadata semántica de meeting_invitations
-- pasa exclusivamente por los comandos transaccionales de lib/meetings/invitations.ts y lib/meetings/public.ts, que actualizan
-- la fila y registran el evento en la MISMA transacción, con la invitación bloqueada (FOR UPDATE). Un test de código fuente
-- es una defensa adicional, no una garantía de integridad de base.
--
-- Eventos: invited · responded (pending → aceptó/rechazó) · response_changed (cambia el estado o se corrige canal/fecha) ·
--          withdrawn · reinvited (estado previo → pending).
-- recorded_by NULL solo en respuestas dadas por la propia persona (enlace público).

-- La FK compuesta garantiza que el evento nombra la misma reunión y persona que su invitación.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.meeting_invitations'::regclass AND conname = 'meeting_invitations_id_meeting_person_key') THEN
    ALTER TABLE public.meeting_invitations
      ADD CONSTRAINT meeting_invitations_id_meeting_person_key UNIQUE (id, meeting_id, person_id);
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS public.meeting_invitation_events (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Orden de inserción real (las transacciones sobre una misma invitación se serializan con FOR UPDATE).
  seq                    bigint GENERATED ALWAYS AS IDENTITY,
  invitation_id          uuid NOT NULL,
  meeting_id             uuid NOT NULL,
  person_id              uuid NOT NULL,
  event_type             text NOT NULL,
  -- Cuándo lo registró el sistema (no la fecha real de la respuesta, que va en responded_at). La toma el comando DESPUÉS de bloquear la invitación.
  occurred_at            timestamptz NOT NULL DEFAULT now(),
  recorded_by            uuid REFERENCES public.users (id) ON DELETE RESTRICT,
  batch_id               uuid REFERENCES public.meeting_invitation_batches (id) ON DELETE RESTRICT,
  invitation_channel     text,
  response_status_from   text,
  response_status_to     text,
  response_channel       text,
  responded_at           timestamptz,
  responded_at_precision text,
  CONSTRAINT meeting_invitation_events_invitation_fkey
    FOREIGN KEY (invitation_id, meeting_id, person_id)
    REFERENCES public.meeting_invitations (id, meeting_id, person_id) ON DELETE RESTRICT,
  CONSTRAINT meeting_invitation_events_type_check
    CHECK (event_type IN ('invited', 'responded', 'response_changed', 'withdrawn', 'reinvited')),
  CONSTRAINT meeting_invitation_events_status_check
    CHECK ((response_status_from IS NULL OR response_status_from IN ('pending', 'confirmed', 'declined'))
       AND (response_status_to IS NULL OR response_status_to IN ('pending', 'confirmed', 'declined'))),
  CONSTRAINT meeting_invitation_events_invitation_channel_check
    CHECK (invitation_channel IS NULL OR invitation_channel IN ('whatsapp', 'email', 'sms', 'phone', 'in_person', 'other')),
  CONSTRAINT meeting_invitation_events_response_channel_check
    CHECK (response_channel IS NULL OR response_channel IN ('public_link', 'whatsapp', 'email', 'sms', 'phone', 'in_person', 'other')),
  CONSTRAINT meeting_invitation_events_precision_check
    CHECK (responded_at_precision IS NULL OR responded_at_precision IN ('exact_datetime', 'date_only')),
  CONSTRAINT meeting_invitation_events_precision_pair_check
    CHECK ((responded_at IS NULL) = (responded_at_precision IS NULL)),
  -- invited: lo crea un usuario; arranca pendiente y sin datos de respuesta.
  CONSTRAINT meeting_invitation_events_invited_check
    CHECK (event_type <> 'invited' OR (
      recorded_by IS NOT NULL AND response_status_from IS NULL AND response_status_to = 'pending'
      AND response_channel IS NULL AND responded_at IS NULL)),
  -- responded: primera respuesta (de pending a aceptó/rechazó).
  CONSTRAINT meeting_invitation_events_responded_check
    CHECK (event_type <> 'responded' OR (
      response_status_from = 'pending' AND response_status_to IN ('confirmed', 'declined')
      AND response_channel IS NOT NULL AND invitation_channel IS NULL AND batch_id IS NULL)),
  -- response_changed: de aceptó/rechazó a aceptó/rechazó (from = to solo en una corrección explícita de metadata por staff).
  CONSTRAINT meeting_invitation_events_response_changed_check
    CHECK (event_type <> 'response_changed' OR (
      response_status_from IN ('confirmed', 'declined') AND response_status_to IN ('confirmed', 'declined')
      AND response_channel IS NOT NULL AND invitation_channel IS NULL AND batch_id IS NULL)),
  -- Quien responde por el enlace no tiene recorder; quien responde por cualquier otro canal lo registró un operador.
  CONSTRAINT meeting_invitation_events_public_recorder_check
    CHECK (event_type NOT IN ('responded', 'response_changed') OR ((response_channel = 'public_link') = (recorded_by IS NULL))),
  CONSTRAINT meeting_invitation_events_public_exact_check
    CHECK (response_channel IS DISTINCT FROM 'public_link' OR (responded_at IS NOT NULL AND responded_at_precision = 'exact_datetime')),
  -- withdrawn: siempre lo hace un usuario; sin datos de respuesta.
  CONSTRAINT meeting_invitation_events_withdrawn_check
    CHECK (event_type <> 'withdrawn' OR (
      recorded_by IS NOT NULL AND response_status_from IS NULL AND response_status_to IS NULL
      AND response_channel IS NULL AND responded_at IS NULL AND invitation_channel IS NULL AND batch_id IS NULL)),
  -- reinvited: lo hace un usuario; guarda el estado previo y reinicia a pending.
  CONSTRAINT meeting_invitation_events_reinvited_check
    CHECK (event_type <> 'reinvited' OR (
      recorded_by IS NOT NULL AND response_status_from IS NOT NULL AND response_status_to = 'pending'
      AND response_channel IS NULL AND responded_at IS NULL))
);

CREATE INDEX IF NOT EXISTS meeting_invitation_events_invitation_idx
  ON public.meeting_invitation_events (invitation_id, seq);

-- Append-only: ni UPDATE ni DELETE para ningún rol (la app además solo tiene SELECT/INSERT).
CREATE OR REPLACE FUNCTION public.sutecba_block_invitation_event_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $$
BEGIN
  RAISE EXCEPTION 'meeting_invitation_events es append-only: no se actualiza ni se borra';
END;
$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'meeting_invitation_events_append_only' AND tgrelid = 'public.meeting_invitation_events'::regclass) THEN
    CREATE TRIGGER meeting_invitation_events_append_only
    BEFORE UPDATE OR DELETE ON public.meeting_invitation_events
    FOR EACH ROW
    EXECUTE FUNCTION public.sutecba_block_invitation_event_mutation();
  END IF;
END $$;

ALTER TABLE public.meeting_invitation_events ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'meeting_invitation_events' AND policyname = 'sutecba_app_all') THEN
    CREATE POLICY sutecba_app_all ON public.meeting_invitation_events FOR ALL TO sutecba_app USING (true) WITH CHECK (true);
  END IF;
END $$;

REVOKE ALL ON TABLE public.meeting_invitation_events FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT ON TABLE public.meeting_invitation_events TO sutecba_app;

COMMIT;
