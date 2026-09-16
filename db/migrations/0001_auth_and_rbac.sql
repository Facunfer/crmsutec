-- Autenticación y RBAC. FKs hacia users siempre RESTRICT (regla R8: nunca
-- SET NULL/CASCADE hacia entidades con historial). roles/permissions son
-- catálogo de configuración, no trazabilidad: cascade ahí es seguro.

create table roles (
  id uuid primary key default gen_random_uuid(),
  key text not null unique,
  name text not null,
  is_system boolean not null default true,
  created_at timestamptz not null default now()
);

create table permissions (
  id uuid primary key default gen_random_uuid(),
  key text not null unique,
  description text not null,
  created_at timestamptz not null default now()
);

create table role_permissions (
  role_id uuid not null references roles (id) on delete cascade,
  permission_id uuid not null references permissions (id) on delete cascade,
  primary key (role_id, permission_id)
);

create table users (
  id uuid primary key default gen_random_uuid(),
  email text not null,
  password_hash text not null,
  must_change_password boolean not null default false,
  full_name text not null,
  role_id uuid not null references roles (id) on delete restrict,
  status text not null default 'active' check (status in ('active', 'inactive')),
  -- se incrementa al cambiar rol/estado/contraseña; toda sesión con una
  -- versión distinta a la actual queda inválida en el próximo request.
  permissions_version integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references users (id) on delete restrict,
  updated_by uuid references users (id) on delete restrict
);

create unique index users_email_unique_idx on users (lower(email));

create table sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users (id) on delete restrict,
  token_hash text not null unique,
  permissions_version_snapshot integer not null,
  ip_address inet,
  user_agent text,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  revoked_at timestamptz
);

create index sessions_user_id_idx on sessions (user_id);
create index sessions_expires_at_idx on sessions (expires_at);

create table login_attempts (
  id uuid primary key default gen_random_uuid(),
  identifier text not null,
  ip_address inet not null,
  succeeded boolean not null,
  created_at timestamptz not null default now()
);

create index login_attempts_identifier_idx on login_attempts (identifier, created_at);
create index login_attempts_ip_idx on login_attempts (ip_address, created_at);
