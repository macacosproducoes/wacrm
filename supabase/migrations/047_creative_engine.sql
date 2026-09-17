-- ============================================================
-- Migration 047: Creative Engine (Automated Creative Generation)
--
-- Provides generic, reusable, multi-tenant templates, deterministic
-- creative generation, job queue with idempotency, and delivery tracking.
-- ============================================================

-- 1. CREATIVE TEMPLATES
CREATE TABLE IF NOT EXISTS public.creative_templates (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id  uuid NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  created_by  uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  name        text NOT NULL,
  description text,
  category    text NOT NULL DEFAULT 'general',
  type        text NOT NULL DEFAULT 'image/png',
  status      text NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT', 'ACTIVE', 'ARCHIVED')),
  version     int NOT NULL DEFAULT 1,
  definition  jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_creative_templates_account ON public.creative_templates(account_id);
CREATE INDEX IF NOT EXISTS idx_creative_templates_status ON public.creative_templates(status);
CREATE INDEX IF NOT EXISTS idx_creative_templates_category ON public.creative_templates(category);

ALTER TABLE public.creative_templates ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS creative_templates_select ON public.creative_templates;
CREATE POLICY creative_templates_select ON public.creative_templates
  FOR SELECT USING (public.is_account_member(account_id));

DROP POLICY IF EXISTS creative_templates_insert ON public.creative_templates;
CREATE POLICY creative_templates_insert ON public.creative_templates
  FOR INSERT WITH CHECK (public.is_account_member(account_id, 'agent'));

DROP POLICY IF EXISTS creative_templates_update ON public.creative_templates;
CREATE POLICY creative_templates_update ON public.creative_templates
  FOR UPDATE USING (public.is_account_member(account_id, 'agent'));

DROP POLICY IF EXISTS creative_templates_delete ON public.creative_templates;
CREATE POLICY creative_templates_delete ON public.creative_templates
  FOR DELETE USING (public.is_account_member(account_id, 'admin'));


-- 2. CREATIVE TEMPLATE VERSIONS (Historical version snapshots)
CREATE TABLE IF NOT EXISTS public.creative_template_versions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  template_id uuid NOT NULL REFERENCES public.creative_templates(id) ON DELETE CASCADE,
  account_id  uuid NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  created_by  uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  version     int NOT NULL,
  definition  jsonb NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (template_id, version)
);

CREATE INDEX IF NOT EXISTS idx_creative_template_versions_template ON public.creative_template_versions(template_id);
CREATE INDEX IF NOT EXISTS idx_creative_template_versions_account ON public.creative_template_versions(account_id);

ALTER TABLE public.creative_template_versions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS creative_template_versions_select ON public.creative_template_versions;
CREATE POLICY creative_template_versions_select ON public.creative_template_versions
  FOR SELECT USING (public.is_account_member(account_id));

DROP POLICY IF EXISTS creative_template_versions_insert ON public.creative_template_versions;
CREATE POLICY creative_template_versions_insert ON public.creative_template_versions
  FOR INSERT WITH CHECK (public.is_account_member(account_id, 'agent'));


