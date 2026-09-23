BEGIN;

-- 0014 — Unidad propietaria para asociaciones, reuniones y formularios.
-- La base Supabase objetivo está vacía. Si hubiera datos previos, se corta
-- para evitar asignar una unidad arbitraria.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.associations LIMIT 1)
     OR EXISTS (SELECT 1 FROM public.meetings LIMIT 1)
     OR EXISTS (SELECT 1 FROM public.forms LIMIT 1) THEN
    RAISE EXCEPTION
      '0014 requiere associations/meetings/forms vacías. Migrar owner_organization_id explícitamente antes de continuar.';
  END IF;
END $$;

ALTER TABLE public.associations
  ADD COLUMN IF NOT EXISTS owner_organization_id uuid
  REFERENCES public.organizations(id) ON DELETE RESTRICT;

ALTER TABLE public.meetings
  ADD COLUMN IF NOT EXISTS owner_organization_id uuid
  REFERENCES public.organizations(id) ON DELETE RESTRICT;

ALTER TABLE public.forms
  ADD COLUMN IF NOT EXISTS owner_organization_id uuid
  REFERENCES public.organizations(id) ON DELETE RESTRICT;

ALTER TABLE public.associations
  ALTER COLUMN owner_organization_id SET NOT NULL;

ALTER TABLE public.meetings
  ALTER COLUMN owner_organization_id SET NOT NULL;

ALTER TABLE public.forms
  ALTER COLUMN owner_organization_id SET NOT NULL;

CREATE INDEX IF NOT EXISTS associations_owner_organization_idx
  ON public.associations (owner_organization_id);

CREATE INDEX IF NOT EXISTS meetings_owner_organization_idx
  ON public.meetings (owner_organization_id, starts_at);

CREATE INDEX IF NOT EXISTS forms_owner_organization_idx
  ON public.forms (owner_organization_id);

-- Función genérica de protección contra borrado físico.
CREATE OR REPLACE FUNCTION public.sutecba_block_delete()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  RAISE EXCEPTION '% no permite DELETE físico', TG_TABLE_NAME;
END;
$$;

-- meeting_attendance se puede corregir, pero no borrar.
CREATE OR REPLACE FUNCTION public.sutecba_meeting_attendance_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.meeting_id IS DISTINCT FROM OLD.meeting_id
       OR NEW.person_id IS DISTINCT FROM OLD.person_id THEN
      RAISE EXCEPTION 'No se puede cambiar meeting_id/person_id de una asistencia existente';
    END IF;

    IF NEW.registered_by IS NULL
       OR NEW.correction_reason IS NULL
       OR btrim(NEW.correction_reason) = '' THEN
      RAISE EXCEPTION 'Toda corrección de asistencia requiere registered_by y correction_reason';
    END IF;
  END IF;

  IF TG_OP = 'INSERT' AND NEW.method = 'manual' THEN
    IF NEW.registered_by IS NULL
       OR NEW.correction_reason IS NULL
       OR btrim(NEW.correction_reason) = '' THEN
      RAISE EXCEPTION 'La asistencia manual requiere registered_by y correction_reason';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS meeting_attendance_guard ON public.meeting_attendance;
CREATE TRIGGER meeting_attendance_guard
BEFORE INSERT OR UPDATE ON public.meeting_attendance
FOR EACH ROW
EXECUTE FUNCTION public.sutecba_meeting_attendance_guard();

DROP TRIGGER IF EXISTS meeting_attendance_no_delete ON public.meeting_attendance;
CREATE TRIGGER meeting_attendance_no_delete
BEFORE DELETE ON public.meeting_attendance
FOR EACH ROW
EXECUTE FUNCTION public.sutecba_block_delete();

COMMIT;

-- VERIFICACIÓN (ejecutar aparte):
-- SELECT table_name,column_name,is_nullable
-- FROM information_schema.columns
-- WHERE table_schema='public'
--   AND table_name IN ('associations','meetings','forms')
--   AND column_name='owner_organization_id';
-- SELECT tgname FROM pg_trigger
-- WHERE tgrelid='public.meeting_attendance'::regclass AND NOT tgisinternal;
--
-- ROLLBACK CONSERVADOR:
-- No quitar owner_organization_id ni borrar asistencias. Una reversión debe
-- ser una migración forward que deje de usar esas columnas sin destruir datos.
