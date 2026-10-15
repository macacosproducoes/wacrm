import { createClient as createAdminClient } from '@supabase/supabase-js';
import { replaceQuickReplyVariables } from '@/lib/inbox/quick-reply-variables';
import { decrypt } from '@/lib/whatsapp/encryption';
import {
  sendUazApiText,
  sendUazApiMedia,
  normalizeBaseUrl,
  normalizeMediaUrl,
  formatUazApiNumber,
} from '@/lib/whatsapp/uazapi-client';
import { whatsappBus } from '@/lib/whatsapp/whatsapp-bus';

const inFlightWelcomeDispatches = new Set<string>();

function supabaseAdmin() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  return createAdminClient(url, key);
}

export interface WelcomeFollowUpStep {
  step_number: number;
  delay_minutes: number;
  response_id: string;
  cancel_if_client_replied?: boolean;
  cancel_if_agent_replied?: boolean;
}

export interface WelcomeAutomationConfig {
  id?: string;
  account_id: string;
  is_active: boolean;
  response_id?: string | null;
  inactivity_window_days: number;
  send_if_human_active: boolean;
  follow_ups: WelcomeFollowUpStep[];
  created_at?: string;
  updated_at?: string;
}

export async function getWelcomeConfig(accountId: string): Promise<WelcomeAutomationConfig> {
  const admin = supabaseAdmin();
  if (!admin) {
    return {
      account_id: accountId,
      is_active: false,
      response_id: null,
      inactivity_window_days: 14,
      send_if_human_active: false,
      follow_ups: [],
    };
  }
  try {
    const { data, error } = await admin
      .from('welcome_automation_configs')
      .select('*')
      .eq('account_id', accountId)
      .maybeSingle();

    if (error || !data) {
      return {
        account_id: accountId,
        is_active: false,
        response_id: null,
        inactivity_window_days: 14,
        send_if_human_active: false,
        follow_ups: [],
      };
    }

    return {
      id: data.id,
      account_id: data.account_id,
      is_active: Boolean(data.is_active),
      response_id: data.response_id || null,
      inactivity_window_days: Number(data.inactivity_window_days ?? 14),
      send_if_human_active: Boolean(data.send_if_human_active),
      follow_ups: Array.isArray(data.follow_ups) ? data.follow_ups : [],
      created_at: data.created_at,
      updated_at: data.updated_at,
    };
  } catch {
    return {
      account_id: accountId,
      is_active: false,
      response_id: null,
      inactivity_window_days: 14,
      send_if_human_active: false,
      follow_ups: [],
    };
  }
}

export async function saveWelcomeConfig(
  accountId: string,
  config: Partial<WelcomeAutomationConfig>
): Promise<{ success: boolean; config?: WelcomeAutomationConfig; error?: string }> {
  const admin = supabaseAdmin();
  if (!admin) return { success: false, error: 'Database not initialized' };
  try {
    const payload = {
      account_id: accountId,
      is_active: Boolean(config.is_active),
      response_id: config.response_id || null,
      inactivity_window_days: Number(config.inactivity_window_days ?? 14),
      send_if_human_active: Boolean(config.send_if_human_active),
      follow_ups: Array.isArray(config.follow_ups) ? config.follow_ups : [],
      updated_at: new Date().toISOString(),
    };

    const { data, error } = await admin
      .from('welcome_automation_configs')
      .upsert(payload, { onConflict: 'account_id' })
      .select('*')
      .single();

    if (error) {
      return { success: false, error: error.message };
    }

    return { success: true, config: data as WelcomeAutomationConfig };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Falha ao salvar configuração';
    return { success: false, error: message };
  }
}

export interface CheckWelcomeDispatchArgs {
  accountId: string;
  conversationId: string;
  contactId: string;
  connection: Record<string, unknown>;
  pushName?: string;
}

/**
 * Evaluates whether an incoming message should trigger a Welcome Message.
 * If eligible, dispatches it immediately via WhatsApp provider and schedules chained follow-ups.
 */
