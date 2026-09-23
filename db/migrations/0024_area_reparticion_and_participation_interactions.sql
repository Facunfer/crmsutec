BEGIN;

-- 0024 — Área/Repartición, afiliación organizacional de usuarios e interacciones por participación.
--
-- Cambios ADITIVOS (no borra ni reescribe datos):
--
--  1. users.primary_organization_id: dónde PERTENECE el usuario (afiliación). No otorga acceso: la fuente de verdad
--     de qué datos puede ver sigue siendo user_scopes (0012). Nullable; sin backfill.
--
--  2. organization_area_id(uuid): el ÁREA de una unidad es su ancestro raíz (la unidad sin padre a la que llega
--     recorriendo parent_id). Personas conserva UNA sola columna (people.organization_id = la unidad más específica
--     conocida); Área y Repartición se derivan, no se duplican.
--       - Área        = organization_area_id(people.organization_id)
--       - Repartición = people.organization_id (NULL de «repartición específica» cuando la unidad ES el área)
--     Tope de profundidad 32: protege ante un ciclo (parent_id ya lo impide en 0012, esto es defensa en profundidad).
--
--  3. person_interactions:
--       - occurred_precision ('exact_datetime' | 'date_only'): una participación en una actividad con solo día conocido
--         NO inventa una hora; occurred_at guarda el inicio del día (00:00 de Buenos Aires) y la precisión lo declara;
--       - source_key: clave lógica de idempotencia de las interacciones AUTOMÁTICAS («meeting_participation:<id>»,
--         «meeting_attendance:<id>»). UNIQUE parcial: reprocesar una reunión no duplica.
--
--  4. Tipo de interacción «participation» (Participación en actividad), para las interacciones automáticas.

-- ---------------------------------------------------------------- 1. users.primary_organization_id

ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS primary_organization_id uuid REFERENCES public.organizations (id) ON DELETE RESTRICT;

CREATE INDEX IF NOT EXISTS users_primary_organization_idx
  ON public.users (primary_organization_id)
  WHERE primary_organization_id IS NOT NULL;

COMMENT ON COLUMN public.users.primary_organization_id IS
  'Afiliación organizativa del usuario (informativa). NO otorga acceso: los datos que puede ver salen de user_scopes.';

-- ---------------------------------------------------------------- 2. organization_area_id

CREATE OR REPLACE FUNCTION public.organization_area_id(p_organization_id uuid)
RETURNS uuid
LANGUAGE sql
STABLE
SET search_path = public, pg_temp
AS $$
  WITH RECURSIVE up AS (
    SELECT o.id, o.parent_id, 0 AS depth
    FROM public.organizations o
    WHERE o.id = p_organization_id
    UNION ALL
    SELECT p.id, p.parent_id, up.depth + 1
    FROM public.organizations p
    JOIN up ON p.id = up.parent_id
    WHERE up.depth < 32
  )
  SELECT up.id FROM up WHERE up.parent_id IS NULL ORDER BY up.depth DESC LIMIT 1
$$;

-- Misma política que 0019/0023: nada de EXECUTE para PUBLIC; solo el rol runtime.
REVOKE EXECUTE ON FUNCTION public.organization_area_id(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.organization_area_id(uuid) TO sutecba_app;

-- ---------------------------------------------------------------- 3. person_interactions

ALTER TABLE public.person_interactions
  ADD COLUMN IF NOT EXISTS occurred_precision text NOT NULL DEFAULT 'exact_datetime',
  ADD COLUMN IF NOT EXISTS source_key text;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'person_interactions_precision_check' AND conrelid = 'public.person_interactions'::regclass) THEN
    ALTER TABLE public.person_interactions
      ADD CONSTRAINT person_interactions_precision_check
      CHECK (occurred_precision IN ('exact_datetime', 'date_only'));
  END IF;
  -- date_only = solo el día: occurred_at es el inicio de ese día en Buenos Aires (nunca una hora inventada).
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'person_interactions_date_only_check' AND conrelid = 'public.person_interactions'::regclass) THEN
    ALTER TABLE public.person_interactions
      ADD CONSTRAINT person_interactions_date_only_check
      CHECK (occurred_precision <> 'date_only' OR (occurred_at AT TIME ZONE 'America/Argentina/Buenos_Aires')::time = TIME '00:00');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'person_interactions_source_key_check' AND conrelid = 'public.person_interactions'::regclass) THEN
    ALTER TABLE public.person_interactions
      ADD CONSTRAINT person_interactions_source_key_check
      CHECK (source_key IS NULL OR btrim(source_key) <> '');
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS person_interactions_source_key_unique_idx
  ON public.person_interactions (source_key)
  WHERE source_key IS NOT NULL;

-- Última interacción por persona (semáforo): filtra por persona y estado válido, ordenado por fecha.
CREATE INDEX IF NOT EXISTS person_interactions_person_valid_idx
  ON public.person_interactions (person_id, occurred_at DESC)
  WHERE status IN ('open', 'completed');

-- ---------------------------------------------------------------- 4. tipo de interacción automática

INSERT INTO public.interaction_types (key, name, active, sort_order)
VALUES ('participation', 'Participación en actividad', true, 15)
ON CONFLICT (key) DO NOTHING;

COMMIT;
