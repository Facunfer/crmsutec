-- 0020 — Un actor que no es MASTER_GLOBAL no puede revocar el último alcance
-- activo de un usuario.
--
-- Aditiva: no borra ni modifica objetos de 0012–0019 (solo agrega un trigger y
-- su función). Idempotente (CREATE OR REPLACE / DROP TRIGGER IF EXISTS).
--
-- Hoy la regla también la aplica el servidor (lib/users/commands.ts →
-- revokeUserScope, dentro de una transacción con `SELECT ... FOR UPDATE` sobre
-- la fila del usuario). Este trigger lleva la misma garantía a la base, de modo
-- que valga también para un UPDATE directo, de varias filas a la vez, o para
-- cualquier otro cliente.
--
-- Diseño (revisado):
--  * AFTER UPDATE ... FOR EACH ROW: los triggers AFTER se ejecutan al terminar
--    la sentencia, así que cada fila ve el estado final de un UPDATE
--    multi-fila (revocar "todos los alcances" de una vez no lo esquiva).
--  * Solo mira revocaciones reales (`revoked_at` pasa de NULL a un valor); las
--    filas ya revocadas son inmutables por user_scopes_validate_change (0013).
--  * Toma `FOR UPDATE` sobre la fila de users antes de contar, para que dos
--    transacciones concurrentes que revocan cada una uno de los dos últimos
--    alcances se serialicen: la segunda espera y, al reanudar (READ COMMITTED
--    vuelve a leer), ve la primera ya confirmada y falla. El nombre del
--    trigger ordena después de user_scopes_bump_permissions_version, que ya
--    actualiza esa misma fila de users.
--  * MASTER_GLOBAL queda exceptuado (por el rol de `revoked_by`): puede dejar a
--    un usuario sin alcances a propósito.
--  * Corre con los privilegios del invocador (sutecba_app): lee roles/users/
--    user_scopes y toma FOR UPDATE sobre users, todo cubierto por los GRANT y la
--    política FOR ALL de 0019.
--
-- Operaciones legítimas que NO bloquea: revocar un alcance cuando queda otro
-- vigente; que MASTER_GLOBAL revoque cualquiera; conceder alcances; y reemplazar
-- un alcance (concederlo primero y revocar el viejo después, en ese orden).
-- Sí bloquea, a propósito, que un delegado deje a un usuario sin ningún alcance.
--
-- Limitaciones conocidas:
--  * No cubre el alta sin alcances: eso es un INSERT, no una revocación, y lo
--    exige `createUser` (un delegado debe indicar al menos un alcance).
--  * Si un UPDATE directo y el comando del servidor tocan a la vez el mismo
--    alcance del mismo usuario, el orden de bloqueos es distinto (servidor:
--    users → fila de alcance; directo: fila de alcance → users) y PostgreSQL
--    puede detectar un deadlock y abortar una de las dos transacciones. No
--    corrompe nada y es improbable: la vía normal es siempre el servidor.
--
BEGIN;

CREATE OR REPLACE FUNCTION public.sutecba_user_scopes_keep_last_scope()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_actor_role text;
BEGIN
  IF NEW.revoked_at IS NULL OR OLD.revoked_at IS NOT NULL THEN
    RETURN NEW;
  END IF;

  SELECT r.key INTO v_actor_role
  FROM public.users u
  JOIN public.roles r ON r.id = u.role_id
  WHERE u.id = NEW.revoked_by;

  IF v_actor_role = 'MASTER_GLOBAL' THEN
    RETURN NEW;
  END IF;

  PERFORM 1 FROM public.users WHERE id = NEW.user_id FOR UPDATE;

  IF NOT EXISTS (
    SELECT 1
    FROM public.user_scopes
    WHERE user_id = NEW.user_id
      AND revoked_at IS NULL
  ) THEN
    RAISE EXCEPTION 'No se puede revocar el último alcance activo del usuario; debe conservar al menos uno';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS user_scopes_keep_last_scope ON public.user_scopes;
CREATE TRIGGER user_scopes_keep_last_scope
AFTER UPDATE ON public.user_scopes
FOR EACH ROW
EXECUTE FUNCTION public.sutecba_user_scopes_keep_last_scope();

COMMIT;

-- VERIFICACIÓN (ejecutar aparte):
-- SELECT tgname FROM pg_trigger WHERE tgrelid = 'public.user_scopes'::regclass AND NOT tgisinternal ORDER BY tgname;
--
-- ROLLBACK CONSERVADOR (solo quita el trigger nuevo; no toca datos):
-- DROP TRIGGER IF EXISTS user_scopes_keep_last_scope ON public.user_scopes;
-- DROP FUNCTION IF EXISTS public.sutecba_user_scopes_keep_last_scope();
