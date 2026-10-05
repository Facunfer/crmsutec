BEGIN;

-- Falla rápido (no bloquea la aplicación esperando) si otra transacción larga retiene un lock.
SET LOCAL lock_timeout = '10s';

-- 0036 — Campañas como entidad (Fase A del Bloque II). ADITIVA e idempotente.
--
-- Una campaña (vacunación, operativo oftalmológico…) puede existir sin ninguna reunión, tener varias jornadas (meetings con
-- campaign_id) y tener participación acreditada a nivel campaña (meeting_participations.campaign_key, sin cambios).
-- NO se modifica meeting_participations ni ninguna participación. NO se inventan fechas.
--
-- Estado operativo y condición histórica son conceptos SEPARADOS:
--   · status: ciclo de vida operativo gestionado en el sistema (draft/scheduled/active/finalized/cancelled). Es NULL
--     mientras nadie lo haya gestionado (p. ej. campañas importadas): no se fuerza 'finalized' por haber sido importada.
--   · historical_condition: qué sabemos de una campaña IMPORTADA — 'imported_occurred' (la fuente acredita que ocurrió y
--     hay al menos una jornada con fecha documentada) o 'imported_undated' (ocurrió según la fuente, pero no hay una fecha
--     documentada). La condición vive en la campaña; la procedencia real (lotes, archivos, filas, base de la participación)
--     sigue en meeting_participations / import_rows / import_files: no se guarda un único lote como «la» procedencia.

CREATE TABLE IF NOT EXISTS public.campaigns (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_key text NOT NULL,
  name text NOT NULL,
  campaign_type text NOT NULL,
  owner_organization_id uuid NOT NULL REFERENCES public.organizations (id) ON DELETE RESTRICT,
  status text,
  historical_condition text,
  origin text NOT NULL DEFAULT 'manual',
  start_date date,
  end_date date,
  created_by uuid REFERENCES public.users (id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT campaigns_campaign_key_unique UNIQUE (campaign_key),
  CONSTRAINT campaigns_key_format_check CHECK (campaign_key ~ '^[a-z0-9][a-z0-9:_-]*$'),
  CONSTRAINT campaigns_name_not_blank_check CHECK (btrim(name) <> ''),
  CONSTRAINT campaigns_type_check CHECK (campaign_type IN ('vaccination', 'ophthalmology', 'other')),
  CONSTRAINT campaigns_status_check CHECK (status IS NULL OR status IN ('draft', 'scheduled', 'active', 'finalized', 'cancelled')),
  CONSTRAINT campaigns_origin_check CHECK (origin IN ('manual', 'import')),
  CONSTRAINT campaigns_historical_condition_check CHECK (historical_condition IS NULL OR historical_condition IN ('imported_occurred', 'imported_undated')),
  CONSTRAINT campaigns_origin_consistency_check CHECK (
    (origin = 'manual' AND status IS NOT NULL AND historical_condition IS NULL)
    OR (origin = 'import' AND historical_condition IS NOT NULL)
  ),
  CONSTRAINT campaigns_dates_check CHECK (end_date IS NULL OR start_date IS NULL OR end_date >= start_date)
);

COMMENT ON TABLE public.campaigns IS
  'Campañas (vacunación, oftalmología…). Participación a nivel campaña: meeting_participations.campaign_key = campaigns.campaign_key; jornadas: meetings.campaign_id.';

ALTER TABLE public.meetings
  ADD COLUMN IF NOT EXISTS campaign_id uuid REFERENCES public.campaigns (id) ON DELETE RESTRICT;

CREATE INDEX IF NOT EXISTS meetings_campaign_idx ON public.meetings (campaign_id) WHERE campaign_id IS NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'campaigns_no_delete' AND tgrelid = 'public.campaigns'::regclass) THEN
    CREATE TRIGGER campaigns_no_delete
    BEFORE DELETE ON public.campaigns
    FOR EACH ROW
    EXECUTE FUNCTION public.sutecba_block_delete();
  END IF;
END $$;

ALTER TABLE public.campaigns ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'campaigns' AND policyname = 'sutecba_app_all') THEN
    CREATE POLICY sutecba_app_all ON public.campaigns FOR ALL TO sutecba_app USING (true) WITH CHECK (true);
  END IF;
END $$;

REVOKE ALL ON TABLE public.campaigns FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON TABLE public.campaigns TO sutecba_app;

