BEGIN;

SET LOCAL lock_timeout = '10s';

-- 0048 — Actividades unificadas, paso 1a: inscripción automática desde formularios y permisos de creación para REUNIONES.
-- ADITIVA e idempotente. Sin backfill ni cambios de filas existentes (producción tiene 1 formulario sin publicar y 0 envíos).
--
--  1. `forms.enrollment_mode`: qué hace un envío vinculado con la inscripción. «never» (por defecto) conserva el comportamiento
--     anterior: completar un formulario NO inscribe. Los demás modos inscriben, con las reglas de B4 (`enrollPerson`), SOLO si la
--     persona quedó vinculada sin ambigüedad:
--       · single_meeting   → el formulario tiene `meeting_id` (reunión de un día): inscribe en esa reunión.
--       · campaign_all     → el formulario tiene `campaign_id` (y no `meeting_id`): inscribe en todas las jornadas de la campaña.
--       · campaign_selected→ idem, pero solo en las jornadas que la persona eligió en el formulario.
--     El modo debe ser coherente con el destino del formulario (CHECK `forms_enrollment_target_check`).
--
--  2. `form_submission_events`: nuevo tipo `auto_enrolled` (acto del sistema al procesar el envío: `recorded_by` NULL, como el resto de los
--     `auto_*`). Referencia la fila canónica de `meeting_participations` (misma regla que `enrolled`: exige reunión y participación).
--     Idempotencia: una respuesta origina, como máximo, UNA inscripción por reunión, sea automática o manual (índice único que cubre
--     `enrolled` y `auto_enrolled`).
--
--  3. REUNIONES gana `meetings.create` y `meetings.edit` (el catálogo en lib/permissions/catalog.ts es la fuente; el seed converge al
--     mismo estado). Hoy no existe ningún usuario con ese rol. Crear sigue acotado por el alcance de unidades de cada usuario.
--
--  4. Usuario de sistema «Sistema (formularios)»: autor de las inscripciones automáticas. En `meeting_participations` y en
--     `meeting_registration_events` una inscripción operativa exige un usuario (`recorded_by`), y «sin usuario» significa histórica o
--     importada; una respuesta pública no tiene usuario. En vez de aflojar esas reglas (que protegen la trazabilidad), el acto se
--     atribuye a este usuario: INACTIVO (no puede iniciar sesión), contraseña imposible, rol LECTURA y sin alcances. El evento
--     `auto_enrolled` de la respuesta sigue con `recorded_by` NULL (acto del sistema), como el resto de los `auto_*`.
--
-- Rollback (solo después de volver al código anterior): DELETE de los dos permisos de REUNIONES; DROP del índice y de los CHECK nuevos;
-- restituir el CHECK de event_type sin `auto_enrolled`; ALTER TABLE forms DROP COLUMN enrollment_mode. El código anterior ignora todo esto.

-- ---------------------------------------------------------------- 1. forms.enrollment_mode
ALTER TABLE public.forms
  ADD COLUMN IF NOT EXISTS enrollment_mode text NOT NULL DEFAULT 'never';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.forms'::regclass AND conname = 'forms_enrollment_mode_check') THEN
    ALTER TABLE public.forms ADD CONSTRAINT forms_enrollment_mode_check
      CHECK (enrollment_mode IN ('never', 'single_meeting', 'campaign_all', 'campaign_selected'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.forms'::regclass AND conname = 'forms_enrollment_target_check') THEN
    ALTER TABLE public.forms ADD CONSTRAINT forms_enrollment_target_check
      CHECK (
        enrollment_mode = 'never'
        OR (enrollment_mode = 'single_meeting' AND meeting_id IS NOT NULL)
        OR (enrollment_mode IN ('campaign_all', 'campaign_selected') AND campaign_id IS NOT NULL AND meeting_id IS NULL)
      );
  END IF;
END $$;

COMMENT ON COLUMN public.forms.enrollment_mode IS
  'never (default) | single_meeting | campaign_all | campaign_selected: si un envío vinculado sin ambigüedad inscribe a la persona (0048).';

-- ---------------------------------------------------------------- 2. form_submission_events: auto_enrolled
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.form_submission_events'::regclass AND conname = 'form_submission_events_type_check'
             AND pg_get_constraintdef(oid) NOT LIKE '%auto_enrolled%') THEN
    ALTER TABLE public.form_submission_events DROP CONSTRAINT form_submission_events_type_check;
    ALTER TABLE public.form_submission_events ADD CONSTRAINT form_submission_events_type_check
      CHECK (event_type IN ('auto_linked', 'auto_person_created', 'auto_data_applied', 'auto_enrolled', 'linked', 'person_created', 'data_applied', 'enrolled'));
  END IF;
  -- Misma regla que `enrolled`: la inscripción referencia reunión y participación. Se reemplaza para que cubra también `auto_enrolled`.
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.form_submission_events'::regclass AND conname = 'form_submission_events_enrolled_check'
             AND pg_get_constraintdef(oid) NOT LIKE '%auto_enrolled%') THEN
    ALTER TABLE public.form_submission_events DROP CONSTRAINT form_submission_events_enrolled_check;
    ALTER TABLE public.form_submission_events ADD CONSTRAINT form_submission_events_enrolled_check
      CHECK (event_type NOT IN ('enrolled', 'auto_enrolled') OR (meeting_id IS NOT NULL AND participation_id IS NOT NULL));
  END IF;
END $$;

-- Una respuesta origina, como máximo, una inscripción por reunión (automática o manual). El índice de 0043 (solo `enrolled`) se conserva.
CREATE UNIQUE INDEX IF NOT EXISTS form_submission_events_any_enrolled_unique_idx
  ON public.form_submission_events (submission_id, meeting_id)
  WHERE event_type IN ('enrolled', 'auto_enrolled');

-- ---------------------------------------------------------------- 3. REUNIONES: crear y editar reuniones
INSERT INTO public.role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM public.roles r
JOIN public.permissions p ON p.key IN ('meetings.create', 'meetings.edit')
WHERE r.key = 'REUNIONES'
ON CONFLICT (role_id, permission_id) DO NOTHING;

-- ---------------------------------------------------------------- 4. Usuario de sistema (autor de las inscripciones automáticas)
-- password_hash no es un hash bcrypt válido: ninguna contraseña lo verifica. status 'inactive': el login lo rechaza igual.
INSERT INTO public.users (email, password_hash, full_name, role_id, status, must_change_password)
SELECT 'sistema.formularios@sutecba.local', '!sin-acceso', 'Sistema (formularios)', r.id, 'inactive', true
FROM public.roles r
WHERE r.key = 'LECTURA'
  AND NOT EXISTS (SELECT 1 FROM public.users u WHERE lower(u.email) = 'sistema.formularios@sutecba.local');

COMMIT;
