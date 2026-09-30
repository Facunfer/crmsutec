BEGIN;

-- 0033 — Observaciones de persona: categoría + valor + procedencia.
--
-- Estructura mínima y trazable para datos descriptivos de una persona que no son campos de la ficha ni actividades
-- (p. ej. categoría 'colegio_votacion' = sede/colegio donde vota, del padrón de abogados). No reemplaza custom_fields
-- (sin definiciones ni UI). Nunca se pisa ni se borra: cada (persona, categoría, valor) se guarda una vez; si la fuente
-- trae otro valor para la misma categoría, se agrega otra fila y ambas conviven (sin UPDATE ni DELETE).

CREATE TABLE IF NOT EXISTS public.person_observations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  person_id uuid NOT NULL REFERENCES public.people (id) ON DELETE RESTRICT,
  category text NOT NULL,
  value text NOT NULL,
  source_kind text NOT NULL DEFAULT 'import',
  import_row_id uuid REFERENCES public.import_rows (id) ON DELETE RESTRICT,
  source_note text,
  created_by uuid NOT NULL REFERENCES public.users (id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT person_observations_category_format CHECK (category ~ '^[a-z][a-z0-9_]*$'),
  CONSTRAINT person_observations_value_not_blank CHECK (btrim(value) <> ''),
  CONSTRAINT person_observations_source_kind_check CHECK (source_kind IN ('import', 'manual')),
  CONSTRAINT person_observations_import_has_row CHECK (source_kind <> 'import' OR import_row_id IS NOT NULL),
  CONSTRAINT person_observations_unique UNIQUE (person_id, category, value)
);

CREATE INDEX IF NOT EXISTS person_observations_person_idx ON public.person_observations (person_id, category);
CREATE INDEX IF NOT EXISTS person_observations_row_idx ON public.person_observations (import_row_id) WHERE import_row_id IS NOT NULL;

COMMENT ON TABLE public.person_observations IS
  'Observaciones de persona (categoría/valor/procedencia). Inmutable: sin UPDATE ni DELETE. Puede contener datos personales.';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'person_observations_no_delete' AND tgrelid = 'public.person_observations'::regclass) THEN
    CREATE TRIGGER person_observations_no_delete
    BEFORE DELETE ON public.person_observations
    FOR EACH ROW
    EXECUTE FUNCTION public.sutecba_block_delete();
  END IF;
END $$;

ALTER TABLE public.person_observations ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'person_observations' AND policyname = 'sutecba_app_all') THEN
    CREATE POLICY sutecba_app_all ON public.person_observations FOR ALL TO sutecba_app USING (true) WITH CHECK (true);
  END IF;
END $$;

REVOKE ALL ON TABLE public.person_observations FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT ON TABLE public.person_observations TO sutecba_app;

COMMIT;
