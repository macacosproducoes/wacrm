
-- 051_broadcast_cooldown_queue.sql
ALTER TABLE broadcasts DROP CONSTRAINT IF EXISTS broadcasts_status_check;
ALTER TABLE broadcasts ADD CONSTRAINT broadcasts_status_check 
  CHECK (status IN ('draft', 'scheduled', 'sending', 'paused', 'sent', 'failed', 'cancelled'));

ALTER TABLE broadcast_recipients DROP CONSTRAINT IF EXISTS broadcast_recipients_status_check;
ALTER TABLE broadcast_recipients ADD CONSTRAINT broadcast_recipients_status_check 
  CHECK (status IN ('pending', 'processing', 'sent', 'delivered', 'read', 'replied', 'failed', 'cancelled'));

ALTER TABLE broadcasts
  ADD COLUMN IF NOT EXISTS cooldown_interval_seconds INTEGER NOT NULL DEFAULT 5,
  ADD COLUMN IF NOT EXISTS batch_size INTEGER NOT NULL DEFAULT 20,
  ADD COLUMN IF NOT EXISTS batch_pause_seconds INTEGER NOT NULL DEFAULT 60,
  ADD COLUMN IF NOT EXISTS daily_limit INTEGER NOT NULL DEFAULT 1000,
  ADD COLUMN IF NOT EXISTS window_start_time TEXT NOT NULL DEFAULT '08:00',
  ADD COLUMN IF NOT EXISTS window_end_time TEXT NOT NULL DEFAULT '20:00',
  ADD COLUMN IF NOT EXISTS timezone TEXT NOT NULL DEFAULT 'America/Sao_Paulo',
  ADD COLUMN IF NOT EXISTS paused_reason TEXT,
  ADD COLUMN IF NOT EXISTS next_run_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS consecutive_failures INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS max_consecutive_failures INTEGER NOT NULL DEFAULT 5;

ALTER TABLE broadcast_recipients
  ADD COLUMN IF NOT EXISTS attempts INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_attempt_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS broadcast_events (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  broadcast_id UUID NOT NULL REFERENCES broadcasts(id) ON DELETE CASCADE,
  account_id UUID REFERENCES accounts(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  message TEXT NOT NULL,
  details JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_broadcast_events_broadcast_time
  ON broadcast_events(broadcast_id, created_at DESC);

ALTER TABLE broadcast_events ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Users can view own account broadcast events" ON broadcast_events;
CREATE POLICY "Users can view own account broadcast events" ON broadcast_events
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM broadcasts b 
      WHERE b.id = broadcast_events.broadcast_id 
        AND is_account_member(b.account_id, 'viewer')
    )
  );

GRANT ALL ON broadcast_events TO service_role;
GRANT SELECT ON broadcast_events TO authenticated;

CREATE OR REPLACE FUNCTION public.claim_next_broadcast_recipient(p_broadcast_id UUID)
RETURNS TABLE (
  recipient_id UUID,
  contact_id UUID,
  phone TEXT,
  template_params JSONB,
  attempts INTEGER
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN QUERY
  WITH next_rec AS (
    SELECT r.id
    FROM broadcast_recipients r
    WHERE r.broadcast_id = p_broadcast_id
      AND r.status = 'pending'
    ORDER BY r.created_at ASC
    LIMIT 1
    FOR UPDATE SKIP LOCKED
  )
  UPDATE broadcast_recipients r
  SET status = 'processing',
      attempts = r.attempts + 1,
      last_attempt_at = NOW()
  FROM next_rec, contacts c
  WHERE r.id = next_rec.id AND r.contact_id = c.id
  RETURNING r.id, r.contact_id, c.phone, r.template_params, r.attempts;
END;
$$;

REVOKE ALL ON FUNCTION public.claim_next_broadcast_recipient(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.claim_next_broadcast_recipient(UUID) FROM anon;
REVOKE ALL ON FUNCTION public.claim_next_broadcast_recipient(UUID) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.claim_next_broadcast_recipient(UUID) TO service_role;
