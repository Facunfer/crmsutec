BEGIN;

-- 0022 — Alias de organización CONTEXTUALES.
--
-- Hay organizaciones homónimas en el organigrama oficial (p. ej. 5 «Dirección General Técnica, Administrativa y
-- Legal», una por jurisdicción; 5 «Unidad de Auditoría Interna»). Un alias como «DGTAL» no puede resolverse de forma
-- global: la jurisdicción de origen forma parte del contexto de resolución.
--
--   context_organization_id IS NULL      → alias GLOBAL: identifica inequívocamente una sola organización.
--   context_organization_id = <org>      → alias CONTEXTUAL: solo vale cuando la jurisdicción de origen (la
--                                          organización ya resuelta de la fila, del archivo o de la persona) está
--                                          dentro de esa organización de contexto.
--
-- Cambios (aditivos; el único reemplazo es del índice único de alias aprobados, que ya no puede ser global):
--  1. columna nullable context_organization_id → organizations (ON DELETE RESTRICT), distinta de organization_id;
--  2. el índice único «un alias aprobado por texto» se reemplaza por dos:
--       - global:      UNIQUE (normalized_alias)                          WHERE aprobado AND context IS NULL
--       - contextual:  UNIQUE (normalized_alias, context_organization_id) WHERE aprobado AND context IS NOT NULL
--  3. UN solo trigger de guarda, seguro con concurrencia real y sin depender del orden de otros triggers:
--       - calcula él mismo el texto normalizado con la MISMA función que usa el trigger de normalización
--         (sutecba_organization_alias_normalize, que 0022 también pone detrás del trigger de 0012), y lo deja en
--         NEW.normalized_alias: el valor que ve la guarda es siempre el que indexan los índices únicos;
--       - para alias APROBADOS toma un lock transaccional (pg_advisory_xact_lock sobre el texto normalizado) ANTES de
--         verificar: dos transacciones que aprueban el mismo texto serializan la comprobación, y la segunda ve lo que
--         la primera confirmó (READ COMMITTED evalúa cada sentencia con una foto nueva). Una colisión accidental del
--         hash solo serializa dos textos distintos: nunca viola la integridad;
--       - global existente + contextual nuevo → rechazado; contextual existente + global nuevo → rechazado;
--         contextual A + contextual B con contextos distintos → permitido; mismo texto + mismo contexto → UNIQUE;
--       - la organización destino debe estar DENTRO del contexto (un alias contextual no puede saltar de jurisdicción).

ALTER TABLE public.organization_aliases
  ADD COLUMN IF NOT EXISTS context_organization_id uuid REFERENCES public.organizations (id) ON DELETE RESTRICT;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'organization_aliases_context_not_self_check' AND conrelid = 'public.organization_aliases'::regclass) THEN
    ALTER TABLE public.organization_aliases
      ADD CONSTRAINT organization_aliases_context_not_self_check
      CHECK (context_organization_id IS NULL OR context_organization_id <> organization_id);
  END IF;
END $$;

DROP INDEX IF EXISTS public.organization_aliases_approved_unique_idx;

CREATE UNIQUE INDEX IF NOT EXISTS organization_aliases_approved_global_unique_idx
  ON public.organization_aliases (normalized_alias)
  WHERE status = 'approved' AND context_organization_id IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS organization_aliases_approved_context_unique_idx
  ON public.organization_aliases (normalized_alias, context_organization_id)
  WHERE status = 'approved' AND context_organization_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS organization_aliases_context_idx
  ON public.organization_aliases (context_organization_id)
  WHERE context_organization_id IS NOT NULL;

-- Normalización única (misma expresión que 0012): la usan el trigger de normalización y la guarda.
CREATE OR REPLACE FUNCTION public.sutecba_organization_alias_normalize(p_alias text)
RETURNS text
LANGUAGE sql
STABLE
SET search_path = public, extensions
AS $$
  SELECT regexp_replace(lower(unaccent(btrim(p_alias))), '\s+', ' ', 'g')
$$;

REVOKE ALL ON FUNCTION public.sutecba_organization_alias_normalize(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.sutecba_organization_alias_normalize(text) TO sutecba_app;

-- El trigger de normalización de 0012 pasa a delegar en la función compartida (mismo resultado, un solo lugar).
CREATE OR REPLACE FUNCTION public.sutecba_normalize_organization_alias()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, extensions
AS $$
BEGIN
  NEW.normalized_alias := public.sutecba_organization_alias_normalize(NEW.alias);
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.sutecba_organization_aliases_context_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, extensions
AS $$
BEGIN
  -- Mismo valor normalizado que indexan los índices únicos, sin importar en qué orden corran los triggers.
  NEW.normalized_alias := public.sutecba_organization_alias_normalize(NEW.alias);

  IF NEW.context_organization_id IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.organization_descendants(NEW.context_organization_id) d
      WHERE d.organization_id = NEW.organization_id
    ) THEN
      RAISE EXCEPTION 'El alias contextual debe apuntar a una organización dentro de su contexto';
    END IF;
  END IF;

  IF NEW.status = 'approved' THEN
    -- Serializa la comprobación de todo alias aprobado con el mismo texto normalizado.
    PERFORM pg_advisory_xact_lock(hashtextextended('sutecba:organization_alias:' || NEW.normalized_alias, 0));

    IF EXISTS (
      SELECT 1 FROM public.organization_aliases a
      WHERE a.id <> NEW.id
        AND a.status = 'approved'
        AND a.normalized_alias = NEW.normalized_alias
        AND ((NEW.context_organization_id IS NULL) <> (a.context_organization_id IS NULL))
    ) THEN
      RAISE EXCEPTION 'Un alias no puede ser a la vez global y contextual: el global haría sombra al contextual';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'organization_aliases_context_guard' AND tgrelid = 'public.organization_aliases'::regclass) THEN
    CREATE TRIGGER organization_aliases_context_guard
    BEFORE INSERT OR UPDATE ON public.organization_aliases
    FOR EACH ROW
    EXECUTE FUNCTION public.sutecba_organization_aliases_context_guard();
  END IF;
END $$;

COMMIT;

-- VERIFICACIÓN (ejecutar aparte):
-- SELECT column_name, is_nullable FROM information_schema.columns WHERE table_name = 'organization_aliases' AND column_name = 'context_organization_id';
-- SELECT indexname FROM pg_indexes WHERE tablename = 'organization_aliases' ORDER BY 1;
-- ROLLBACK CONSERVADOR: la columna nueva es inerte si no se usa; el índice único global anterior se puede recrear solo
-- si no hay alias contextuales aprobados.
