BEGIN;

-- Falla rápido (no bloquea la aplicación esperando) si otra transacción larga retiene un lock.
SET LOCAL lock_timeout = '10s';

-- 0039 — Asistencia: metadata de registro, hora real vs hora de registro y revocación (B3). ADITIVA e idempotente.
-- Sin backfill: en producción hay 0 filas de meeting_attendance. No toca participaciones ni interacciones.
--
-- meeting_attendance es la fuente CANÓNICA de asistencia real. La fila es el ESTADO ACTUAL; el historial vive en
-- meeting_attendance_events (0040). Una asistencia está VIGENTE cuando revoked_at IS NULL. Nunca se borra (trigger no_delete).
--
-- Dos conceptos que NO se mezclan:
--   · method: CÓMO se registró — 'qr' (la persona escaneó el QR de la reunión y se identificó), 'invitation_link' (usó su enlace
--     personal) o 'manual' (lo acreditó un operador).
--   · identification: CON QUÉ se identificó la persona — 'dni' | 'email' | 'phone' | 'invitation_token'. NULL en lo manual.
--   Compatibilidad: el CHECK de method acepta TAMBIÉN los valores anteriores ('invitation_token','dni','email','phone') para que el
--   runtime desplegado antes de B3 siga funcionando; quedan deprecados y se ajustan en una fase posterior.
--
-- Tiempos (no se inventa ninguna fecha ni hora):
--   · checked_in_at + occurred_precision: CUÁNDO ocurrió la asistencia. 'exact_datetime' (QR, enlace y manual con hora),
--     'date_only' (manual: solo se sabe el día → medianoche de Buenos Aires) o 'unknown' (manual: se desconoce; checked_in_at NULL).
--   · recorded_at: cuándo guardó el CRM la asistencia (siempre exacto).
--
-- Revocación (undo auditable): revoked_at / revoked_by / revoke_reason van juntos y el motivo no puede ser vacío. Restaurar los
-- limpia; quién/cuándo/por qué se revocó y se restauró queda en los eventos. correction_reason conserva su significado de
-- «motivo de la carga manual» (obligatorio cuando method = 'manual'); el motivo de revocación es revoke_reason.

ALTER TABLE public.meeting_attendance
  ADD COLUMN IF NOT EXISTS identification text,
  ADD COLUMN IF NOT EXISTS recorded_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS occurred_precision text NOT NULL DEFAULT 'exact_datetime',
  ADD COLUMN IF NOT EXISTS revoked_at timestamptz,
  ADD COLUMN IF NOT EXISTS revoked_by uuid,
  ADD COLUMN IF NOT EXISTS revoke_reason text;

