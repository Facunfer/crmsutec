BEGIN;

-- 0019 — Cierre de seguridad específico para Supabase.
-- RLS acá funciona como barrera contra exposición accidental por Data API.
-- La autorización de negocio (rol + módulo + permiso + alcance) sigue en
-- la capa servidor. No se usa Supabase Auth ni auth.uid().

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sutecba_app') THEN
    CREATE ROLE sutecba_app
      LOGIN
      NOSUPERUSER
      NOCREATEDB
      NOCREATEROLE
      NOREPLICATION
      NOBYPASSRLS
      PASSWORD NULL;
  ELSE
    ALTER ROLE sutecba_app
      LOGIN
      NOSUPERUSER
      NOCREATEDB
      NOCREATEROLE
      NOREPLICATION
      NOBYPASSRLS;
  END IF;
END $$;

-- La contraseña NO se versiona en Git ni se guarda en la migración.
-- Definirla fuera del repositorio, por ejemplo desde el SQL Editor:
-- ALTER ROLE sutecba_app WITH PASSWORD '<<CONTRASEÑA_A_DEFINIR>>';

GRANT USAGE ON SCHEMA public TO sutecba_app;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'extensions') THEN
    GRANT USAGE ON SCHEMA extensions TO sutecba_app;
  END IF;
END $$;

-- La API pública no recibe acceso directo a objetos del CRM.
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM anon, authenticated;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM anon, authenticated;
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC, anon, authenticated;

-- Privilegios explícitos para la aplicación.
-- Catálogos de solo lectura para la app.
GRANT SELECT ON TABLE
  public.roles,
  public.permissions,
  public.modules
TO sutecba_app;

-- Configuración/RBAC administrable.
GRANT SELECT, INSERT, UPDATE ON TABLE
  public.organization_types,
  public.association_types,
  public.organizations,
  public.organization_aliases,
  public.users,
  public.user_scopes,
  public.user_modules,
  public.person_field_definitions,
  public.app_settings,
  public.interaction_types,
  public.interaction_channels
TO sutecba_app;

GRANT SELECT, INSERT, DELETE ON TABLE
  public.role_permissions
TO sutecba_app;

-- Autenticación y rate limiting: se revoca, no se borra desde la app.
GRANT SELECT, INSERT, UPDATE ON TABLE public.sessions TO sutecba_app;
GRANT SELECT, INSERT ON TABLE
  public.login_attempts,
  public.public_link_attempts
TO sutecba_app;

-- Personas y estructuras de negocio.
GRANT SELECT, INSERT, UPDATE ON TABLE
  public.people,
  public.associations,
  public.people_associations,
  public.meetings,
  public.meeting_invitations,
  public.meeting_attendance,
  public.forms,
  public.form_submissions,
  public.person_duplicate_candidates,
  public.notification_outbox,
  public.tags,
  public.person_tags,
  public.person_interactions,
  public.association_interactions,
  public.import_batches,
  public.import_rows,
  public.import_issues
TO sutecba_app;

-- Relaciones editables sin historial propio o con snapshot histórico aparte.
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE
  public.association_managers,
  public.meeting_associations,
  public.form_fields,
  public.form_actions
TO sutecba_app;

-- Trazabilidad / snapshots: sin UPDATE ni DELETE.
GRANT SELECT, INSERT ON TABLE
  public.meeting_invitation_batches,
  public.form_versions,
  public.audit_logs,
  public.person_organization_transfers,
  public.interaction_links,
  public.import_files,
  public.import_batch_files,
  public.import_entity_links
TO sutecba_app;

-- Las tablas internas del runner NO se otorgan a sutecba_app:
-- sutecba_meta y sutecba_migrations quedan reservadas a la conexión de migración.

