import { supabaseAdmin } from '@/lib/flows/admin-client';
import { type PixKeyType, validatePixKey } from './pix-validator';

export interface PixConfig {
  pix_key: string;
  pix_key_type: PixKeyType;
  pix_merchant_name: string;
  pix_follow_up_enabled?: boolean;
  pix_follow_up_type?: 'text' | 'audio';
  pix_follow_up_quick_reply_id?: string | null;
  pix_follow_up_content?: string;
  pix_follow_up_media_url?: string | null;
  pix_follow_up_delay_seconds?: number;
}

/**
 * Fetch the configured company PIX details for an account.
 */
export async function getPixConfig(accountId: string): Promise<PixConfig | null> {
  const admin = supabaseAdmin();

  const query = admin
    .from('whatsapp_connections')
    .select('id, provider_config, is_active')
    .eq('account_id', accountId);

  const res = typeof (query as any)?.order === 'function'
    ? await (query as any).order('is_active', { ascending: false })
    : await query;

  const conns = res?.data;

  if (!conns || conns.length === 0) return null;

  // Search in active connection first, then any connection that has PIX configured
  for (const c of conns) {
    const cfg = (c.provider_config || {}) as Record<string, any>;
    if (cfg.pix_key && cfg.pix_key_type) {
      return {
        pix_key: String(cfg.pix_key).trim(),
        pix_key_type: String(cfg.pix_key_type).toUpperCase() as PixKeyType,
        pix_merchant_name: String(cfg.pix_merchant_name || 'Pix').trim(),
        pix_follow_up_enabled: Boolean(cfg.pix_follow_up_enabled),
        pix_follow_up_type: cfg.pix_follow_up_type === 'audio' ? 'audio' : 'text',
        pix_follow_up_quick_reply_id: cfg.pix_follow_up_quick_reply_id || null,
        pix_follow_up_content: cfg.pix_follow_up_content || '',
        pix_follow_up_media_url: cfg.pix_follow_up_media_url || null,
        pix_follow_up_delay_seconds: typeof cfg.pix_follow_up_delay_seconds === 'number' ? cfg.pix_follow_up_delay_seconds : 5,
      };
    }
  }

  return null;
}

/**
 * Save or update company PIX details for an account.
 */
export async function savePixConfig(
  accountId: string,
  config: {
    pix_key: string;
    pix_key_type: PixKeyType;
    pix_merchant_name: string;
    pix_follow_up_enabled?: boolean;
    pix_follow_up_type?: 'text' | 'audio';
    pix_follow_up_quick_reply_id?: string | null;
    pix_follow_up_content?: string;
    pix_follow_up_media_url?: string | null;
    pix_follow_up_delay_seconds?: number;
  }
): Promise<{ success: boolean; error?: string; config?: PixConfig }> {
  // Validate the key first
  const validation = validatePixKey(config.pix_key, config.pix_key_type);
  if (!validation.valid) {
    return { success: false, error: validation.error || 'Chave PIX inválida.' };
  }

  const merchantName = (config.pix_merchant_name || '').trim() || 'Pix';
  const admin = supabaseAdmin();

  // Find connections for the account
  const { data: conns } = await admin
    .from('whatsapp_connections')
    .select('id, provider_config')
    .eq('account_id', accountId);

  if (!conns || conns.length === 0) {
    return {
      success: false,
      error: 'Nenhuma conexão de WhatsApp encontrada para esta conta. Conecte o WhatsApp antes de salvar o PIX.',
    };
  }

  // Update provider_config in all connections for this account
  for (const c of conns) {
    const current = (c.provider_config || {}) as Record<string, any>;
    await admin
      .from('whatsapp_connections')
      .update({
        provider_config: {
          ...current,
          pix_key: validation.formattedKey,
          pix_key_type: config.pix_key_type,
          pix_merchant_name: merchantName,
          pix_follow_up_enabled: Boolean(config.pix_follow_up_enabled),
          pix_follow_up_type: config.pix_follow_up_type || 'text',
          pix_follow_up_quick_reply_id: config.pix_follow_up_quick_reply_id || null,
          pix_follow_up_content: config.pix_follow_up_content || '',
          pix_follow_up_media_url: config.pix_follow_up_media_url || null,
          pix_follow_up_delay_seconds: typeof config.pix_follow_up_delay_seconds === 'number' ? config.pix_follow_up_delay_seconds : 5,
        },
        updated_at: new Date().toISOString(),
      })
      .eq('id', c.id);
  }

  return {
    success: true,
    config: {
      pix_key: validation.formattedKey,
      pix_key_type: config.pix_key_type,
      pix_merchant_name: merchantName,
      pix_follow_up_enabled: Boolean(config.pix_follow_up_enabled),
      pix_follow_up_type: config.pix_follow_up_type || 'text',
      pix_follow_up_quick_reply_id: config.pix_follow_up_quick_reply_id || null,
      pix_follow_up_content: config.pix_follow_up_content || '',
      pix_follow_up_media_url: config.pix_follow_up_media_url || null,
      pix_follow_up_delay_seconds: typeof config.pix_follow_up_delay_seconds === 'number' ? config.pix_follow_up_delay_seconds : 5,
    },
  };
}
