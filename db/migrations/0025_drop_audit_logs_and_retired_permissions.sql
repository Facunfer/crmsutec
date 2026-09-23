BEGIN;

-- 0025 — DESTRUCTIVA. Elimina la auditoría del producto y los permisos de los módulos retirados.
--
-- REQUIERE APROBACIÓN EXPLÍCITA y `npm run migrate -- --yes --allow-destructive`. Sin ese flag el runner se detiene
-- en este archivo (después de aplicar 0024) y no toca nada.
--
-- Qué se borra:
--  1. public.audit_logs (tabla, sus 3 índices, sus triggers append-only y la política RLS) y la función
--     sutecba_audit_logs_no_mutation(). Ningún objeto de la base depende de la tabla (sin FK, vistas ni otras
--     funciones); el código de la aplicación dejó de escribirla y de leerla.
--  2. Los permisos de módulos retirados, con sus filas de role_permissions:
--       audit.view, roles.manage, people.manage_custom_fields.
--     El RBAC (roles, permissions, role_permissions, user_scopes) sigue intacto para el resto de los permisos.
--
-- Qué NO se toca: import_batches / import_files / import_rows / import_issues / import_entity_links / plan_hash /
-- hashes / procedencia (la trazabilidad del importador vive ahí y no dependía de audit_logs), notification_outbox,
-- person_field_definitions y people.custom_fields (siguen usándose internamente desde Formularios).
--
-- Antes de aplicar: exportar audit_logs (npm run audit:export-before-drop deja un JSON fuera de Git) y confirmar backup.

DO $$
DECLARE
  dependent_count integer;
BEGIN
  -- Defensa: si apareciera una FK o vista que dependa de audit_logs, se aborta en vez de arrastrarla con CASCADE.
  SELECT count(*) INTO dependent_count
  FROM pg_depend d
  JOIN pg_rewrite r ON r.oid = d.objid
  WHERE d.refobjid = 'public.audit_logs'::regclass AND d.classid = 'pg_rewrite'::regclass;
  IF dependent_count > 0 THEN
    RAISE EXCEPTION 'audit_logs tiene vistas dependientes (%): no se elimina', dependent_count;
  END IF;
  SELECT count(*) INTO dependent_count FROM pg_constraint WHERE confrelid = 'public.audit_logs'::regclass;
  IF dependent_count > 0 THEN
    RAISE EXCEPTION 'audit_logs es referenciada por % clave(s) foránea(s): no se elimina', dependent_count;
  END IF;
END $$;

DROP TABLE IF EXISTS public.audit_logs;
DROP FUNCTION IF EXISTS public.sutecba_audit_logs_no_mutation();

DELETE FROM public.role_permissions
WHERE permission_id IN (SELECT id FROM public.permissions WHERE key IN ('audit.view', 'roles.manage', 'people.manage_custom_fields'));

DELETE FROM public.permissions WHERE key IN ('audit.view', 'roles.manage', 'people.manage_custom_fields');

COMMIT;
