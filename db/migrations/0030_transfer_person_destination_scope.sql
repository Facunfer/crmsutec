BEGIN;

-- 0030 — `transfer_person`: exige alcance también sobre la repartición DESTINO (no solo origen).
--
-- Hasta ahora `transfer_person` (migración 0015) solo validaba que el actor tuviera alcance sobre la repartición de
-- ORIGEN de la persona; el destino podía ser cualquier organización activa, sin importar el alcance del actor
-- (comentado explícitamente en lib/people/transfers.ts: "El destino puede ser cualquier unidad activa"). Decisión de
-- negocio 2026-09-24: un usuario no global solo puede trasladar personas cuyo origen Y destino estén dentro de sus
-- alcances autorizados. Si necesita trasladar a alguien fuera de su alcance, debe intervenir Master Global (que sigue
-- exento, igual que en el resto del sistema). Esto es SOLO la capa de base: lib/people/transfers.ts agrega la misma
-- validación en la app para un mensaje de error más claro antes de tocar la base.
--
-- No se toca `assign_initial_organization`: ya exigía alcance sobre el destino (es la única organización que aplica
-- en una asignación inicial, no hay "origen").

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

    -- NUEVO (0030): el destino también debe estar dentro del alcance del actor.
    IF NOT EXISTS (
      SELECT 1
      FROM public.user_accessible_organizations(p_actor_user_id) a
      WHERE a.organization_id = p_to_organization_id
    ) THEN
      RAISE EXCEPTION 'El actor no tiene alcance sobre la repartición destino';
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

COMMIT;
