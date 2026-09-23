BEGIN;

-- 0012 — Organizaciones ampliadas, alias y alcances jerárquicos.
-- Regla: los alcances se revocan; no se borran.

ALTER TABLE public.organizations
  ADD COLUMN IF NOT EXISTS official_code text,
  ADD COLUMN IF NOT EXISTS valid_from date,
  ADD COLUMN IF NOT EXISTS valid_to date;

CREATE UNIQUE INDEX IF NOT EXISTS organizations_official_code_unique_idx
  ON public.organizations (official_code)
  WHERE official_code IS NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'organizations_valid_dates_check'
      AND conrelid = 'public.organizations'::regclass
  ) THEN
    ALTER TABLE public.organizations
      ADD CONSTRAINT organizations_valid_dates_check
      CHECK (valid_to IS NULL OR valid_from IS NULL OR valid_to >= valid_from);
  END IF;
END $$;

-- Un CHECK no alcanza para detectar ciclos de profundidad arbitraria;
-- por eso la validación se hace con trigger.
CREATE OR REPLACE FUNCTION public.sutecba_organizations_prevent_cycle()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_cycle boolean;
BEGIN
  IF NEW.parent_id IS NULL THEN
    RETURN NEW;
  END IF;

  IF NEW.parent_id = NEW.id THEN
    RAISE EXCEPTION 'Una organización no puede ser su propio padre';
  END IF;

  WITH RECURSIVE ancestors AS (
    SELECT o.id, o.parent_id
    FROM public.organizations o
    WHERE o.id = NEW.parent_id

    UNION

    SELECT o.id, o.parent_id
    FROM public.organizations o
    JOIN ancestors a ON o.id = a.parent_id
  )
  SELECT EXISTS (
    SELECT 1 FROM ancestors WHERE id = NEW.id
  ) INTO v_cycle;

  IF v_cycle THEN
    RAISE EXCEPTION 'La relación padre/hijo generaría un ciclo en organizations';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS organizations_prevent_cycle ON public.organizations;
CREATE TRIGGER organizations_prevent_cycle
BEFORE INSERT OR UPDATE OF parent_id ON public.organizations
FOR EACH ROW
EXECUTE FUNCTION public.sutecba_organizations_prevent_cycle();

CREATE TABLE IF NOT EXISTS public.organization_aliases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  alias text NOT NULL,
  normalized_alias text NOT NULL,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved', 'rejected')),
  approved_by uuid REFERENCES public.users(id) ON DELETE RESTRICT,
  approved_at timestamptz,
  created_by uuid REFERENCES public.users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT organization_aliases_alias_not_blank CHECK (btrim(alias) <> ''),
  CONSTRAINT organization_aliases_normalized_not_blank CHECK (btrim(normalized_alias) <> ''),
  CONSTRAINT organization_aliases_approval_consistency CHECK (
    (status = 'approved' AND approved_by IS NOT NULL AND approved_at IS NOT NULL)
    OR
    (status <> 'approved' AND approved_by IS NULL AND approved_at IS NULL)
  )
);

CREATE OR REPLACE FUNCTION public.sutecba_normalize_organization_alias()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, extensions
AS $$
BEGIN
  -- Se usa unaccent solamente para persistir el valor normalizado.
  -- No se crea un wrapper inmutable ni un índice de expresión con unaccent.
  NEW.normalized_alias :=
    regexp_replace(
      lower(unaccent(btrim(NEW.alias))),
      '\s+',
      ' ',
      'g'
    );
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS organization_aliases_normalize ON public.organization_aliases;
CREATE TRIGGER organization_aliases_normalize
BEFORE INSERT OR UPDATE OF alias ON public.organization_aliases
FOR EACH ROW
EXECUTE FUNCTION public.sutecba_normalize_organization_alias();

CREATE UNIQUE INDEX IF NOT EXISTS organization_aliases_approved_unique_idx
  ON public.organization_aliases (normalized_alias)
  WHERE status = 'approved';

CREATE INDEX IF NOT EXISTS organization_aliases_organization_idx
  ON public.organization_aliases (organization_id);

CREATE INDEX IF NOT EXISTS organization_aliases_status_idx
  ON public.organization_aliases (status);

CREATE TABLE IF NOT EXISTS public.user_scopes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  include_descendants boolean NOT NULL DEFAULT false,
  granted_by uuid NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  granted_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  revoked_by uuid REFERENCES public.users(id) ON DELETE RESTRICT,
  CONSTRAINT user_scopes_revocation_consistency CHECK (
    (revoked_at IS NULL AND revoked_by IS NULL)
    OR
    (revoked_at IS NOT NULL AND revoked_by IS NOT NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS user_scopes_active_unique_idx
  ON public.user_scopes (user_id, organization_id)
  WHERE revoked_at IS NULL;

CREATE INDEX IF NOT EXISTS user_scopes_user_active_idx
  ON public.user_scopes (user_id)
  WHERE revoked_at IS NULL;

CREATE INDEX IF NOT EXISTS user_scopes_organization_active_idx
  ON public.user_scopes (organization_id)
  WHERE revoked_at IS NULL;

-- Incluye la propia raíz. Esto simplifica las comprobaciones de alcance.
CREATE OR REPLACE FUNCTION public.organization_descendants(p_organization_id uuid)
RETURNS TABLE (organization_id uuid)
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  WITH RECURSIVE tree AS (
    SELECT o.id
    FROM public.organizations o
    WHERE o.id = p_organization_id

    UNION

    SELECT child.id
    FROM public.organizations child
    JOIN tree parent ON child.parent_id = parent.id
  )
  SELECT id FROM tree;
$$;

CREATE OR REPLACE FUNCTION public.user_accessible_organizations(p_user_id uuid)
RETURNS TABLE (organization_id uuid)
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  WITH actor AS (
    SELECT u.id, u.status, r.key AS role_key
    FROM public.users u
    JOIN public.roles r ON r.id = u.role_id
    WHERE u.id = p_user_id
  ),
  scoped AS (
    SELECT us.organization_id, us.include_descendants
    FROM public.user_scopes us
    JOIN actor a ON a.id = us.user_id
    WHERE a.status = 'active'
      AND a.role_key <> 'MASTER_GLOBAL'
      AND us.revoked_at IS NULL
  ),
  expanded AS (
    SELECT s.organization_id
    FROM scoped s
    WHERE s.include_descendants = false

    UNION

    SELECT d.organization_id
    FROM scoped s
    CROSS JOIN LATERAL public.organization_descendants(s.organization_id) d
    WHERE s.include_descendants = true
  ),
  master_all AS (
    SELECT o.id AS organization_id
    FROM public.organizations o
    JOIN actor a ON a.status = 'active' AND a.role_key = 'MASTER_GLOBAL'
  )
  SELECT organization_id FROM expanded
  UNION
  SELECT organization_id FROM master_all;
$$;

COMMIT;

-- VERIFICACIÓN (ejecutar aparte):
-- SELECT column_name FROM information_schema.columns
-- WHERE table_schema='public' AND table_name='organizations'
--   AND column_name IN ('official_code','valid_from','valid_to');
-- SELECT * FROM public.organization_descendants('<uuid-organizacion>');
-- SELECT * FROM public.user_accessible_organizations('<uuid-usuario>');
--
-- ROLLBACK CONSERVADOR:
-- No se incluyen DROP ejecutables en este archivo. Si hubiera que revertir,
-- deshabilitar la funcionalidad con una migración forward y conservar datos.
