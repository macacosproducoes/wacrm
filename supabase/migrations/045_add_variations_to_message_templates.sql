-- Migration 045: Add variations column to message_templates
ALTER TABLE message_templates ADD COLUMN IF NOT EXISTS variations text[];
COMMENT ON COLUMN message_templates.variations IS 'Optional array of message variations rotated during broadcast to avoid spam patterns';
