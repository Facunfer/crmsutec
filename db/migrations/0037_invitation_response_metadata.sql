BEGIN;

-- Falla rápido (no bloquea la aplicación esperando) si otra transacción larga retiene un lock.
SET LOCAL lock_timeout = '10s';

-- 0037 — Metadata de invitación y respuesta (B2). ADITIVA e idempotente. Sin backfill: en producción hay 0 invitaciones.
--
-- Cuatro conceptos que NO se mezclan:
--   · channel (existente, default 'manual_link'): forma TÉCNICA de creación/entrega del enlace. No se toca ni se reinterpreta.
--   · invitation_channel: canal de COMUNICACIÓN por el que se invitó (registro manual: el CRM NO envía mensajes). NULL = no registrado.
--   · response_channel: cómo llegó la respuesta. 'public_link' = la persona respondió por su enlace; el resto lo registró un operador.
--   · response_recorded_by: NULL ⇔ respuesta por el enlace público; usuario ⇔ la cargó un operador. Nunca se atribuye
--     una respuesta pública a un usuario interno. «Cargada manualmente» no es un canal: es quién la registró.
--
-- Tiempos de la respuesta (no se inventa ninguna fecha):
--   · responded_at (+ responded_at_precision): cuándo respondió la persona, si se sabe. NULL solo para una respuesta cargada por
--     staff cuya fecha real se desconoce. 'date_only' = medianoche de Buenos Aires (mismo patrón que meetings e interacciones).
--   · response_recorded_at: cuándo guardó el sistema la respuesta. Siempre exacto.
--
-- attendance_status queda DEPRECADO (no es fuente de asistencia; ver docs/FASE-B-DISENO.md). Esta migración no lo toca.
--
-- INVARIANTE DE INTEGRIDAD (aplicación): toda mutación de estado o de metadata semántica de meeting_invitations debe pasar
-- exclusivamente por los comandos transaccionales de lib/meetings/invitations.ts y lib/meetings/public.ts, que actualizan la
-- fila y registran su evento (0038) en la MISMA transacción. La base impone las combinaciones imposibles; no impone el historial.
--
-- COMPATIBILIDAD: el código anterior no escribe estas columnas (quedan NULL). Con las invariantes de abajo, el código anterior
-- fallaría al GUARDAR una respuesta (no manda canal): hoy no existe ninguna invitación, así que se aplica pegada al deploy.

