BEGIN;

-- Falla rápido (no bloquea la aplicación esperando) si otra transacción larga retiene un lock.
SET LOCAL lock_timeout = '10s';

-- 0041 — Inscripción operativa: metadata de registro y anulación (B4). ADITIVA e idempotente.
-- Solo agrega columnas NULL a meeting_participations: NO modifica ninguna de las 5.581 filas (las 961 inscripciones históricas
-- quedan sin operador, fecha, canal ni invitación de origen: nada se inventa). NO toca participaciones, asistencia ni interacciones.
--
-- Dos clases de inscripción OPERATIVA (las crea un usuario desde el CRM), siempre a nivel reunión/jornada:
--   A. Manual individual : recorded_by + origin_channel (canal REAL por el que llegó la solicitud), sin invitación de origen.
--   B. Desde aceptación  : recorded_by + origin_invitation_id (la invitación confirmada que la originó), sin canal propio.
--      El canal con que la persona respondió es un hecho DISTINTO y vive en la invitación (response_channel): no se copia acá.
-- Una fila sin recorded_by (histórica/importada) NO puede tener canal, fecha ni invitación de origen.
-- origin_invitation_id usa una FK COMPUESTA (invitación, reunión, persona): no se puede referenciar la invitación de otra persona
-- ni de otra reunión.
--
-- Fecha real de la inscripción: registered_at + registered_at_precision ('exact_datetime' | 'date_only'); ambos NULL = no
-- registrada / se desconoce. created_at sigue siendo la fecha TÉCNICA de carga (no se usa como fecha de inscripción).
--
-- Anulación (nunca DELETE): voided_at / voided_by / void_reason van juntos, el motivo no es vacío y solo aplica a filas
-- 'registration'. Restaurar los limpia; el historial vive en meeting_registration_events (0042). Anular una inscripción NO
-- anula ni modifica participación, asistencia, invitación ni respuesta.
--
-- Hasta hoy meeting_participations era inmutable para la app (solo INSERT/SELECT). Se abre UPDATE ÚNICAMENTE por columna
-- (voided_*, registered_at, registered_at_precision, origin_channel) y un guard impide cambiar la identidad del hecho.
--
-- INVARIANTE DE INTEGRIDAD (aplicación): toda mutación operativa de inscripciones pasa por los comandos transaccionales de
-- lib/meetings/registrations.ts, que cambian la fila Y registran su evento en la misma transacción.

