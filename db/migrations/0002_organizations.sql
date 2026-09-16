-- Catálogo jerárquico de organismos (decisión D8): SUTECBA representa
-- personal de los tres poderes, entes autárquicos, Legislatura, entes
-- públicos no estatales y jubilados/pensionados, no solo "ministerios".
-- La UI puede seguir mostrando "Ministerio"/"Dependencia" como etiquetas
-- de los niveles más comunes sin que el modelo los fije como únicos.

create table organization_types (
  id uuid primary key default gen_random_uuid(),
  key text not null unique,
  name text not null,
  level integer not null,
  active boolean not null default true
);

create table organizations (
  id uuid primary key default gen_random_uuid(),
  type_id uuid not null references organization_types (id) on delete restrict,
  parent_id uuid references organizations (id) on delete restrict,
  name text not null,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index organizations_type_id_idx on organizations (type_id);
create index organizations_parent_id_idx on organizations (parent_id);
