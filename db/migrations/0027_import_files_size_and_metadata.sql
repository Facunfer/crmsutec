BEGIN;

-- 0027 — Trazabilidad completa de import_files: tamaño del original y metadata de la fuente (necesario para que el
-- segundo lote de Gabriel ("nuevas bases") tenga la misma procedencia que el histórico). Columnas nuevas, nulables /
-- con default: no afecta filas ya cargadas por el importador histórico.

ALTER TABLE public.import_files
  ADD COLUMN IF NOT EXISTS size_bytes integer,
  ADD COLUMN IF NOT EXISTS source_metadata jsonb NOT NULL DEFAULT '{}'::jsonb;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'import_files_size_bytes_check' AND conrelid = 'public.import_files'::regclass) THEN
    ALTER TABLE public.import_files
      ADD CONSTRAINT import_files_size_bytes_check CHECK (size_bytes IS NULL OR size_bytes >= 0);
  END IF;
END $$;

COMMENT ON COLUMN public.import_files.source_metadata IS
  'Metadata de la fuente (código de archivo, tablas/páginas detectadas, etc.). Nunca datos personales.';

COMMIT;
