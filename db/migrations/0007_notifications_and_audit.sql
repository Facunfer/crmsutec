-- Notificaciones desacopladas (D14): en el MVP solo existe el canal
-- 'manual_link', esta tabla es el punto de extensión para proveedores
-- reales sin tocar el resto del sistema.
create table notification_outbox (
  id uuid primary key default gen_random_uuid(),
  channel text not null check (channel in ('manual_link', 'email', 'whatsapp', 'sms')),
  recipient text not null,
  payload jsonb not null,
  status text not null default 'pending' check (
    status in ('pending', 'sent', 'failed', 'not_applicable')
  ),
  related_entity_type text,
  related_entity_id uuid,
  created_at timestamptz not null default now(),
  sent_at timestamptz
);

-- Auditoría: append-only de verdad, no solo por convención de código.
-- Cualquier UPDATE/DELETE directo contra esta tabla revienta.
create table audit_logs (
  id uuid primary key default gen_random_uuid(),
  actor_user_id uuid references users (id) on delete restrict,
  actor_type text not null default 'user' check (actor_type in ('user', 'public', 'system')),
  action text not null,
  entity_type text not null,
  entity_id uuid,
  before jsonb,
  after jsonb,
  metadata jsonb,
  created_at timestamptz not null default now()
);

create index audit_logs_entity_idx on audit_logs (entity_type, entity_id);
create index audit_logs_actor_idx on audit_logs (actor_user_id);
create index audit_logs_created_at_idx on audit_logs (created_at);

create function sutecba_audit_logs_no_mutation() returns trigger as $$
begin
  raise exception 'audit_logs es append-only: % no permitido', TG_OP;
end;
$$ language plpgsql;

create trigger audit_logs_no_update
  before update on audit_logs
  for each row execute function sutecba_audit_logs_no_mutation();

create trigger audit_logs_no_delete
  before delete on audit_logs
  for each row execute function sutecba_audit_logs_no_mutation();
