BEGIN;

-- 0017 — Interacciones de personas y asociaciones.
-- owner_organization_id queda fijo: un traslado posterior de la persona
-- NO mueve ni expone automáticamente interacciones históricas.

CREATE TABLE IF NOT EXISTS public.interaction_types (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key text NOT NULL UNIQUE,
  name text NOT NULL,
  active boolean NOT NULL DEFAULT true,
  sort_order integer NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS public.interaction_channels (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key text NOT NULL UNIQUE,
  name text NOT NULL,
  active boolean NOT NULL DEFAULT true,
  sort_order integer NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS public.person_interactions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  person_id uuid NOT NULL REFERENCES public.people(id) ON DELETE RESTRICT,
  owner_organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  occurred_at timestamptz NOT NULL,
  interaction_type_id uuid NOT NULL REFERENCES public.interaction_types(id) ON DELETE RESTRICT,
  channel_id uuid REFERENCES public.interaction_channels(id) ON DELETE RESTRICT,
  subject text NOT NULL,
  description text,
  status text NOT NULL DEFAULT 'open'
    CHECK (status IN ('open','completed','cancelled','voided')),
  outcome text,
  responsible_user_id uuid REFERENCES public.users(id) ON DELETE RESTRICT,
  next_follow_up_at timestamptz,
  meeting_id uuid REFERENCES public.meetings(id) ON DELETE RESTRICT,
  void_reason text,
  created_by uuid NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1,
  CONSTRAINT person_interactions_subject_not_blank CHECK (btrim(subject) <> ''),
  CONSTRAINT person_interactions_void_reason_check CHECK (
    status <> 'voided' OR (void_reason IS NOT NULL AND btrim(void_reason) <> '')
  )
);

CREATE TABLE IF NOT EXISTS public.association_interactions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  association_id uuid NOT NULL REFERENCES public.associations(id) ON DELETE RESTRICT,
  contact_person_id uuid REFERENCES public.people(id) ON DELETE RESTRICT,
  owner_organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  occurred_at timestamptz NOT NULL,
  interaction_type_id uuid NOT NULL REFERENCES public.interaction_types(id) ON DELETE RESTRICT,
  channel_id uuid REFERENCES public.interaction_channels(id) ON DELETE RESTRICT,
  subject text NOT NULL,
  description text,
  status text NOT NULL DEFAULT 'open'
    CHECK (status IN ('open','completed','cancelled','voided')),
  outcome text,
  responsible_user_id uuid REFERENCES public.users(id) ON DELETE RESTRICT,
  next_follow_up_at timestamptz,
  meeting_id uuid REFERENCES public.meetings(id) ON DELETE RESTRICT,
  void_reason text,
  created_by uuid NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1,
  CONSTRAINT association_interactions_subject_not_blank CHECK (btrim(subject) <> ''),
  CONSTRAINT association_interactions_void_reason_check CHECK (
    status <> 'voided' OR (void_reason IS NOT NULL AND btrim(void_reason) <> '')
  )
);

CREATE INDEX IF NOT EXISTS person_interactions_person_date_idx
  ON public.person_interactions (person_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS person_interactions_owner_idx
  ON public.person_interactions (owner_organization_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS person_interactions_followup_idx
  ON public.person_interactions (next_follow_up_at)
  WHERE next_follow_up_at IS NOT NULL AND status = 'open';
CREATE INDEX IF NOT EXISTS person_interactions_responsible_idx
  ON public.person_interactions (responsible_user_id, occurred_at DESC)
  WHERE responsible_user_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS association_interactions_association_date_idx
  ON public.association_interactions (association_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS association_interactions_owner_idx
  ON public.association_interactions (owner_organization_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS association_interactions_followup_idx
  ON public.association_interactions (next_follow_up_at)
  WHERE next_follow_up_at IS NOT NULL AND status = 'open';
CREATE INDEX IF NOT EXISTS association_interactions_responsible_idx
  ON public.association_interactions (responsible_user_id, occurred_at DESC)
  WHERE responsible_user_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.interaction_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  person_interaction_id uuid NOT NULL REFERENCES public.person_interactions(id) ON DELETE RESTRICT,
  association_interaction_id uuid NOT NULL REFERENCES public.association_interactions(id) ON DELETE RESTRICT,
  created_by uuid NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (person_interaction_id),
  UNIQUE (association_interaction_id)
);

DROP TRIGGER IF EXISTS person_interactions_no_delete ON public.person_interactions;
CREATE TRIGGER person_interactions_no_delete
BEFORE DELETE ON public.person_interactions
FOR EACH ROW
EXECUTE FUNCTION public.sutecba_block_delete();

DROP TRIGGER IF EXISTS association_interactions_no_delete ON public.association_interactions;
CREATE TRIGGER association_interactions_no_delete
BEFORE DELETE ON public.association_interactions
FOR EACH ROW
EXECUTE FUNCTION public.sutecba_block_delete();

DROP TRIGGER IF EXISTS interaction_links_no_delete ON public.interaction_links;
CREATE TRIGGER interaction_links_no_delete
BEFORE DELETE ON public.interaction_links
FOR EACH ROW
EXECUTE FUNCTION public.sutecba_block_delete();

COMMIT;

-- VERIFICACIÓN (ejecutar aparte):
-- SELECT table_name FROM information_schema.tables
-- WHERE table_schema='public'
--   AND table_name IN ('interaction_types','interaction_channels',
--                      'person_interactions','association_interactions','interaction_links');
--
-- ROLLBACK CONSERVADOR:
-- No borrar interacciones. Anular con status='voided' y void_reason.