-- ------------------------------------------------------------------------------------------------------------------------
-- BACKFILL (guiado por los datos existentes; idempotente; no toca meeting_participations).
-- Una campaña por cada campaign_key que ya existe en participaciones o que se deduce de las reuniones de oftalmología
-- (ophthalmology:<fecha|sin-fecha>:<campaña>). La regex vive SOLO acá, una vez, para esta carga inicial.
-- Propietaria administrativa: SUTECBA raíz (como el resto de las actividades históricas). Sin ella no se crea ninguna fila.
-- start_date/end_date quedan NULL: no se inventan fechas (el rango se calcula al leer, desde las jornadas).
-- ------------------------------------------------------------------------------------------------------------------------
WITH keys AS (
  SELECT DISTINCT mp.campaign_key AS k
  FROM public.meeting_participations mp
  WHERE mp.campaign_key IS NOT NULL
  UNION
  SELECT 'ophthalmology:' || (regexp_match(m.source_event_key, '^ophthalmology:(?:[0-9]{4}-[0-9]{2}-[0-9]{2}|sin-fecha):(.+)$'))[1]
  FROM public.meetings m
  WHERE m.source_event_key ~ '^ophthalmology:(?:[0-9]{4}-[0-9]{2}-[0-9]{2}|sin-fecha):.+$'
),
labels(slug, label) AS (
  VALUES
    ('asi', 'ASI'),
    ('canale', 'Canale'),
    ('centro-metropolitano-de-diseno', 'Centro Metropolitano de Diseño'),
    ('cruz-malta', 'Cruz Malta'),
    ('educacion', 'Educación'),
    ('infraestructura-escolar', 'Infraestructura Escolar'),
    ('ivc', 'IVC'),
    ('ministerio-de-justicia', 'Ministerio de Justicia'),
    ('procuracion', 'Procuración'),
    ('ss-trabajo', 'Subsecretaría de Trabajo'),
    ('teatro-colon', 'Teatro Colón')
),
owner AS (
  SELECT id FROM public.organizations WHERE official_code = 'SUTECBA' AND parent_id IS NULL LIMIT 1
)
INSERT INTO public.campaigns (campaign_key, name, campaign_type, owner_organization_id, status, historical_condition, origin)
SELECT
  keys.k,
  CASE
    WHEN keys.k = 'vaccination:2026' THEN 'Campaña de vacunación 2026'
    WHEN keys.k LIKE 'ophthalmology:%' THEN 'Campaña oftalmológica — ' || coalesce(l.label, initcap(replace(substr(keys.k, length('ophthalmology:') + 1), '-', ' ')))
    ELSE initcap(replace(replace(keys.k, ':', ' '), '-', ' '))
  END,
  CASE WHEN keys.k LIKE 'vaccination:%' THEN 'vaccination' WHEN keys.k LIKE 'ophthalmology:%' THEN 'ophthalmology' ELSE 'other' END,
  owner.id,
  NULL,
  -- «ocurrió con fecha documentada» solo si alguna jornada de la campaña tiene fecha real; si no, «ocurrió sin fecha».
  CASE WHEN EXISTS (
    SELECT 1 FROM public.meetings m
    WHERE m.schedule_precision <> 'unknown'
      AND m.source_event_key ~ '^ophthalmology:[0-9]{4}-[0-9]{2}-[0-9]{2}:.+$'
      AND 'ophthalmology:' || (regexp_match(m.source_event_key, '^ophthalmology:[0-9]{4}-[0-9]{2}-[0-9]{2}:(.+)$'))[1] = keys.k
  ) THEN 'imported_occurred' ELSE 'imported_undated' END,
  'import'
FROM keys
CROSS JOIN owner
LEFT JOIN labels l ON keys.k = 'ophthalmology:' || l.slug
WHERE keys.k ~ '^[a-z0-9][a-z0-9:_-]*$'
ON CONFLICT (campaign_key) DO NOTHING;

-- Jornadas de oftalmología → su campaña. Solo completa campaign_id donde está vacío; no toca ninguna otra columna de importación.
UPDATE public.meetings m
SET campaign_id = c.id
FROM public.campaigns c
WHERE m.campaign_id IS NULL
  AND m.source_event_key ~ '^ophthalmology:(?:[0-9]{4}-[0-9]{2}-[0-9]{2}|sin-fecha):.+$'
  AND c.campaign_key = 'ophthalmology:' || (regexp_match(m.source_event_key, '^ophthalmology:(?:[0-9]{4}-[0-9]{2}-[0-9]{2}|sin-fecha):(.+)$'))[1];

COMMIT;
