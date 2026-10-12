BEGIN;

SET LOCAL lock_timeout = '10s';

-- 0044 — Mailing MVP con Amazon SES. ADITIVA e idempotente: solo tablas nuevas, ninguna fila histórica se toca.
--
-- Principios:
--   · MAILING ≠ CONTACTO REAL: ninguna de estas tablas escribe en person_interactions ni mueve el semáforo (B5).
--   · La audiencia queda CONGELADA al crear la campaña (mailing_campaign_recipients + mailing_campaign_recipient_people).
--   · Un destinatario es un EMAIL normalizado de la campaña, no una persona: varias personas pueden compartirlo.
--   · Estado de envío en PostgreSQL; el worker (proceso aparte) reclama con FOR UPDATE SKIP LOCKED y lease.
--   · Una respuesta incierta de SES NUNCA se reintenta sola (send_unknown).
--   · Cuota diaria GLOBAL (no por remitente) con reserva atómica.
--   · Historial append-only (mailing_events) y supresiones sin DELETE.

-- ---------------------------------------------------------------------------------------------------------------------
-- Remitentes
-- ---------------------------------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.mailing_senders (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name                   text NOT NULL,
  from_name              text NOT NULL,
  from_email             text NOT NULL,
  reply_to               text,
  active                 boolean NOT NULL DEFAULT true,
  is_default             boolean NOT NULL DEFAULT false,
  -- NULL = remitente global (visible para cualquier usuario con mailing.create dentro de su módulo).
  owner_organization_id  uuid REFERENCES public.organizations (id) ON DELETE RESTRICT,
  provider               text NOT NULL DEFAULT 'ses',
  -- Identidad verificada en el proveedor (email o dominio). Por defecto, el propio from_email.
  provider_identity      text,
  verified_status        text NOT NULL DEFAULT 'pending',
  verified_at            timestamptz,
  verified_checked_at    timestamptz,
  created_by             uuid REFERENCES public.users (id) ON DELETE RESTRICT,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT mailing_senders_provider_check CHECK (provider IN ('ses')),
  CONSTRAINT mailing_senders_verified_status_check CHECK (verified_status IN ('pending', 'verified', 'failed', 'unknown')),
  CONSTRAINT mailing_senders_name_check CHECK (btrim(name) <> '' AND btrim(from_name) <> ''),
  -- Sin saltos de línea: el remitente se vuelca a cabeceras (inyección de cabeceras).
  CONSTRAINT mailing_senders_header_safe_check CHECK (
    from_name !~ '[\r\n]' AND from_email !~ '[\r\n\s]' AND (reply_to IS NULL OR reply_to !~ '[\r\n\s]')
  ),
  CONSTRAINT mailing_senders_email_check CHECK (from_email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$')
);

CREATE UNIQUE INDEX IF NOT EXISTS mailing_senders_from_email_unique_idx ON public.mailing_senders (lower(from_email));
-- A lo sumo un remitente por defecto.
CREATE UNIQUE INDEX IF NOT EXISTS mailing_senders_single_default_idx ON public.mailing_senders (is_default) WHERE is_default;
CREATE INDEX IF NOT EXISTS mailing_senders_owner_idx ON public.mailing_senders (owner_organization_id);

-- ---------------------------------------------------------------------------------------------------------------------
-- Campañas
-- ---------------------------------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.mailing_campaigns (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name                   text NOT NULL,
  subject                text NOT NULL DEFAULT '',
  preheader              text,
  sender_id              uuid REFERENCES public.mailing_senders (id) ON DELETE RESTRICT,
  reply_to               text,
  html_body              text NOT NULL DEFAULT '',
  text_body              text NOT NULL DEFAULT '',
  status                 text NOT NULL DEFAULT 'draft',
  owner_organization_id  uuid REFERENCES public.organizations (id) ON DELETE RESTRICT,
  provider               text NOT NULL DEFAULT 'ses',
  -- Cómo se armó la audiencia (auditoría; NO se recalcula jamás). Los ids manuales no se guardan acá: quedan en recipient_people.
  audience_spec          jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- Conteos del snapshot: seleccionadas, con/sin email, inválidos, duplicados, suprimidos, finales.
  audience_stats         jsonb NOT NULL DEFAULT '{}'::jsonb,
  total_selected         integer NOT NULL DEFAULT 0,
  total_recipients       integer NOT NULL DEFAULT 0,
  daily_limit_snapshot   integer,
  scheduled_at           timestamptz,
  launched_at            timestamptz,
  launched_by            uuid REFERENCES public.users (id) ON DELETE RESTRICT,
  started_at             timestamptz,
  finished_at            timestamptz,
  paused_at              timestamptz,
  paused_by              uuid REFERENCES public.users (id) ON DELETE RESTRICT,
  cancelled_at           timestamptz,
  cancelled_by           uuid REFERENCES public.users (id) ON DELETE RESTRICT,
  cancel_reason          text,
  created_by             uuid NOT NULL REFERENCES public.users (id) ON DELETE RESTRICT,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT mailing_campaigns_status_check
    CHECK (status IN ('draft', 'ready', 'scheduled', 'sending', 'paused', 'completed', 'cancelled', 'failed')),
  CONSTRAINT mailing_campaigns_provider_check CHECK (provider IN ('ses')),
  CONSTRAINT mailing_campaigns_name_check CHECK (btrim(name) <> ''),
  CONSTRAINT mailing_campaigns_subject_header_check CHECK (subject !~ '[\r\n]'),
  CONSTRAINT mailing_campaigns_reply_to_check CHECK (reply_to IS NULL OR (reply_to ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' AND reply_to !~ '[\r\n\s]')),
  CONSTRAINT mailing_campaigns_totals_check CHECK (total_selected >= 0 AND total_recipients >= 0),
  -- Lanzada (scheduled/sending/paused/completed): remitente, asunto y cuerpo son obligatorios.
  CONSTRAINT mailing_campaigns_launched_content_check
    CHECK (status IN ('draft', 'ready', 'cancelled', 'failed') OR (sender_id IS NOT NULL AND btrim(subject) <> '' AND (btrim(html_body) <> '' OR btrim(text_body) <> '')))
);

CREATE INDEX IF NOT EXISTS mailing_campaigns_status_idx ON public.mailing_campaigns (status, created_at DESC);
CREATE INDEX IF NOT EXISTS mailing_campaigns_owner_idx ON public.mailing_campaigns (owner_organization_id, created_at DESC);
CREATE INDEX IF NOT EXISTS mailing_campaigns_created_by_idx ON public.mailing_campaigns (created_by, created_at DESC);
CREATE INDEX IF NOT EXISTS mailing_campaigns_sender_idx ON public.mailing_campaigns (sender_id);

-- ---------------------------------------------------------------------------------------------------------------------
-- Lotes (un lote = un día de envío bajo la cuota global)
-- ---------------------------------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.mailing_campaign_batches (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id      uuid NOT NULL REFERENCES public.mailing_campaigns (id) ON DELETE RESTRICT,
  sequence         integer NOT NULL,
  -- Día calendario en America/Argentina/Buenos_Aires.
  scheduled_date   date NOT NULL,
  status           text NOT NULL DEFAULT 'pending',
  recipient_count  integer NOT NULL DEFAULT 0,
  sent_count       integer NOT NULL DEFAULT 0,
  created_at       timestamptz NOT NULL DEFAULT now(),
  started_at       timestamptz,
  finished_at      timestamptz,
  CONSTRAINT mailing_campaign_batches_status_check CHECK (status IN ('pending', 'running', 'completed', 'cancelled')),
  CONSTRAINT mailing_campaign_batches_counts_check CHECK (recipient_count >= 0 AND sent_count >= 0),
  CONSTRAINT mailing_campaign_batches_sequence_unique UNIQUE (campaign_id, sequence)
);
CREATE INDEX IF NOT EXISTS mailing_campaign_batches_date_idx ON public.mailing_campaign_batches (scheduled_date, status);

-- ---------------------------------------------------------------------------------------------------------------------
-- Destinatarios (snapshot) — un EMAIL normalizado por campaña
-- ---------------------------------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.mailing_campaign_recipients (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id           uuid NOT NULL REFERENCES public.mailing_campaigns (id) ON DELETE RESTRICT,
  -- Persona de referencia (la primera por id). Puede haber más en mailing_campaign_recipient_people.
  primary_person_id     uuid REFERENCES public.people (id) ON DELETE RESTRICT,
  person_count          integer NOT NULL DEFAULT 1,
  normalized_email      text NOT NULL,
  -- Valor original de people.email al congelar la audiencia (nunca se modifica people.email).
  email_snapshot        text NOT NULL,
  -- Variables de personalización congeladas ({nombre, apellido, organizacion}); vacías si el email es compartido.
  merge_vars            jsonb NOT NULL DEFAULT '{}'::jsonb,
  status                text NOT NULL DEFAULT 'pending',
  status_detail         text,
  batch_id              uuid REFERENCES public.mailing_campaign_batches (id) ON DELETE RESTRICT,
  provider_message_id   text,
  attempt_count         integer NOT NULL DEFAULT 0,
  next_attempt_at       timestamptz,
  lease_owner           text,
  lease_until           timestamptz,
  queued_at             timestamptz,
  sent_at               timestamptz,
  delivered_at          timestamptz,
  opened_at             timestamptz,
  clicked_at            timestamptz,
  open_count            integer NOT NULL DEFAULT 0,
  click_count           integer NOT NULL DEFAULT 0,
  bounced_at            timestamptz,
  soft_bounce_count     integer NOT NULL DEFAULT 0,
  complained_at         timestamptz,
  unsubscribed_at       timestamptz,
  failed_at             timestamptz,
  last_error            text,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT mailing_campaign_recipients_status_check CHECK (status IN (
    'pending', 'queued', 'sending', 'sent', 'delivered', 'bounced', 'complained', 'unsubscribed', 'failed', 'suppressed', 'invalid', 'send_unknown'
  )),
  CONSTRAINT mailing_campaign_recipients_email_unique UNIQUE (campaign_id, normalized_email),
  CONSTRAINT mailing_campaign_recipients_counts_check CHECK (attempt_count >= 0 AND person_count >= 1 AND open_count >= 0 AND click_count >= 0 AND soft_bounce_count >= 0),
  -- Un lease solo existe mientras se está enviando.
  CONSTRAINT mailing_campaign_recipients_lease_check CHECK ((status = 'sending') OR (lease_owner IS NULL AND lease_until IS NULL))
);

CREATE INDEX IF NOT EXISTS mailing_campaign_recipients_campaign_status_idx ON public.mailing_campaign_recipients (campaign_id, status);
-- Cola del worker: solo filas en cola.
CREATE INDEX IF NOT EXISTS mailing_campaign_recipients_claim_idx ON public.mailing_campaign_recipients (batch_id, id) WHERE status = 'queued';
CREATE INDEX IF NOT EXISTS mailing_campaign_recipients_lease_idx ON public.mailing_campaign_recipients (lease_until) WHERE status = 'sending';
CREATE UNIQUE INDEX IF NOT EXISTS mailing_campaign_recipients_message_idx ON public.mailing_campaign_recipients (provider_message_id) WHERE provider_message_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS mailing_campaign_recipients_email_idx ON public.mailing_campaign_recipients (normalized_email);

CREATE TABLE IF NOT EXISTS public.mailing_campaign_recipient_people (
  recipient_id  uuid NOT NULL REFERENCES public.mailing_campaign_recipients (id) ON DELETE RESTRICT,
  person_id     uuid NOT NULL REFERENCES public.people (id) ON DELETE RESTRICT,
  campaign_id   uuid NOT NULL REFERENCES public.mailing_campaigns (id) ON DELETE RESTRICT,
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (recipient_id, person_id)
);
-- Una persona aparece una sola vez por campaña.
CREATE UNIQUE INDEX IF NOT EXISTS mailing_campaign_recipient_people_person_unique_idx ON public.mailing_campaign_recipient_people (campaign_id, person_id);
CREATE INDEX IF NOT EXISTS mailing_campaign_recipient_people_person_idx ON public.mailing_campaign_recipient_people (person_id);

-- ---------------------------------------------------------------------------------------------------------------------
-- Supresiones (lista de bajas) — sin DELETE; levantar = UPDATE de lifted_*
-- ---------------------------------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.mailing_suppressions (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  normalized_email    text NOT NULL,
  reason              text NOT NULL,
  source              text NOT NULL,
  campaign_id         uuid REFERENCES public.mailing_campaigns (id) ON DELETE RESTRICT,
  created_at          timestamptz NOT NULL DEFAULT now(),
  created_by          uuid REFERENCES public.users (id) ON DELETE RESTRICT,
  provider_event_id   text,
  lifted_at           timestamptz,
  lifted_by           uuid REFERENCES public.users (id) ON DELETE RESTRICT,
  lift_reason         text,
  CONSTRAINT mailing_suppressions_reason_check CHECK (reason IN ('hard_bounce', 'complaint', 'unsubscribe', 'invalid', 'manual')),
  CONSTRAINT mailing_suppressions_lift_check CHECK (
    (lifted_at IS NULL AND lifted_by IS NULL AND lift_reason IS NULL)
    OR (lifted_at IS NOT NULL AND lifted_by IS NOT NULL AND lift_reason IS NOT NULL AND btrim(lift_reason) <> '')
  )
);
-- A lo sumo una supresión ACTIVA por email.
CREATE UNIQUE INDEX IF NOT EXISTS mailing_suppressions_active_unique_idx ON public.mailing_suppressions (normalized_email) WHERE lifted_at IS NULL;
CREATE INDEX IF NOT EXISTS mailing_suppressions_email_idx ON public.mailing_suppressions (normalized_email);

-- ---------------------------------------------------------------------------------------------------------------------
-- Eventos del proveedor (append-only, idempotentes por provider_event_key)
-- ---------------------------------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.mailing_events (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  seq                  bigint GENERATED ALWAYS AS IDENTITY,
  campaign_id          uuid NOT NULL REFERENCES public.mailing_campaigns (id) ON DELETE RESTRICT,
  recipient_id         uuid NOT NULL REFERENCES public.mailing_campaign_recipients (id) ON DELETE RESTRICT,
  provider_event_key   text NOT NULL,
  provider_message_id  text,
  event_type           text NOT NULL,
  event_at             timestamptz NOT NULL,
  -- Solo campos seguros y acotados (nunca el payload bruto del proveedor).
  payload_safe         jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT mailing_events_key_unique UNIQUE (provider_event_key),
  CONSTRAINT mailing_events_type_check CHECK (event_type IN (
    'send', 'delivery', 'bounce', 'soft_bounce', 'complaint', 'reject', 'open', 'click', 'delivery_delay', 'rendering_failure', 'unsubscribe'
  ))
);
CREATE INDEX IF NOT EXISTS mailing_events_recipient_idx ON public.mailing_events (recipient_id, seq);
CREATE INDEX IF NOT EXISTS mailing_events_campaign_idx ON public.mailing_events (campaign_id, event_type);

CREATE OR REPLACE FUNCTION public.sutecba_block_mailing_event_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $$
BEGIN
  RAISE EXCEPTION 'mailing_events es append-only: no se actualiza ni se borra';
END;
$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'mailing_events_append_only' AND tgrelid = 'public.mailing_events'::regclass) THEN
    CREATE TRIGGER mailing_events_append_only
    BEFORE UPDATE OR DELETE ON public.mailing_events
    FOR EACH ROW
    EXECUTE FUNCTION public.sutecba_block_mailing_event_mutation();
  END IF;
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- Cuota diaria GLOBAL (día calendario de Buenos Aires)
-- ---------------------------------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.mailing_daily_quota (
  day            date PRIMARY KEY,
  daily_limit    integer NOT NULL,
  reserved       integer NOT NULL DEFAULT 0,
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT mailing_daily_quota_check CHECK (daily_limit >= 0 AND reserved >= 0)
);

-- ---------------------------------------------------------------------------------------------------------------------
-- Latido del worker (observabilidad)
-- ---------------------------------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.mailing_worker_heartbeats (
  worker_id      text PRIMARY KEY,
  started_at     timestamptz NOT NULL DEFAULT now(),
  last_seen_at   timestamptz NOT NULL DEFAULT now(),
  info           jsonb NOT NULL DEFAULT '{}'::jsonb
);

-- ---------------------------------------------------------------------------------------------------------------------
-- RLS y privilegios (la app usa el rol sutecba_app; sin DELETE en ninguna tabla de mailing)
-- ---------------------------------------------------------------------------------------------------------------------
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'mailing_senders', 'mailing_campaigns', 'mailing_campaign_batches', 'mailing_campaign_recipients', 'mailing_campaign_recipient_people',
    'mailing_suppressions', 'mailing_events', 'mailing_daily_quota', 'mailing_worker_heartbeats'
  ] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = t AND policyname = 'sutecba_app_all') THEN
      EXECUTE format('CREATE POLICY sutecba_app_all ON public.%I FOR ALL TO sutecba_app USING (true) WITH CHECK (true)', t);
    END IF;
    EXECUTE format('REVOKE ALL ON TABLE public.%I FROM PUBLIC, anon, authenticated', t);
  END LOOP;
END $$;

GRANT SELECT, INSERT, UPDATE ON TABLE public.mailing_senders TO sutecba_app;
GRANT SELECT, INSERT, UPDATE ON TABLE public.mailing_campaigns TO sutecba_app;
GRANT SELECT, INSERT, UPDATE ON TABLE public.mailing_campaign_batches TO sutecba_app;
GRANT SELECT, INSERT, UPDATE ON TABLE public.mailing_campaign_recipients TO sutecba_app;
GRANT SELECT, INSERT ON TABLE public.mailing_campaign_recipient_people TO sutecba_app;
GRANT SELECT, INSERT ON TABLE public.mailing_suppressions TO sutecba_app;
GRANT UPDATE (lifted_at, lifted_by, lift_reason) ON TABLE public.mailing_suppressions TO sutecba_app;
GRANT SELECT, INSERT ON TABLE public.mailing_events TO sutecba_app;
GRANT SELECT, INSERT, UPDATE ON TABLE public.mailing_daily_quota TO sutecba_app;
-- Único DELETE de mailing: el worker poda latidos viejos (> 24 h) y retira el propio al apagarse. Es solo telemetría operativa.
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.mailing_worker_heartbeats TO sutecba_app;

COMMIT;
