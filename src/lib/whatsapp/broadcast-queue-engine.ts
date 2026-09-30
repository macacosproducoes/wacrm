// ============================================================
// Broadcast Queue Engine (Cooldown & Safety Management)
//
// Persistent, backend-driven message queue executor:
// - Atomic single-recipient claims via 'claim_next_broadcast_recipient'
// - Cooldown interval between messages
// - Configurable batch sizes and batch pause timers
// - Daily sending limit verification per account and timezone
// - Active sending window verification (start / end hour in timezone)
// - Opt-out / blocklist checking before dispatch
// - Circuit breaker auto-pause for rate limits, account blocks, or consecutive failures
// - Full event timeline logging in 'broadcast_events'
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';
import { sendTemplateMessage } from '@/lib/whatsapp/meta-api';
import { decrypt } from '@/lib/whatsapp/encryption';
import {
  sanitizePhoneForMeta,
  phoneVariants,
  isRecipientNotAllowedError,
} from '@/lib/whatsapp/phone-utils';
import { resolveTemplateRow } from '@/lib/whatsapp/template-body';
import {
  sendUazApiText,
  sendUazApiMedia,
  normalizeBaseUrl,
} from '@/lib/whatsapp/uazapi-client';
import { finalizeBroadcastStatus } from '@/lib/whatsapp/broadcast-core';
import type { Broadcast, BroadcastEvent } from '@/types';

export interface QueueTickResult {
  broadcastId: string;
  status: 'idle' | 'running' | 'paused' | 'batch_paused' | 'completed' | 'cancelled' | 'outside_window' | 'daily_limit_reached';
  messagesProcessedThisTick: number;
  sentCount: number;
  failedCount: number;
  cancelledCount: number;
  nextRunAt?: string | null;
  pausedReason?: string | null;
  message?: string;
}

/** Sleep utility for cooldown intervals */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Log a timeline event for this broadcast
 */
export async function logBroadcastEvent(
  db: SupabaseClient,
  broadcastId: string,
  accountId: string | undefined,
  eventType: BroadcastEvent['event_type'],
  message: string,
  details?: Record<string, unknown> | null
): Promise<void> {
  try {
    await db.from('broadcast_events').insert({
      broadcast_id: broadcastId,
      account_id: accountId || null,
      event_type: eventType,
      message,
      details: details || null,
    });
  } catch (err) {
    console.error('[broadcast-queue-engine] Failed to log event:', err);
  }
}

/**
 * Check whether the current time falls within the configured window (e.g. "08:00" to "20:00")
 */