-- 3. CREATIVE JOBS (Execution, Idempotency & Concurrency)
CREATE TABLE IF NOT EXISTS public.creative_jobs (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id       uuid NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  template_id      uuid NOT NULL REFERENCES public.creative_templates(id) ON DELETE RESTRICT,
  template_version int NOT NULL,
  source_type      text NOT NULL DEFAULT 'MANUAL',
  source_id        text NOT NULL DEFAULT '',
  creative_type    text NOT NULL DEFAULT 'default',
  idempotency_key  text NOT NULL,
  input_data       jsonb NOT NULL DEFAULT '{}'::jsonb,
  output_url       text,
  output_path      text,
  status           text NOT NULL DEFAULT 'PENDING' CHECK (status IN (
    'PENDING', 'PROCESSING', 'GENERATED', 'READY', 'SENDING', 'SENT', 'FAILED', 'NEEDS_REVIEW', 'CANCELLED'
  )),
  error            text,
  attempts         int NOT NULL DEFAULT 0,
  max_attempts     int NOT NULL DEFAULT 3,
  locked_at        timestamptz,
  locked_by        text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  started_at       timestamptz,
  completed_at     timestamptz,
  sent_at          timestamptz,
  UNIQUE (account_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_creative_jobs_account_status ON public.creative_jobs(account_id, status);
CREATE INDEX IF NOT EXISTS idx_creative_jobs_template ON public.creative_jobs(template_id, template_version);
CREATE INDEX IF NOT EXISTS idx_creative_jobs_source ON public.creative_jobs(account_id, source_type, source_id);
CREATE INDEX IF NOT EXISTS idx_creative_jobs_idempotency ON public.creative_jobs(account_id, idempotency_key);

ALTER TABLE public.creative_jobs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS creative_jobs_select ON public.creative_jobs;
CREATE POLICY creative_jobs_select ON public.creative_jobs
  FOR SELECT USING (public.is_account_member(account_id));

DROP POLICY IF EXISTS creative_jobs_insert ON public.creative_jobs;
CREATE POLICY creative_jobs_insert ON public.creative_jobs
  FOR INSERT WITH CHECK (public.is_account_member(account_id, 'agent'));

DROP POLICY IF EXISTS creative_jobs_update ON public.creative_jobs;
CREATE POLICY creative_jobs_update ON public.creative_jobs
  FOR UPDATE USING (public.is_account_member(account_id, 'agent'));


-- 4. CREATIVE DELIVERIES (Channel Delivery Tracking)
CREATE TABLE IF NOT EXISTS public.creative_deliveries (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id          uuid NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  job_id              uuid NOT NULL REFERENCES public.creative_jobs(id) ON DELETE CASCADE,
  channel             text NOT NULL DEFAULT 'whatsapp',
  recipient           text NOT NULL,
  provider            text NOT NULL DEFAULT 'whatsapp',
  provider_message_id text,
  status              text NOT NULL DEFAULT 'SENT' CHECK (status IN ('PENDING', 'SENT', 'FAILED')),
  error               text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  sent_at             timestamptz
);

CREATE INDEX IF NOT EXISTS idx_creative_deliveries_account ON public.creative_deliveries(account_id);
CREATE INDEX IF NOT EXISTS idx_creative_deliveries_job ON public.creative_deliveries(job_id);

ALTER TABLE public.creative_deliveries ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS creative_deliveries_select ON public.creative_deliveries;
CREATE POLICY creative_deliveries_select ON public.creative_deliveries
  FOR SELECT USING (public.is_account_member(account_id));

DROP POLICY IF EXISTS creative_deliveries_insert ON public.creative_deliveries;
CREATE POLICY creative_deliveries_insert ON public.creative_deliveries
  FOR INSERT WITH CHECK (public.is_account_member(account_id, 'agent'));

DROP POLICY IF EXISTS creative_deliveries_update ON public.creative_deliveries;
CREATE POLICY creative_deliveries_update ON public.creative_deliveries
  FOR UPDATE USING (public.is_account_member(account_id, 'agent'));

-- Trigger for creative_templates updated_at
CREATE OR REPLACE FUNCTION public.update_creative_templates_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_creative_templates_updated_at ON public.creative_templates;
CREATE TRIGGER trg_creative_templates_updated_at
  BEFORE UPDATE ON public.creative_templates
  FOR EACH ROW EXECUTE FUNCTION public.update_creative_templates_updated_at();

-- Permissions
GRANT ALL ON public.creative_templates TO anon, authenticated, service_role;
GRANT ALL ON public.creative_template_versions TO anon, authenticated, service_role;
GRANT ALL ON public.creative_jobs TO anon, authenticated, service_role;
GRANT ALL ON public.creative_deliveries TO anon, authenticated, service_role;
