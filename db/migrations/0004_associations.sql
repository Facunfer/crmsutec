-- Asociaciones = estructura interna del sindicato (delegados, comisiones,
-- agrupaciones) modelada como catálogo de tipos configurable, no un enum
-- fijo (sección 4 del prompt).

create table association_types (
  id uuid primary key default gen_random_uuid(),
  key text not null unique,
  name text not null,
  active boolean not null default true
);

create table associations (
  id uuid primary key default gen_random_uuid(),
  type_id uuid not null references association_types (id) on delete restrict,
  name text not null,
  description text,
  status text not null default 'active' check (status in ('active', 'inactive')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references users (id) on delete restrict
);

create index associations_type_id_idx on associations (type_id);

create table association_managers (
  id uuid primary key default gen_random_uuid(),
  association_id uuid not null references associations (id) on delete restrict,
  user_id uuid references users (id) on delete restrict,
  person_id uuid references people (id) on delete restrict,
  created_at timestamptz not null default now(),
  constraint association_managers_user_or_person check (
    user_id is not null or person_id is not null
  )
);

create index association_managers_association_id_idx on association_managers (association_id);

-- N:M persona-asociación con historial: se permite más de una fila por par
-- a lo largo del tiempo (altas y bajas), pero solo una activa a la vez.
create table people_associations (
  id uuid primary key default gen_random_uuid(),
  person_id uuid not null references people (id) on delete restrict,
  association_id uuid not null references associations (id) on delete restrict,
  role text,
  status text not null default 'active' check (status in ('active', 'inactive')),
  added_at timestamptz not null default now(),
  added_by uuid references users (id) on delete restrict,
  removed_at timestamptz,
  removed_by uuid references users (id) on delete restrict
);

create unique index people_associations_active_unique_idx
  on people_associations (person_id, association_id)
  where status = 'active';
create index people_associations_person_id_idx on people_associations (person_id);
create index people_associations_association_id_idx on people_associations (association_id);
