-- ============================================================
-- 041_quick_replies_zap_plus.sql
--
-- Enhances quick_replies to support ZapPlus-style voice audios,
-- shortcuts (/command), categories, and media attachments.
-- ============================================================

-- Expand kind check to allow 'audio' and 'media'
ALTER TABLE quick_replies DROP CONSTRAINT IF EXISTS quick_replies_kind_check;
DO $$
BEGIN
  ALTER TABLE quick_replies ADD CONSTRAINT quick_replies_kind_check CHECK (kind IN ('text', 'interactive', 'audio', 'media'));
EXCEPTION
  WHEN OTHERS THEN NULL;
END $$;

-- Add extended columns for fast indexing and direct schema storage
ALTER TABLE quick_replies
  ADD COLUMN IF NOT EXISTS shortcut TEXT,
  ADD COLUMN IF NOT EXISTS category TEXT DEFAULT 'Geral',
  ADD COLUMN IF NOT EXISTS media_url TEXT,
  ADD COLUMN IF NOT EXISTS media_type TEXT,
  ADD COLUMN IF NOT EXISTS media_duration NUMERIC;

CREATE INDEX IF NOT EXISTS idx_quick_replies_shortcut ON quick_replies(account_id, shortcut);
CREATE INDEX IF NOT EXISTS idx_quick_replies_category ON quick_replies(account_id, category);
