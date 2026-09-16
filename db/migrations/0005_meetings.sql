-- Reuniones, invitaciones (dos dimensiones: respuesta + asistencia, D9) y
-- asistencia. El QR (D11) guarda su configuración en la propia reunión.

create table meetings (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  description text,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  location_name text,
  address text,
  organizer_user_id uuid references users (id) on delete restrict,
  status text not null default 'draft' check (
    status in ('draft', 'scheduled', 'in_progress', 'finished', 'cancelled', 'overdue_unclosed')
  ),
  qr_mode text not null default 'rotating' check (qr_mode in ('static', 'rotating')),
  qr_secret_version integer not null default 1,
  checkin_tolerance_before_minutes integer not null default 30,
  checkin_tolerance_after_minutes integer not null default 60,
  allow_uninvited_checkin boolean not null default false,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references users (id) on delete restrict,
  constraint meetings_ends_after_starts check (ends_at > starts_at)
);

create index meetings_status_starts_at_idx on meetings (status, starts_at);

create table meeting_associations (
  meeting_id uuid not null references meetings (id) on delete restrict,
  association_id uuid not null references associations (id) on delete restrict,
  primary key (meeting_id, association_id)
);

-- Registra con qué criterios se generó cada tanda de invitaciones, para
-- poder explicar después "por qué esta persona fue invitada".
create table meeting_invitation_batches (
  id uuid primary key default gen_random_uuid(),
  meeting_id uuid not null references meetings (id) on delete restrict,
  criteria jsonb not null,
  resolved_count integer not null,
  inserted_count integer not null,
  created_at timestamptz not null default now(),
  created_by uuid references users (id) on delete restrict
);

create table meeting_invitations (
  id uuid primary key default gen_random_uuid(),
  meeting_id uuid not null references meetings (id) on delete restrict,
  person_id uuid not null references people (id) on delete restrict,
  batch_id uuid references meeting_invitation_batches (id) on delete restrict,
  -- D10: solo se guarda el hash del token, nunca el valor en claro.
  token_hash text not null unique,
  response_status text not null default 'pending' check (
    response_status in ('pending', 'confirmed', 'declined')
  ),
  attendance_status text not null default 'unknown' check (
    attendance_status in ('unknown', 'attended', 'absent')
  ),
  channel text not null default 'manual_link',
  invited_at timestamptz not null default now(),
  responded_at timestamptz,
  unique (meeting_id, person_id)
);

create index meeting_invitations_meeting_id_idx on meeting_invitations (meeting_id);
create index meeting_invitations_person_id_idx on meeting_invitations (person_id);

create table meeting_attendance (
  id uuid primary key default gen_random_uuid(),
  meeting_id uuid not null references meetings (id) on delete restrict,
  person_id uuid not null references people (id) on delete restrict,
  invitation_id uuid references meeting_invitations (id) on delete restrict,
  method text not null check (
    method in ('invitation_token', 'dni', 'email', 'phone', 'manual')
  ),
  checked_in_at timestamptz not null default now(),
  ip_address inet,
  user_agent text,
  registered_by uuid references users (id) on delete restrict,
  correction_reason text,
  unique (meeting_id, person_id)
);

create index meeting_attendance_meeting_id_idx on meeting_attendance (meeting_id);
