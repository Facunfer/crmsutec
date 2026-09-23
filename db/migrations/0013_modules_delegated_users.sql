BEGIN;

-- 0013 — Catálogo de módulos, módulos por usuario, permisos nuevos
-- y defensas para creación delegada de usuarios.

CREATE TABLE IF NOT EXISTS public.modules (
  key text PRIMARY KEY,
  name text NOT NULL,
  sort_order integer NOT NULL DEFAULT 0,
  active boolean NOT NULL DEFAULT true
);

INSERT INTO public.modules (key, name, sort_order, active) VALUES
  ('dashboard',       'Dashboard',       10, true),
  ('personas',        'Personas',        20, true),
  ('asociaciones',    'Asociaciones',    30, true),
  ('reuniones',       'Reuniones',       40, true),
  ('formularios',     'Formularios',     50, true),
  ('visualizacion',   'Visualización',   60, true),
  ('interacciones',   'Interacciones',   70, true),
  ('importaciones',   'Importaciones',   80, true),
  ('etiquetas',       'Etiquetas',       90, true),
  ('administracion',  'Administración', 100, true)
ON CONFLICT (key) DO UPDATE SET
  name = EXCLUDED.name,
  sort_order = EXCLUDED.sort_order,
  active = EXCLUDED.active;

ALTER TABLE public.permissions
  ADD COLUMN IF NOT EXISTS module_key text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'permissions_module_key_fkey'
      AND conrelid = 'public.permissions'::regclass
  ) THEN
    ALTER TABLE public.permissions
      ADD CONSTRAINT permissions_module_key_fkey
      FOREIGN KEY (module_key)
      REFERENCES public.modules(key)
      ON DELETE RESTRICT;
  END IF;
END $$;

-- Backfill de los 30 permisos existentes.
UPDATE public.permissions SET module_key = 'dashboard'
WHERE key = 'dashboard.view' AND module_key IS NULL;

UPDATE public.permissions SET module_key = 'visualizacion'
WHERE key = 'visualization.view' AND module_key IS NULL;

UPDATE public.permissions SET module_key = 'personas'
WHERE key LIKE 'people.%' AND module_key IS NULL;

UPDATE public.permissions SET module_key = 'asociaciones'
WHERE key LIKE 'associations.%' AND module_key IS NULL;

UPDATE public.permissions SET module_key = 'reuniones'
WHERE key LIKE 'meetings.%' AND module_key IS NULL;

UPDATE public.permissions SET module_key = 'formularios'
WHERE key LIKE 'forms.%' AND module_key IS NULL;

UPDATE public.permissions SET module_key = 'administracion'
WHERE key IN ('organizations.manage','users.manage','roles.manage','audit.view')
  AND module_key IS NULL;

INSERT INTO public.permissions (key, description, module_key)
VALUES
  ('users.manage_scoped', 'Crear, editar y desactivar usuarios únicamente dentro de los alcances propios', 'administracion'),
  ('scopes.manage', 'Administrar alcances organizativos de usuarios dentro de los alcances propios', 'administracion'),
  ('people.transfer', 'Trasladar personas entre reparticiones desde una repartición bajo alcance propio', 'personas'),
  ('people.assign_organization', 'Asignar la repartición inicial a una persona pendiente de clasificación', 'personas'),
  ('interactions.view', 'Ver interacciones dentro del alcance organizativo', 'interacciones'),
  ('interactions.create', 'Registrar interacciones dentro del alcance organizativo', 'interacciones'),
  ('interactions.edit', 'Editar o anular interacciones dentro del alcance organizativo', 'interacciones'),
  ('imports.view', 'Ver lotes, archivos, filas e incidencias de importación autorizadas', 'importaciones'),
  ('imports.run', 'Crear y procesar importaciones dentro del alcance organizativo', 'importaciones'),
  ('imports.review', 'Revisar incidencias y coincidencias ambiguas de importaciones', 'importaciones'),
  ('tags.view', 'Ver etiquetas de personas respetando alcance y sensibilidad', 'etiquetas'),
  ('tags.assign', 'Crear etiquetas libres locales y asignar o quitar etiquetas dentro del alcance propio', 'etiquetas'),
  ('tags.manage', 'Administrar el catálogo de etiquetas, incluidas etiquetas controladas', 'etiquetas')
ON CONFLICT (key) DO UPDATE SET
  description = EXCLUDED.description,
  module_key = EXCLUDED.module_key;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.permissions WHERE module_key IS NULL
  ) THEN
    RAISE EXCEPTION 'Hay permisos sin module_key. Completar el mapeo antes de continuar.';
  END IF;
