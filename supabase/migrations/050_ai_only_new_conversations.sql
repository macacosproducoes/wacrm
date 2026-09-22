-- ============================================================
-- 050_ai_only_new_conversations.sql
--
-- Adds only_new_conversations boolean column to ai_configs.
-- When true, the AI responds only to new contacts who have no
-- prior conversation history. Existing contacts with old messages
-- are routed directly to human atendimento.
-- ============================================================

ALTER TABLE ai_configs
  ADD COLUMN IF NOT EXISTS only_new_conversations BOOLEAN DEFAULT false;
