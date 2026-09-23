BEGIN;

-- 0026 — Cierra la exposición de privilegios de `anon` / `authenticated` (y PUBLIC) sobre tablas del CRM.
--
-- QUÉ PASABA (auditoría de solo lectura contra Supabase, 2026-09-21):
--   * `meeting_participations` (creada en 0021, DESPUÉS del endurecimiento de 0019) quedó con MAINTAIN, REFERENCES,
--     TRIGGER y vaciado de tabla (privilegio «D») para `anon` y `authenticated`. RLS NO frena el vaciado de tabla.
--   * Causa raíz: Supabase trae privilegios por defecto para las tablas que crea el rol `postgres` en `public`
--     (`anon` y `authenticated` reciben D, x, t, m). 0019 solo revocó SELECT/INSERT/UPDATE/DELETE por defecto; así que
--     toda tabla creada después de 0019 nace con esos cuatro privilegios. Es la única tabla afectada: las demás se
--     crearon antes de 0019 (cubiertas por su REVOKE ALL) o no se crearon tablas desde entonces.
--   * El rol que crea los objetos es `postgres` (propietario de las 49 tablas y ejecutor de las migraciones), verificado
--     contra la base real: por eso el ALTER DEFAULT PRIVILEGES es FOR ROLE postgres y no a ciegas.
--
-- QUÉ HACE (solo REVOKE; no toca datos, no otorga nada, no cambia lo que `sutecba_app` ya tenía):
--   1. Revoca TODO a PUBLIC, `anon` y `authenticated` sobre todas las tablas y secuencias existentes de `public`.
--   2. Cierra los privilegios POR DEFECTO de las tablas y secuencias futuras creadas por `postgres` en `public`.
--   3. Falla (y revierte) si después de revocar aún queda algún privilegio de PUBLIC/anon/authenticated en `public`.
--
-- `sutecba_app` conserva exactamente lo que ya tenía (SELECT/INSERT/UPDATE según la tabla, sin UPDATE ni borrado
-- sobre meeting_participations). El rol `service_role` (clave de servidor de Supabase, con BYPASSRLS) no forma parte
-- de esta migración: su clave nunca debe llegar al navegador ni a este CRM.

REVOKE ALL ON ALL TABLES IN SCHEMA public FROM PUBLIC, anon, authenticated;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM PUBLIC, anon, authenticated;

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  REVOKE ALL ON TABLES FROM PUBLIC, anon, authenticated;

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  REVOKE ALL ON SEQUENCES FROM PUBLIC, anon, authenticated;

DO $$
DECLARE
  leftover text;
BEGIN
  SELECT string_agg(c.relname || ':' || CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END || ':' || a.privilege_type, ', ')
    INTO leftover
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  CROSS JOIN LATERAL aclexplode(c.relacl) a
  WHERE n.nspname = 'public'
    AND c.relkind IN ('r', 'p', 'v', 'm', 'S')
    AND (a.grantee = 0 OR pg_get_userbyid(a.grantee) IN ('anon', 'authenticated'));
  IF leftover IS NOT NULL THEN
    RAISE EXCEPTION 'Quedan privilegios de PUBLIC/anon/authenticated en public: %', leftover;
  END IF;
END $$;

COMMIT;
