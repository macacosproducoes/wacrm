-- ============================================================
-- Migration 048: Instagram Profile Resolver
--
-- Adds Instagram profile resolution, structured metadata,
-- photo caching, hash tracking, and manual photo overrides to contacts.
-- ============================================================

ALTER TABLE public.contacts
  ADD COLUMN IF NOT EXISTS instagram_username text,
  ADD COLUMN IF NOT EXISTS instagram_url text,
  ADD COLUMN IF NOT EXISTS profile_image_url text,
  ADD COLUMN IF NOT EXISTS profile_image_source text DEFAULT 'INSTAGRAM_PROVIDER' CHECK (profile_image_source IN ('MANUAL', 'STORED', 'INSTAGRAM_PROVIDER')),
  ADD COLUMN IF NOT EXISTS profile_image_updated_at timestamptz,
  ADD COLUMN IF NOT EXISTS profile_image_hash text,
  ADD COLUMN IF NOT EXISTS instagram_resolve_status text DEFAULT 'NOT_REQUESTED' CHECK (instagram_resolve_status IN ('NOT_REQUESTED', 'PENDING', 'RESOLVING', 'RESOLVED', 'IMAGE_AVAILABLE', 'IMAGE_UNAVAILABLE', 'FAILED', 'MANUAL_REQUIRED')),
  ADD COLUMN IF NOT EXISTS instagram_last_error text,
  ADD COLUMN IF NOT EXISTS instagram_attempt_count int DEFAULT 0,
  ADD COLUMN IF NOT EXISTS instagram_last_attempt_at timestamptz;

CREATE INDEX IF NOT EXISTS idx_contacts_instagram_username ON public.contacts(account_id, instagram_username);
CREATE INDEX IF NOT EXISTS idx_contacts_instagram_resolve_status ON public.contacts(account_id, instagram_resolve_status);
