import { createClient as createAdminClient } from '@supabase/supabase-js';
import { formatUazApiNumber } from '@/lib/whatsapp/uazapi-client';
import { isRealWhatsAppContact } from '@/lib/whatsapp/phone-utils';
import { dispatchInboundToAiReply } from '@/lib/ai/auto-reply';
import { notifyClientPresence } from '@/lib/ai/auto-reply-debouncer';
import { whatsappBus } from '@/lib/whatsapp/whatsapp-bus';
import { sendWhatsAppPresence } from '@/lib/whatsapp/unified-presence';

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

  // Handle Messages
  const msgData = ((body.message || body.data || body) ?? {}) as Record<string, unknown>;
  const chatData = ((body.chat || {}) ?? {}) as Record<string, unknown>;
  const key = (msgData.key || {}) as Record<string, unknown>;
  const fromMe = Boolean(key.fromMe ?? msgData.fromMe);

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

  // Extract message content object early to check for reactions
  const msgContentObj = ((msgData.content || msgData.message || msgData) ?? {}) as Record<string, unknown>;

  // 2. STRICT REACTION VETO
  // Reactions (emojis like 👍, ❤️, 😮, etc.) are message reactions, NOT customer conversation turns.
  // They must NEVER trigger AI auto-reply or create pseudo text messages.
  const isReaction = Boolean(
    eventType === 'reaction' ||
    eventType === 'messages_reaction' ||
    eventType === 'messages_update' ||
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

  if (typeof msgData.text === 'string' && msgData.text.trim()) {
    messageText = msgData.text;
  } else if (typeof msgContentObj.text === 'string' && msgContentObj.text.trim()) {
    messageText = msgContentObj.text;
  } else if (msgContentObj.conversation) {
    messageText = String(msgContentObj.conversation);
  } else if (extText?.text) {
    messageText = String(extText.text);
  } else if (imgMsg) {
    contentType = 'image';
    messageText = String(imgMsg.caption || '[Imagem]');
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
    if (!mediaUrl && typeof imgMsg.url === 'string') {
      mediaUrl = imgMsg.url;
    }
  } else if (audMsg) {
    contentType = 'audio';
    messageText = '[Áudio]';
    mediaUrl = (audMsg.url as string) || null;
  } else if (vidMsg) {
    contentType = 'video';
    messageText = String(vidMsg.caption || '[Vídeo]');
    mediaUrl = (vidMsg.url as string) || null;
  } else if (docMsg) {
    contentType = 'document';
    messageText = String(docMsg.fileName || '[Documento]');
    mediaUrl = (docMsg.url as string) || null;
  }

  if (!messageText && !mediaUrl) {
    messageText = '[Mensagem recebida]';
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
    `uazapi_${Date.now()}`
  );
  const externalMessageId = rawExternalId.includes(':') ? rawExternalId.split(':').pop()! : rawExternalId;

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

  // Update conversation summary via update_conversation_with_message RPC
  await admin.rpc('update_conversation_with_message', {
    p_conversation_id: conversationId,
    p_message_text: messageText,
    p_message_timestamp: messageCreatedAt,
    p_is_inbound: !fromMe,
  });

  // For inbound customer messages, refresh ai_reply_count to 0 so conversation never gets muted
  if (!fromMe) {
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

  // Trigger AI auto-reply for inbound customer messages (strictly for real-time text turns within last 5m, never reactions/emojis or historical syncs)
  const trimmed = (messageText || '').trim();
  const isEmojiOnly = /^(\p{Extended_Pictographic}|\p{Emoji_Presentation}|\s)+$/u.test(trimmed);
  const isIgnoredText =
    trimmed === '[Mensagem recebida]' ||
    trimmed === '[Reação]' ||
    trimmed.startsWith('[Undecryptable]');
  const isFreshMessage = messageAgeMs < 5 * 60 * 1000;

  if (!fromMe && trimmed && !isEmojiOnly && !isIgnoredText && isFreshMessage) {
    void dispatchInboundToAiReply({
      accountId: connection.account_id,
      conversationId,
      contactId,
      configOwnerUserId: userId,
      messageId: externalMessageId,
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
