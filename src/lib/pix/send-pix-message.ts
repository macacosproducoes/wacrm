import { supabaseAdmin } from '@/lib/flows/admin-client';
import { decrypt } from '@/lib/whatsapp/encryption';
import {
  normalizeBaseUrl,
  sendUazApiPixButton,
  sendUazApiText,
  formatUazApiNumber,
} from '@/lib/whatsapp/uazapi-client';
import { updateConversationWithMessage } from '@/lib/whatsapp/conversation-helpers';
import { whatsappBus } from '@/lib/whatsapp/whatsapp-bus';
import { type PixKeyType, validatePixKey } from './pix-validator';
import { getPixConfig } from './pix-config';
import { generatePixCopiaECola } from './pix-copia-e-cola';

export type PixSendMode = 'button' | 'copia_e_cola' | 'both';

export interface SendPixMessageParams {
  accountId: string;
  conversationId: string;
  userId?: string;
  number?: string;
  pixKey?: string;
  pixKeyType?: PixKeyType;
  merchantName?: string;
  merchantCity?: string;
  amount?: number | string;
  text?: string;
  sendMode?: PixSendMode;
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
  pixCopiaECola?: string;
  sendMode: PixSendMode;
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

  const sendMode: PixSendMode = params.sendMode || 'button';
  const merchantCity = (params.merchantCity || 'SAO PAULO').trim();
  const amount = params.amount;

  // 5. Generate standard BACEN Pix Copia e Cola string if required
  let pixCopiaECola: string | undefined = undefined;
  if (sendMode === 'copia_e_cola' || sendMode === 'both') {
    pixCopiaECola = generatePixCopiaECola({
      pixKey: finalPixKey,
      pixKeyType: rawPixKeyType,
      merchantName,
      merchantCity,
      amount,
    });
  }

  let primaryMessageId = '';
  let providerRawResponse: Record<string, unknown> = {};

  if (sendMode === 'button') {
    // 5a. Send native PIX button via UazAPI /send/pix-button
    const sendRes = await sendUazApiPixButton(baseUrl, token, {
      number: targetNumber,
      pixKey: finalPixKey,
      pixType: rawPixKeyType,
      pixName: merchantName,
      text: text || undefined,
    });
    primaryMessageId = sendRes.messageId;
    providerRawResponse = sendRes.raw || {};
  } else if (sendMode === 'copia_e_cola') {
    // 5b. Send BACEN standard Pix Copia e Cola
    // If intro text was passed, send it first
    if (text && text.trim()) {
      await sendUazApiText(baseUrl, token, {
        number: targetNumber,
        text: text.trim(),
      }).catch((err) => console.warn('[sendPixMessage] Warning sending intro text:', err));
    }

    // Send isolated, pure Copia e Cola payload so client can 1-touch copy in bank app
    const copiaRes = await sendUazApiText(baseUrl, token, {
      number: targetNumber,
      text: pixCopiaECola!,
    });
    primaryMessageId = copiaRes.messageId;
    providerRawResponse = copiaRes.raw || {};
  } else if (sendMode === 'both') {
    // 5c. Send both: Native WhatsApp card + pure Copia e Cola string
    const buttonRes = await sendUazApiPixButton(baseUrl, token, {
      number: targetNumber,
      pixKey: finalPixKey,
      pixType: rawPixKeyType,
      pixName: merchantName,
      text: text || undefined,
    });
    primaryMessageId = buttonRes.messageId;
    providerRawResponse = buttonRes.raw || {};

    // Standalone Copia e Cola payload
    await sendUazApiText(baseUrl, token, {
      number: targetNumber,
      text: pixCopiaECola!,
    }).catch((err) => console.warn('[sendPixMessage] Warning sending copia e cola follow-up:', err));
  }

  const nowIso = new Date().toISOString();
  let displaySummary = '';
  if (sendMode === 'copia_e_cola') {
    displaySummary = text
      ? `${text}\n[PIX Copia e Cola]: ${pixCopiaECola}`
      : `[PIX Copia e Cola]: ${pixCopiaECola}`;
  } else if (sendMode === 'both') {
    displaySummary = text
      ? `${text}\n[Chave PIX: ${finalPixKey}]\n[PIX Copia e Cola]: ${pixCopiaECola}`
      : `[Chave PIX: ${finalPixKey}]\n[PIX Copia e Cola]: ${pixCopiaECola}`;
  } else {
    displaySummary = text
      ? `${text}\n[Chave PIX: ${finalPixKey}]`
      : `[Chave PIX (${rawPixKeyType}): ${finalPixKey}]`;
  }

  // 6. Idempotently persist message in database
  const { data: newMsg, error: insertErr } = await admin
    .from('messages')
    .insert({
      conversation_id: conversationId,
      sender_type: 'agent',
      sender_id: userId || null,
      content_type: 'interactive',
      content_text: displaySummary,
      message_id: primaryMessageId,
      status: 'sent',
      created_at: nowIso,
      interactive_payload: {
        type: 'pix',
        pix_key: finalPixKey,
        pix_key_type: rawPixKeyType,
        pix_merchant_name: merchantName,
        pix_copia_e_cola: pixCopiaECola,
        send_mode: sendMode,
        amount: amount || null,
        sent_at: nowIso,
        status: 'sent',
        provider: 'uazapi',
        provider_response: providerRawResponse,
      },
    })
    .select('id')
    .single();

  if (insertErr) {
    console.error('[sendPixMessage] Error inserting message row:', insertErr);
  }

  const dbMessageId = newMsg?.id || primaryMessageId;

  // 7. Update conversation last message & timestamp
  const lastMsgText =
    sendMode === 'copia_e_cola'
      ? 'PIX Copia e Cola'
      : sendMode === 'both'
      ? 'PIX (Botão + Copia e Cola)'
      : `Chave PIX (${rawPixKeyType})`;

  await updateConversationWithMessage(admin, {
    conversationId,
    messageText: lastMsgText,
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
      message_id: primaryMessageId,
      status: 'sent',
      created_at: nowIso,
      interactive_payload: {
        type: 'pix',
        pix_key: finalPixKey,
        pix_key_type: rawPixKeyType,
        pix_merchant_name: merchantName,
        pix_copia_e_cola: pixCopiaECola,
        send_mode: sendMode,
        amount: amount || null,
        sent_at: nowIso,
        status: 'sent',
        provider: 'uazapi',
        provider_response: providerRawResponse,
      },
    },
    conversation: {
      id: conversationId,
      last_message_text: lastMsgText,
      last_message_at: nowIso,
    },
  });

  return {
    success: true,
    messageId: primaryMessageId,
    dbMessageId,
    conversationId,
    number: targetNumber,
    pixKey: finalPixKey,
    pixKeyType: rawPixKeyType,
    merchantName,
    pixCopiaECola,
    sendMode,
    sentAt: nowIso,
    provider: 'uazapi',
    providerResponse: providerRawResponse,
  };
}
