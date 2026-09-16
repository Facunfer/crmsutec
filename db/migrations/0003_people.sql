-- Personas. DNI único parcial (se excluye cuando la persona fue fusionada,
-- decisión D6/D7 de SUTECBA_ARCHITECTURE.md). Nunca se borra físicamente
-- (R8): el estado 'merged' reemplaza al borrado en caso de deduplicación.

create table people (
  id uuid primary key default gen_random_uuid(),
  first_name text not null,
  last_name text not null,
  dni text,
  email text,
  phone text,
  organization_id uuid references organizations (id) on delete restrict,
  -- Edad (decisión D7): se guarda la fecha de nacimiento y se calcula, o si
  -- solo se declaró una edad, se guarda junto con la fecha de declaración
  -- para poder estimarla más adelante sin que quede un número congelado.
  birth_date date,
  declared_age integer,
  declared_age_at date,
  status text not null default 'active' check (status in ('active', 'inactive', 'merged')),
  merged_into_id uuid references people (id) on delete restrict,
  custom_fields jsonb not null default '{}'::jsonb,
  origin text not null default 'manual' check (origin in ('manual', 'import', 'form')),
  version integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references users (id) on delete restrict,
  updated_by uuid references users (id) on delete restrict
);

create unique index people_dni_unique_idx on people (dni) where dni is not null and status <> 'merged';
create index people_email_idx on people (lower(email)) where email is not null;
create index people_phone_idx on people (phone) where phone is not null;
create index people_organization_id_idx on people (organization_id);
create index people_custom_fields_gin_idx on people using gin (custom_fields);

create table person_field_definitions (
  id uuid primary key default gen_random_uuid(),
  key text not null unique,
  label text not null,
  -- registro de tipos compartido con el constructor de formularios (Etapa 8)
  field_type text not null check (
    field_type in (
      'text', 'textarea', 'dni', 'phone', 'email', 'number', 'date',
      'select', 'radio', 'checkbox', 'association'
    )
  ),
  options jsonb,
  required boolean not null default false,
  active boolean not null default true,
  sensitive boolean not null default false,
  sort_order integer not null default 0,
  created_at timestamptz not null default now()
);