export function isWithinSendingWindow(
  startTime = '08:00',
  endTime = '20:00',
  timeZone = 'America/Sao_Paulo'
): boolean {
  try {
    const now = new Date();
    const formatter = new Intl.DateTimeFormat('en-GB', {
      timeZone,
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
    const currentHhMm = formatter.format(now);

    const [startH, startM] = startTime.split(':').map(Number);
    const [endH, endM] = endTime.split(':').map(Number);
    const [curH, curM] = currentHhMm.split(':').map(Number);

    const startVal = startH * 60 + (startM || 0);
    const endVal = endH * 60 + (endM || 0);
    const curVal = curH * 60 + (curM || 0);

    if (startVal <= endVal) {
      return curVal >= startVal && curVal <= endVal;
    }
    // Overnight window (e.g., 22:00 to 06:00)
    return curVal >= startVal || curVal <= endVal;
  } catch {
    // If timezone is invalid, allow send rather than deadlocking
    return true;
  }
}

/**
 * Check if the account has reached its daily sending limit for the current calendar day
 */
export async function checkDailySendingLimit(
  db: SupabaseClient,
  accountId: string,
  dailyLimit: number,
  timeZone = 'America/Sao_Paulo'
): Promise<{ allowed: boolean; sentToday: number; dailyLimit: number }> {
  try {
    // Determine midnight of the current day in the configured timezone
    const now = new Date();
    const localDateStr = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(now); // "YYYY-MM-DD"

    const startOfDayUtc = new Date(`${localDateStr}T00:00:00Z`).toISOString();

    const { count, error } = await db
      .from('broadcast_recipients')
      .select('id, broadcasts!inner(account_id)', { count: 'exact', head: true })
      .eq('broadcasts.account_id', accountId)
      .in('status', ['sent', 'delivered', 'read', 'replied'])
      .gte('sent_at', startOfDayUtc);

    if (error) {
      console.warn('[broadcast-queue-engine] Error counting daily sends:', error);
      return { allowed: true, sentToday: 0, dailyLimit };
    }

    const sentToday = count ?? 0;
    return {
      allowed: sentToday < dailyLimit,
      sentToday,
      dailyLimit,
    };
  } catch {
    return { allowed: true, sentToday: 0, dailyLimit };
  }
}

/**
 * Check if contact is opted out or blocked from receiving marketing/broadcast messages
 */
export async function isContactOptedOut(
  db: SupabaseClient,
  contactId: string
): Promise<boolean> {
  try {
    // Check contact tags for opt-out keywords
    const { data: contactTags } = await db
      .from('contact_tags')
      .select('tags(name)')
      .eq('contact_id', contactId);

    const optOutTags = ['opt-out', 'optout', 'descadastro', 'bloqueado', 'spam', 'cancelar', 'stop'];
    for (const ct of contactTags ?? []) {
      const tagName = (ct as any)?.tags?.name?.toLowerCase()?.trim();
      if (tagName && optOutTags.some((term) => tagName.includes(term))) {
        return true;
      }
    }

    return false;
  } catch {
    return false;
  }
}

/**
 * Classify errors into security blocks (circuit breaker) vs ordinary transient failures
 */
export function classifyBroadcastError(errorMessage: string): {
  isSecurityBlock: boolean;
  reason: string;
} {
  const lower = errorMessage.toLowerCase();

  // Meta specific security error codes
  if (lower.includes('131056') || lower.includes('pair rate limit')) {
    return {
      isSecurityBlock: true,
      reason: 'Limite de taxa de envio de mensagens do WhatsApp atingido (Meta 131056).',
    };
  }
  if (lower.includes('131031') || lower.includes('account locked')) {
    return {
      isSecurityBlock: true,
      reason: 'Conta WhatsApp bloqueada ou com restrições ativas (Meta 131031).',
    };
  }
  if (lower.includes('368') || lower.includes('temporarily blocked')) {
    return {
      isSecurityBlock: true,
      reason: 'Envio bloqueado temporariamente por detecção antispam / política (Meta 368).',
    };
  }
  if (lower.includes('141006') || lower.includes('quality rating')) {
    return {
      isSecurityBlock: true,
      reason: 'Envio pausado devido à queda na classificação de qualidade da conta (Meta 141006).',
    };
  }
  if (lower.includes('429') || lower.includes('rate limit') || lower.includes('too many requests')) {
    return {
      isSecurityBlock: true,
      reason: 'Limite de requisições excedido junto ao provedor (429 Rate Limit).',
    };
  }
  if (lower.includes('account restricted') || lower.includes('spam policy') || lower.includes('banned')) {
    return {
      isSecurityBlock: true,
      reason: 'Sinal de restrição ou bloqueio recebido do provedor: ' + errorMessage,
    };
  }

  // UazAPI disconnection/logout signals
  if (lower.includes('session closed') || lower.includes('not connected') || lower.includes('device disconnected')) {
    return {
      isSecurityBlock: true,
      reason: 'Instância WhatsApp desconectada do provedor UazAPI.',
    };
  }

  return {
    isSecurityBlock: false,
    reason: errorMessage,
  };
}

/**
 * Claim the mutex delivery lock on a broadcast
 */
export async function claimQueueLock(
  db: SupabaseClient,
  broadcastId: string,
  timeoutMinutes = 5
): Promise<boolean> {
  const cutoff = new Date(Date.now() - timeoutMinutes * 60 * 1000).toISOString();
  const { data, error } = await db
    .from('broadcasts')
    .update({ delivery_locked_at: new Date().toISOString() })
    .eq('id', broadcastId)
    .or(`delivery_locked_at.is.null,delivery_locked_at.lt.${cutoff}`)
    .select('id');

  if (error || !data || data.length === 0) {
    return false;
  }
  return true;
}

/**
 * Release the mutex delivery lock on a broadcast
 */
export async function releaseQueueLock(
  db: SupabaseClient,
  broadcastId: string
): Promise<void> {
  await db
    .from('broadcasts')
    .update({ delivery_locked_at: null })
    .eq('id', broadcastId);
}

/**
 * Pause a broadcast campaign (Admin or Auto)
 */
export async function pauseBroadcast(
  db: SupabaseClient,
  broadcastId: string,
  reason: string,
  accountId?: string
): Promise<void> {
  await db
    .from('broadcasts')
    .update({
      status: 'paused',
      paused_reason: reason,
      delivery_locked_at: null,
      updated_at: new Date().toISOString(),
    })
    .eq('id', broadcastId);

  await logBroadcastEvent(
    db,
    broadcastId,
    accountId,
    'paused',
    `Campanha pausada: ${reason}`,
    { reason }
  );
}

/**
 * Resume a paused or scheduled broadcast campaign
 */
export async function resumeBroadcast(
  db: SupabaseClient,
  broadcastId: string,
  accountId?: string
): Promise<void> {
  await db
    .from('broadcasts')
    .update({
      status: 'sending',
      paused_reason: null,
      consecutive_failures: 0,
      next_run_at: null,
      delivery_locked_at: null,
      updated_at: new Date().toISOString(),
    })
    .eq('id', broadcastId);

  await logBroadcastEvent(
    db,
    broadcastId,
    accountId,
    'resumed',
    'Campanha retomada pelo administrador.',
    {}
  );
}

/**
 * Cancel a broadcast campaign and mark remaining pending/processing recipients as cancelled
 */
export async function cancelBroadcast(
  db: SupabaseClient,
  broadcastId: string,
  reason = 'Cancelado pelo usuário',
  accountId?: string
): Promise<void> {
  await db
    .from('broadcasts')
    .update({
      status: 'cancelled',
      paused_reason: reason,
      delivery_locked_at: null,
      updated_at: new Date().toISOString(),
    })
    .eq('id', broadcastId);

  // Mark all unreached recipients as cancelled
  await db
    .from('broadcast_recipients')
    .update({
      status: 'cancelled',
      error_message: reason,
    })
    .eq('broadcast_id', broadcastId)
    .in('status', ['pending', 'processing']);

  await logBroadcastEvent(
    db,
    broadcastId,
    accountId,
    'cancelled',
    `Campanha cancelada: ${reason}`,
    { reason }
  );
}

/**
 * Process a queue tick for a broadcast campaign.
 * Executes messages sequentially respecting cooldown, batch pause, limits, and safety pauses.
 */
export async function processBroadcastQueueTick(
  db: SupabaseClient,
  broadcastId: string,
  options: {
    maxMessagesThisTick?: number;
    forceResume?: boolean;
  } = {}
): Promise<QueueTickResult> {
  // 1. Fetch broadcast state
  const { data: broadcast, error: fetchErr } = await db
    .from('broadcasts')
    .select('*')
    .eq('id', broadcastId)
    .single();

  if (fetchErr || !broadcast) {
    return {
      broadcastId,
      status: 'idle',
      messagesProcessedThisTick: 0,
      sentCount: 0,
      failedCount: 0,
      cancelledCount: 0,
      message: 'Broadcast not found',
    };
  }

  const b = broadcast as Broadcast;

  if (b.status === 'paused') {
    return {
      broadcastId,
      status: 'paused',
      messagesProcessedThisTick: 0,
      sentCount: 0,
      failedCount: 0,
      cancelledCount: 0,
      pausedReason: b.paused_reason,
      message: 'Campanha está pausada.',
    };
  }

  if (b.status === 'cancelled') {
    return {
      broadcastId,
      status: 'cancelled',
      messagesProcessedThisTick: 0,
      sentCount: 0,
      failedCount: 0,
      cancelledCount: 0,
      message: 'Campanha foi cancelada.',
    };
  }

  if (b.status !== 'sending') {
    return {
      broadcastId,
      status: 'idle',
      messagesProcessedThisTick: 0,
      sentCount: 0,
      failedCount: 0,
      cancelledCount: 0,
      message: `Campanha em status: ${b.status}`,
    };
  }

  const accountId = b.account_id || (b as any).account_id;
  const timeZone = b.timezone || 'America/Sao_Paulo';
  const cooldownSec = Math.max(1, b.cooldown_interval_seconds ?? 5);
  const batchSize = Math.max(1, b.batch_size ?? 20);
  const batchPauseSec = Math.max(1, b.batch_pause_seconds ?? 60);
  const dailyLimit = Math.max(1, b.daily_limit ?? 1000);
  const maxConsecutiveFailures = Math.max(1, b.max_consecutive_failures ?? 5);
  const windowStart = b.window_start_time || '08:00';
  const windowEnd = b.window_end_time || '20:00';

  // 2. Check Active Sending Window
  if (!isWithinSendingWindow(windowStart, windowEnd, timeZone)) {
    return {
      broadcastId,
      status: 'outside_window',
      messagesProcessedThisTick: 0,
      sentCount: 0,
      failedCount: 0,
      cancelledCount: 0,
      message: `Fora do horário permitido de envio (${windowStart} às ${windowEnd} ${timeZone}).`,
    };
  }

  // 3. Check Daily Sending Limit
  if (accountId) {
    const dailyCheck = await checkDailySendingLimit(db, accountId, dailyLimit, timeZone);
    if (!dailyCheck.allowed) {
      const reason = `Limite diário atingido (${dailyCheck.sentToday}/${dailyLimit} mensagens hoje).`;
      await pauseBroadcast(db, broadcastId, reason, accountId);
      return {
        broadcastId,
        status: 'daily_limit_reached',
        messagesProcessedThisTick: 0,
        sentCount: 0,
        failedCount: 0,
        cancelledCount: 0,
        pausedReason: reason,
        message: reason,
      };
    }
  }

  // 4. Check Batch Pause Timer (next_run_at)
  if (b.next_run_at && !options.forceResume) {
    const nextRun = new Date(b.next_run_at).getTime();
    const now = Date.now();
    if (nextRun > now) {
      return {
        broadcastId,
        status: 'batch_paused',
        messagesProcessedThisTick: 0,
        sentCount: 0,
        failedCount: 0,
        cancelledCount: 0,
        nextRunAt: b.next_run_at,
        message: `Aguardando pausa de lote até ${new Date(b.next_run_at).toLocaleTimeString()}.`,
      };
    }
  }

  // 5. Claim delivery lock mutex
  const locked = await claimQueueLock(db, broadcastId);
  if (!locked) {
    return {
      broadcastId,
      status: 'running',
      messagesProcessedThisTick: 0,
      sentCount: 0,
      failedCount: 0,
      cancelledCount: 0,
      message: 'Outro processo já está enviando mensagens desta fila.',
    };
  }

  let processedCount = 0;
  let sentCount = 0;
  let failedCount = 0;
  let cancelledCount = 0;
  let consecutiveFailures = b.consecutive_failures ?? 0;

  try {
    // 6. Resolve provider configuration once for the tick
    let provider: 'meta' | 'uazapi' = 'meta';
    let uazConn: any = null;
    let metaConfig: any = null;

    if (accountId) {
      const { data: uaz } = await db
        .from('whatsapp_connections')
        .select('*')
        .eq('account_id', accountId)
        .eq('provider', 'uazapi')
        .eq('is_active', true)
        .maybeSingle();

      if (uaz) {
        provider = 'uazapi';
        uazConn = uaz;
      } else {
        const { data: meta } = await db
          .from('whatsapp_config')
          .select('*')
          .eq('account_id', accountId)
          .maybeSingle();
        metaConfig = meta;
      }
    }

    const resolvedTemplate = await resolveTemplateRow(
      db,
      accountId || '',
      b.template_name,
      b.template_language
    );
    const templateRow = resolvedTemplate.row;

    // Determine how many messages to attempt in this execution tick
    const maxMessages = options.maxMessagesThisTick || batchSize;

    while (processedCount < maxMessages) {
      // Re-check if broadcast was paused or cancelled by an outside call during the loop
      const { data: curBcast } = await db
        .from('broadcasts')
        .select('status, paused_reason')
        .eq('id', broadcastId)
        .single();

      if (curBcast?.status === 'paused' || curBcast?.status === 'cancelled') {
        break;
      }

      // Claim next recipient atomically via PostgreSQL FOR UPDATE SKIP LOCKED function
      const { data: claimRows, error: claimErr } = await db.rpc(
        'claim_next_broadcast_recipient',
        { p_broadcast_id: broadcastId }
      );

      if (claimErr) {
        console.error('[broadcast-queue-engine] Claim error:', claimErr);
        break;
      }

      if (!claimRows || claimRows.length === 0) {
        // No pending recipients left! Finalize broadcast status
        await finalizeBroadcastStatus(db, broadcastId);
        await logBroadcastEvent(
          db,
          broadcastId,
          accountId,
          'message_sent',
          'Todos os contatos da fila foram processados.'
        );
        return {
          broadcastId,
          status: 'completed',
          messagesProcessedThisTick: processedCount,
          sentCount,
          failedCount,
          cancelledCount,
          message: 'Fila de envio concluída com sucesso.',
        };
      }

      const rec = claimRows[0];
      const recipientId = rec.recipient_id as string;
      const contactId = rec.contact_id as string;
      const rawPhone = rec.phone as string;
      const params: string[] = Array.isArray(rec.template_params)
        ? rec.template_params
        : [];

      // Check opt-out / consent
      const isOptedOut = await isContactOptedOut(db, contactId);
      if (isOptedOut) {
        await db
          .from('broadcast_recipients')
          .update({
            status: 'cancelled',
            error_message: 'Contato com tag de descadastro / opt-out.',
          })
          .eq('id', recipientId);

        cancelledCount++;
        processedCount++;
        continue;
      }

      // Check phone validity
      const sanitizedPhone = sanitizePhoneForMeta(rawPhone || '');
      if (!sanitizedPhone) {
        await db
          .from('broadcast_recipients')
          .update({
            status: 'failed',
            error_message: 'Número de telefone inválido.',
          })
          .eq('id', recipientId);

        failedCount++;
        processedCount++;
        continue;
      }

      // Execute Send via active provider
      let sentMessageId: string | null = null;
      let lastError: string | null = null;

      try {
        if (provider === 'uazapi' && uazConn) {
          const uazConfig = uazConn.provider_config || {};
          let token = '';
          try {
            token = decrypt(uazConfig.token);
          } catch {
            token = uazConfig.token;
          }
          const baseUrl = normalizeBaseUrl(uazConfig.base_url);

          // Build list of message variations (Var 1 principal + up to 3 extra variations = total 4)
          const allVariations: string[] = [];
          if (templateRow?.body_text && templateRow.body_text.trim()) {
            allVariations.push(templateRow.body_text.trim());
          }
          if (Array.isArray(templateRow?.variations)) {
            for (const v of templateRow.variations) {
              if (typeof v === 'string' && v.trim() && !allVariations.includes(v.trim())) {
                allVariations.push(v.trim());
              }
            }
          }
          const extraVars = (b.template_variables as Record<string, unknown> | null)?._variations;
          if (Array.isArray(extraVars)) {
            for (const v of extraVars) {
              if (typeof v === 'string' && v.trim() && !allVariations.includes(v.trim())) {
                allVariations.push(v.trim());
              }
            }
          }

          // Rotate variations sequentially per contact to bypass spam patterns
          const chosenBody = allVariations.length > 0
            ? allVariations[(b.sent_count + sentCount + failedCount) % allVariations.length]
            : (templateRow?.body_text || b.template_name);

          let text = chosenBody;
          params.forEach((val, idx) => {
            text = text.replaceAll(`{{${idx + 1}}}`, val);
          });
          if (templateRow?.header_content) {
            text = `*${templateRow.header_content}*\n\n${text}`;
          }
          if (templateRow?.footer_text) {
            text = `${text}\n\n_${templateRow.footer_text}_`;
          }

          const mediaUrl = templateRow?.header_media_url;
          if (mediaUrl) {
            const res = await sendUazApiMedia(baseUrl, token, {
              number: sanitizedPhone,
              url: mediaUrl,
              type: 'image',
              caption: text,
            });
            sentMessageId = res.messageId;
          } else {
            const res = await sendUazApiText(baseUrl, token, {
              number: sanitizedPhone,
              text,
            });
            sentMessageId = res.messageId;
          }
        } else if (metaConfig) {
          const accessToken = decrypt(metaConfig.access_token);
          const variants = phoneVariants(sanitizedPhone);

          for (const variant of variants) {
            try {
              const res = await sendTemplateMessage({
                phoneNumberId: metaConfig.phone_number_id,
                accessToken,
                to: variant,
                templateName: b.template_name,
                language: b.template_language || 'pt_BR',
                template: templateRow ?? undefined,
                params,
              });
              sentMessageId = res.messageId;
              lastError = null;
              break;
            } catch (err) {
              const msg = err instanceof Error ? err.message : 'Unknown error';
              lastError = msg;
              if (!isRecipientNotAllowedError(msg)) break;
            }
          }
        } else {
          lastError = 'Provedor WhatsApp não configurado.';
        }
      } catch (err) {
        lastError = err instanceof Error ? err.message : 'Falha no envio';
      }

      // Handle Result & Circuit Breaker
      if (sentMessageId) {
        consecutiveFailures = 0;
        sentCount++;
        processedCount++;

        await db
          .from('broadcast_recipients')
          .update({
            status: 'sent',
            sent_at: new Date().toISOString(),
            whatsapp_message_id: sentMessageId,
            error_message: null,
          })
          .eq('id', recipientId);

        await db
          .from('broadcasts')
          .update({
            consecutive_failures: 0,
            updated_at: new Date().toISOString(),
          })
          .eq('id', broadcastId);
      } else {
        // Failed send
        failedCount++;
        processedCount++;
        consecutiveFailures++;

        await db
          .from('broadcast_recipients')
          .update({
            status: 'failed',
            error_message: lastError || 'Erro desconhecido',
          })
          .eq('id', recipientId);

        await db
          .from('broadcasts')
          .update({
            consecutive_failures: consecutiveFailures,
            updated_at: new Date().toISOString(),
          })
          .eq('id', broadcastId);

        // Check for security block / rate limit circuit breaker
        const classification = classifyBroadcastError(lastError || '');
        if (classification.isSecurityBlock) {
          const pauseMsg = `Pausa de segurança automática: ${classification.reason}`;
          await pauseBroadcast(db, broadcastId, pauseMsg, accountId);
          await logBroadcastEvent(
            db,
            broadcastId,
            accountId,
            'auto_pause_safety',
            pauseMsg,
            { error: lastError, recipientId, phone: sanitizedPhone }
          );

          return {
            broadcastId,
            status: 'paused',
            messagesProcessedThisTick: processedCount,
            sentCount,
            failedCount,
            cancelledCount,
            pausedReason: pauseMsg,
            message: pauseMsg,
          };
        }

        // Check consecutive failures threshold
        if (consecutiveFailures >= maxConsecutiveFailures) {
          const pauseMsg = `Pausa automática de segurança: ${consecutiveFailures} falhas consecutivas de envio.`;
          await pauseBroadcast(db, broadcastId, pauseMsg, accountId);
          await logBroadcastEvent(
            db,
            broadcastId,
            accountId,
            'auto_pause_safety',
            pauseMsg,
            { consecutiveFailures, lastError }
          );

          return {
            broadcastId,
            status: 'paused',
            messagesProcessedThisTick: processedCount,
            sentCount,
            failedCount,
            cancelledCount,
            pausedReason: pauseMsg,
            message: pauseMsg,
          };
        }
      }

      // Check if batch is completed
      if (processedCount % batchSize === 0) {
        const nextRunAt = new Date(Date.now() + batchPauseSec * 1000).toISOString();
        await db
          .from('broadcasts')
          .update({
            next_run_at: nextRunAt,
            updated_at: new Date().toISOString(),
          })
          .eq('id', broadcastId);

        await logBroadcastEvent(
          db,
          broadcastId,
          accountId,
          'batch_pause',
          `Lote de ${batchSize} mensagens concluído. Pausa de ${batchPauseSec}s programada.`,
          { batchSize, batchPauseSec, nextRunAt }
        );

        return {
          broadcastId,
          status: 'batch_paused',
          messagesProcessedThisTick: processedCount,
          sentCount,
          failedCount,
          cancelledCount,
          nextRunAt,
          message: `Lote concluído. Pausa de ${batchPauseSec}s.`,
        };
      }

      // Cooldown sleep before next message in the same batch
      if (cooldownSec > 0 && processedCount < maxMessages) {
        await sleep(cooldownSec * 1000);
      }
    }

    // Check remaining pending recipients
    const { count: pendingLeft } = await db
      .from('broadcast_recipients')
      .select('id', { count: 'exact', head: true })
      .eq('broadcast_id', broadcastId)
      .eq('status', 'pending');

    if ((pendingLeft ?? 0) === 0) {
      await finalizeBroadcastStatus(db, broadcastId);
      return {
        broadcastId,
        status: 'completed',
        messagesProcessedThisTick: processedCount,
        sentCount,
        failedCount,
        cancelledCount,
        message: 'Todos os contatos foram processados.',
      };
    }

    return {
      broadcastId,
      status: 'running',
      messagesProcessedThisTick: processedCount,
      sentCount,
      failedCount,
      cancelledCount,
      message: `Processadas ${processedCount} mensagens neste ciclo.`,
    };
  } finally {
    await releaseQueueLock(db, broadcastId);
  }
}