END $$;

ALTER TABLE public.permissions
  ALTER COLUMN module_key SET NOT NULL;

CREATE TABLE IF NOT EXISTS public.user_modules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  module_key text NOT NULL REFERENCES public.modules(key) ON DELETE RESTRICT,
  granted_by uuid NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  granted_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  revoked_by uuid REFERENCES public.users(id) ON DELETE RESTRICT,
  CONSTRAINT user_modules_revocation_consistency CHECK (
    (revoked_at IS NULL AND revoked_by IS NULL)
    OR
    (revoked_at IS NOT NULL AND revoked_by IS NOT NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS user_modules_active_unique_idx
  ON public.user_modules (user_id, module_key)
  WHERE revoked_at IS NULL;

CREATE INDEX IF NOT EXISTS user_modules_user_active_idx
  ON public.user_modules (user_id)
  WHERE revoked_at IS NULL;

CREATE OR REPLACE FUNCTION public.user_has_permission(
  p_user_id uuid,
  p_permission_key text
)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.users u
    JOIN public.role_permissions rp ON rp.role_id = u.role_id
    JOIN public.permissions p ON p.id = rp.permission_id
    WHERE u.id = p_user_id
      AND u.status = 'active'
      AND p.key = p_permission_key
  );
$$;

CREATE OR REPLACE FUNCTION public.user_enabled_modules(p_user_id uuid)
RETURNS TABLE (module_key text)
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  WITH actor AS (
    SELECT u.id, u.status, r.key AS role_key
    FROM public.users u
    JOIN public.roles r ON r.id = u.role_id
    WHERE u.id = p_user_id
  )
  SELECT m.key
  FROM public.modules m
  JOIN actor a ON a.status = 'active' AND a.role_key = 'MASTER_GLOBAL'
  WHERE m.active = true

  UNION

  SELECT um.module_key
  FROM public.user_modules um
  JOIN public.modules m ON m.key = um.module_key AND m.active = true
  JOIN actor a ON a.id = um.user_id
  WHERE a.status = 'active'
    AND a.role_key <> 'MASTER_GLOBAL'
    AND um.revoked_at IS NULL;
$$;

CREATE OR REPLACE FUNCTION public.user_has_module(
  p_user_id uuid,
  p_module_key text
)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.user_enabled_modules(p_user_id) m
    WHERE m.module_key = p_module_key
  );
$$;

-- Validación reutilizable por la capa servidor antes de crear un usuario delegado.
CREATE OR REPLACE FUNCTION public.create_scoped_user_checks(
  p_actor_user_id uuid,
  p_target_role_id uuid,
  p_scope_organization_ids uuid[] DEFAULT ARRAY[]::uuid[],
  p_scope_include_descendants boolean[] DEFAULT ARRAY[]::boolean[],
  p_module_keys text[] DEFAULT ARRAY[]::text[]
)
RETURNS void
LANGUAGE plpgsql
STABLE
SET search_path = public
AS $$
DECLARE
  v_actor_role text;
  v_target_role text;
  v_org uuid;
  v_include boolean;
  v_idx integer;
  v_module text;
