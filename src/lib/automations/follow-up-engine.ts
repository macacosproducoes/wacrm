import { createClient as createAdminClient } from '@supabase/supabase-js';
import { replaceQuickReplyVariables } from '@/lib/inbox/quick-reply-variables';
import { decrypt } from '@/lib/whatsapp/encryption';
import {
  sendUazApiText,
  sendUazApiMedia,
  normalizeBaseUrl,
  formatUazApiNumber,
} from '@/lib/whatsapp/uazapi-client';
import { whatsappBus } from '@/lib/whatsapp/whatsapp-bus';

function supabaseAdmin() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  return createAdminClient(url, key);
}

export type FollowUpStatus =
  | 'pending'
  | 'scheduled'
  | 'processing'
  | 'sent'
  | 'cancelled'
  | 'failed'
  | 'completed';

export interface FollowUpRow {
  id: string;
  account_id: string;
  conversation_id: string;
  contact_id: string;
  response_id: string;
  automation_id?: string | null;
  sequence_id?: string | null;
  step_id?: string | null;
  status: FollowUpStatus;
  scheduled_at: string;
  sent_at?: string | null;
  cancelled_at?: string | null;
  failed_at?: string | null;
  cancel_reason?: string | null;
  cancel_on_client_reply: boolean;
  cancel_on_agent_reply: boolean;
  source?: string | null;
  idempotency_key?: string | null;
  uazapi_message_id?: string | null;
  error_message?: string | null;
  quick_reply?: {
    id: string;
    title: string;
    kind: string;
    content_text?: string | null;
    color?: string | null;
  } | null;
  created_at: string;
  updated_at: string;
}

/**
 * Cancel pending / scheduled follow-ups for a conversation when a stop condition is met
 * (e.g. client sent a message, agent replied, conversation closed).
 */
export async function cancelPendingFollowUps(
  conversationId: string,
  reason: 'client_replied' | 'agent_replied' | 'manual_cancel' | 'lead_won' | 'lead_lost' | 'conversation_closed'
): Promise<number> {
  const admin = supabaseAdmin();
  if (!admin) return 0;
  try {
    let query = admin
      .from('conversation_follow_ups')
      .update({
        status: 'cancelled',
        cancelled_at: new Date().toISOString(),
        cancel_reason: reason,
        updated_at: new Date().toISOString(),
      })
      .eq('conversation_id', conversationId)
      .in('status', ['pending', 'scheduled']);

    if (reason === 'client_replied') {
      query = query.eq('cancel_on_client_reply', true);
    } else if (reason === 'agent_replied') {
      query = query.eq('cancel_on_agent_reply', true);
    }

    const { data } = await query.select('id');
    const cancelledCount = data?.length || 0;
    if (cancelledCount > 0) {
      console.log(`[follow-up-engine] Cancelled ${cancelledCount} follow-ups for conv ${conversationId} (reason: ${reason}).`);
    }
    return cancelledCount;
  } catch (err) {
    console.error('[follow-up-engine] Error cancelling follow-ups:', err);
    return 0;
  }
}

/**
 * Schedule a manual follow-up from the UI.
 */
