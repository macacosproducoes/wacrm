-- ============================================================
-- 044_central_library_welcome_and_followups.sql
--
-- Evolução Completa da Biblioteca Central de Respostas:
-- 1. Categorias Padronizadas e Customizadas (quick_reply_categories)
-- 2. Evolução de quick_replies (category_id, usage_count)
-- 3. Configuração de Boas-vindas da Conta (welcome_automation_configs)
-- 4. Log / Idempotência de Boas-vindas (welcome_message_logs)
-- 5. Motor de Follow-ups Condicionais (conversation_follow_ups)
-- 6. Função de incremento atômico de uso de respostas
-- ============================================================

-- 1. Categorias Padronizadas e Customizadas
CREATE TABLE IF NOT EXISTS quick_reply_categories (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT,
  icon TEXT DEFAULT 'folder',
  color TEXT DEFAULT '#EAB308',
  order_index INTEGER DEFAULT 0,
  is_active BOOLEAN DEFAULT TRUE,
  is_system BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(account_id, name)
);

CREATE INDEX IF NOT EXISTS idx_qr_cat_account ON quick_reply_categories(account_id, order_index);

ALTER TABLE quick_reply_categories ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS qr_cat_select ON quick_reply_categories;
CREATE POLICY qr_cat_select ON quick_reply_categories FOR SELECT USING (is_account_member(account_id));
DROP POLICY IF EXISTS qr_cat_insert ON quick_reply_categories;
CREATE POLICY qr_cat_insert ON quick_reply_categories FOR INSERT WITH CHECK (is_account_member(account_id, 'agent'));
DROP POLICY IF EXISTS qr_cat_update ON quick_reply_categories;
CREATE POLICY qr_cat_update ON quick_reply_categories FOR UPDATE USING (is_account_member(account_id, 'agent'));
DROP POLICY IF EXISTS qr_cat_delete ON quick_reply_categories;
CREATE POLICY qr_cat_delete ON quick_reply_categories FOR DELETE USING (is_account_member(account_id, 'agent'));

-- 2. Evolução de quick_replies (category_id, usage_count)
ALTER TABLE quick_replies
  ADD COLUMN IF NOT EXISTS category_id UUID REFERENCES quick_reply_categories(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS usage_count INTEGER DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_quick_replies_usage ON quick_replies(account_id, usage_count DESC);
CREATE INDEX IF NOT EXISTS idx_quick_replies_cat_id ON quick_replies(category_id);

-- 3. Configuração de Boas-vindas da Conta
CREATE TABLE IF NOT EXISTS welcome_automation_configs (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE UNIQUE,
  is_active BOOLEAN NOT NULL DEFAULT FALSE,
  response_id UUID REFERENCES quick_replies(id) ON DELETE SET NULL,
  inactivity_window_days INTEGER NOT NULL DEFAULT 14,
  send_if_human_active BOOLEAN NOT NULL DEFAULT FALSE,
  follow_ups JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_welcome_config_account ON welcome_automation_configs(account_id);

ALTER TABLE welcome_automation_configs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS welcome_cfg_select ON welcome_automation_configs;
CREATE POLICY welcome_cfg_select ON welcome_automation_configs FOR SELECT USING (is_account_member(account_id));
DROP POLICY IF EXISTS welcome_cfg_insert ON welcome_automation_configs;
CREATE POLICY welcome_cfg_insert ON welcome_automation_configs FOR INSERT WITH CHECK (is_account_member(account_id, 'agent'));
DROP POLICY IF EXISTS welcome_cfg_update ON welcome_automation_configs;
CREATE POLICY welcome_cfg_update ON welcome_automation_configs FOR UPDATE USING (is_account_member(account_id, 'agent'));
DROP POLICY IF EXISTS welcome_cfg_delete ON welcome_automation_configs;
CREATE POLICY welcome_cfg_delete ON welcome_automation_configs FOR DELETE USING (is_account_member(account_id, 'agent'));

-- 4. Histórico / Idempotência de Boas-vindas enviadas
CREATE TABLE IF NOT EXISTS welcome_message_logs (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  contact_id UUID REFERENCES contacts(id) ON DELETE SET NULL,
  response_id UUID REFERENCES quick_replies(id) ON DELETE SET NULL,
  uazapi_message_id TEXT,
  sent_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_welcome_logs_conv ON welcome_message_logs(conversation_id, sent_at DESC);
CREATE INDEX IF NOT EXISTS idx_welcome_logs_account ON welcome_message_logs(account_id, sent_at DESC);

ALTER TABLE welcome_message_logs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS welcome_log_select ON welcome_message_logs;
CREATE POLICY welcome_log_select ON welcome_message_logs FOR SELECT USING (is_account_member(account_id));

-- 5. Fila e Registro de Follow-ups Condicionais (Automáticos e Manuais)
CREATE TABLE IF NOT EXISTS conversation_follow_ups (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  contact_id UUID REFERENCES contacts(id) ON DELETE SET NULL,
  response_id UUID NOT NULL REFERENCES quick_replies(id) ON DELETE CASCADE,
  source TEXT NOT NULL CHECK (source IN ('welcome_automation', 'manual', 'sequence', 'automation_rule')),
  step_number INTEGER DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'scheduled' CHECK (status IN ('pending', 'scheduled', 'processing', 'sent', 'cancelled', 'failed', 'completed')),
  scheduled_at TIMESTAMPTZ NOT NULL,
  sent_at TIMESTAMPTZ,
  cancelled_at TIMESTAMPTZ,
  cancel_reason TEXT,
  failed_at TIMESTAMPTZ,
  error_message TEXT,
  uazapi_message_id TEXT,
  cancel_on_client_reply BOOLEAN NOT NULL DEFAULT TRUE,
  cancel_on_agent_reply BOOLEAN NOT NULL DEFAULT TRUE,
  created_by_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  idempotency_key TEXT UNIQUE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_follow_ups_due ON conversation_follow_ups(scheduled_at) WHERE status IN ('pending', 'scheduled');
CREATE INDEX IF NOT EXISTS idx_follow_ups_conv ON conversation_follow_ups(conversation_id, status);
CREATE INDEX IF NOT EXISTS idx_follow_ups_account ON conversation_follow_ups(account_id, scheduled_at);

ALTER TABLE conversation_follow_ups ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS follow_ups_select ON conversation_follow_ups;
CREATE POLICY follow_ups_select ON conversation_follow_ups FOR SELECT USING (is_account_member(account_id));
DROP POLICY IF EXISTS follow_ups_insert ON conversation_follow_ups;
CREATE POLICY follow_ups_insert ON conversation_follow_ups FOR INSERT WITH CHECK (is_account_member(account_id, 'agent'));
DROP POLICY IF EXISTS follow_ups_update ON conversation_follow_ups;
CREATE POLICY follow_ups_update ON conversation_follow_ups FOR UPDATE USING (is_account_member(account_id, 'agent'));
DROP POLICY IF EXISTS follow_ups_delete ON conversation_follow_ups;
CREATE POLICY follow_ups_delete ON conversation_follow_ups FOR DELETE USING (is_account_member(account_id, 'agent'));

-- 6. Função de incremento atômico de uso de respostas rápidas
CREATE OR REPLACE FUNCTION increment_quick_reply_usage(p_id UUID)
RETURNS VOID AS $$
BEGIN
  UPDATE quick_replies SET usage_count = COALESCE(usage_count, 0) + 1 WHERE id = p_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
