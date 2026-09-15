-- ============================================================
-- Migration 046: whatsapp_connections Table & Instance Restoration
--
-- Restores the whatsapp_connections table used across the application
-- by UazAPI, Baileys, and Meta WhatsApp integration paths.
-- Also restores the active Larissa WhatsApp connection.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.whatsapp_connections (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id              uuid NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  provider                text NOT NULL DEFAULT 'uazapi',
  display_name            text NOT NULL DEFAULT 'WhatsApp',
  phone_number            text,
  status                  text NOT NULL DEFAULT 'disconnected',
  is_active               boolean NOT NULL DEFAULT true,
  provider_config         jsonb NOT NULL DEFAULT '{}'::jsonb,
  mirror_inbound_media    boolean NOT NULL DEFAULT true,
  last_sync_at            timestamptz,
  last_error              text,
  registered_at           timestamptz,
  subscribed_apps_at      timestamptz,
  last_registration_error text,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now()
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_whatsapp_connections_account_id ON public.whatsapp_connections(account_id);
CREATE INDEX IF NOT EXISTS idx_whatsapp_connections_provider ON public.whatsapp_connections(provider);
CREATE INDEX IF NOT EXISTS idx_whatsapp_connections_status ON public.whatsapp_connections(status);
CREATE INDEX IF NOT EXISTS idx_whatsapp_connections_account_active ON public.whatsapp_connections(account_id, is_active);

-- Row Level Security
ALTER TABLE public.whatsapp_connections ENABLE ROW LEVEL SECURITY;

-- Policies
DROP POLICY IF EXISTS whatsapp_connections_select ON public.whatsapp_connections;
CREATE POLICY whatsapp_connections_select ON public.whatsapp_connections
  FOR SELECT USING (public.is_account_member(account_id));

DROP POLICY IF EXISTS whatsapp_connections_insert ON public.whatsapp_connections;
CREATE POLICY whatsapp_connections_insert ON public.whatsapp_connections
  FOR INSERT WITH CHECK (public.is_account_member(account_id, 'admin'));

DROP POLICY IF EXISTS whatsapp_connections_update ON public.whatsapp_connections;
CREATE POLICY whatsapp_connections_update ON public.whatsapp_connections
  FOR UPDATE USING (public.is_account_member(account_id, 'admin'));

DROP POLICY IF EXISTS whatsapp_connections_delete ON public.whatsapp_connections;
CREATE POLICY whatsapp_connections_delete ON public.whatsapp_connections
  FOR DELETE USING (public.is_account_member(account_id, 'admin'));

-- Trigger to maintain updated_at
CREATE OR REPLACE FUNCTION public.update_whatsapp_connections_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_whatsapp_connections_updated_at ON public.whatsapp_connections;
CREATE TRIGGER trg_whatsapp_connections_updated_at
  BEFORE UPDATE ON public.whatsapp_connections
  FOR EACH ROW EXECUTE FUNCTION public.update_whatsapp_connections_updated_at();

-- Permissions
GRANT ALL ON public.whatsapp_connections TO anon, authenticated, service_role;

-- Realtime publication
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.whatsapp_connections;
  END IF;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- Restore active Larissa WhatsApp instance
INSERT INTO public.whatsapp_connections (
  id,
  account_id,
  provider,
  display_name,
  phone_number,
  status,
  is_active,
  provider_config,
  mirror_inbound_media,
  last_sync_at
) VALUES (
  '62fd0743-19f0-45ff-a059-12e462c24853',
  '4fe971b8-cf70-45e2-8db3-c3eff700ae75',
  'uazapi',
  'Larissa',
  '5516989233842',
  'connected',
  true,
  jsonb_build_object(
    'base_url', 'https://3nglobal.uazapi.com',
    'token', '268e61c3f6762ada656f5899:b9ff1e33c188ba7d99f0fbc9ecff88b702a8fd94748f004c6cd3f85831e63b41837580f9:f2d8fc5a2ceb081be81017c92a91a386'
  ),
  true,
  now()
) ON CONFLICT (id) DO UPDATE SET
  status = 'connected',
  is_active = true,
  provider_config = EXCLUDED.provider_config;
