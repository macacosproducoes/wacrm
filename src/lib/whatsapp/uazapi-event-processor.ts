import { createClient as createAdminClient } from '@supabase/supabase-js';
import { formatUazApiNumber, addUazApiContact, normalizeBaseUrl } from '@/lib/whatsapp/uazapi-client';
import { decrypt } from '@/lib/whatsapp/encryption';
import { isRealWhatsAppContact } from '@/lib/whatsapp/phone-utils';
import { dispatchInboundToAiReply } from '@/lib/ai/auto-reply';
import { notifyClientPresence } from '@/lib/ai/auto-reply-debouncer';
import { whatsappBus } from '@/lib/whatsapp/whatsapp-bus';
import { sendWhatsAppPresence } from '@/lib/whatsapp/unified-presence';
import { cancelPendingFollowUps } from '@/lib/automations/follow-up-engine';
import { checkAndDispatchWelcomeMessage } from '@/lib/automations/welcome-engine';

async function downloadUazApiMediaDirect(
  baseUrl: string,
  token: string,
  messageId: string
): Promise<{ fileURL?: string; mimetype?: string } | null> {
  try {
    const res = await fetch(`${normalizeBaseUrl(baseUrl)}/message/download`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        token,
      },
      body: JSON.stringify({
        id: messageId,
        return_link: true,
        return_base64: false,
      }),
      signal: AbortSignal.timeout(4000),
    });
    if (!res.ok) return null;
    const data = await res.json().catch(() => null);
    if (data?.fileURL) {
      return { fileURL: String(data.fileURL), mimetype: data.mimetype };
    }
  } catch {
    // Non-blocking timeout
  }
  return null;
}

function supabaseAdmin() {
  return createAdminClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );
}

export interface ProcessUazApiResult {
  success: boolean;
  reason?: string;
  conversationId?: string;
  contactId?: string;
}

/**
 * Process an inbound UazAPI payload (from Webhook or SSE stream)
 */
