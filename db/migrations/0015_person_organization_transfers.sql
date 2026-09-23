BEGIN;

-- 0015 — Historial de repartición de personas.
-- from_organization_id es NULL solamente para la asignación inicial.

CREATE TABLE IF NOT EXISTS public.person_organization_transfers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  person_id uuid NOT NULL REFERENCES public.people(id) ON DELETE RESTRICT,
  from_organization_id uuid REFERENCES public.organizations(id) ON DELETE RESTRICT,
  to_organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  reason text NOT NULL,
  transferred_by uuid NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  transferred_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT person_org_transfer_reason_not_blank CHECK (btrim(reason) <> ''),
  CONSTRAINT person_org_transfer_different_orgs CHECK (
    from_organization_id IS NULL OR from_organization_id <> to_organization_id
  )
);

CREATE INDEX IF NOT EXISTS person_org_transfers_person_idx
  ON public.person_organization_transfers (person_id, transferred_at DESC);

CREATE INDEX IF NOT EXISTS person_org_transfers_from_idx
  ON public.person_organization_transfers (from_organization_id, transferred_at DESC)
  WHERE from_organization_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS person_org_transfers_to_idx
  ON public.person_organization_transfers (to_organization_id, transferred_at DESC);

CREATE OR REPLACE FUNCTION public.sutecba_person_org_transfers_append_only()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  RAISE EXCEPTION 'person_organization_transfers es append-only: % no permitido', TG_OP;
END;
$$;

DROP TRIGGER IF EXISTS person_org_transfers_no_update ON public.person_organization_transfers;
CREATE TRIGGER person_org_transfers_no_update
BEFORE UPDATE ON public.person_organization_transfers
FOR EACH ROW
EXECUTE FUNCTION public.sutecba_person_org_transfers_append_only();

DROP TRIGGER IF EXISTS person_org_transfers_no_delete ON public.person_organization_transfers;
CREATE TRIGGER person_org_transfers_no_delete
BEFORE DELETE ON public.person_organization_transfers
FOR EACH ROW
EXECUTE FUNCTION public.sutecba_person_org_transfers_append_only();

CREATE OR REPLACE FUNCTION public.transfer_person(
  p_person_id uuid,
  p_to_organization_id uuid,
  p_reason text,
  p_actor_user_id uuid
)
RETURNS public.person_organization_transfers
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_person public.people%ROWTYPE;
  v_event public.person_organization_transfers%ROWTYPE;
  v_actor_role text;
BEGIN
  IF p_reason IS NULL OR btrim(p_reason) = '' THEN
    RAISE EXCEPTION 'El motivo del traslado es obligatorio';
  END IF;

  SELECT p.* INTO v_person
  FROM public.people p
  WHERE p.id = p_person_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Persona inexistente';
  END IF;

  IF v_person.status = 'merged' THEN
    RAISE EXCEPTION 'No se puede trasladar una persona fusionada';
  END IF;

  IF v_person.organization_id IS NULL THEN
    RAISE EXCEPTION 'La persona no tiene repartición inicial; usar assign_initial_organization';
  END IF;

  IF v_person.organization_id = p_to_organization_id THEN
    RAISE EXCEPTION 'La repartición destino coincide con la actual';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.organizations o
    WHERE o.id = p_to_organization_id AND o.active = true
  ) THEN
    RAISE EXCEPTION 'La repartición destino no existe o está inactiva';
  END IF;

  SELECT r.key INTO v_actor_role
  FROM public.users u
  JOIN public.roles r ON r.id = u.role_id
  WHERE u.id = p_actor_user_id AND u.status = 'active';

  IF v_actor_role IS NULL THEN
    RAISE EXCEPTION 'Actor inexistente o inactivo';
  END IF;

  IF v_actor_role <> 'MASTER_GLOBAL' THEN
    IF NOT public.user_has_permission(p_actor_user_id, 'people.transfer') THEN
      RAISE EXCEPTION 'El actor no tiene people.transfer';
    END IF;

    IF NOT EXISTS (
      SELECT 1
      FROM public.user_accessible_organizations(p_actor_user_id) a
      WHERE a.organization_id = v_person.organization_id
    ) THEN
      RAISE EXCEPTION 'El actor no tiene alcance sobre la repartición de origen';
    END IF;
  END IF;

  UPDATE public.people
  SET organization_id = p_to_organization_id,
      version = version + 1,
      updated_at = now(),
      updated_by = p_actor_user_id
  WHERE id = p_person_id;

  INSERT INTO public.person_organization_transfers (
    person_id,
    from_organization_id,
    to_organization_id,
    reason,
    transferred_by
  )
  VALUES (
    p_person_id,
    v_person.organization_id,
    p_to_organization_id,
    btrim(p_reason),
    p_actor_user_id
  )
  RETURNING * INTO v_event;

  RETURN v_event;
