BEGIN;

-- Falla rápido (no bloquea la aplicación esperando) si otra transacción larga retiene un lock sobre people/la función.
SET LOCAL lock_timeout = '10s';

-- 0034 — Rendimiento de /personas (etapa 1). Aditiva: no cambia datos ni resultados.
--
-- 1. organization_area_id(uuid) pasa a STRICT: con NULL devuelve NULL SIN ejecutar el CTE recursivo. Hoy 98,7 % de las personas
--    tienen organization_id NULL y la función se evaluaba 179.631 veces por listado (~70 % del tiempo). Con un CTE recursivo que
--    arranca en `WHERE o.id = NULL`, el resultado para NULL ya era NULL: la semántica no cambia.
-- 2. Índice parcial por nombre para personas activas (orden del listado). Incluye `id` al final para que el orden sea total y
--    estable: las personas con el mismo nombre se desempatan por id y la paginación no repite ni saltea filas.

ALTER FUNCTION public.organization_area_id(uuid) STRICT;

CREATE INDEX IF NOT EXISTS people_name_active_idx
  ON public.people (last_name, first_name, id)
  WHERE status = 'active';

COMMIT;
