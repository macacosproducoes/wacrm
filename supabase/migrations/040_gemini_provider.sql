-- ============================================================
-- Migration 040: Add Google Gemini as an AI Provider
--
-- Expands the provider CHECK constraints on `ai_configs` and
-- `ai_usage_log` to include 'gemini' alongside 'openai' and 'anthropic'.
-- ============================================================

-- 1. ai_configs: expand provider check constraint
ALTER TABLE ai_configs
  DROP CONSTRAINT IF EXISTS ai_configs_provider_check;

ALTER TABLE ai_configs
  ADD CONSTRAINT ai_configs_provider_check
  CHECK (provider IN ('openai', 'anthropic', 'gemini'));

-- 2. ai_usage_log: expand provider check constraint
ALTER TABLE ai_usage_log
  DROP CONSTRAINT IF EXISTS ai_usage_log_provider_check;

ALTER TABLE ai_usage_log
  ADD CONSTRAINT ai_usage_log_provider_check
  CHECK (provider IN ('openai', 'anthropic', 'gemini'));