BEGIN
  SELECT r.key
    INTO v_actor_role
  FROM public.users u
  JOIN public.roles r ON r.id = u.role_id
  WHERE u.id = p_actor_user_id
    AND u.status = 'active';

  IF v_actor_role IS NULL THEN
    RAISE EXCEPTION 'Actor inexistente o inactivo';
  END IF;

  SELECT key INTO v_target_role
  FROM public.roles
  WHERE id = p_target_role_id;

  IF v_target_role IS NULL THEN
    RAISE EXCEPTION 'Rol destino inexistente';
  END IF;

  IF v_actor_role = 'MASTER_GLOBAL' THEN
    RETURN;
  END IF;

  IF NOT public.user_has_permission(p_actor_user_id, 'users.manage_scoped') THEN
    RAISE EXCEPTION 'El actor no tiene users.manage_scoped';
  END IF;

  IF v_target_role = 'MASTER_GLOBAL' THEN
    RAISE EXCEPTION 'Un usuario delegado no puede crear MASTER_GLOBAL';
  END IF;

  -- El rol destino no puede contener permisos que el actor no posea.
  IF EXISTS (
    SELECT 1
    FROM public.role_permissions target_rp
    JOIN public.permissions target_p ON target_p.id = target_rp.permission_id
    WHERE target_rp.role_id = p_target_role_id
      AND NOT public.user_has_permission(p_actor_user_id, target_p.key)
  ) THEN
    RAISE EXCEPTION 'El rol destino contiene permisos que el actor no posee';
  END IF;

  IF coalesce(array_length(p_scope_organization_ids, 1), 0)
     <> coalesce(array_length(p_scope_include_descendants, 1), 0) THEN
    RAISE EXCEPTION 'Las listas de alcances e include_descendants deben tener igual longitud';
  END IF;

  FOR v_idx IN 1..coalesce(array_length(p_scope_organization_ids, 1), 0) LOOP
    v_org := p_scope_organization_ids[v_idx];
    v_include := p_scope_include_descendants[v_idx];

    IF NOT EXISTS (
      SELECT 1
      FROM public.user_scopes actor_scope
      WHERE actor_scope.user_id = p_actor_user_id
        AND actor_scope.revoked_at IS NULL
        AND (
          (
            actor_scope.include_descendants = false
            AND v_include = false
            AND actor_scope.organization_id = v_org
          )
          OR
          (
            actor_scope.include_descendants = true
            AND EXISTS (
              SELECT 1
              FROM public.organization_descendants(actor_scope.organization_id) d
              WHERE d.organization_id = v_org
            )
          )
        )
    ) THEN
      RAISE EXCEPTION 'El alcance solicitado (%) excede los alcances del actor', v_org;
    END IF;
  END LOOP;

  FOREACH v_module IN ARRAY p_module_keys LOOP
    IF NOT public.user_has_module(p_actor_user_id, v_module) THEN
      RAISE EXCEPTION 'El actor no puede otorgar el módulo %', v_module;
    END IF;
  END LOOP;
END;
$$;

CREATE OR REPLACE FUNCTION public.sutecba_validate_user_scope_change()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_actor uuid;
  v_actor_role text;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.user_id IS DISTINCT FROM OLD.user_id
       OR NEW.organization_id IS DISTINCT FROM OLD.organization_id
       OR NEW.include_descendants IS DISTINCT FROM OLD.include_descendants
       OR NEW.granted_by IS DISTINCT FROM OLD.granted_by
       OR NEW.granted_at IS DISTINCT FROM OLD.granted_at THEN
      RAISE EXCEPTION 'Un alcance existente no se reescribe; revocarlo y crear uno nuevo';
    END IF;

    IF OLD.revoked_at IS NOT NULL THEN
      RAISE EXCEPTION 'Un alcance revocado es inmutable';
    END IF;

    IF NEW.revoked_at IS NULL OR NEW.revoked_by IS NULL THEN
      RAISE EXCEPTION 'La actualización de un alcance solo puede ser una revocación';
    END IF;
  END IF;

  v_actor := CASE
    WHEN TG_OP = 'INSERT' THEN NEW.granted_by
    ELSE NEW.revoked_by
  END;

  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'Todo cambio de alcance debe identificar actor';
  END IF;

  IF NEW.user_id = v_actor THEN
    RAISE EXCEPTION 'Un usuario delegado no puede modificar sus propios alcances';
  END IF;

  SELECT r.key INTO v_actor_role
  FROM public.users u
  JOIN public.roles r ON r.id = u.role_id
  WHERE u.id = v_actor AND u.status = 'active';

  IF v_actor_role IS NULL THEN
    RAISE EXCEPTION 'Actor inexistente o inactivo';
  END IF;

  IF v_actor_role <> 'MASTER_GLOBAL' THEN
    IF NOT public.user_has_permission(v_actor, 'scopes.manage') THEN
      RAISE EXCEPTION 'El actor no tiene scopes.manage';
    END IF;

    IF NOT EXISTS (
      SELECT 1
      FROM public.user_scopes actor_scope
      WHERE actor_scope.user_id = v_actor
        AND actor_scope.revoked_at IS NULL
        AND (
          (
            actor_scope.include_descendants = false
            AND NEW.include_descendants = false
            AND actor_scope.organization_id = NEW.organization_id
          )
          OR
          (
            actor_scope.include_descendants = true
            AND EXISTS (
              SELECT 1
              FROM public.organization_descendants(actor_scope.organization_id) d
              WHERE d.organization_id = NEW.organization_id
            )
          )
        )
    ) THEN
      RAISE EXCEPTION 'El alcance a otorgar/revocar excede los alcances del actor';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS user_scopes_validate_change ON public.user_scopes;
CREATE TRIGGER user_scopes_validate_change
BEFORE INSERT OR UPDATE ON public.user_scopes
FOR EACH ROW
EXECUTE FUNCTION public.sutecba_validate_user_scope_change();

