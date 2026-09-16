-- Formularios públicos. form_versions guarda un snapshot inmutable del
-- esquema en cada publicación para que editar un formulario publicado no
-- cambie cómo se interpretan las respuestas ya recibidas.

create table forms (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  name text not null,
  status text not null default 'draft' check (
    status in ('draft', 'published', 'unpublished', 'archived')
  ),
  success_message text,
  consent_text text,
  opens_at timestamptz,
  closes_at timestamptz,
  identification_policy jsonb not null default '{}'::jsonb,
  update_policy text not null default 'fill_empty_only' check (
    update_policy in ('fill_empty_only', 'always_flag_for_review')
  ),
  published_version integer,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references users (id) on delete restrict
);

create table form_versions (
  id uuid primary key default gen_random_uuid(),
  form_id uuid not null references forms (id) on delete restrict,
  version integer not null,
  schema jsonb not null,
  created_at timestamptz not null default now(),
  unique (form_id, version)
);

create table form_fields (
  id uuid primary key default gen_random_uuid(),
  form_id uuid not null references forms (id) on delete restrict,
  key text not null,
  label text not null,
  field_type text not null check (
    field_type in (
      'text', 'textarea', 'dni', 'phone', 'email', 'number', 'date',
      'select', 'radio', 'checkbox', 'association'
    )
  ),
  options jsonb,
  required boolean not null default false,
  visible boolean not null default true,
  sort_order integer not null default 0,
  -- mapea a person_field_definitions.key o a un campo núcleo de people
  person_field_mapping text,
  unique (form_id, key)
);

create table form_actions (
  id uuid primary key default gen_random_uuid(),
  form_id uuid not null references forms (id) on delete restrict,
  action_type text not null check (action_type in ('add_to_association')),
  config jsonb not null,
  sort_order integer not null default 0
);

create table form_submissions (
  id uuid primary key default gen_random_uuid(),
  form_id uuid not null references forms (id) on delete restrict,
  form_version integer not null,
  -- payload original, inmutable: se guarda antes de cualquier otro paso.
  raw_payload jsonb not null,
  normalized_values jsonb not null default '{}'::jsonb,
  match_result text not null default 'pending' check (
    match_result in ('pending', 'created', 'matched', 'needs_review', 'error')
  ),
  person_id uuid references people (id) on delete restrict,
  idempotency_key text not null unique,
  ip_address inet,
  user_agent text,
  error_message text,
  created_at timestamptz not null default now(),
  processed_at timestamptz
);

create index form_submissions_form_id_idx on form_submissions (form_id);

create table person_duplicate_candidates (
  id uuid primary key default gen_random_uuid(),
  person_id uuid references people (id) on delete restrict,
  submission_id uuid references form_submissions (id) on delete restrict,
  match_reason text not null,
  status text not null default 'pending' check (
    status in ('pending', 'linked', 'created_new', 'discarded')
  ),
  resolved_by uuid references users (id) on delete restrict,
  resolved_at timestamptz,
  created_at timestamptz not null default now()
);

create index person_duplicate_candidates_status_idx on person_duplicate_candidates (status);
