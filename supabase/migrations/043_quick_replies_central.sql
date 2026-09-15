-- ============================================================
-- 043_quick_replies_central.sql
--
-- Central de Respostas Rápidas & Atalhos (Estilo ZapPlus)
-- Expande a tabela quick_replies para suportar 6 tipos de mídia:
-- (text, audio, image, video, document, sequence, interactive),
-- cores identificadoras, favoritos, ordenação, escopo (equipe/pessoal),
-- e itens de sequência com delay.
-- ============================================================

-- 1. Expande a restrição CHECK da coluna kind
ALTER TABLE quick_replies DROP CONSTRAINT IF EXISTS quick_replies_kind_check;
DO $$
BEGIN
  ALTER TABLE quick_replies ADD CONSTRAINT quick_replies_kind_check 
    CHECK (kind IN ('text', 'interactive', 'audio', 'image', 'video', 'document', 'media', 'sequence'));
EXCEPTION
  WHEN OTHERS THEN NULL;
END $$;

-- 2. Adiciona colunas para central de atalhos e metadados
ALTER TABLE quick_replies
  ADD COLUMN IF NOT EXISTS shortcut TEXT,
  ADD COLUMN IF NOT EXISTS category TEXT DEFAULT 'Geral',
  ADD COLUMN IF NOT EXISTS color TEXT DEFAULT '#EAB308',
  ADD COLUMN IF NOT EXISTS media_url TEXT,
  ADD COLUMN IF NOT EXISTS media_type TEXT,
  ADD COLUMN IF NOT EXISTS media_duration NUMERIC,
  ADD COLUMN IF NOT EXISTS is_favorite BOOLEAN DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS order_index INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS is_active BOOLEAN DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS scope TEXT DEFAULT 'team' CHECK (scope IN ('team', 'personal')),
  ADD COLUMN IF NOT EXISTS sequence_items JSONB;

-- 3. Índices para consultas de alta performance
CREATE INDEX IF NOT EXISTS idx_quick_replies_account_fav ON quick_replies(account_id, is_favorite);
CREATE INDEX IF NOT EXISTS idx_quick_replies_account_cat ON quick_replies(account_id, category);
CREATE INDEX IF NOT EXISTS idx_quick_replies_account_short ON quick_replies(account_id, shortcut);
CREATE INDEX IF NOT EXISTS idx_quick_replies_account_order ON quick_replies(account_id, order_index);