ALTER TABLE public.meeting_participations
  ADD COLUMN IF NOT EXISTS registered_at timestamptz,
  ADD COLUMN IF NOT EXISTS registered_at_precision text,
  ADD COLUMN IF NOT EXISTS recorded_by uuid,
  ADD COLUMN IF NOT EXISTS origin_channel text,
  ADD COLUMN IF NOT EXISTS origin_invitation_id uuid,
  ADD COLUMN IF NOT EXISTS voided_at timestamptz,
  ADD COLUMN IF NOT EXISTS voided_by uuid,
  ADD COLUMN IF NOT EXISTS void_reason text;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.meeting_participations'::regclass AND conname = 'meeting_participations_recorded_by_fkey') THEN
    ALTER TABLE public.meeting_participations
      ADD CONSTRAINT meeting_participations_recorded_by_fkey FOREIGN KEY (recorded_by) REFERENCES public.users (id) ON DELETE RESTRICT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.meeting_participations'::regclass AND conname = 'meeting_participations_voided_by_fkey') THEN
    ALTER TABLE public.meeting_participations
      ADD CONSTRAINT meeting_participations_voided_by_fkey FOREIGN KEY (voided_by) REFERENCES public.users (id) ON DELETE RESTRICT;
  END IF;
  -- FK compuesta: la invitación de origen es de ESA reunión y de ESA persona (MATCH SIMPLE: sin origen no se evalúa).
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.meeting_participations'::regclass AND conname = 'meeting_participations_origin_invitation_fkey') THEN
    ALTER TABLE public.meeting_participations
      ADD CONSTRAINT meeting_participations_origin_invitation_fkey
      FOREIGN KEY (origin_invitation_id, meeting_id, person_id) REFERENCES public.meeting_invitations (id, meeting_id, person_id) ON DELETE RESTRICT;
  END IF;
  -- Para la FK compuesta de los eventos (0042).
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.meeting_participations'::regclass AND conname = 'meeting_participations_id_person_key') THEN
    ALTER TABLE public.meeting_participations ADD CONSTRAINT meeting_participations_id_person_key UNIQUE (id, person_id);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.meeting_participations'::regclass AND conname = 'meeting_participations_origin_channel_check') THEN
    ALTER TABLE public.meeting_participations ADD CONSTRAINT meeting_participations_origin_channel_check
      CHECK (origin_channel IS NULL OR origin_channel IN ('whatsapp', 'email', 'sms', 'phone', 'in_person', 'other'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.meeting_participations'::regclass AND conname = 'meeting_participations_registered_precision_check') THEN
    ALTER TABLE public.meeting_participations ADD CONSTRAINT meeting_participations_registered_precision_check
      CHECK (registered_at_precision IS NULL OR registered_at_precision IN ('exact_datetime', 'date_only'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.meeting_participations'::regclass AND conname = 'meeting_participations_registered_pair_check') THEN
    ALTER TABLE public.meeting_participations ADD CONSTRAINT meeting_participations_registered_pair_check
      CHECK ((registered_at IS NULL) = (registered_at_precision IS NULL));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.meeting_participations'::regclass AND conname = 'meeting_participations_registered_date_only_check') THEN
    ALTER TABLE public.meeting_participations ADD CONSTRAINT meeting_participations_registered_date_only_check
      CHECK (registered_at_precision IS DISTINCT FROM 'date_only'
             OR ((registered_at AT TIME ZONE 'America/Argentina/Buenos_Aires')::time = TIME '00:00'));
  END IF;

  -- Clases de fila: histórica/importada (sin operador y sin metadata operativa) u operativa A (manual) o B (desde aceptación).
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.meeting_participations'::regclass AND conname = 'meeting_participations_operative_class_check') THEN
    ALTER TABLE public.meeting_participations ADD CONSTRAINT meeting_participations_operative_class_check
      CHECK (
        (recorded_by IS NULL AND origin_channel IS NULL AND origin_invitation_id IS NULL AND registered_at IS NULL AND registered_at_precision IS NULL)
        OR (
          recorded_by IS NOT NULL AND participation_kind = 'registration' AND participation_basis = 'standard' AND meeting_id IS NOT NULL
          AND ((origin_invitation_id IS NULL AND origin_channel IS NOT NULL) OR (origin_invitation_id IS NOT NULL AND origin_channel IS NULL))
        )
      );
  END IF;

  -- Anulación: completa, con motivo, y solo en inscripciones.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.meeting_participations'::regclass AND conname = 'meeting_participations_voiding_complete_check') THEN
    ALTER TABLE public.meeting_participations ADD CONSTRAINT meeting_participations_voiding_complete_check
      CHECK ((voided_at IS NULL) = (voided_by IS NULL) AND (voided_at IS NULL) = (void_reason IS NULL)
             AND (void_reason IS NULL OR btrim(void_reason) <> ''));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.meeting_participations'::regclass AND conname = 'meeting_participations_voiding_only_registration_check') THEN
    ALTER TABLE public.meeting_participations ADD CONSTRAINT meeting_participations_voiding_only_registration_check
      CHECK (voided_at IS NULL OR participation_kind = 'registration');
  END IF;
END $$;

-- GUARD. INSERT: una fila no nace anulada. UPDATE: la identidad del hecho es inmutable (reunión/campaña, persona, tipo, base,
-- evidencia, procedencia de importación, fecha técnica, operador y invitación de origen). Cambian solo voided_* y — únicamente en una
-- inscripción OPERATIVA (recorded_by) — la fecha, su precisión y el canal.
CREATE OR REPLACE FUNCTION public.sutecba_meeting_participations_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.voided_at IS NOT NULL THEN
      RAISE EXCEPTION 'Una inscripción no puede crearse ya anulada';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.meeting_id IS DISTINCT FROM OLD.meeting_id
     OR NEW.campaign_key IS DISTINCT FROM OLD.campaign_key
     OR NEW.person_id IS DISTINCT FROM OLD.person_id
     OR NEW.participation_kind IS DISTINCT FROM OLD.participation_kind
     OR NEW.participation_basis IS DISTINCT FROM OLD.participation_basis
     OR NEW.evidence IS DISTINCT FROM OLD.evidence
     OR NEW.import_row_id IS DISTINCT FROM OLD.import_row_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.recorded_by IS DISTINCT FROM OLD.recorded_by
     OR NEW.origin_invitation_id IS DISTINCT FROM OLD.origin_invitation_id THEN
    RAISE EXCEPTION 'Una participación existente solo admite anulación/restauración o corrección de fecha y canal de una inscripción operativa';
  END IF;

  IF (NEW.registered_at IS DISTINCT FROM OLD.registered_at
      OR NEW.registered_at_precision IS DISTINCT FROM OLD.registered_at_precision
      OR NEW.origin_channel IS DISTINCT FROM OLD.origin_channel)
     AND OLD.recorded_by IS NULL THEN
    RAISE EXCEPTION 'Solo una inscripción operativa admite corregir fecha o canal (las importadas no)';
  END IF;

  RETURN NEW;
END;
$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'meeting_participations_guard' AND tgrelid = 'public.meeting_participations'::regclass) THEN
    CREATE TRIGGER meeting_participations_guard
    BEFORE INSERT OR UPDATE ON public.meeting_participations
    FOR EACH ROW
    EXECUTE FUNCTION public.sutecba_meeting_participations_guard();
  END IF;
END $$;

-- UPDATE solo por columna: la app NO puede modificar el resto de la tabla.
GRANT UPDATE (voided_at, voided_by, void_reason, registered_at, registered_at_precision, origin_channel)
  ON TABLE public.meeting_participations TO sutecba_app;

COMMENT ON COLUMN public.meeting_participations.created_at IS 'Fecha TÉCNICA de carga/importación de la fila. NO es la fecha de la inscripción: ver registered_at.';
COMMENT ON COLUMN public.meeting_participations.registered_at IS 'Cuándo ocurrió realmente la inscripción (ver registered_at_precision). NULL = no registrada / se desconoce (incluye todas las históricas).';
COMMENT ON COLUMN public.meeting_participations.recorded_by IS 'Usuario que cargó la inscripción desde el CRM. NULL en lo importado.';
COMMENT ON COLUMN public.meeting_participations.origin_channel IS 'Canal REAL por el que llegó una inscripción MANUAL (whatsapp | email | sms | phone | in_person | other). NULL si nació de una aceptación.';
COMMENT ON COLUMN public.meeting_participations.origin_invitation_id IS 'Invitación confirmada de la que nació la inscripción ("Inscribir aceptados"). El canal de respuesta vive en la invitación, no se copia.';

COMMIT;
