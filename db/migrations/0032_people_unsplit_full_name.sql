BEGIN;

-- 0032 — Personas con nombre completo original y sin separación confiable nombre/apellido.
--
-- Hay fuentes (padrón de abogados, formulario Antigripal) donde «Apellido y Nombre» viene en una sola celda y no se puede
-- separar de forma confiable (apellidos y nombres compuestos). En vez de inventar un texto ("(sin separar)"), inferir por
-- heurística o bloquear, la persona se guarda con el valor ORIGINAL íntegro:
--   · name_split_status = 'unsplit'
--   · full_name_original = texto exacto de la fuente
--   · last_name = ese mismo texto (así búsqueda, listados, orden alfabético y exportación siguen funcionando sin cambios)
--   · first_name = '' (ausencia real, no un valor ficticio)
-- Cuando alguien la edite y cargue nombre y apellido por separado, pasa a 'split' y full_name_original se conserva como
-- procedencia. Las 2.195 personas actuales quedan 'split' (no se modifica ninguna).

ALTER TABLE public.people
  ADD COLUMN IF NOT EXISTS name_split_status text NOT NULL DEFAULT 'split',
  ADD COLUMN IF NOT EXISTS full_name_original text;

ALTER TABLE public.people
  ADD CONSTRAINT people_name_split_status_check CHECK (name_split_status IN ('split', 'unsplit'));

ALTER TABLE public.people
  ADD CONSTRAINT people_name_split_consistency_check
  CHECK (
    (name_split_status = 'split' AND btrim(first_name) <> '' AND btrim(last_name) <> '')
    OR
    (name_split_status = 'unsplit'
      AND first_name = ''
      AND full_name_original IS NOT NULL AND btrim(full_name_original) <> ''
      AND last_name = full_name_original)
  );

COMMENT ON COLUMN public.people.full_name_original IS
  'Nombre completo tal cual figura en la fuente cuando no se pudo separar de forma confiable (name_split_status=unsplit). Dato personal.';

COMMIT;
