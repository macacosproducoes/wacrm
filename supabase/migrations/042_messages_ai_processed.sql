-- ============================================================
-- 042_messages_ai_processed.sql
--
-- Adds ai_processed_at timestamp to messages to track which
-- incoming customer messages have already been included in an
-- AI auto-reply batch.
-- ============================================================

ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS ai_processed_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_messages_ai_processed
  ON messages(conversation_id, ai_processed_at)
  WHERE sender_type = 'customer';