ALTER TABLE public.meeting_invitations
  ADD COLUMN IF NOT EXISTS invited_by uuid,
  ADD COLUMN IF NOT EXISTS invitation_channel text,
  ADD COLUMN IF NOT EXISTS response_channel text,
  ADD COLUMN IF NOT EXISTS response_recorded_by uuid,
  ADD COLUMN IF NOT EXISTS responded_at_precision text,
  ADD COLUMN IF NOT EXISTS response_recorded_at timestamptz;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.meeting_invitations'::regclass AND conname = 'meeting_invitations_invited_by_fkey') THEN
    ALTER TABLE public.meeting_invitations
      ADD CONSTRAINT meeting_invitations_invited_by_fkey FOREIGN KEY (invited_by) REFERENCES public.users (id) ON DELETE RESTRICT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.meeting_invitations'::regclass AND conname = 'meeting_invitations_response_recorded_by_fkey') THEN
    ALTER TABLE public.meeting_invitations
      ADD CONSTRAINT meeting_invitations_response_recorded_by_fkey FOREIGN KEY (response_recorded_by) REFERENCES public.users (id) ON DELETE RESTRICT;
  END IF;

  -- Vocabularios
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.meeting_invitations'::regclass AND conname = 'meeting_invitations_invitation_channel_check') THEN
    ALTER TABLE public.meeting_invitations ADD CONSTRAINT meeting_invitations_invitation_channel_check
      CHECK (invitation_channel IS NULL OR invitation_channel IN ('whatsapp', 'email', 'sms', 'phone', 'in_person', 'other'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.meeting_invitations'::regclass AND conname = 'meeting_invitations_response_channel_check') THEN
    ALTER TABLE public.meeting_invitations ADD CONSTRAINT meeting_invitations_response_channel_check
      CHECK (response_channel IS NULL OR response_channel IN ('public_link', 'whatsapp', 'email', 'sms', 'phone', 'in_person', 'other'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.meeting_invitations'::regclass AND conname = 'meeting_invitations_responded_precision_check') THEN
    ALTER TABLE public.meeting_invitations ADD CONSTRAINT meeting_invitations_responded_precision_check
      CHECK (responded_at_precision IS NULL OR responded_at_precision IN ('exact_datetime', 'date_only'));
  END IF;

  -- 1. Pendiente: sin ningún dato de respuesta.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.meeting_invitations'::regclass AND conname = 'meeting_invitations_pending_has_no_response_check') THEN
    ALTER TABLE public.meeting_invitations ADD CONSTRAINT meeting_invitations_pending_has_no_response_check
      CHECK (response_status <> 'pending' OR (
        responded_at IS NULL AND responded_at_precision IS NULL AND response_channel IS NULL
        AND response_recorded_by IS NULL AND response_recorded_at IS NULL));
  END IF;
  -- 2. Respondida: canal y fecha de registro obligatorios.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.meeting_invitations'::regclass AND conname = 'meeting_invitations_answered_has_channel_check') THEN
    ALTER TABLE public.meeting_invitations ADD CONSTRAINT meeting_invitations_answered_has_channel_check
      CHECK (response_status = 'pending' OR (response_channel IS NOT NULL AND response_recorded_at IS NOT NULL));
  END IF;
  -- 3. Fecha y precisión van juntas (precisión NULL ⇔ fecha NULL).
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.meeting_invitations'::regclass AND conname = 'meeting_invitations_responded_precision_pair_check') THEN
    ALTER TABLE public.meeting_invitations ADD CONSTRAINT meeting_invitations_responded_precision_pair_check
      CHECK ((responded_at IS NULL) = (responded_at_precision IS NULL));
  END IF;
  -- 4. Fecha real desconocida: solo en una respuesta cargada por un operador.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.meeting_invitations'::regclass AND conname = 'meeting_invitations_unknown_date_requires_staff_check') THEN
    ALTER TABLE public.meeting_invitations ADD CONSTRAINT meeting_invitations_unknown_date_requires_staff_check
      CHECK (response_status = 'pending' OR responded_at IS NOT NULL OR response_recorded_by IS NOT NULL);
  END IF;
  -- 5. Respuesta pública: el servidor conoce el momento exacto y no hay usuario.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.meeting_invitations'::regclass AND conname = 'meeting_invitations_public_link_response_check') THEN
    ALTER TABLE public.meeting_invitations ADD CONSTRAINT meeting_invitations_public_link_response_check
      CHECK (response_channel IS DISTINCT FROM 'public_link' OR (
        response_recorded_by IS NULL AND responded_at IS NOT NULL AND responded_at_precision = 'exact_datetime'
        AND response_recorded_at IS NOT NULL));
  END IF;
  -- 6. Cualquier otro canal lo registró un operador (con 5: recorder NULL ⇔ enlace público).
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.meeting_invitations'::regclass AND conname = 'meeting_invitations_staff_channel_requires_recorder_check') THEN
    ALTER TABLE public.meeting_invitations ADD CONSTRAINT meeting_invitations_staff_channel_requires_recorder_check
      CHECK (response_channel IS NULL OR response_channel = 'public_link' OR response_recorded_by IS NOT NULL);
  END IF;
  -- 7. date_only = medianoche de Buenos Aires.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.meeting_invitations'::regclass AND conname = 'meeting_invitations_responded_date_only_check') THEN
    ALTER TABLE public.meeting_invitations ADD CONSTRAINT meeting_invitations_responded_date_only_check
      CHECK (responded_at_precision IS DISTINCT FROM 'date_only'
             OR ((responded_at AT TIME ZONE 'America/Argentina/Buenos_Aires')::time = TIME '00:00'));
  END IF;
  -- 8. Nunca se inventa una fecha posterior a cuando se registró la respuesta.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.meeting_invitations'::regclass AND conname = 'meeting_invitations_responded_not_after_recorded_check') THEN
    ALTER TABLE public.meeting_invitations ADD CONSTRAINT meeting_invitations_responded_not_after_recorded_check
      CHECK (responded_at IS NULL OR response_recorded_at IS NULL OR responded_at <= response_recorded_at);
  END IF;
  -- 10. Retiro: fecha y responsable van juntos.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.meeting_invitations'::regclass AND conname = 'meeting_invitations_withdrawn_pair_check') THEN
    ALTER TABLE public.meeting_invitations ADD CONSTRAINT meeting_invitations_withdrawn_pair_check
      CHECK ((withdrawn_at IS NULL) = (withdrawn_by IS NULL));
  END IF;
END $$;

COMMENT ON COLUMN public.meeting_invitations.channel IS
  'Forma TÉCNICA de creación/entrega (p. ej. manual_link: enlace personal repartido por el operador). NO es el canal de comunicación: ver invitation_channel.';
COMMENT ON COLUMN public.meeting_invitations.invitation_channel IS
  'Canal por el que se invitó (registro manual; el CRM no envía mensajes). NULL = no registrado.';
COMMENT ON COLUMN public.meeting_invitations.response_recorded_by IS
  'NULL = respondió la propia persona por el enlace público; usuario = lo registró un operador.';
COMMENT ON COLUMN public.meeting_invitations.responded_at IS
  'Cuándo respondió la persona, si se sabe (ver responded_at_precision). NULL solo en una respuesta cargada por staff con fecha real desconocida.';
COMMENT ON COLUMN public.meeting_invitations.attendance_status IS
  'DEPRECADO (Fase B). No es fuente de asistencia: la asistencia vigente es meeting_attendance.';

COMMIT;
