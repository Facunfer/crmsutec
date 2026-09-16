-- Rate limit genérico para endpoints públicos basados en token (respuesta
-- de invitación ahora, check-in por QR en la Etapa 7). En tabla, no en
-- memoria de proceso (mismo motivo que login_attempts, D4/D13).
create table public_link_attempts (
  id uuid primary key default gen_random_uuid(),
  scope text not null,
  identifier text not null,
  ip_address inet not null,
  succeeded boolean not null,
  created_at timestamptz not null default now()
);

create index public_link_attempts_scope_identifier_idx
  on public_link_attempts (scope, identifier, created_at);
create index public_link_attempts_ip_idx on public_link_attempts (ip_address, created_at);
