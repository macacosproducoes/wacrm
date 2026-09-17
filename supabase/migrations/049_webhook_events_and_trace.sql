-- ============================================================
-- 049_webhook_events_and_trace.sql
--
-- Persistent webhook event intake log, idempotency queue,
-- and trace tracking across CRM, Creative Engine, and WhatsApp.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.webhook_events (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider            text NOT NULL DEFAULT 'uazapi',
  event_type          text NOT NULL,
  external_event_id   text,
  message_id          text,
  connection_id       uuid REFERENCES public.whatsapp_connections(id) ON DELETE SET NULL,
  account_id          uuid REFERENCES public.accounts(id) ON DELETE CASCADE,
  payload             jsonb NOT NULL DEFAULT '{}'::jsonb,
  payload_hash        text,
  processing_status   text NOT NULL DEFAULT 'RECEIVED' CHECK (processing_status IN ('RECEIVED', 'QUEUED', 'PROCESSING', 'COMPLETED', 'FAILED', 'RETRYING')),
  error               text,
  trace_id            text NOT NULL,
  received_at         timestamptz NOT NULL DEFAULT now(),
  processed_at        timestamptz,
  attempts            int NOT NULL DEFAULT 0,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_webhook_events_trace_id ON public.webhook_events(trace_id);
CREATE INDEX IF NOT EXISTS idx_webhook_events_message_id ON public.webhook_events(message_id);
CREATE INDEX IF NOT EXISTS idx_webhook_events_status ON public.webhook_events(processing_status);
CREATE INDEX IF NOT EXISTS idx_webhook_events_received_at ON public.webhook_events(received_at DESC);

-- Add trace_id columns to messages, creative_jobs, creative_deliveries
ALTER TABLE public.messages ADD COLUMN IF NOT EXISTS trace_id text;
CREATE INDEX IF NOT EXISTS idx_messages_trace_id ON public.messages(trace_id);

ALTER TABLE public.creative_jobs ADD COLUMN IF NOT EXISTS trace_id text;
CREATE INDEX IF NOT EXISTS idx_creative_jobs_trace_id ON public.creative_jobs(trace_id);

ALTER TABLE public.creative_deliveries ADD COLUMN IF NOT EXISTS trace_id text;
CREATE INDEX IF NOT EXISTS idx_creative_deliveries_trace_id ON public.creative_deliveries(trace_id);

GRANT ALL ON public.webhook_events TO anon, authenticated, service_role;
