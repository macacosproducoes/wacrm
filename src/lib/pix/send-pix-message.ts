import { supabaseAdmin } from '@/lib/flows/admin-client';
import { decrypt } from '@/lib/whatsapp/encryption';
import { normalizeBaseUrl, sendUazApiPixButton, formatUazApiNumber } from '@/lib/whatsapp/uazapi-client';
import { updateConversationWithMessage } from '@/lib/whatsapp/conversation-helpers';
import { whatsappBus } from '@/lib/whatsapp/whatsapp-bus';
import { type PixKeyType, validatePixKey } from './pix-validator';
import { getPixConfig } from './pix-config';

export interface SendPixMessageParams {
  accountId: string;
  conversationId: string;
  userId?: string;
  number?: string;
  pixKey?: string;
  pixKeyType?: PixKeyType;
  merchantName?: string;
  text?: string;
}

export interface SendPixResult {
  success: boolean;
  messageId: string;
  dbMessageId: string;
  conversationId: string;
  number: string;
  pixKey: string;
  pixKeyType: PixKeyType;
  merchantName: string;
  sentAt: string;
  provider: 'uazapi';
  providerResponse: Record<string, unknown>;
}

/**
 * Central function to send a native WhatsApp PIX key message.
 *
 * Requirements:
 * - Does NOT send as raw text; uses WhatsApp native PIX card with copy action
 * - Validates key format (EMAIL, PHONE, CPF, EVP)
 * - Resolves company configuration if not overridden
 * - Maintains idempotency and records in DB:
 *     message_id, conversation_id, pix_key_type, sent_at, status, provider, provider_response
 */
export async function sendPixMessage(params: SendPixMessageParams): Promise<SendPixResult> {
  const {
    accountId,
    conversationId,
    userId,
    text,
  } = params;

  const admin = supabaseAdmin();

  // 1. Resolve Contact & Phone number if not passed directly
  let targetNumber = params.number ? formatUazApiNumber(params.number) : '';
  if (!targetNumber) {
    const { data: convData, error: convErr } = await admin
      .from('conversations')
      .select('id, contact_id, contacts (id, phone, name)')
      .eq('id', conversationId)
      .eq('account_id', accountId)
      .single();

    if (convErr || !convData) {
      throw new Error('Conversa não encontrada.');
    }

    const contactPhone = (convData as any)?.contacts?.phone;
    if (!contactPhone) {
      throw new Error('Contato não possui número de telefone cadastrado.');
    }

    targetNumber = formatUazApiNumber(contactPhone);
  }

  // 2. Resolve PIX parameters from params or Company Configuration
  let rawPixKey = (params.pixKey || '').trim();
  let rawPixKeyType = params.pixKeyType;
  let rawMerchantName = (params.merchantName || '').trim();

  if (!rawPixKey || !rawPixKeyType) {
    const savedConfig = await getPixConfig(accountId);
    if (!savedConfig || !savedConfig.pix_key) {
      throw new Error(
        'Nenhuma chave PIX configurada para a empresa. Cadastre a chave PIX nas configurações antes de enviar.'
      );
    }
    rawPixKey = savedConfig.pix_key;
    rawPixKeyType = savedConfig.pix_key_type;
    rawMerchantName = rawMerchantName || savedConfig.pix_merchant_name;
  }

  const merchantName = rawMerchantName || 'Pix';

  // 3. Strict Validation
  const validation = validatePixKey(rawPixKey, rawPixKeyType);
  if (!validation.valid) {
    throw new Error(validation.error || 'Chave PIX inválida para o tipo selecionado.');
  }

  const finalPixKey = validation.formattedKey;

  // 4. Resolve Active UazAPI connection
  const { data: activeConns } = await admin
    .from('whatsapp_connections')
    .select('*')
    .eq('account_id', accountId)
    .eq('is_active', true)
    .order('updated_at', { ascending: false });

  const uazConn = (activeConns || []).find((c) => c.provider === 'uazapi') || (activeConns || [])[0];
  if (!uazConn) {
    throw new Error('Nenhuma conexão ativa de WhatsApp encontrada para esta conta.');
  }

  const config = (uazConn.provider_config || {}) as Record<string, any>;
  const baseUrl = normalizeBaseUrl(config.base_url);

  let token = '';
  try {
    token = decrypt(config.token);
  } catch {
    token = config.token || '';
  }

  if (!token) {
    throw new Error('Token de autenticação da conexão WhatsApp inválido ou não encontrado.');
  }

  // 5. Send via UazAPI native /send/pix-button
  const sendRes = await sendUazApiPixButton(baseUrl, token, {
    number: targetNumber,
    pixKey: finalPixKey,
    pixType: rawPixKeyType,
    pixName: merchantName,
    text: text || undefined,
  });

  const nowIso = new Date().toISOString();
  const displaySummary = text
    ? `${text}\n[Chave PIX: ${finalPixKey}]`
    : `[Chave PIX (${rawPixKeyType}): ${finalPixKey}]`;

  // 6. Idempotently persist message in database
  const { data: newMsg, error: insertErr } = await admin
    .from('messages')
    .insert({
      conversation_id: conversationId,
      sender_type: 'agent',
      sender_id: userId || null,
      content_type: 'interactive',
      content_text: displaySummary,
      message_id: sendRes.messageId,
      status: 'sent',
      created_at: nowIso,
      interactive_payload: {
        type: 'pix',
        pix_key: finalPixKey,
        pix_key_type: rawPixKeyType,
        pix_merchant_name: merchantName,
        sent_at: nowIso,
        status: 'sent',
        provider: 'uazapi',
        provider_response: sendRes.raw || {},
      },
    })
    .select('id')
    .single();

  if (insertErr) {
    console.error('[sendPixMessage] Error inserting message row:', insertErr);
  }

  const dbMessageId = newMsg?.id || sendRes.messageId;

  // 7. Update conversation last message & timestamp
  await updateConversationWithMessage(admin, {
    conversationId,
    messageText: `Chave PIX (${rawPixKeyType})`,
    messageTimestamp: nowIso,
    isInbound: false,
    senderType: 'agent',
  });

  // 8. Real-time emit to Inbox
  whatsappBus.emitInboxEvent({
    accountId,
    conversationId,
    eventType: 'INSERT',
    message: {
      id: dbMessageId,
      conversation_id: conversationId,
      sender_type: 'agent',
      sender_id: userId || null,
      content_type: 'interactive',
      content_text: displaySummary,
      message_id: sendRes.messageId,
      status: 'sent',
      created_at: nowIso,
      interactive_payload: {
        type: 'pix',
        pix_key: finalPixKey,
        pix_key_type: rawPixKeyType,
        pix_merchant_name: merchantName,
        sent_at: nowIso,
        status: 'sent',
        provider: 'uazapi',
        provider_response: sendRes.raw || {},
      },
    },
    conversation: {
      id: conversationId,
      last_message_text: `Chave PIX (${rawPixKeyType})`,
      last_message_at: nowIso,
    },
  });

  return {
    success: true,
    messageId: sendRes.messageId,
    dbMessageId,
    conversationId,
    number: targetNumber,
    pixKey: finalPixKey,
    pixKeyType: rawPixKeyType,
    merchantName,
    sentAt: nowIso,
    provider: 'uazapi',
    providerResponse: sendRes.raw || {},
  };
}