END;
$$;

CREATE OR REPLACE FUNCTION public.assign_initial_organization(
  p_person_id uuid,
  p_organization_id uuid,
  p_actor_user_id uuid
)
RETURNS public.person_organization_transfers
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_person public.people%ROWTYPE;
  v_event public.person_organization_transfers%ROWTYPE;
  v_actor_role text;
BEGIN
  SELECT p.* INTO v_person
  FROM public.people p
  WHERE p.id = p_person_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Persona inexistente';
  END IF;

  IF v_person.status = 'merged' THEN
    RAISE EXCEPTION 'No se puede asignar repartición a una persona fusionada';
  END IF;

  IF v_person.organization_id IS NOT NULL THEN
    RAISE EXCEPTION 'La persona ya tiene repartición; usar transfer_person';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.organizations o
    WHERE o.id = p_organization_id AND o.active = true
  ) THEN
    RAISE EXCEPTION 'La repartición destino no existe o está inactiva';
  END IF;

  SELECT r.key INTO v_actor_role
  FROM public.users u
  JOIN public.roles r ON r.id = u.role_id
  WHERE u.id = p_actor_user_id AND u.status = 'active';

  IF v_actor_role IS NULL THEN
    RAISE EXCEPTION 'Actor inexistente o inactivo';
  END IF;

  IF v_actor_role <> 'MASTER_GLOBAL' THEN
    IF NOT public.user_has_permission(p_actor_user_id, 'people.assign_organization') THEN
      RAISE EXCEPTION 'El actor no tiene people.assign_organization';
    END IF;

    IF NOT EXISTS (
      SELECT 1
      FROM public.user_accessible_organizations(p_actor_user_id) a
      WHERE a.organization_id = p_organization_id
    ) THEN
      RAISE EXCEPTION 'El actor no tiene alcance sobre la repartición a asignar';
    END IF;
  END IF;

  UPDATE public.people
  SET organization_id = p_organization_id,
      version = version + 1,
      updated_at = now(),
      updated_by = p_actor_user_id
  WHERE id = p_person_id;

  INSERT INTO public.person_organization_transfers (
    person_id,
    from_organization_id,
    to_organization_id,
    reason,
    transferred_by
  )
  VALUES (
    p_person_id,
    NULL,
    p_organization_id,
    'Asignación inicial de repartición',
    p_actor_user_id
  )
  RETURNING * INTO v_event;

  RETURN v_event;
END;
$$;

COMMIT;

-- VERIFICACIÓN (ejecutar aparte):
-- SELECT * FROM information_schema.tables
-- WHERE table_schema='public' AND table_name='person_organization_transfers';
-- SELECT proname FROM pg_proc
-- WHERE proname IN ('transfer_person','assign_initial_organization');
--
-- ROLLBACK CONSERVADOR:
-- El historial no se borra ni se edita. Para retirar la funcionalidad,
-- revocar EXECUTE sobre las funciones mediante una migración forward.
