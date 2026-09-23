BEGIN;

-- 0016 — Etiquetas de personas.
-- Las etiquetas sensibles se filtran SIEMPRE del lado servidor con
-- people.view_sensitive, incluso en filtros, exportaciones y estadísticas.

CREATE TABLE IF NOT EXISTS public.tags (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  normalized_name text NOT NULL,
  category text,
  is_controlled boolean NOT NULL DEFAULT false,
  is_sensitive boolean NOT NULL DEFAULT false,
  owner_organization_id uuid REFERENCES public.organizations(id) ON DELETE RESTRICT,
  active boolean NOT NULL DEFAULT true,
  created_by uuid NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT tags_name_not_blank CHECK (btrim(name) <> ''),
  CONSTRAINT tags_normalized_name_not_blank CHECK (btrim(normalized_name) <> '')
);

CREATE OR REPLACE FUNCTION public.sutecba_normalize_tag()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, extensions
AS $$
BEGIN
  NEW.normalized_name :=
    regexp_replace(
      lower(unaccent(btrim(NEW.name))),
      '\s+',
      ' ',
      'g'
    );
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tags_normalize ON public.tags;
CREATE TRIGGER tags_normalize
BEFORE INSERT OR UPDATE OF name ON public.tags
FOR EACH ROW
EXECUTE FUNCTION public.sutecba_normalize_tag();

-- NULLS NOT DISTINCT hace que las etiquetas globales (owner NULL) también
-- sean únicas por normalized_name.
CREATE UNIQUE INDEX IF NOT EXISTS tags_owner_normalized_unique_idx
  ON public.tags (owner_organization_id, normalized_name) NULLS NOT DISTINCT;

CREATE INDEX IF NOT EXISTS tags_owner_active_idx
  ON public.tags (owner_organization_id, active);

CREATE TABLE IF NOT EXISTS public.person_tags (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  person_id uuid NOT NULL REFERENCES public.people(id) ON DELETE RESTRICT,
  tag_id uuid NOT NULL REFERENCES public.tags(id) ON DELETE RESTRICT,
  assigned_by uuid NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  assigned_at timestamptz NOT NULL DEFAULT now(),
  removed_at timestamptz,
  removed_by uuid REFERENCES public.users(id) ON DELETE RESTRICT,
  CONSTRAINT person_tags_removal_consistency CHECK (
    (removed_at IS NULL AND removed_by IS NULL)
    OR
    (removed_at IS NOT NULL AND removed_by IS NOT NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS person_tags_active_unique_idx
  ON public.person_tags (person_id, tag_id)
  WHERE removed_at IS NULL;

CREATE INDEX IF NOT EXISTS person_tags_person_active_idx
  ON public.person_tags (person_id)
  WHERE removed_at IS NULL;

CREATE INDEX IF NOT EXISTS person_tags_tag_active_idx
  ON public.person_tags (tag_id, person_id)
  WHERE removed_at IS NULL;

CREATE OR REPLACE FUNCTION public.sutecba_person_tags_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.person_id IS DISTINCT FROM OLD.person_id
       OR NEW.tag_id IS DISTINCT FROM OLD.tag_id
       OR NEW.assigned_by IS DISTINCT FROM OLD.assigned_by
       OR NEW.assigned_at IS DISTINCT FROM OLD.assigned_at THEN
      RAISE EXCEPTION 'No se puede reescribir la identidad/historia de person_tags';
    END IF;

    IF OLD.removed_at IS NOT NULL THEN
      RAISE EXCEPTION 'Una asignación de tag revocada es inmutable';
    END IF;

    IF NEW.removed_at IS NULL OR NEW.removed_by IS NULL THEN
      RAISE EXCEPTION 'La actualización de person_tags solo puede ser una remoción';
    END IF;

    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'person_tags no permite DELETE; usar removed_at/removed_by';
END;
$$;

DROP TRIGGER IF EXISTS person_tags_guard_update ON public.person_tags;
CREATE TRIGGER person_tags_guard_update
BEFORE UPDATE ON public.person_tags
FOR EACH ROW
EXECUTE FUNCTION public.sutecba_person_tags_guard();

DROP TRIGGER IF EXISTS person_tags_no_delete ON public.person_tags;
CREATE TRIGGER person_tags_no_delete
BEFORE DELETE ON public.person_tags
FOR EACH ROW
EXECUTE FUNCTION public.sutecba_person_tags_guard();

COMMIT;

-- VERIFICACIÓN (ejecutar aparte):
-- SELECT indexname,indexdef FROM pg_indexes
-- WHERE schemaname='public' AND tablename IN ('tags','person_tags');
--
-- ROLLBACK CONSERVADOR:
-- Desactivar tags (active=false) y revocar asignaciones; no borrar historial.