export async function scheduleManualFollowUp(params: {
  accountId: string;
  conversationId: string;
  contactId?: string | null;
  responseId: string;
  scheduledAt: string;
  cancelOnClientReply?: boolean;
  cancelOnAgentReply?: boolean;
  userId?: string | null;
}): Promise<{ success: boolean; followUp?: FollowUpRow; error?: string }> {
  const admin = supabaseAdmin();
  if (!admin) return { success: false, error: 'Database client not initialized' };
  try {
    const { data, error } = await admin
      .from('conversation_follow_ups')
      .insert({
        account_id: params.accountId,
        conversation_id: params.conversationId,
        contact_id: params.contactId || null,
        response_id: params.responseId,
        source: 'manual',
        step_number: 1,
        status: 'scheduled',
        scheduled_at: params.scheduledAt,
        cancel_on_client_reply: params.cancelOnClientReply !== false,
        cancel_on_agent_reply: params.cancelOnAgentReply !== false,
        created_by_user_id: params.userId || null,
        idempotency_key: `manual_${params.conversationId}_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
      })
      .select('*, quick_reply:quick_replies(id, title, kind, content_text, color)')
      .single();

    if (error) return { success: false, error: error.message };
    return { success: true, followUp: data as unknown as FollowUpRow };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Falha ao agendar follow-up';
    return { success: false, error: message };
  }
}

/**
 * Get active and recent follow-ups for a conversation.
 */
export async function getConversationFollowUps(conversationId: string): Promise<FollowUpRow[]> {
  const admin = supabaseAdmin();
  if (!admin) return [];
  try {
    const { data, error } = await admin
      .from('conversation_follow_ups')
      .select('*, quick_reply:quick_replies(id, title, kind, content_text, color)')
      .eq('conversation_id', conversationId)
      .order('scheduled_at', { ascending: true })
      .limit(30);

    if (error || !data) return [];
    return data as unknown as FollowUpRow[];
  } catch {
    return [];
  }
}

/**
 * Drain and process due follow-ups (Cron / Worker job).
 * Ensures idempotency and validates stop conditions prior to dispatch.
 */
export async function processDueFollowUps(): Promise<{ processed: number; sent: number; cancelled: number }> {
  const admin = supabaseAdmin();
  if (!admin) return { processed: 0, sent: 0, cancelled: 0 };
  const nowIso = new Date().toISOString();

  // Find due follow-ups
  const { data: due, error } = await admin
    .from('conversation_follow_ups')
    .select('*, quick_reply:quick_replies(*)')
    .in('status', ['pending', 'scheduled'])
    .lte('scheduled_at', nowIso)
    .order('scheduled_at', { ascending: true })
    .limit(50);

  if (error || !due || due.length === 0) {
    return { processed: 0, sent: 0, cancelled: 0 };
  }

  let sent = 0;
  let cancelled = 0;

  for (const row of due) {
    // 1. Atomic claim
    const { data: claimed } = await admin
      .from('conversation_follow_ups')
      .update({ status: 'processing', updated_at: nowIso })
      .eq('id', row.id)
      .in('status', ['pending', 'scheduled'])
      .select('id')
      .maybeSingle();

    if (!claimed) continue; // Claim lost to concurrent worker

    try {
      // 2. Validate Stop Conditions: Did client send a message since this follow-up was scheduled?
      if (row.cancel_on_client_reply) {
        const { data: recentClientMsgs } = await admin
          .from('messages')
          .select('id')
          .eq('conversation_id', row.conversation_id)
          .eq('sender_type', 'customer')
          .gte('created_at', row.created_at)
          .limit(1);

        if (recentClientMsgs && recentClientMsgs.length > 0) {
          await admin.from('conversation_follow_ups').update({
            status: 'cancelled',
            cancelled_at: new Date().toISOString(),
            cancel_reason: 'client_replied',
            updated_at: new Date().toISOString(),
          }).eq('id', row.id);
          cancelled++;
          continue;
        }
      }

      // 3. Stop condition: Did an agent send a manual message?
      if (row.cancel_on_agent_reply) {
        const { data: recentAgentMsgs } = await admin
          .from('messages')
          .select('id')
          .eq('conversation_id', row.conversation_id)
          .eq('sender_type', 'agent')
          .gte('created_at', row.created_at)
          .limit(1);

        if (recentAgentMsgs && recentAgentMsgs.length > 0) {
          await admin.from('conversation_follow_ups').update({
            status: 'cancelled',
            cancelled_at: new Date().toISOString(),
            cancel_reason: 'agent_replied',
            updated_at: new Date().toISOString(),
          }).eq('id', row.id);
          cancelled++;
          continue;
        }
      }

      // 4. Fetch contact info
      const { data: contact } = await admin
        .from('contacts')
        .select('name, phone, company')
        .eq('id', row.contact_id)
        .maybeSingle();

      if (!contact?.phone) {
        await admin.from('conversation_follow_ups').update({
          status: 'failed',
          failed_at: new Date().toISOString(),
          error_message: 'Contact phone not found',
        }).eq('id', row.id);
        continue;
      }

      // 5. Fetch active WhatsApp connection
      let { data: conns } = await admin
        .from('whatsapp_connections')
        .select('*')
        .eq('account_id', row.account_id)
        .eq('is_active', true)
        .limit(1);

      if (!conns || conns.length === 0) {
        const { data: fallbackConns } = await admin
          .from('whatsapp_connections')
          .select('*')
          .eq('account_id', row.account_id)
          .order('updated_at', { ascending: false })
          .limit(1);
        conns = fallbackConns;
      }

      const connection = conns?.[0];
      if (!connection) {
        await admin.from('conversation_follow_ups').update({
          status: 'failed',
          failed_at: new Date().toISOString(),
          error_message: 'No active WhatsApp connection for account',
        }).eq('id', row.id);
        continue;
      }

      // 6. Resolve variables in message text
      const quickReply = row.quick_reply as Record<string, unknown> | undefined;
      const rawText = String(quickReply?.content_text || '');
      const resolvedText = replaceQuickReplyVariables(rawText, {
        name: contact.name,
        phone: contact.phone,
        company: contact.company,
        date: new Date(),
      });

      // 7. Send via UAZAPI
      const uazConfig = (connection.provider_config as Record<string, unknown>) || {};
      let plainToken = String(uazConfig.token || '');
      try {
        plainToken = decrypt(plainToken);
      } catch {}

      const baseUrl = typeof uazConfig.base_url === 'string' ? uazConfig.base_url : 'https://free.uazapi.com';
      const formattedPhone = formatUazApiNumber(contact.phone);
      const kind = String(quickReply?.kind || 'text');
      let uazapiMessageId = `followup_${Date.now()}`;

      if (kind === 'sequence') {
        const meta = ((quickReply?.interactive_payload as Record<string, unknown>) || {}) as Record<string, unknown>;
        const sequenceSteps = ((Array.isArray(quickReply?.sequence_items) ? quickReply.sequence_items : meta.sequence_items) || []) as Array<{
          order: number;
          type: string;
          content?: string;
          media_url?: string;
          delay_seconds?: number;
        }>;
        const sortedSteps = [...sequenceSteps].sort((a, b) => (a.order || 0) - (b.order || 0));

        for (let i = 0; i < sortedSteps.length; i++) {
          const step = sortedSteps[i];
          if (i > 0 && step.delay_seconds) {
            await new Promise((resolve) => setTimeout(resolve, Math.min((step.delay_seconds || 0) * 1000, 30000)));
          }
          const stepText = replaceQuickReplyVariables(step.content || '', {
            name: contact.name,
            phone: contact.phone,
            company: contact.company,
            date: new Date(),
          });
          let stepMsgId = `followup_seq_${Date.now()}_${i}`;
          if (step.type === 'audio' && step.media_url) {
            const res = await sendUazApiMedia(baseUrl, plainToken, {
              number: formattedPhone,
              url: step.media_url,
              type: 'audio',
              caption: stepText || undefined,
              ptt: true,
            });
            if (res?.messageId) stepMsgId = res.messageId;
          } else if (['image', 'video', 'document'].includes(step.type) && step.media_url) {
            const res = await sendUazApiMedia(baseUrl, plainToken, {
              number: formattedPhone,
              url: step.media_url,
              type: step.type as any,
              caption: stepText || undefined,
            });
            if (res?.messageId) stepMsgId = res.messageId;
          } else if (stepText) {
            const res = await sendUazApiText(baseUrl, plainToken, {
              number: formattedPhone,
              text: stepText,
            });
            if (res?.messageId) stepMsgId = res.messageId;
          }

          await admin.from('messages').insert({
            conversation_id: row.conversation_id,
            sender_type: 'bot',
            content_type: step.type === 'audio' ? 'audio' : step.type === 'image' ? 'image' : 'text',
            content_text: stepText,
            media_url: step.media_url || null,
            message_id: stepMsgId,
            status: 'delivered',
            created_at: new Date().toISOString(),
          });
        }
        uazapiMessageId = `followup_seq_${Date.now()}`;
      } else if (kind === 'audio' && quickReply?.media_url) {
        const res = await sendUazApiMedia(baseUrl, plainToken, {
          number: formattedPhone,
          url: String(quickReply.media_url),
          type: 'audio',
          caption: resolvedText || undefined,
          ptt: true,
        });
        if (res.messageId) uazapiMessageId = res.messageId;
      } else if (['image', 'video', 'document'].includes(kind) && quickReply?.media_url) {
        const res = await sendUazApiMedia(baseUrl, plainToken, {
          number: formattedPhone,
          url: String(quickReply.media_url),
          type: kind as 'image' | 'video' | 'document',
          caption: resolvedText || undefined,
        });
        if (res.messageId) uazapiMessageId = res.messageId;
      } else {
        const res = await sendUazApiText(baseUrl, plainToken, {
          number: formattedPhone,
          text: resolvedText || 'Olá!',
        });
        if (res.messageId) uazapiMessageId = res.messageId;
      }

      // 8. Record in messages table as 'bot'
      const msgTimestamp = new Date().toISOString();
      const { data: createdMsg } = await admin
        .from('messages')
        .insert({
          conversation_id: row.conversation_id,
          sender_type: 'bot',
          content_type: kind === 'audio' ? 'audio' : kind === 'image' ? 'image' : 'text',
          content_text: resolvedText,
          media_url: (quickReply?.media_url as string) || null,
          message_id: uazapiMessageId,
          status: 'delivered',
          created_at: msgTimestamp,
        })
        .select('id, created_at')
        .maybeSingle();

      // 9. Mark follow-up as SENT
      await admin.from('conversation_follow_ups').update({
        status: 'sent',
        sent_at: msgTimestamp,
        uazapi_message_id: uazapiMessageId,
        updated_at: msgTimestamp,
      }).eq('id', row.id);

      // 10. Increment quick reply usage
      try {
        await admin.rpc('increment_quick_reply_usage', { p_id: row.response_id });
      } catch {}

      // 11. Emit to UI bus
      whatsappBus.emitInboxEvent({
        accountId: row.account_id,
        conversationId: row.conversation_id,
        eventType: 'INSERT',
        message: {
          id: createdMsg?.id || `msg-${Date.now()}`,
          conversation_id: row.conversation_id,
          sender_type: 'bot',
          content_type: kind === 'audio' ? 'audio' : 'text',
          content_text: resolvedText,
          media_url: (quickReply?.media_url as string) || null,
          message_id: uazapiMessageId,
          status: 'delivered',
          created_at: msgTimestamp,
        },
        conversation: {
          id: row.conversation_id,
          last_message_text: resolvedText,
          last_message_at: msgTimestamp,
          unread_count: 0,
        },
      });

      sent++;
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : 'Unknown follow-up dispatch error';
      console.error(`[follow-up-engine] Error executing follow-up ${row.id}:`, err);
      await admin.from('conversation_follow_ups').update({
        status: 'failed',
        failed_at: new Date().toISOString(),
        error_message: errMsg,
        updated_at: new Date().toISOString(),
      }).eq('id', row.id);
    }
  }

  return { processed: due.length, sent, cancelled };
}