-- Funciones que la aplicación puede invocar.
GRANT EXECUTE ON FUNCTION public.organization_descendants(uuid) TO sutecba_app;
GRANT EXECUTE ON FUNCTION public.user_accessible_organizations(uuid) TO sutecba_app;
GRANT EXECUTE ON FUNCTION public.user_has_permission(uuid, text) TO sutecba_app;
GRANT EXECUTE ON FUNCTION public.user_enabled_modules(uuid) TO sutecba_app;
GRANT EXECUTE ON FUNCTION public.user_has_module(uuid, text) TO sutecba_app;
GRANT EXECUTE ON FUNCTION public.create_scoped_user_checks(uuid, uuid, uuid[], boolean[], text[]) TO sutecba_app;
GRANT EXECUTE ON FUNCTION public.transfer_person(uuid, uuid, text, uuid) TO sutecba_app;
GRANT EXECUTE ON FUNCTION public.assign_initial_organization(uuid, uuid, uuid) TO sutecba_app;

-- Los triggers de normalización usan unaccent(text). Si la extensión quedó
-- en public, el REVOKE general anterior también le quitó EXECUTE a PUBLIC;
-- si quedó en extensions, se otorga de forma explícita igualmente.
DO $$
DECLARE
  v_schema text;
BEGIN
  SELECT n.nspname
    INTO v_schema
  FROM pg_extension e
  JOIN pg_namespace n ON n.oid = e.extnamespace
  WHERE e.extname = 'unaccent';

  IF v_schema IS NOT NULL THEN
    EXECUTE format(
      'GRANT EXECUTE ON FUNCTION %I.unaccent(text) TO sutecba_app',
      v_schema
    );
  END IF;
END $$;

-- RLS default-deny para anon/authenticated + policy explícita para sutecba_app.
-- El loop incluye también sutecba_meta y sutecba_migrations si existen,
-- tal como exige la guarda del runner.
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT tablename
    FROM pg_tables
    WHERE schemaname = 'public'
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', r.tablename);

    IF NOT EXISTS (
      SELECT 1
      FROM pg_policies p
      WHERE p.schemaname = 'public'
        AND p.tablename = r.tablename
        AND p.policyname = 'sutecba_app_all'
    ) THEN
      EXECUTE format(
        'CREATE POLICY sutecba_app_all ON public.%I
         FOR ALL TO sutecba_app
         USING (true)
         WITH CHECK (true)',
        r.tablename
      );
    END IF;
  END LOOP;
END $$;

-- Evita que objetos futuros creados por el rol postgres vuelvan a quedar
-- accesibles a la API por privilegios por defecto.
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  REVOKE SELECT, INSERT, UPDATE, DELETE ON TABLES FROM anon, authenticated;

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  REVOKE USAGE, SELECT, UPDATE ON SEQUENCES FROM anon, authenticated;

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC, anon, authenticated;

COMMIT;

-- VERIFICACIÓN SQL (ejecutar aparte con conexión administrativa):
-- 1) RLS en TODAS las tablas:
-- SELECT c.relname, c.relrowsecurity
-- FROM pg_class c
-- JOIN pg_namespace n ON n.oid=c.relnamespace
-- WHERE n.nspname='public' AND c.relkind='r'
-- ORDER BY c.relname;
--
-- 2) Meta/migrations también protegidas:
-- SELECT tablename, policyname, roles
-- FROM pg_policies
-- WHERE schemaname='public'
--   AND tablename IN ('sutecba_meta','sutecba_migrations');
--
-- 3) anon no debe poder leer:
-- SET LOCAL ROLE anon;
-- SELECT * FROM public.people LIMIT 1; -- debe fallar por privilegios/RLS
-- RESET ROLE;
--
-- 4) sutecba_app no debe borrar auditoría:
-- SET LOCAL ROLE sutecba_app;
-- DELETE FROM public.audit_logs WHERE false; -- debe fallar por privilegios
-- RESET ROLE;
--
-- 5) sutecba_app sí puede leer tablas de negocio:
-- SET LOCAL ROLE sutecba_app;
-- SELECT count(*) FROM public.people;
-- RESET ROLE;
--
-- ROLLBACK CONSERVADOR:
-- No hay DROP de políticas/tablas/columnas. Si se cambia el modelo de acceso,
-- hacerlo con una migración forward explícita.
