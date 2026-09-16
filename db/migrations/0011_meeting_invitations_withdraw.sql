-- "Quitar invitado" nunca borra la fila (R8: nada de trazabilidad se borra
-- físicamente) — se marca. Re-invitar a alguien retirado revive la misma
-- fila (ver lib/meetings/invitations.ts) en vez de violar el UNIQUE
-- (meeting_id, person_id).
alter table meeting_invitations
  add column withdrawn_at timestamptz,
  add column withdrawn_by uuid references users (id) on delete restrict;
