BEGIN;

-- 0018 — Importaciones con procedencia, revisión e idempotencia.
-- El archivo es canónico por hash GLOBAL. Un lote nuevo puede referenciar
-- un archivo ya registrado mediante import_batch_files.
-- raw_data puede contener DNI/email/teléfono: tratar como dato sensible.

CREATE TABLE IF NOT EXISTS public.import_batches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  responsible_user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  status text NOT NULL DEFAULT 'staged'
    CHECK (status IN ('staged','processing','in_review','approved','applied','failed','cancelled')),
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  completed_at timestamptz,
  created_by uuid NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  notes text
);

CREATE INDEX IF NOT EXISTS import_batches_owner_status_idx
  ON public.import_batches (owner_organization_id, status, created_at DESC);

CREATE TABLE IF NOT EXISTS public.import_files (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  original_name text NOT NULL,
  content_hash text NOT NULL UNIQUE,
  external_reference text,
  created_by uuid NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT import_files_name_not_blank CHECK (btrim(original_name) <> ''),
  CONSTRAINT import_files_hash_format CHECK (content_hash ~ '^[0-9a-f]{64}$')
);

CREATE TABLE IF NOT EXISTS public.import_batch_files (
  batch_id uuid NOT NULL REFERENCES public.import_batches(id) ON DELETE RESTRICT,
  file_id uuid NOT NULL REFERENCES public.import_files(id) ON DELETE RESTRICT,
  linked_by uuid NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  linked_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (batch_id, file_id)
);

CREATE INDEX IF NOT EXISTS import_batch_files_file_idx
  ON public.import_batch_files (file_id, batch_id);

