BEGIN;

SET LOCAL lock_timeout = '10s';

-- 0045 — Mailing: admite Resend como segundo proveedor, sin quitar Amazon SES. ADITIVA e idempotente.
--
-- Solo se AMPLÍAN dos restricciones CHECK (provider IN ('ses') → provider IN ('ses', 'resend')). Ninguna fila existente cambia:
-- todas las campañas y remitentes históricos conservan provider = 'ses'. No hay backfill, ni columnas nuevas, ni tablas nuevas.
-- mailing_events.event_type NO cambia: los eventos de Resend se mapean a los tipos existentes (ver lib/mailing/resend-webhook.ts).
--
-- Rollback: volver a la restricción anterior solo es posible mientras no exista ninguna fila con provider = 'resend'
-- (ver el procedimiento en docs/MAILING-RESEND-RUNBOOK.md).

-- ---------------------------------------------------------------- mailing_senders.provider
ALTER TABLE public.mailing_senders DROP CONSTRAINT IF EXISTS mailing_senders_provider_check;
ALTER TABLE public.mailing_senders
  ADD CONSTRAINT mailing_senders_provider_check CHECK (provider IN ('ses', 'resend'));

-- ---------------------------------------------------------------- mailing_campaigns.provider
ALTER TABLE public.mailing_campaigns DROP CONSTRAINT IF EXISTS mailing_campaigns_provider_check;
ALTER TABLE public.mailing_campaigns
  ADD CONSTRAINT mailing_campaigns_provider_check CHECK (provider IN ('ses', 'resend'));

COMMIT;