-- La hora real puede desconocerse (solo en una carga manual): checked_in_at admite NULL. Idempotente.
ALTER TABLE public.meeting_attendance ALTER COLUMN checked_in_at DROP NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.meeting_attendance'::regclass AND conname = 'meeting_attendance_revoked_by_fkey') THEN
    ALTER TABLE public.meeting_attendance
      ADD CONSTRAINT meeting_attendance_revoked_by_fkey FOREIGN KEY (revoked_by) REFERENCES public.users (id) ON DELETE RESTRICT;
  END IF;

  -- method: superconjunto (vocabulario nuevo + valores anteriores deprecados).
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.meeting_attendance'::regclass AND conname = 'meeting_attendance_method_check'
      AND pg_get_constraintdef(oid) LIKE '%qr%'
  ) THEN
    ALTER TABLE public.meeting_attendance DROP CONSTRAINT IF EXISTS meeting_attendance_method_check;
    ALTER TABLE public.meeting_attendance ADD CONSTRAINT meeting_attendance_method_check
      CHECK (method IN ('qr', 'invitation_link', 'manual', 'invitation_token', 'dni', 'email', 'phone'));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.meeting_attendance'::regclass AND conname = 'meeting_attendance_identification_check') THEN
    ALTER TABLE public.meeting_attendance ADD CONSTRAINT meeting_attendance_identification_check
      CHECK (identification IS NULL OR identification IN ('dni', 'email', 'phone', 'invitation_token'));
  END IF;
  -- Combinaciones del vocabulario NUEVO (los valores anteriores no se restringen).
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.meeting_attendance'::regclass AND conname = 'meeting_attendance_method_identification_check') THEN
    ALTER TABLE public.meeting_attendance ADD CONSTRAINT meeting_attendance_method_identification_check
      CHECK (
        (method <> 'qr' OR (identification IS NOT NULL AND identification IN ('dni', 'email', 'phone')))
        AND (method <> 'invitation_link' OR identification = 'invitation_token')
        AND (method <> 'manual' OR identification IS NULL)
      );
  END IF;
  -- La carga manual exige operador y motivo (antes solo lo garantizaba el trigger).
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.meeting_attendance'::regclass AND conname = 'meeting_attendance_manual_requires_actor_reason_check') THEN
    ALTER TABLE public.meeting_attendance ADD CONSTRAINT meeting_attendance_manual_requires_actor_reason_check
      CHECK (method <> 'manual' OR (registered_by IS NOT NULL AND correction_reason IS NOT NULL AND btrim(correction_reason) <> ''));
  END IF;

  -- Tiempos.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.meeting_attendance'::regclass AND conname = 'meeting_attendance_precision_check') THEN
    ALTER TABLE public.meeting_attendance ADD CONSTRAINT meeting_attendance_precision_check
      CHECK (occurred_precision IN ('exact_datetime', 'date_only', 'unknown'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.meeting_attendance'::regclass AND conname = 'meeting_attendance_precision_time_pair_check') THEN
    ALTER TABLE public.meeting_attendance ADD CONSTRAINT meeting_attendance_precision_time_pair_check
      CHECK ((occurred_precision = 'unknown') = (checked_in_at IS NULL));
  END IF;
  -- Solo la carga manual puede tener día sin hora o fecha desconocida; QR/enlace (y los métodos anteriores) son siempre exactos.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.meeting_attendance'::regclass AND conname = 'meeting_attendance_inexact_only_manual_check') THEN
    ALTER TABLE public.meeting_attendance ADD CONSTRAINT meeting_attendance_inexact_only_manual_check
      CHECK (occurred_precision = 'exact_datetime' OR method = 'manual');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.meeting_attendance'::regclass AND conname = 'meeting_attendance_date_only_check') THEN
    ALTER TABLE public.meeting_attendance ADD CONSTRAINT meeting_attendance_date_only_check
      CHECK (occurred_precision IS DISTINCT FROM 'date_only'
             OR ((checked_in_at AT TIME ZONE 'America/Argentina/Buenos_Aires')::time = TIME '00:00'));
  END IF;

  -- Revocación: los tres campos van juntos y el motivo no es vacío.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.meeting_attendance'::regclass AND conname = 'meeting_attendance_revocation_complete_check') THEN
    ALTER TABLE public.meeting_attendance ADD CONSTRAINT meeting_attendance_revocation_complete_check
      CHECK ((revoked_at IS NULL) = (revoked_by IS NULL) AND (revoked_at IS NULL) = (revoke_reason IS NULL)
             AND (revoke_reason IS NULL OR btrim(revoke_reason) <> ''));
  END IF;

  -- Para la FK compuesta de los eventos (0040): el evento nombra la misma reunión y persona que su asistencia.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.meeting_attendance'::regclass AND conname = 'meeting_attendance_id_meeting_person_key') THEN
    ALTER TABLE public.meeting_attendance ADD CONSTRAINT meeting_attendance_id_meeting_person_key UNIQUE (id, meeting_id, person_id);
  END IF;
END $$;

-- La actividad de la persona (y su futura línea de tiempo) consulta por persona.
CREATE INDEX IF NOT EXISTS meeting_attendance_person_idx ON public.meeting_attendance (person_id);

-- GUARD reescrito. El anterior exigía operador y motivo en CUALQUIER UPDATE, lo que impedía revocar. Ahora:
--   · INSERT: la carga manual exige operador y motivo; una asistencia no puede nacer revocada.
--   · UPDATE: la identidad del hecho es inmutable (reunión, persona, invitación, método, identificación, IP, user-agent, operador de
--     la carga, motivo de la carga y recorded_at). Solo cambian (a) la revocación/restauración (revoked_*) y (b) la hora/precisión
--     (checked_in_at, occurred_precision) y SOLO de una asistencia manual.
CREATE OR REPLACE FUNCTION public.sutecba_meeting_attendance_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.method = 'manual' AND (NEW.registered_by IS NULL OR NEW.correction_reason IS NULL OR btrim(NEW.correction_reason) = '') THEN
      RAISE EXCEPTION 'La asistencia manual requiere registered_by y correction_reason';
    END IF;
    IF NEW.revoked_at IS NOT NULL THEN
      RAISE EXCEPTION 'Una asistencia no puede crearse ya revocada';
    END IF;
    RETURN NEW;
  END IF;

  -- UPDATE
  IF NEW.meeting_id IS DISTINCT FROM OLD.meeting_id
     OR NEW.person_id IS DISTINCT FROM OLD.person_id
     OR NEW.invitation_id IS DISTINCT FROM OLD.invitation_id
     OR NEW.method IS DISTINCT FROM OLD.method
     OR NEW.identification IS DISTINCT FROM OLD.identification
     OR NEW.ip_address IS DISTINCT FROM OLD.ip_address
     OR NEW.user_agent IS DISTINCT FROM OLD.user_agent
     OR NEW.registered_by IS DISTINCT FROM OLD.registered_by
     OR NEW.correction_reason IS DISTINCT FROM OLD.correction_reason
     OR NEW.recorded_at IS DISTINCT FROM OLD.recorded_at THEN
    RAISE EXCEPTION 'Una asistencia existente solo admite revocación/restauración o corrección de su hora (si es manual)';
  END IF;

  IF (NEW.checked_in_at IS DISTINCT FROM OLD.checked_in_at OR NEW.occurred_precision IS DISTINCT FROM OLD.occurred_precision)
     AND OLD.method <> 'manual' THEN
    RAISE EXCEPTION 'Solo la hora de una asistencia manual puede corregirse';
  END IF;

  RETURN NEW;
END;
$$;

COMMENT ON COLUMN public.meeting_attendance.method IS
  'Cómo se registró: qr | invitation_link | manual (valores anteriores deprecados: invitation_token, dni, email, phone).';
COMMENT ON COLUMN public.meeting_attendance.identification IS
  'Con qué se identificó la persona: dni | email | phone | invitation_token. NULL en lo manual.';
COMMENT ON COLUMN public.meeting_attendance.checked_in_at IS
  'Cuándo OCURRIÓ la asistencia (ver occurred_precision). NULL solo si occurred_precision = unknown (carga manual).';
COMMENT ON COLUMN public.meeting_attendance.recorded_at IS 'Cuándo guardó el CRM la asistencia (siempre exacto).';
COMMENT ON COLUMN public.meeting_attendance.correction_reason IS 'Motivo de la CARGA MANUAL (obligatorio si method = manual). El motivo de revocación es revoke_reason.';
COMMENT ON COLUMN public.meeting_attendance.revoked_at IS 'Asistencia VIGENTE ⇔ revoked_at IS NULL. Restaurar limpia revoked_*; el historial vive en meeting_attendance_events.';

COMMIT;