CREATE TABLE IF NOT EXISTS public.import_rows (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  file_id uuid NOT NULL REFERENCES public.import_files(id) ON DELETE RESTRICT,
  sheet text NOT NULL DEFAULT '',
  row_number integer NOT NULL CHECK (row_number > 0),
  raw_data jsonb NOT NULL,
  normalized_data jsonb NOT NULL DEFAULT '{}'::jsonb,
  row_hash text NOT NULL,
  duplicate_of_row_id uuid REFERENCES public.import_rows(id) ON DELETE RESTRICT,
  status text NOT NULL DEFAULT 'staged'
    CHECK (status IN ('staged','normalized','in_review','approved','applied','rejected','skipped')),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (file_id, sheet, row_number),
  CONSTRAINT import_rows_hash_format CHECK (row_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT import_rows_not_self_duplicate CHECK (
    duplicate_of_row_id IS NULL OR duplicate_of_row_id <> id
  )
);

COMMENT ON COLUMN public.import_rows.raw_data IS
  'Dato sensible potencial: puede contener DNI, email y teléfono originales.';

CREATE INDEX IF NOT EXISTS import_rows_file_hash_idx
  ON public.import_rows (file_id, row_hash);

CREATE INDEX IF NOT EXISTS import_rows_file_status_idx
  ON public.import_rows (file_id, status, row_number);

CREATE TABLE IF NOT EXISTS public.import_issues (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id uuid NOT NULL REFERENCES public.import_batches(id) ON DELETE RESTRICT,
  import_row_id uuid NOT NULL REFERENCES public.import_rows(id) ON DELETE RESTRICT,
  severity text NOT NULL CHECK (severity IN ('warning','error')),
  code text NOT NULL,
  message text NOT NULL,
  status text NOT NULL DEFAULT 'open'
    CHECK (status IN ('open','resolved','dismissed')),
  resolved_by uuid REFERENCES public.users(id) ON DELETE RESTRICT,
  resolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT import_issues_resolution_consistency CHECK (
    (status = 'open' AND resolved_by IS NULL AND resolved_at IS NULL)
    OR
    (status <> 'open' AND resolved_by IS NOT NULL AND resolved_at IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS import_issues_batch_status_idx
  ON public.import_issues (batch_id, status, severity);

CREATE INDEX IF NOT EXISTS import_issues_row_idx
  ON public.import_issues (import_row_id);

CREATE TABLE IF NOT EXISTS public.import_entity_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  import_row_id uuid NOT NULL REFERENCES public.import_rows(id) ON DELETE RESTRICT,
  entity_type text NOT NULL,
  entity_id uuid NOT NULL,
  linked_by uuid NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  linked_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT import_entity_links_type_not_blank CHECK (btrim(entity_type) <> ''),
  UNIQUE (import_row_id, entity_type)
);

CREATE INDEX IF NOT EXISTS import_entity_links_entity_idx
  ON public.import_entity_links (entity_type, entity_id);

-- Extiende la cola existente de duplicados para poder originarse en forms
-- o imports. Nunca se fusiona automáticamente una coincidencia ambigua.
ALTER TABLE public.person_duplicate_candidates
  ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'form',
  ADD COLUMN IF NOT EXISTS import_row_id uuid
    REFERENCES public.import_rows(id) ON DELETE RESTRICT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'person_duplicate_candidates_source_check'
      AND conrelid = 'public.person_duplicate_candidates'::regclass
  ) THEN
    ALTER TABLE public.person_duplicate_candidates
      ADD CONSTRAINT person_duplicate_candidates_source_check
      CHECK (
        (source = 'form' AND submission_id IS NOT NULL AND import_row_id IS NULL)
        OR
        (source = 'import' AND submission_id IS NULL AND import_row_id IS NOT NULL)
      );
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS person_duplicate_candidates_import_row_idx
  ON public.person_duplicate_candidates (import_row_id)
  WHERE import_row_id IS NOT NULL;

-- raw_data, ubicación de la fila y row_hash son procedencia inmutable.
CREATE OR REPLACE FUNCTION public.sutecba_import_rows_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'import_rows no permite DELETE físico';
  END IF;

  IF NEW.file_id IS DISTINCT FROM OLD.file_id
     OR NEW.sheet IS DISTINCT FROM OLD.sheet
     OR NEW.row_number IS DISTINCT FROM OLD.row_number
     OR NEW.raw_data IS DISTINCT FROM OLD.raw_data
     OR NEW.row_hash IS DISTINCT FROM OLD.row_hash THEN
    RAISE EXCEPTION 'No se puede reescribir la procedencia original de import_rows';
  END IF;

  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS import_rows_guard_update ON public.import_rows;
CREATE TRIGGER import_rows_guard_update
BEFORE UPDATE ON public.import_rows
FOR EACH ROW
EXECUTE FUNCTION public.sutecba_import_rows_guard();

DROP TRIGGER IF EXISTS import_rows_no_delete ON public.import_rows;
CREATE TRIGGER import_rows_no_delete
BEFORE DELETE ON public.import_rows
FOR EACH ROW
EXECUTE FUNCTION public.sutecba_import_rows_guard();

DROP TRIGGER IF EXISTS import_files_no_delete ON public.import_files;
CREATE TRIGGER import_files_no_delete
BEFORE DELETE ON public.import_files
FOR EACH ROW
EXECUTE FUNCTION public.sutecba_block_delete();

DROP TRIGGER IF EXISTS import_batches_no_delete ON public.import_batches;
CREATE TRIGGER import_batches_no_delete
BEFORE DELETE ON public.import_batches
FOR EACH ROW
EXECUTE FUNCTION public.sutecba_block_delete();

DROP TRIGGER IF EXISTS import_batch_files_no_delete ON public.import_batch_files;
CREATE TRIGGER import_batch_files_no_delete
BEFORE DELETE ON public.import_batch_files
FOR EACH ROW
EXECUTE FUNCTION public.sutecba_block_delete();

DROP TRIGGER IF EXISTS import_entity_links_no_delete ON public.import_entity_links;
CREATE TRIGGER import_entity_links_no_delete
BEFORE DELETE ON public.import_entity_links
FOR EACH ROW
EXECUTE FUNCTION public.sutecba_block_delete();

DROP TRIGGER IF EXISTS import_issues_no_delete ON public.import_issues;
CREATE TRIGGER import_issues_no_delete
BEFORE DELETE ON public.import_issues
FOR EACH ROW
EXECUTE FUNCTION public.sutecba_block_delete();

COMMIT;

-- VERIFICACIÓN (ejecutar aparte):
-- SELECT table_name FROM information_schema.tables
-- WHERE table_schema='public' AND table_name LIKE 'import_%'
-- ORDER BY table_name;
-- SELECT indexname,indexdef FROM pg_indexes
-- WHERE schemaname='public' AND tablename='import_files';
--
-- ROLLBACK CONSERVADOR:
-- Cancelar lotes y conservar archivos/filas/procedencia. No usar DROP.