CREATE OR REPLACE FUNCTION public.sutecba_validate_user_module_change()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_actor uuid;
  v_actor_role text;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.user_id IS DISTINCT FROM OLD.user_id
       OR NEW.module_key IS DISTINCT FROM OLD.module_key
       OR NEW.granted_by IS DISTINCT FROM OLD.granted_by
       OR NEW.granted_at IS DISTINCT FROM OLD.granted_at THEN
      RAISE EXCEPTION 'Un módulo otorgado no se reescribe; revocarlo y crear uno nuevo';
    END IF;

    IF OLD.revoked_at IS NOT NULL THEN
      RAISE EXCEPTION 'Un módulo revocado es inmutable';
    END IF;

    IF NEW.revoked_at IS NULL OR NEW.revoked_by IS NULL THEN
      RAISE EXCEPTION 'La actualización de user_modules solo puede ser una revocación';
    END IF;
  END IF;

  v_actor := CASE
    WHEN TG_OP = 'INSERT' THEN NEW.granted_by
    ELSE NEW.revoked_by
  END;

  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'Todo cambio de módulo debe identificar actor';
  END IF;

  IF NEW.user_id = v_actor THEN
    RAISE EXCEPTION 'Un usuario delegado no puede modificar sus propios módulos';
  END IF;

  SELECT r.key INTO v_actor_role
  FROM public.users u
  JOIN public.roles r ON r.id = u.role_id
  WHERE u.id = v_actor AND u.status = 'active';

  IF v_actor_role IS NULL THEN
    RAISE EXCEPTION 'Actor inexistente o inactivo';
  END IF;

  IF v_actor_role <> 'MASTER_GLOBAL' THEN
    IF NOT public.user_has_permission(v_actor, 'users.manage_scoped') THEN
      RAISE EXCEPTION 'El actor no tiene users.manage_scoped';
    END IF;

    IF NOT public.user_has_module(v_actor, NEW.module_key) THEN
      RAISE EXCEPTION 'El actor no puede otorgar el módulo %', NEW.module_key;
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS user_modules_validate_change ON public.user_modules;
CREATE TRIGGER user_modules_validate_change
BEFORE INSERT OR UPDATE ON public.user_modules
FOR EACH ROW
EXECUTE FUNCTION public.sutecba_validate_user_module_change();

-- Invalida sesiones cuando cambian rol/estado/contraseña.
CREATE OR REPLACE FUNCTION public.sutecba_users_bump_permissions_version()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NEW.role_id IS DISTINCT FROM OLD.role_id
     OR NEW.status IS DISTINCT FROM OLD.status
     OR NEW.password_hash IS DISTINCT FROM OLD.password_hash THEN
    IF NEW.permissions_version <= OLD.permissions_version THEN
      NEW.permissions_version := OLD.permissions_version + 1;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS users_bump_permissions_version ON public.users;
CREATE TRIGGER users_bump_permissions_version
BEFORE UPDATE ON public.users
FOR EACH ROW
EXECUTE FUNCTION public.sutecba_users_bump_permissions_version();

-- Invalida sesiones cuando cambian alcances o módulos.
CREATE OR REPLACE FUNCTION public.sutecba_related_access_bump_permissions_version()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  UPDATE public.users
  SET permissions_version = permissions_version + 1,
      updated_at = now()
  WHERE id = NEW.user_id;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS user_scopes_bump_permissions_version ON public.user_scopes;
CREATE TRIGGER user_scopes_bump_permissions_version
AFTER INSERT OR UPDATE ON public.user_scopes
FOR EACH ROW
EXECUTE FUNCTION public.sutecba_related_access_bump_permissions_version();

DROP TRIGGER IF EXISTS user_modules_bump_permissions_version ON public.user_modules;
CREATE TRIGGER user_modules_bump_permissions_version
AFTER INSERT OR UPDATE ON public.user_modules
FOR EACH ROW
EXECUTE FUNCTION public.sutecba_related_access_bump_permissions_version();

COMMIT;

-- VERIFICACIÓN (ejecutar aparte):
-- SELECT key,name FROM public.modules ORDER BY sort_order;
-- SELECT key,module_key FROM public.permissions ORDER BY key;
-- SELECT * FROM public.user_enabled_modules('<uuid-usuario>');
--
-- ROLLBACK CONSERVADOR:
-- No hay DROP ejecutable. Revocar módulos/alcances y desactivar permisos
-- mediante una migración forward si la funcionalidad debe retirarse.