export async function checkAndDispatchWelcomeMessage(
  args: CheckWelcomeDispatchArgs
): Promise<{ dispatched: boolean; reason?: string; uazapiMessageId?: string }> {
  const { accountId, conversationId, contactId, connection, pushName } = args;
  const admin = supabaseAdmin();
  if (!admin) return { dispatched: false, reason: 'db_not_ready' };

  const lockKey = `${accountId}:${conversationId}`;
  if (inFlightWelcomeDispatches.has(lockKey)) {
    console.log(`[welcome-engine] Memory lock active for conv ${conversationId}: duplicate inbound burst prevented.`);
    return { dispatched: false, reason: 'duplicate_inbound_burst_prevented' };
  }
  inFlightWelcomeDispatches.add(lockKey);

  let lockRowId: string | null = null;
  const welcomeSequenceStartTime = new Date().toISOString();

  try {
    // 1. Clean up stale lock rows older than 3 minutes
    try {
      const threeMinutesAgo = new Date(Date.now() - 3 * 60 * 1000).toISOString();
      await admin
        .from('welcome_message_logs')
        .delete()
        .or(`conversation_id.eq.${conversationId},contact_id.eq.${contactId}`)
        .like('uazapi_message_id', 'welcome_lock_%')
        .lt('sent_at', threeMinutesAgo);
    } catch {}

    // 2. Check for recent welcome dispatches or active locks
    const { data: recentLogs } = await admin
      .from('welcome_message_logs')
      .select('id, sent_at, uazapi_message_id')
      .or(`conversation_id.eq.${conversationId},contact_id.eq.${contactId}`)
      .order('sent_at', { ascending: false })
      .limit(1);

    const lastLog = recentLogs?.[0];
    if (lastLog) {
      const lastSentAt = new Date(lastLog.sent_at).getTime();
      const now = Date.now();

      // If an active lock exists from less than 3 minutes ago, a sequence is CURRENTLY in flight!
      if (lastLog.uazapi_message_id?.startsWith('welcome_lock_')) {
        if (now - lastSentAt < 3 * 60 * 1000) {
          console.log(`[welcome-engine] Active DB lock found for conv ${conversationId}: sequence in progress. Aborting duplicate burst.`);
          return { dispatched: false, reason: 'duplicate_inbound_burst_prevented' };
        }
      }

      // Idempotency: prevent duplicate dispatch within 10 minutes (covers multi-message bursts at start)
      if (now - lastSentAt < 10 * 60 * 1000) {
        console.log(`[welcome-engine] Welcome message already sent recently (${Math.round((now - lastSentAt) / 1000)}s ago) for conv ${conversationId}. Duplicate prevented.`);
        return { dispatched: false, reason: 'duplicate_inbound_burst_prevented' };
      }
    }

    // 3. Immediately reserve atomic lock in DB before doing any heavy operations
    const lockKeyId = `welcome_lock_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    const { data: insertedLock } = await admin
      .from('welcome_message_logs')
      .insert({
        account_id: accountId,
        conversation_id: conversationId,
        contact_id: contactId,
        uazapi_message_id: lockKeyId,
        sent_at: new Date().toISOString(),
      })
      .select('id')
      .maybeSingle();

    lockRowId = insertedLock?.id || null;

    // Race-check: if two requests inserted locks at the exact same millisecond window,
    // verify if we are the winner (earliest row)
    if (lockRowId) {
      const tenSecondsAgo = new Date(Date.now() - 10 * 1000).toISOString();
      const { data: activeLocks } = await admin
        .from('welcome_message_logs')
        .select('id, sent_at')
        .or(`conversation_id.eq.${conversationId},contact_id.eq.${contactId}`)
        .like('uazapi_message_id', 'welcome_lock_%')
        .gte('sent_at', tenSecondsAgo)
        .order('sent_at', { ascending: true });

      if (activeLocks && activeLocks.length > 1 && activeLocks[0].id !== lockRowId) {
        console.log(`[welcome-engine] Lost lock race condition to ${activeLocks[0].id} for conv ${conversationId}. Aborting duplicate.`);
        await admin.from('welcome_message_logs').delete().eq('id', lockRowId);
        lockRowId = null;
        return { dispatched: false, reason: 'duplicate_inbound_burst_prevented' };
      }
    }

    // 4. Get welcome config
    const config = await getWelcomeConfig(accountId);
    if (!config.is_active || !config.response_id) {
      if (lockRowId) await admin.from('welcome_message_logs').delete().eq('id', lockRowId);
      lockRowId = null;
      return { dispatched: false, reason: 'welcome_disabled' };
    }

    // 5. Human active check
    const { data: conv } = await admin
      .from('conversations')
      .select('id, assigned_agent_id, status, ai_autoreply_disabled')
      .eq('id', conversationId)
      .maybeSingle();

    const isHumanActive = Boolean(
      conv?.assigned_agent_id ||
      conv?.status === 'human_active' ||
      conv?.ai_autoreply_disabled
    );

    if (isHumanActive && !config.send_if_human_active) {
      console.log(`[welcome-engine] Standing down for conversation ${conversationId}: human agent is active.`);
      if (lockRowId) await admin.from('welcome_message_logs').delete().eq('id', lockRowId);
      lockRowId = null;
      return { dispatched: false, reason: 'human_active_stand_down' };
    }

    // 6. Inactivity window check for past completed sends
    if (lastLog && !lastLog.uazapi_message_id?.startsWith('welcome_lock_')) {
      const lastSentAt = new Date(lastLog.sent_at).getTime();
      const now = Date.now();

      if (config.inactivity_window_days === 0) {
        if (lockRowId) await admin.from('welcome_message_logs').delete().eq('id', lockRowId);
        lockRowId = null;
        return { dispatched: false, reason: 'strictly_first_message_already_sent' };
      }

      const elapsedDays = (now - lastSentAt) / (86400 * 1000);
      if (elapsedDays < config.inactivity_window_days) {
        if (lockRowId) await admin.from('welcome_message_logs').delete().eq('id', lockRowId);
        lockRowId = null;
        return { dispatched: false, reason: `within_inactivity_window_${Math.floor(elapsedDays)}d` };
      }
    }

    // 7. Fetch the configured quick reply
    const { data: replyRow } = await admin
      .from('quick_replies')
      .select('*')
      .eq('id', config.response_id)
      .eq('account_id', accountId)
      .maybeSingle();

    if (!replyRow) {
      console.warn(`[welcome-engine] Configured response ${config.response_id} not found.`);
      if (lockRowId) await admin.from('welcome_message_logs').delete().eq('id', lockRowId);
      lockRowId = null;
      return { dispatched: false, reason: 'configured_response_missing' };
    }

  // 5. Fetch contact info to resolve variables
  const { data: contactRow } = await admin
    .from('contacts')
    .select('name, phone, company')
    .eq('id', contactId)
    .maybeSingle();

  const contactName = (contactRow?.name || pushName || '').trim();
  const rawText = replyRow.content_text || '';
  const resolvedText = replaceQuickReplyVariables(rawText, {
    name: contactName,
    phone: contactRow?.phone || '',
    company: contactRow?.company || '',
    date: new Date(),
  });

  // 6. Decrypt token and send via UAZAPI
  const uazConfig = (connection.provider_config as Record<string, unknown>) || {};
  let plainToken = String(uazConfig.token || '');
  try {
    plainToken = decrypt(plainToken);
  } catch {}

  const baseUrl = typeof uazConfig.base_url === 'string' ? uazConfig.base_url : 'https://free.uazapi.com';
  const phone = formatUazApiNumber(contactRow?.phone || '');

  let uazapiMessageId = `welcome_${Date.now()}`;
  const meta = ((replyRow.interactive_payload as Record<string, unknown>) || {}) as Record<string, unknown>;
  const rawKind = String(replyRow.kind || meta.type || 'text').toLowerCase();
  const rawMediaUrl = String(replyRow.media_url || meta.media_url || uazConfig.media_url || '').trim();
  const mediaUrl = normalizeMediaUrl(rawMediaUrl);
  const mediaType = String(replyRow.media_type || meta.media_type || '').toLowerCase();
  const category = String(replyRow.category || meta.category || '').toLowerCase();

  let effectiveKind: 'sequence' | 'audio' | 'image' | 'video' | 'document' | 'text' = 'text';

  if (
    rawKind === 'sequence' ||
    meta.type === 'sequence' ||
    (Array.isArray(replyRow.sequence_items) && replyRow.sequence_items.length > 0) ||
    (Array.isArray(meta.sequence_items) && (meta.sequence_items as unknown[]).length > 0)
  ) {
    effectiveKind = 'sequence';
  } else if (
    rawKind === 'audio' ||
    meta.type === 'audio' ||
    category.includes('áudio') ||
    category.includes('audio') ||
    mediaType.startsWith('audio/') ||
    /\.(ogg|mp3|wav|m4a|aac|opus)($|\?)/i.test(mediaUrl)
  ) {
    effectiveKind = 'audio';
  } else if (
    rawKind === 'image' ||
    meta.type === 'image' ||
    category.includes('imagem') ||
    category.includes('image') ||
    mediaType.startsWith('image/') ||
    /\.(jpe?g|png|webp|gif)($|\?)/i.test(mediaUrl)
  ) {
    effectiveKind = 'image';
  } else if (
    rawKind === 'video' ||
    meta.type === 'video' ||
    mediaType.startsWith('video/') ||
    /\.(mp4|mov|avi|webm)($|\?)/i.test(mediaUrl)
  ) {
    effectiveKind = 'video';
  } else if (
    rawKind === 'document' ||
    meta.type === 'document' ||
    mediaType.startsWith('application/') ||
    /\.(pdf|docx?|xlsx?)($|\?)/i.test(mediaUrl)
  ) {
    effectiveKind = 'document';
  }

  const isSequence = effectiveKind === 'sequence';
  const messageCreatedAt = new Date().toISOString();

  try {
    if (isSequence) {
      const sequenceSteps = ((Array.isArray(replyRow.sequence_items) && replyRow.sequence_items.length > 0
        ? replyRow.sequence_items
        : meta.sequence_items) || []) as Array<{
        order: number;
        type: string;
        content?: string;
        media_url?: string;
        delay_seconds?: number;
      }>;
      const sortedSteps = [...sequenceSteps].sort((a, b) => (a.order || 0) - (b.order || 0));

      for (let i = 0; i < sortedSteps.length; i++) {
        const step = sortedSteps[i];
        // The first step must send immediately (0s delay) so the customer receives the initial greeting without waiting.
        // Subsequent steps respect configured delay (clamped to a safe max of 5s to prevent serverless timeout).
        const rawDelay = i === 0 ? 0 : Math.max(0, step.delay_seconds || 0);
        const stepDelay = Math.min(rawDelay, 5);
        if (stepDelay > 0) {
          await new Promise((resolve) => setTimeout(resolve, stepDelay * 1000));
        }
        const stepText = replaceQuickReplyVariables(step.content || '', {
          name: contactName,
          phone: contactRow?.phone || '',
          company: contactRow?.company || '',
          date: new Date(),
        });
        let stepMsgId = `welcome_seq_${Date.now()}_${i}`;
        const stepType = (step.type || 'text').toLowerCase();
        const stepMediaUrl = normalizeMediaUrl(step.media_url);
        const hasMedia = Boolean(stepMediaUrl && typeof stepMediaUrl === 'string' && stepMediaUrl.trim().length > 0);

        try {
          if (stepType === 'audio' && hasMedia) {
            const res = await sendUazApiMedia(baseUrl, plainToken, {
              number: phone,
              url: stepMediaUrl,
              type: 'audio',
              ptt: true,
            });
            if (res?.messageId) stepMsgId = res.messageId;
          } else if (['image', 'video', 'document'].includes(stepType) && hasMedia) {
            const res = await sendUazApiMedia(baseUrl, plainToken, {
              number: phone,
              url: stepMediaUrl,
              type: stepType as any,
              caption: stepText || undefined,
            });
            if (res?.messageId) stepMsgId = res.messageId;
          } else {
            // Strictly text: never call media endpoints
            const res = await sendUazApiText(baseUrl, plainToken, {
              number: phone,
              text: stepText || 'Olá! Seja muito bem-vindo.',
            });
            if (res?.messageId) stepMsgId = res.messageId;
          }
        } catch (stepErr) {
          console.error('[welcome-engine] Step ' + (i + 1) + ' failed to send media via provider, continuing sequence:', stepErr);
          // If media failed, fallback to sending the accompanying text if available
          if (hasMedia && stepText) {
            try {
              const textRes = await sendUazApiText(baseUrl, plainToken, {
                number: phone,
                text: stepText,
              });
              if (textRes?.messageId) stepMsgId = textRes.messageId;
            } catch {}
          }
        }

        const stepTime = new Date().toISOString();
        const { data: stepMsg } = await admin
          .from('messages')
          .insert({
            conversation_id: conversationId,
            sender_type: 'bot',
            content_type: step.type === 'audio' ? 'audio' : step.type === 'image' ? 'image' : 'text',
            content_text: stepText || (step.type === 'audio' ? '[Áudio]' : step.type === 'image' ? '[Imagem]' : ''),
            media_url: step.media_url || null,
            message_id: stepMsgId,
            status: 'delivered',
            created_at: stepTime,
          })
          .select('id, created_at')
          .maybeSingle();

        // Broadcast each step via real-time bus
        whatsappBus.emitInboxEvent({
          accountId,
          conversationId,
          eventType: 'INSERT',
          message: {
            id: stepMsg?.id || `msg-${Date.now()}-${i}`,
            conversation_id: conversationId,
            sender_type: 'bot',
            content_type: step.type === 'audio' ? 'audio' : step.type === 'image' ? 'image' : 'text',
            content_text: stepText || (step.type === 'audio' ? '[Áudio]' : step.type === 'image' ? '[Imagem]' : ''),
            media_url: step.media_url || null,
            message_id: stepMsgId,
            status: 'delivered',
            created_at: stepTime,
          },
          conversation: {
            id: conversationId,
            last_message_text: stepText || (step.type === 'image' ? '[Tabela de Valores]' : ''),
            last_message_at: stepTime,
            unread_count: 0,
          },
        });
      }
      uazapiMessageId = `welcome_seq_${Date.now()}`;
    } else if (effectiveKind === 'audio' && mediaUrl) {
      const sendRes = await sendUazApiMedia(baseUrl, plainToken, {
        number: phone,
        url: mediaUrl,
        type: 'audio',
        ptt: true,
      });
      if (sendRes.messageId) uazapiMessageId = sendRes.messageId;
    } else if (['image', 'video', 'document'].includes(effectiveKind) && mediaUrl) {
      const sendRes = await sendUazApiMedia(baseUrl, plainToken, {
        number: phone,
        url: mediaUrl,
        type: effectiveKind as 'image' | 'video' | 'document',
        caption: resolvedText || undefined,
      });
      if (sendRes.messageId) uazapiMessageId = sendRes.messageId;
    } else {
      const sendRes = await sendUazApiText(baseUrl, plainToken, {
        number: phone,
        text: resolvedText || 'Olá! Seja muito bem-vindo.',
      });
      if (sendRes.messageId) uazapiMessageId = sendRes.messageId;
    }
  } catch (err) {
    console.error('[welcome-engine] Failed to send welcome message via provider:', err);
    try {
      if (lockRowId) {
        await admin
          .from('welcome_message_logs')
          .delete()
          .eq('id', lockRowId);
      }
    } catch {}
    return { dispatched: false, reason: 'provider_send_failed' };
  }

  // 7. For non-sequence, record single message in CRM database as 'bot'
  if (!isSequence) {
    const messageContentText =
      effectiveKind === 'audio'
        ? (resolvedText.startsWith('🎙️') ? resolvedText : `🎙️ ${resolvedText || '[Áudio]'}`)
        : resolvedText;

    const { data: createdMsg } = await admin
      .from('messages')
      .insert({
        conversation_id: conversationId,
        sender_type: 'bot',
        content_type: effectiveKind,
        content_text: messageContentText,
        media_url: mediaUrl || null,
        media_type: mediaType || (effectiveKind === 'audio' ? 'audio/ogg' : null),
        message_id: uazapiMessageId,
        status: 'delivered',
        created_at: messageCreatedAt,
      })
      .select('id, created_at')
      .maybeSingle();

    whatsappBus.emitInboxEvent({
      accountId,
      conversationId,
      eventType: 'INSERT',
      message: {
        id: createdMsg?.id || `msg-${Date.now()}`,
        conversation_id: conversationId,
        sender_type: 'bot',
        content_type: effectiveKind,
        content_text: messageContentText,
        media_url: mediaUrl || null,
        media_type: mediaType || (effectiveKind === 'audio' ? 'audio/ogg' : null),
        message_id: uazapiMessageId,
        status: 'delivered',
        created_at: messageCreatedAt,
      },
      conversation: {
        id: conversationId,
        last_message_text: effectiveKind === 'audio' ? '🎙️ [Áudio]' : messageContentText,
        last_message_at: messageCreatedAt,
        unread_count: 0,
      },
    });
  }

  // 8. Update pre-inserted welcome_message_logs record with final message ID
  try {
    if (lockRowId) {
      await admin
        .from('welcome_message_logs')
        .update({
          response_id: replyRow.id,
          uazapi_message_id: uazapiMessageId,
          sent_at: new Date().toISOString(),
        })
        .eq('id', lockRowId);
    } else {
      await admin.from('welcome_message_logs').insert({
        account_id: accountId,
        conversation_id: conversationId,
        contact_id: contactId,
        response_id: replyRow.id,
        uazapi_message_id: uazapiMessageId,
        sent_at: new Date().toISOString(),
      });
    }
  } catch {}

  // 9. Increment usage counter
  try {
    await admin.rpc('increment_quick_reply_usage', { p_id: replyRow.id });
  } catch {}

  // 11. Schedule linked follow-up steps if any
  if (Array.isArray(config.follow_ups) && config.follow_ups.length > 0) {
    // Check if the customer replied while the welcome message or sequence was being delivered!
    const { data: customerRepliedDuringSequence } = await admin
      .from('messages')
      .select('id')
      .eq('conversation_id', conversationId)
      .eq('sender_type', 'customer')
      .gte('created_at', welcomeSequenceStartTime)
      .limit(1);

    if (customerRepliedDuringSequence && customerRepliedDuringSequence.length > 0) {
      console.log(`[welcome-engine] Customer replied during sequence for conv ${conversationId}. Skipping follow-ups.`);
      return { dispatched: true, uazapiMessageId };
    }

    const followUpsToInsert = config.follow_ups
      .filter((step) => Boolean(step.response_id && step.delay_minutes > 0))
      .map((step) => {
        const scheduledTime = new Date(Date.now() + step.delay_minutes * 60 * 1000).toISOString();
        return {
          account_id: accountId,
          conversation_id: conversationId,
          contact_id: contactId,
          response_id: step.response_id,
          source: 'welcome_automation' as const,
          step_number: step.step_number || 1,
          status: 'scheduled' as const,
          scheduled_at: scheduledTime,
          cancel_on_client_reply: step.cancel_if_client_replied !== false,
          cancel_on_agent_reply: step.cancel_if_agent_replied !== false,
          idempotency_key: `conv_${conversationId}_welcome_step_${step.step_number}_${scheduledTime}`,
        };
      });

    if (followUpsToInsert.length > 0) {
      await admin.from('conversation_follow_ups').insert(followUpsToInsert);
      console.log(`[welcome-engine] Scheduled ${followUpsToInsert.length} chained follow-ups for conversation ${conversationId}.`);
    }
  }

  return { dispatched: true, uazapiMessageId };
  } finally {
    inFlightWelcomeDispatches.delete(lockKey);
  }
}
