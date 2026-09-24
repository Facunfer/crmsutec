BEGIN;

-- 0029 — `date_basis` en person_interactions: distingue fecha REAL de fecha de REFERENCIA técnica.
--
-- Decisión de negocio SUTECBA 2026-09-23 (segunda etapa de la excepción histórica inicial, ver 0028): las
-- participaciones de los lotes históricos iniciales (participation_kind='participated', participation_basis=
-- 'legacy_initial_import') que hoy NO generan interacción por falta de jornada o de fecha real (campaña sin
-- meeting_id, o reunión con schedule_precision='unknown') deben poder generar igual una interacción, usando
-- 2026-01-01 como fecha TÉCNICA de referencia — nunca como fecha real comprobada de asistencia.
--
-- `date_basis`:
--   'actual'           (default): occurred_at es la fecha real de la actividad (como hoy, sin cambios).
--   'legacy_reference': occurred_at es la fecha de referencia técnica 2026-01-01 (00:00 Buenos Aires), NO una fecha
--                        real. Exclusivo de participaciones legacy_initial_import sin fecha real usable.
--
-- No se sobrescribe ninguna fecha real existente ni se toca meetings/import_rows/raw_data: esta columna vive
-- únicamente en la interacción sintética que genera lib/interactions/legacy-reference-interactions.ts.
--
-- LÍMITE DE LO QUE UN CHECK PUEDE GARANTIZAR: un CHECK de Postgres no puede consultar otra tabla, así que no puede
-- verificar por sí mismo que la meeting_participations de origen sea realmente 'participated'+'legacy_initial_import'
-- (eso exige un JOIN). Por eso esta migración separa dos garantías distintas:
--   1. CHECK intra-fila (person_interactions_legacy_reference_check, abajo): si date_basis='legacy_reference', la
--      fila debe tener exactamente la fecha/precisión de referencia — esto SÍ lo puede garantizar un CHECK, porque
--      solo mira columnas de la misma fila.
--   2. TRIGGER (sutecba_check_legacy_reference_interaction, abajo): si date_basis='legacy_reference', la
--      participación de origen (resuelta desde source_key) debe ser realmente 'participated'+'legacy_initial_import'
--      — esto SÍ requiere consultar meeting_participations, así que solo un trigger (no un CHECK) puede exigirlo.
--      Sin este trigger, la separación de "solo lo histórico puede usar la fecha de referencia" sería una convención
--      de la aplicación, no una garantía real de la base.

ALTER TABLE public.person_interactions
  ADD COLUMN IF NOT EXISTS date_basis text NOT NULL DEFAULT 'actual';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'person_interactions_date_basis_check' AND conrelid = 'public.person_interactions'::regclass) THEN
    ALTER TABLE public.person_interactions
      ADD CONSTRAINT person_interactions_date_basis_check
      CHECK (date_basis IN ('actual', 'legacy_reference'));
  END IF;

  -- legacy_reference exige exactamente: precisión 'date_only' Y occurred_at = 2026-01-01 00:00 Buenos Aires (nunca
  -- una hora real inventada, nunca otra fecha). El cast pasa por "timestamp" (sin zona) y recién ahí se interpreta
  -- en America/Argentina/Buenos_Aires, igual que person_interactions_date_only_check (0024) para no correr el día.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'person_interactions_legacy_reference_check' AND conrelid = 'public.person_interactions'::regclass) THEN
    ALTER TABLE public.person_interactions
      ADD CONSTRAINT person_interactions_legacy_reference_check
      CHECK (
        date_basis <> 'legacy_reference'
        OR (
          occurred_precision = 'date_only'
          AND occurred_at = ('2026-01-01'::date::timestamp AT TIME ZONE 'America/Argentina/Buenos_Aires')
        )
      );
  END IF;
END $$;

-- Garantía real (no solo documentada) de que 'legacy_reference' solo lo usan interacciones derivadas de una
-- participación 'participated'+'legacy_initial_import': un CHECK no puede mirar meeting_participations, un trigger sí.
CREATE OR REPLACE FUNCTION public.sutecba_check_legacy_reference_interaction()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  v_participation_id uuid;
  v_kind text;
  v_basis text;
BEGIN
  IF NEW.date_basis <> 'legacy_reference' THEN
    RETURN NEW;
  END IF;

  IF NEW.source_key IS NULL OR NEW.source_key !~ '^meeting_participation:' THEN
    RAISE EXCEPTION 'date_basis=legacy_reference exige source_key de una meeting_participation (source_key=%)', NEW.source_key;
  END IF;

  v_participation_id := substring(NEW.source_key FROM 'meeting_participation:(.*)')::uuid;

  SELECT participation_kind, participation_basis INTO v_kind, v_basis
  FROM public.meeting_participations
  WHERE id = v_participation_id;

  IF v_kind IS NULL THEN
    RAISE EXCEPTION 'date_basis=legacy_reference: no existe meeting_participations.id=%', v_participation_id;
  END IF;

  IF v_kind <> 'participated' OR v_basis <> 'legacy_initial_import' THEN
    RAISE EXCEPTION 'date_basis=legacy_reference exige participation_kind=participated y participation_basis=legacy_initial_import (encontrado kind=%, basis=%)', v_kind, v_basis;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS person_interactions_legacy_reference_guard ON public.person_interactions;
CREATE TRIGGER person_interactions_legacy_reference_guard
BEFORE INSERT OR UPDATE OF date_basis, source_key ON public.person_interactions
FOR EACH ROW EXECUTE FUNCTION public.sutecba_check_legacy_reference_interaction();

-- Última interacción CON FECHA REAL por persona (semáforo, KPI "real vs referencial" — punto 3.5/4): mismo patrón
-- que person_interactions_person_valid_idx (0024), acotado a date_basis='actual'.
CREATE INDEX IF NOT EXISTS person_interactions_person_valid_actual_idx
  ON public.person_interactions (person_id, occurred_at DESC)
  WHERE status IN ('open', 'completed') AND date_basis = 'actual';

COMMIT;
