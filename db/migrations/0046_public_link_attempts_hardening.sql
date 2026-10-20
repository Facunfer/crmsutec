BEGIN;

SET LOCAL lock_timeout = '10s';

-- 0046 — Rate limit público: sin tokens en claro y con retención acotada (hallazgos S1 y S5 de la Fase F0). ADITIVA e idempotente.
--
--  1. SANEA lo histórico (S1): `public_link_attempts.identifier` guardaba el token de invitación COMPLETO (scopes
--     invitation_view / invitation_respond / invitation_checkin) y los primeros 24 caracteres del token de QR (checkin_qr).
--     Se reemplaza por su hash con la MISMA fórmula que usa la aplicación (lib/security/public-rate-limit.ts
--     `hashRateLimitIdentifier`): 'h1:' + primeros 32 hex de sha256('sutecba:public-link:v1:' || scope || ':' || valor).
--     - NO invalida invitaciones: las invitaciones guardan solo `token_hash` en `meeting_invitations`; esta tabla es un registro
--       de intentos y ninguna decisión de acceso depende del identificador en claro.
--     - NO borra filas ni cambia scope, ip, succeeded ni created_at: el rastro de auditoría se conserva entero.
--     - Los intentos de la ventana vigente (10 min) siguen contando: el código nuevo calcula el mismo hash.
--     - Idempotente: el prefijo 'h1:' evita volver a hashear una fila ya saneada.
--     - `unsubscribe` ya guardaba un hash (sin prefijo) y `form_submit` guarda el slug público: no se tocan.
--
--  2. `GRANT UPDATE (succeeded)` a nivel de COLUMNA (S5): el intento se reserva de forma atómica al entrar y la aplicación completa
--     después si salió bien. No se puede modificar scope, identifier, ip ni created_at.
--
--  3. Limpieza segura (S5): `purge_public_link_attempts(días)` borra filas viejas, en lotes, SIN darle DELETE directo a la app
--     (SECURITY DEFINER, search_path fijo, mínimo 1 día de retención). Índice por created_at para que sea barata. EXECUTE solo para
--     `sutecba_app`: se revoca a PUBLIC, anon, authenticated y service_role, y un bloque de verificación aborta la migración si queda
--     algún otro grantee o si el dueño de la función no puede borrar de la tabla.
--
-- Rollback: ver docs/F0-SEGURIDAD-INFORME-Y-DESPLIEGUE.md (revocar el UPDATE de columna, borrar la función y el índice; el
-- saneamiento de identificadores no se revierte —el valor en claro es justamente lo que no debe conservarse—).

-- ---------------------------------------------------------------- 1. Saneamiento de identificadores sensibles
UPDATE public.public_link_attempts
SET identifier = 'h1:' || substr(
      encode(sha256(convert_to('sutecba:public-link:v1:' || scope || ':' || identifier, 'UTF8')), 'hex'),
      1, 32)
WHERE scope IN ('invitation_view', 'invitation_respond', 'invitation_checkin', 'checkin_qr')
  AND identifier NOT LIKE 'h1:%';

-- ---------------------------------------------------------------- 2. Completar `succeeded`: solo esa columna
GRANT UPDATE (succeeded) ON TABLE public.public_link_attempts TO sutecba_app;

-- ---------------------------------------------------------------- 3. Retención
CREATE INDEX IF NOT EXISTS public_link_attempts_created_at_idx
  ON public.public_link_attempts (created_at);

CREATE OR REPLACE FUNCTION public.purge_public_link_attempts(retention_days integer DEFAULT 30)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  purged integer;
BEGIN
  -- Piso de 1 día: aunque alguien llame mal a la función, nunca se borra la ventana de límite ni el rastro reciente.
  IF retention_days IS NULL OR retention_days < 1 THEN
    RAISE EXCEPTION 'retention_days debe ser >= 1';
  END IF;

  WITH doomed AS (
    SELECT id
    FROM public.public_link_attempts
    WHERE created_at < now() - make_interval(days => retention_days)
    ORDER BY created_at
    LIMIT 5000
  )
  DELETE FROM public.public_link_attempts p
  USING doomed d
  WHERE p.id = d.id;

  GET DIAGNOSTICS purged = ROW_COUNT;
  RETURN purged;
END;
$$;

-- Permisos mínimos de la función. En Supabase, una función nueva en `public` puede recibir EXECUTE por defecto para `anon`,
-- `authenticated` y `service_role` (ALTER DEFAULT PRIVILEGES); `REVOKE ... FROM PUBLIC` NO quita grants explícitos a esos roles. Sin
-- este bloque, la Data API (PostgREST) podría invocar la función y borrar el rastro de más de un día. Se revoca a cada uno de los
-- que existan en la instalación y se concede EXECUTE únicamente a `sutecba_app` (el dueño conserva el suyo implícito).
REVOKE ALL ON FUNCTION public.purge_public_link_attempts(integer) FROM PUBLIC;
DO $$
DECLARE
  r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON FUNCTION public.purge_public_link_attempts(integer) FROM %I', r);
    END IF;
  END LOOP;
END $$;
GRANT EXECUTE ON FUNCTION public.purge_public_link_attempts(integer) TO sutecba_app;

-- Verificación que ABORTA la migración (transaccional) si el resultado no es el esperado: nada de «creemos que quedó bien».
DO $$
DECLARE
  fn oid := 'public.purge_public_link_attempts(integer)'::regprocedure;
  extra text;
  fn_owner oid;
  table_owner oid;
  is_definer boolean;
BEGIN
  SELECT p.proowner, p.prosecdef INTO fn_owner, is_definer FROM pg_proc p WHERE p.oid = fn;
  SELECT c.relowner INTO table_owner FROM pg_class c WHERE c.oid = 'public.public_link_attempts'::regclass;

  IF NOT is_definer THEN
    RAISE EXCEPTION '0046: purge_public_link_attempts debe ser SECURITY DEFINER';
  END IF;
  -- La función borra con los privilegios de su dueño: tiene que ser el dueño de la tabla (o un rol con DELETE sobre ella).
  IF fn_owner <> table_owner AND NOT has_table_privilege(fn_owner, 'public.public_link_attempts', 'DELETE') THEN
    RAISE EXCEPTION '0046: el dueño de purge_public_link_attempts (%) no puede borrar de public_link_attempts (dueño: %)',
      pg_get_userbyid(fn_owner), pg_get_userbyid(table_owner);
  END IF;
  -- Nadie más que el dueño y sutecba_app puede ejecutarla (incluido PUBLIC: grantee 0).
  SELECT string_agg(CASE a.grantee WHEN 0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END, ', ') INTO extra
  FROM pg_proc p, aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
  WHERE p.oid = fn AND a.privilege_type = 'EXECUTE'
    AND a.grantee <> p.proowner AND a.grantee <> 'sutecba_app'::regrole;
  IF extra IS NOT NULL THEN
    RAISE EXCEPTION '0046: purge_public_link_attempts tiene EXECUTE para roles no previstos: %', extra;
  END IF;
  IF NOT has_function_privilege('sutecba_app', fn, 'EXECUTE') THEN
    RAISE EXCEPTION '0046: sutecba_app no puede ejecutar purge_public_link_attempts';
  END IF;
END $$;

COMMIT;