export async function processUazApiEvent(
  body: Record<string, unknown>,
  connectionHint?: {
    id: string;
    account_id: string;
    display_name: string;
    provider_config: Record<string, unknown>;
  } | null
): Promise<ProcessUazApiResult> {
  const admin = supabaseAdmin();

  let connection = connectionHint;
  if (!connection) {
    const { data: activeConn } = await admin
      .from('whatsapp_connections')
      .select('id, account_id, display_name, provider_config')
      .eq('provider', 'uazapi')
      .eq('is_active', true)
      .maybeSingle();

    if (activeConn) {
      connection = activeConn;
    } else {
      const { data: anyConn } = await admin
        .from('whatsapp_connections')
        .select('id, account_id, display_name, provider_config')
        .eq('provider', 'uazapi')
        .limit(1)
        .maybeSingle();
      if (anyConn) connection = anyConn;
    }
  }

  if (!connection) {
    return { success: false, reason: 'no_connection' };
  }

  const eventType = String(
    body.EventType ||
    body.event ||
    body.type ||
    (body.message ? 'messages' : 'unknown')
  ).toLowerCase();

  // Handle Connection status updates
  if (eventType === 'connection') {
    const dataObj = ((body.data || body) ?? {}) as Record<string, unknown>;
    const state = dataObj.state || body.state || body.status || dataObj.status;
    let normalizedStatus: 'connected' | 'disconnected' | 'connecting' = 'disconnected';
    if (state === 'open' || state === 'connected' || body.message === 'Connection established') {
      normalizedStatus = 'connected';
    } else if (state === 'connecting') {
      normalizedStatus = 'connecting';
    }

    const updates: Record<string, unknown> = {
      status: normalizedStatus,
      last_sync_at: new Date().toISOString(),
    };
    if (body.owner) {
      updates.phone_number = formatUazApiNumber(String(body.owner));
    }

    await admin
      .from('whatsapp_connections')
      .update(updates)
      .eq('id', connection.id);

    return { success: true, reason: 'connection_status_updated' };
  }

  // Handle Client Presence (Typing / Recording / Paused)
  if (
    eventType === 'presence' ||
    eventType === 'presence_update' ||
    eventType === 'presence.update' ||
    eventType === 'chats_presence'
  ) {
    const dataObj = ((body.data || body) ?? {}) as Record<string, unknown>;
    const targetJid = String(dataObj.id || dataObj.chatId || dataObj.remoteJid || body.chatId || body.id || '');
    const presenceVal = String(dataObj.presence || dataObj.state || body.presence || '').toLowerCase();
    const isTyping = presenceVal === 'composing' || presenceVal === 'recording';

    if (targetJid && isRealWhatsAppContact(targetJid)) {
      const rawNumber = targetJid.split('@')[0].replace(/\D/g, '');
      const formattedPhone = formatUazApiNumber(rawNumber);

      const { data: contactRow } = await admin
        .from('contacts')
        .select('id')
        .eq('account_id', connection.account_id)
        .eq('phone', formattedPhone)
        .maybeSingle();

      if (contactRow) {
        const { data: convRow } = await admin
          .from('conversations')
          .select('id')
          .eq('contact_id', contactRow.id)
          .eq('account_id', connection.account_id)
          .maybeSingle();

        if (convRow) {
          notifyClientPresence(convRow.id, isTyping);
        }
      }
    }

    return { success: true, reason: 'presence_processed' };
  }

  // Handle Message Status Updates / ACKs / Delivery Receipts
  const isStatusUpdate =
    eventType === 'messages_update' ||
    eventType === 'message_update' ||
    eventType === 'messages.update' ||
    eventType === 'message.update' ||
    eventType === 'message_status' ||
    eventType === 'messages_status' ||
    eventType === 'status' ||
    eventType === 'status_update' ||
    eventType === 'ack' ||
    eventType === 'message_ack' ||
    eventType === 'receipt';

  if (isStatusUpdate) {
    const rawItems: Array<Record<string, unknown>> = Array.isArray(body.data)
      ? (body.data as Array<Record<string, unknown>>)
      : Array.isArray(body.messages)
        ? (body.messages as Array<Record<string, unknown>>)
        : [((body.data || body.message || body) ?? {}) as Record<string, unknown>];

    for (const item of rawItems) {
      if (!item || typeof item !== 'object') continue;
      const itemKey = (item.key || {}) as Record<string, unknown>;
      const rawMsgId = String(
        itemKey.id ||
        item.messageid ||
        item.id ||
        item.message_id ||
        item.msgId ||
        ''
      ).trim();
      if (!rawMsgId) continue;

      const cleanMsgId = rawMsgId.includes(':') ? rawMsgId.split(':').pop()! : rawMsgId;
      const rawStatus =
        item.status ??
        (item.update as Record<string, unknown> | undefined)?.status ??
        item.ack ??
        item.state;

      let normalizedStatus: 'sent' | 'delivered' | 'read' | null = null;
      const statusNum = typeof rawStatus === 'number' ? rawStatus : Number(rawStatus);
      const statusStr = String(rawStatus || '').toLowerCase();

      if (statusNum === 2 || statusStr === 'sent' || statusStr === 'server_ack') {
        normalizedStatus = 'sent';
      } else if (statusNum === 3 || statusStr === 'delivered' || statusStr === 'delivery_ack') {
        normalizedStatus = 'delivered';
      } else if (statusNum === 4 || statusNum === 5 || statusStr === 'read' || statusStr === 'played') {
        normalizedStatus = 'read';
      }

      if (normalizedStatus) {
        const { data: updatedMsg } = await admin
          .from('messages')
          .update({ status: normalizedStatus })
          .or(`message_id.eq.${cleanMsgId},message_id.eq.${rawMsgId}`)
          .select('id, conversation_id, status, sender_type')
          .maybeSingle();

        if (updatedMsg) {
          whatsappBus.emitInboxEvent({
            accountId: connection.account_id,
            conversationId: updatedMsg.conversation_id,
            eventType: 'UPDATE',
            message: updatedMsg,
          });
        }
      }
    }

    return { success: true, reason: 'message_status_updated' };
  }

  // Handle Chat Metadata & Contacts updates (never generate message rows)
  if (
    eventType === 'chats' ||
    eventType === 'chat' ||
    eventType === 'chats_update' ||
    eventType === 'chat_update' ||
    eventType === 'chats.update' ||
    eventType === 'chats_set' ||
    eventType === 'chats.set' ||
    eventType === 'contacts' ||
    eventType === 'contact' ||
    eventType === 'contacts_update' ||
    eventType === 'contact_update' ||
    eventType === 'contacts.update' ||
    eventType === 'contacts_set' ||
    eventType === 'contacts.set' ||
    eventType === 'labels' ||
    eventType === 'call' ||
    eventType === 'call_offer' ||
    eventType === 'qrcode'
  ) {
    return { success: true, reason: `${eventType}_event_ignored` };
  }

  // Handle Messages
  const msgData = ((body.message || body.data || body) ?? {}) as Record<string, unknown>;
  const chatData = ((body.chat || {}) ?? {}) as Record<string, unknown>;
  const key = (msgData.key || {}) as Record<string, unknown>;
  const fromMe = Boolean(
    key.fromMe ||
    msgData.fromMe ||
    msgData.from_me ||
    key.from_me ||
    body.fromMe ||
    (body.data as Record<string, unknown> | undefined)?.fromMe ||
    (body.data as Record<string, unknown> | undefined)?.from_me
  );

  // 1. STRICT GROUP VETO
  // A CRM inbox is strictly for 1-to-1 customer service.
  // Group messages (@g.us), group reactions, and group member events must NEVER
  // create 1-to-1 CRM contacts or trigger the AI auto-reply agent!
  const isGroup = Boolean(
    chatData.isGroup ||
    chatData.wa_isGroup ||
    msgData.isGroup ||
    body.isGroup ||
    String(msgData.chatid || '').includes('@g.us') ||
    String(chatData.wa_chatid || '').includes('@g.us') ||
    String(key.remoteJid || '').includes('@g.us') ||
    String(msgData.remoteJid || '').includes('@g.us') ||
    Boolean(msgData.participant || key.participant)
  );

  if (isGroup) {
    return { success: true, reason: 'group_event_ignored' };
  }

  // Extract message content object early
  const msgContentObj = ((msgData.content || msgData.message || msgData) ?? {}) as Record<string, unknown>;

  // 1.1 PROTOCOL & SYSTEM MESSAGES VETO
  const isProtocolOrStub = Boolean(
    msgData.messageType === 'protocolMessage' ||
    msgData.messageType === 'ProtocolMessage' ||
    msgData.type === 'protocol' ||
    Boolean(msgContentObj.protocolMessage) ||
    msgData.messageStubType ||
    msgData.stubType ||
    msgData.messageType === 'pollUpdateMessage' ||
    msgData.type === 'poll_update'
  );

  if (isProtocolOrStub) {
    return { success: true, reason: 'protocol_or_stub_ignored' };
  }

  // 2. STRICT REACTION VETO
  // Reactions (emojis like 👍, ❤️, 😮, etc.) are message reactions, NOT customer conversation turns.
  // They must NEVER trigger AI auto-reply or create pseudo text messages.
  const isReaction = Boolean(
    eventType === 'reaction' ||
    eventType === 'messages_reaction' ||
    msgData.messageType === 'reactionMessage' ||
    msgData.messageType === 'ReactionMessage' ||
    msgData.type === 'reaction' ||
    Boolean(msgData.reaction) ||
    Boolean(msgContentObj.reactionMessage) ||
    Boolean(msgContentObj.reaction)
  );

  if (isReaction) {
    const reactionObj = (msgData.reaction || msgContentObj.reactionMessage || msgContentObj.reaction || msgData) as Record<string, unknown>;
    const targetMetaId = String(
      (reactionObj?.key as Record<string, unknown>)?.id ||
      reactionObj?.message_id ||
      reactionObj?.id ||
      ''
    );
    const emoji = String(reactionObj?.text || reactionObj?.emoji || msgData.text || '').trim();

    if (targetMetaId) {
      const { data: targetMsg } = await admin
        .from('messages')
        .select('id, conversation_id')
        .eq('message_id', targetMetaId)
        .maybeSingle();

      if (targetMsg) {
        if (!emoji) {
          await admin
            .from('message_reactions')
            .delete()
            .eq('message_id', targetMsg.id)
            .eq('actor_type', fromMe ? 'agent' : 'customer');
        } else {
          await admin
            .from('message_reactions')
            .upsert({
              message_id: targetMsg.id,
              conversation_id: targetMsg.conversation_id,
              actor_type: fromMe ? 'agent' : 'customer',
              actor_id: connection.account_id,
              emoji,
              created_at: new Date().toISOString(),
            }, { onConflict: 'message_id,actor_type,actor_id' });
        }
      }
    }
    return { success: true, reason: 'reaction_processed_no_ai' };
  }

  // Resolve phone number from chatid / remoteJid / sender
  // In WhatsApp / Baileys:
  // - chatid or remoteJid has the real conversation target, e.g. "5511971121710@s.whatsapp.net"
  // - sender may be an internal "@lid" device address (e.g. "104402417401920@lid"), which is NOT a phone number!
  const candidates = [
    msgData.chatid,
    chatData.wa_chatid,
    key.remoteJid,
    msgData.remoteJid,
    chatData.phone,
    msgData.phone,
    msgData.number,
    msgData.from,
    msgData.sender_pn,
    msgData.sender,
  ]
    .filter(Boolean)
    .map(String);

  // Prioritize candidates ending in @s.whatsapp.net or clean non-LID numbers
  let targetJid = candidates.find((c) => c.includes('@s.whatsapp.net')) || '';
  if (!targetJid) {
    targetJid =
      candidates.find((c) => !c.includes('@lid') && !c.includes('@g.us') && !c.includes('@broadcast') && !c.includes('@newsletter')) ||
      candidates[0] ||
      '';
  }

  if (!isRealWhatsAppContact(targetJid)) {
    return { success: false, reason: 'invalid_lid_or_group_sender' };
  }

  const rawNumber = targetJid.split('@')[0].replace(/\D/g, '');
  const formattedPhone = formatUazApiNumber(rawNumber);

  // Extract message content
  let messageText = '';
  let contentType: 'text' | 'image' | 'audio' | 'document' | 'video' = 'text';
  let mediaUrl: string | null = null;

  const extText = msgContentObj.extendedTextMessage as Record<string, unknown> | undefined;
  const imgMsg = msgContentObj.imageMessage as Record<string, unknown> | undefined;
  const audMsg = msgContentObj.audioMessage as Record<string, unknown> | undefined;
  const vidMsg = msgContentObj.videoMessage as Record<string, unknown> | undefined;
  const docMsg = msgContentObj.documentMessage as Record<string, unknown> | undefined;
  const stickerMsg = msgContentObj.stickerMessage as Record<string, unknown> | undefined;
  const locMsg = (msgContentObj.locationMessage || msgContentObj.liveLocationMessage) as Record<string, unknown> | undefined;
  const contactMsg = (msgContentObj.contactMessage || msgContentObj.contactsArrayMessage) as Record<string, unknown> | undefined;

  // Check if this messages event is actually a status/ack event without content
  const hasStatusWithoutContent = Boolean(
    (msgData.status !== undefined || (msgData.update as Record<string, unknown> | undefined)?.status !== undefined || msgData.ack !== undefined) &&
    !msgData.text &&
    !msgContentObj.text &&
    !msgContentObj.conversation &&
    !extText?.text &&
    !imgMsg &&
    !audMsg &&
    !vidMsg &&
    !docMsg &&
    !stickerMsg &&
    !locMsg &&
    !contactMsg
  );

  if (hasStatusWithoutContent) {
    const rawMsgId = String(key.id || msgData.messageid || msgData.id || '');
    if (rawMsgId) {
      const cleanMsgId = rawMsgId.includes(':') ? rawMsgId.split(':').pop()! : rawMsgId;
      const rawStatus = msgData.status ?? (msgData.update as Record<string, unknown> | undefined)?.status ?? msgData.ack;
      let normalizedStatus: 'sent' | 'delivered' | 'read' | null = null;
      const statusNum = typeof rawStatus === 'number' ? rawStatus : Number(rawStatus);
      const statusStr = String(rawStatus || '').toLowerCase();
      if (statusNum === 2 || statusStr === 'sent' || statusStr === 'server_ack') normalizedStatus = 'sent';
      else if (statusNum === 3 || statusStr === 'delivered' || statusStr === 'delivery_ack') normalizedStatus = 'delivered';
      else if (statusNum === 4 || statusNum === 5 || statusStr === 'read' || statusStr === 'played') normalizedStatus = 'read';

      if (normalizedStatus) {
        await admin
          .from('messages')
          .update({ status: normalizedStatus })
          .or(`message_id.eq.${cleanMsgId},message_id.eq.${rawMsgId}`);
      }
    }
    return { success: true, reason: 'message_status_updated' };
  }

  if (typeof msgData.text === 'string' && msgData.text.trim()) {
    messageText = msgData.text.trim();
  } else if (typeof msgContentObj.text === 'string' && msgContentObj.text.trim()) {
    messageText = msgContentObj.text.trim();
  } else if (msgContentObj.conversation && String(msgContentObj.conversation).trim()) {
    messageText = String(msgContentObj.conversation).trim();
  } else if (extText?.text && String(extText.text).trim()) {
    messageText = String(extText.text).trim();
  } else if (imgMsg) {
    contentType = 'image';
    messageText = String(imgMsg.caption || '[Imagem]').trim();
    const rawThumb =
      imgMsg.jpegThumbnail ||
      (msgData as Record<string, unknown>).jpegThumbnail ||
      (msgData as Record<string, unknown>).thumbnail;
    if (rawThumb) {
      const b64 =
        typeof rawThumb === 'string'
          ? rawThumb
          : Buffer.isBuffer(rawThumb)
            ? (rawThumb as Buffer).toString('base64')
            : null;
      if (b64) {
        mediaUrl = b64.startsWith('data:') ? b64 : `data:image/jpeg;base64,${b64}`;
      }
    }
    const publicUrl = (msgData.fileURL || msgContentObj.fileURL || (msgData as Record<string, unknown>).url) as string | undefined;
    if (publicUrl && !publicUrl.includes('mmg.whatsapp.net')) {
      mediaUrl = publicUrl;
    }
    if (!mediaUrl && typeof imgMsg.url === 'string') {
      mediaUrl = imgMsg.url;
    }
  } else if (audMsg) {
    contentType = 'audio';
    messageText = '[Áudio]';
    const publicUrl = (msgData.fileURL || msgContentObj.fileURL || (msgData as Record<string, unknown>).url) as string | undefined;
    mediaUrl = (publicUrl && !publicUrl.includes('mmg.whatsapp.net')) ? publicUrl : (audMsg.url as string) || null;
  } else if (vidMsg) {
    contentType = 'video';
    messageText = String(vidMsg.caption || '[Vídeo]').trim();
    const publicUrl = (msgData.fileURL || msgContentObj.fileURL || (msgData as Record<string, unknown>).url) as string | undefined;
    mediaUrl = (publicUrl && !publicUrl.includes('mmg.whatsapp.net')) ? publicUrl : (vidMsg.url as string) || null;
  } else if (docMsg) {
    const isDocImage =
      String(docMsg.mimetype || '').startsWith('image/') ||
      /\.(jpe?g|png|gif|webp|bmp)$/i.test(String(docMsg.fileName || ''));
    if (isDocImage) {
      contentType = 'image';
      messageText = String(docMsg.caption || docMsg.fileName || '[Imagem]').trim();
    } else {
      contentType = 'document';
      messageText = String(docMsg.fileName || '[Documento]').trim();
    }
    const publicUrl = (msgData.fileURL || msgContentObj.fileURL || (msgData as Record<string, unknown>).url) as string | undefined;
    mediaUrl = (publicUrl && !publicUrl.includes('mmg.whatsapp.net')) ? publicUrl : (docMsg.url as string) || null;
  } else if (stickerMsg) {
    contentType = 'image';
    messageText = '[Figurinha]';
    const publicUrl = (msgData.fileURL || msgContentObj.fileURL || (msgData as Record<string, unknown>).url) as string | undefined;
    mediaUrl = (publicUrl && !publicUrl.includes('mmg.whatsapp.net')) ? publicUrl : (stickerMsg.url as string) || null;
  } else if (locMsg) {
    contentType = 'text';
    messageText = locMsg.name ? `[Localização: ${locMsg.name}]` : '[Localização]';
  } else if (contactMsg) {
    contentType = 'text';
    messageText = '[Contato]';
  }

  // STRICT GUARD: If there is no real text and no media, ignore event completely
  // Never create phantom '[Mensagem recebida]' entries!
  if (!messageText && !mediaUrl) {
    return { success: true, reason: 'empty_event_ignored' };
  }

  const pushName = String(
    msgData.senderName ||
    chatData.wa_name ||
    chatData.name ||
    msgData.pushName ||
    msgData.name ||
    `+${formattedPhone}`
  );
  const rawExternalId = String(
    msgData.messageid ||
    key.id ||
    msgData.id ||
    body.id ||
    body.messageId ||
    ''
  ).trim();

  // STRICT GUARD: Real messages always have an external ID from WhatsApp
  if (!rawExternalId) {
    return { success: true, reason: 'missing_external_message_id_ignored' };
  }
  const externalMessageId = rawExternalId.includes(':') ? rawExternalId.split(':').pop()! : rawExternalId;

  // If this is a media message and mediaUrl is missing or raw encrypted mmg.whatsapp.net,
  // resolve direct public decrypted URL via UazAPI /message/download
  if (
    (contentType === 'image' || contentType === 'audio' || contentType === 'video' || contentType === 'document') &&
    rawExternalId &&
    (!mediaUrl || mediaUrl.includes('mmg.whatsapp.net') || mediaUrl.includes('.enc'))
  ) {
    const uazTokenEnc = (connection.provider_config?.token || (connection as Record<string, unknown>).encrypted_access_token) as string | undefined;
    if (uazTokenEnc) {
      try {
        const uazToken = decrypt(uazTokenEnc);
        const uazBase = normalizeBaseUrl(String(connection.provider_config?.base_url || (connection as Record<string, unknown>).api_url || ''));
        const downloaded = await downloadUazApiMediaDirect(uazBase, uazToken, rawExternalId);
        if (downloaded?.fileURL) {
          mediaUrl = downloaded.fileURL;
        }
      } catch {
        // Non-blocking: fallback to proxy
      }
    }
  }

  // Get account owner user_id
  const { data: accountRow } = await admin
    .from('accounts')
    .select('owner_user_id')
    .eq('id', connection.account_id)
    .single();

  const userId = accountRow?.owner_user_id;
  if (!userId) {
    console.error('[UazAPI Webhook] Account has no owner user_id:', connection.account_id);
    return { success: false, reason: 'account_owner_not_found' };
  }

  // Call find_or_create_contact RPC
  const { data: contactId, error: contactErr } = await admin.rpc('find_or_create_contact', {
    p_account_id: connection.account_id,
    p_user_id: userId,
    p_phone: formattedPhone,
    p_name: pushName,
  });

  if (contactErr || !contactId) {
    console.error('[UazAPI Webhook] find_or_create_contact error:', contactErr);
    return { success: false, reason: 'failed_to_resolve_contact' };
  }

  const rawPic = (msgData.profilePicUrl ||
    msgData.avatarUrl ||
    msgData.profilePictureUrl ||
    chatData.image ||
    chatData.imagePreview ||
    (msgContentObj.profilePicUrl as string)) as string | undefined;

  const contactUpdates: Record<string, unknown> = {};
  if (rawPic && typeof rawPic === 'string' && (rawPic.startsWith('http') || rawPic.startsWith('data:image/'))) {
    contactUpdates.avatar_url = rawPic;
  }
  if (pushName && /[a-zA-ZÀ-ÿ]/.test(pushName)) {
    contactUpdates.name = pushName;
  }
  if (Object.keys(contactUpdates).length > 0) {
    await admin.from('contacts').update(contactUpdates).eq('id', contactId);
  }

  // Auto lead capture: tag contact with 'Lead' tag if enabled
  const isAutoLead = connection.provider_config?.auto_lead_capture !== false;
  if (isAutoLead) {
    try {
      const { data: leadTag } = await admin
        .from('tags')
        .select('id')
        .eq('account_id', connection.account_id)
        .ilike('name', 'Lead')
        .maybeSingle();

      let tagId = leadTag?.id;
      if (!tagId) {
        const { data: createdTag } = await admin
          .from('tags')
          .insert({
            account_id: connection.account_id,
            user_id: userId,
            name: 'Lead',
            color: '#10B981',
          })
          .select('id')
          .single();
        tagId = createdTag?.id;
      }

      if (tagId) {
        await admin
          .from('contact_tags')
          .insert({
            contact_id: contactId,
            tag_id: tagId,
          });
      }

    } catch {
      // Non-blocking
    }
  }

  // Auto-save contact to phone's WhatsApp address book (UAZAPI /contact/add)
  // Ensures customer can view operator's WhatsApp Status / Stories immediately!
  try {
    const uazConfig = connection.provider_config as Record<string, unknown> | undefined;
    if (uazConfig?.token) {
      let plainToken = String(uazConfig.token);
      try {
        plainToken = decrypt(plainToken);
      } catch {}
      const baseUrl = typeof uazConfig.base_url === 'string' ? uazConfig.base_url : 'https://free.uazapi.com';
      const contactSaveName = pushName && /[a-zA-ZÀ-ÿ]/.test(pushName)
        ? pushName
        : `Cliente ${formattedPhone.slice(-4)}`;

      void addUazApiContact(baseUrl, plainToken, {
        number: formattedPhone,
        name: contactSaveName,
      }).catch((err) => console.warn('[uazapi] Auto save contact to phone failed:', err));
    }
  } catch (err) {
    console.warn('[uazapi] Error triggering auto contact save:', err);
  }

  // Call find_or_create_conversation RPC
  const { data: conversationId, error: convErr } = await admin.rpc('find_or_create_conversation', {
    p_account_id: connection.account_id,
    p_user_id: userId,
    p_contact_id: contactId,
    p_connection_id: connection.id,
  });

  if (convErr || !conversationId) {
    console.error('[UazAPI Webhook] find_or_create_conversation error:', convErr);
    return { success: false, reason: 'failed_to_resolve_conversation' };
  }

  // Check for duplicate message (idempotency)
  const { data: existingMsg } = await admin
    .from('messages')
    .select('id')
    .eq('conversation_id', conversationId)
    .in('message_id', [externalMessageId, rawExternalId])
    .maybeSingle();

  if (existingMsg) {
    return { success: true, reason: 'deduplicated', conversationId, contactId };
  }

  // Extract actual message timestamp (handles seconds vs milliseconds)
  const rawMsgTs =
    msgData.messageTimestamp ||
    msgData.timestamp ||
    (key as Record<string, unknown>)?.timestamp;

  let messageCreatedAt = new Date().toISOString();
  let messageAgeMs = 0;
  if (rawMsgTs) {
    const num = typeof rawMsgTs === 'number' ? rawMsgTs : Number(rawMsgTs);
    if (!isNaN(num) && num > 0) {
      const ms = num > 10000000000 ? num : num * 1000;
      messageCreatedAt = new Date(ms).toISOString();
      messageAgeMs = Math.max(0, Date.now() - ms);
    }
  }

  // Insert Message
  const senderType = fromMe ? 'agent' : 'customer';
  const newMsgRow = {
    conversation_id: conversationId,
    sender_type: senderType,
    content_type: contentType,
    content_text: messageText,
    media_url: mediaUrl,
    message_id: externalMessageId,
    status: 'delivered' as const,
    created_at: messageCreatedAt,
  };

  const { data: createdMsg, error: msgInsertErr } = await admin
    .from('messages')
    .insert(newMsgRow)
    .select('id, created_at')
    .maybeSingle();

  if (msgInsertErr) {
    console.error('[UazAPI Webhook] Error inserting message:', msgInsertErr);
  }

  // Background resolver: if mediaUrl is still missing or encrypted, resolve via /message/download asynchronously
  if (
    createdMsg?.id &&
    (contentType === 'image' || contentType === 'audio' || contentType === 'video' || contentType === 'document') &&
    (!mediaUrl || mediaUrl.includes('mmg.whatsapp.net') || mediaUrl.includes('.enc')) &&
    rawExternalId
  ) {
    void (async () => {
      try {
        const uazTokenEnc = (connection.provider_config?.token || (connection as Record<string, unknown>).encrypted_access_token) as string | undefined;
        if (!uazTokenEnc) return;
        const uazToken = decrypt(uazTokenEnc);
        const uazBase = normalizeBaseUrl(String(connection.provider_config?.base_url || (connection as Record<string, unknown>).api_url || ''));

        const downloaded = await downloadUazApiMediaDirect(uazBase, uazToken, rawExternalId);
        if (downloaded?.fileURL) {
          await admin
            .from('messages')
            .update({ media_url: downloaded.fileURL })
            .eq('id', createdMsg.id);

          whatsappBus.emitInboxEvent({
            accountId: connection.account_id,
            conversationId,
            eventType: 'UPDATE',
            message: {
              id: createdMsg.id,
              conversation_id: conversationId,
              sender_type: senderType,
              content_type: contentType,
              content_text: messageText,
              media_url: downloaded.fileURL,
              message_id: externalMessageId,
              status: 'delivered' as const,
              created_at: createdMsg.created_at || messageCreatedAt,
            },
          });
        }
      } catch {
        // Non-blocking background attempt
      }
    })();
  }

  // Update conversation summary via update_conversation_with_message RPC
  await admin.rpc('update_conversation_with_message', {
    p_conversation_id: conversationId,
    p_message_text: messageText,
    p_message_timestamp: messageCreatedAt,
    p_is_inbound: !fromMe,
  });

  // For inbound customer messages, cancel any pending follow-ups and refresh ai counter
  if (!fromMe) {
    void cancelPendingFollowUps(conversationId, 'client_replied');
    void admin
      .from('conversations')
      .update({ ai_reply_count: 0 })
      .eq('id', conversationId);
  }

  // Emit instant event through in-memory bus for 0-latency delivery
  whatsappBus.emitInboxEvent({
    accountId: connection.account_id,
    conversationId,
    eventType: 'INSERT',
    message: {
      id: createdMsg?.id || `msg-${Date.now()}`,
      ...newMsgRow,
      created_at: createdMsg?.created_at || newMsgRow.created_at,
    },
    conversation: {
      id: conversationId,
      last_message_text: messageText,
      last_message_at: createdMsg?.created_at || newMsgRow.created_at,
      unread_count: fromMe ? 0 : 1,
    },
  });

  // Evaluate Welcome Message Automation for inbound customer messages
  const trimmed = (messageText || '').trim();
  const isEmojiOnly = /^(\p{Extended_Pictographic}|\p{Emoji_Presentation}|\s)+$/u.test(trimmed);
  const isIgnoredText =
    trimmed === '[Mensagem recebida]' ||
    trimmed === '[Reação]' ||
    trimmed.startsWith('[Undecryptable]');
  const isFreshMessage = messageAgeMs < 15 * 60 * 1000;

  if (!fromMe && !isIgnoredText && isFreshMessage) {
    try {
      const welcomeResult = await checkAndDispatchWelcomeMessage({
        accountId: connection.account_id,
        conversationId,
        contactId,
        connection,
        pushName,
      });
      if (welcomeResult.dispatched) {
        console.log(`[UazAPI Event Processor] Welcome message successfully dispatched for conv ${conversationId}`);
      }
    } catch (err) {
      console.error('[UazAPI Event Processor] Error evaluating welcome message:', err);
    }
  }

  // Trigger AI auto-reply for inbound customer messages (strictly for real-time text turns within last 15m, never reactions/emojis or historical syncs)
  if (!fromMe && trimmed && !isEmojiOnly && !isIgnoredText && isFreshMessage) {
    void dispatchInboundToAiReply({
      accountId: connection.account_id,
      conversationId,
      contactId,
      configOwnerUserId: userId,
      messageId: externalMessageId,
      immediate: true,
    }).catch((err) => {
      console.error('[UazAPI Event Processor] AI auto-reply dispatch error:', err);
    });
  }


  return {
    success: true,
    conversationId,
    contactId,
  };
}
