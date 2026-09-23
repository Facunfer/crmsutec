BEGIN;

-- 0023 — Hardening mínimo de 0022: privilegios explícitos de la función del trigger de alias contextuales.
--
-- `public.sutecba_organization_aliases_context_guard()` es una función de TRIGGER: no se invoca como función común y
-- PostgreSQL solo exige EXECUTE al CREAR el trigger (lo hace el dueño, postgres), no al dispararlo. Al crearla
-- (0022), quedó con el EXECUTE por defecto de PUBLIC. Se quita: nadie más lo necesita, ni siquiera `sutecba_app`,
-- que sigue insertando alias (el trigger se ejecuta igual). No se otorga nada a nadie.
--
-- Nada más cambia en esta migración: sin tablas, columnas, índices ni datos.

REVOKE EXECUTE ON FUNCTION public.sutecba_organization_aliases_context_guard() FROM PUBLIC;

COMMIT;

-- VERIFICACIÓN (ejecutar aparte):
-- SELECT proname, proacl FROM pg_proc WHERE proname = 'sutecba_organization_aliases_context_guard';
--   → la ACL ya no debe incluir «=X/postgres» (PUBLIC).
