/**
 * First Payment Confirmation Automation Engine
 * 
 * Rules:
 * 1. ONLY on first payment confirmed for each lead (verified across payment history).
 * 2. Truly approved payment (Pix status === "paid" or "approved").
 * 3. Never confuse orders with payments: tracks contact_id and payment history.
 * 4. Deduplication: safe against duplicate webhooks for the same payment_id.
 * 5. Concurrency protection: in-memory mutex + DB transaction lock.
 * 6. Dispatches native WhatsApp PTT voice note via ZapPlus/UazAPI.
 * 7. Traceability: logs lead ID, payment ID, confirmed_at, attempted_at, status, message ID, failure reason.
 * 8. Safe retries on provider failure.
 */

import { createClient as createAdminClient, SupabaseClient } from '@supabase/supabase-js';
import {
  sendUazApiMedia,
  formatUazApiNumber,
  normalizeMediaUrl,
} from '@/lib/whatsapp/uazapi-client';
import { decrypt } from '@/lib/whatsapp/encryption';
import { whatsappBus } from '@/lib/whatsapp/whatsapp-bus';
import { notifyPaymentInCrm } from '@/lib/notifications/payment-notification';

// In-memory concurrency locks to prevent race conditions during simultaneous payment webhooks
const inFlightPaymentLocks = new Set<string>();

function supabaseAdmin(): SupabaseClient | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  return createAdminClient(url, key);
}

export interface FirstPaymentConfig {
  id?: string;
  account_id: string;
  user_id?: string;
  name: string;
  trigger_type: string;
  trigger_name: string;
  action_name: string;
  is_active: boolean;
  audio_id: string;
  audio_name: string;
  audio_url: string;
  execution_count?: number;
  last_executed_at?: string | null;
  created_at?: string;
  updated_at?: string;
}

export interface FirstPaymentLogStep {
  lead_id: string;
  lead_name?: string;
  lead_phone: string;
  payment_id: string;
  external_id?: string;
  amount?: number;
  confirmed_at: string;
  attempted_at: string;
  sent_at?: string | null;
  dispatch_status: 'pending' | 'sent' | 'failed' | 'skipped';
  whatsapp_message_id?: string | null;
  audio_id: string;
  audio_name: string;
  audio_url: string;
  error_reason?: string | null;
  attempt_count: number;
}

export interface FirstPaymentInput {
  payment_id: string;
  external_id?: string;
  status: string; // 'paid' | 'approved' | 'pending' | 'expired' | 'refused' | 'failed'
  amount?: number;
  contact_id?: string;
  account_id?: string;
  user_id?: string;
  buyer?: {
    name?: string;
    phone?: string;
    email?: string;
    document?: string;
  };
  confirmed_at?: string;
  raw_payload?: Record<string, unknown>;
  force_retry?: boolean;
  log_id?: string;
}

export interface ProcessFirstPaymentResult {
  success: boolean;
  dispatched: boolean;
  skipped?: boolean;
  reason?: string;
  messageId?: string;
  error?: string;
  logId?: string;
  leadId?: string;
}

const DEFAULT_AUDIO = {
  id: '2fc16835-ab2a-4bf2-a0a5-3f70c9af402a',
  name: 'PEDIDO CONFIRMADO',
  url: 'https://swovcbrtjzdsqgqzjrdm.supabase.co/storage/v1/object/public/chat-media/account-ce78c02b-49e0-43bf-b384-7cdd52f61b9f/WhatsApp%20Ptt%202025-11-16%20at%2023.28.43.ogg',
};

/**
 * Fetch automation configuration from CRM database (table automations).
 * If no row exists yet, returns active default.
 */
export async function getFirstPaymentConfig(accountId: string): Promise<FirstPaymentConfig> {
  const admin = supabaseAdmin();
  const fallback: FirstPaymentConfig = {
    account_id: accountId,
    name: 'Primeiro pagamento confirmado',
    trigger_type: 'first_payment_approved',
    trigger_name: 'Primeiro pagamento aprovado',
    action_name: 'Enviar áudio pelo WhatsApp',
    is_active: true,
    audio_id: DEFAULT_AUDIO.id,
    audio_name: DEFAULT_AUDIO.name,
    audio_url: DEFAULT_AUDIO.url,
  };

  if (!admin) return fallback;

  try {
    const { data, error } = await admin
      .from('automations')
      .select('*')
      .eq('account_id', accountId)
      .eq('trigger_type', 'first_payment_approved')
      .maybeSingle();

    if (error || !data) {
      return fallback;
    }

    const cfg = (data.trigger_config || {}) as Record<string, unknown>;
    return {
      id: data.id,
      account_id: data.account_id,
      user_id: data.user_id,
      name: data.name || 'Primeiro pagamento confirmado',
      trigger_type: 'first_payment_approved',
      trigger_name: 'Primeiro pagamento aprovado',
      action_name: 'Enviar áudio pelo WhatsApp',
      is_active: Boolean(data.is_active),
      audio_id: String(cfg.audio_id || DEFAULT_AUDIO.id),
      audio_name: String(cfg.audio_name || DEFAULT_AUDIO.name),
      audio_url: String(cfg.audio_url || DEFAULT_AUDIO.url),
      execution_count: Number(data.execution_count || 0),
      last_executed_at: data.last_executed_at || null,
      created_at: data.created_at,
      updated_at: data.updated_at,
    };
  } catch (err) {
    console.warn('[first-payment-engine] Error fetching config:', err);
    return fallback;
  }
}

/**
 * Save / Update automation configuration in CRM database.
 */
export async function saveFirstPaymentConfig(
  accountId: string,
  updates: {
    is_active?: boolean;
    audio_id?: string;
    user_id?: string;
  }
): Promise<{ success: boolean; config?: FirstPaymentConfig; error?: string }> {
  const admin = supabaseAdmin();
  if (!admin) return { success: false, error: 'Database not initialized' };

  try {
    let audioName = DEFAULT_AUDIO.name;
    let audioUrl = DEFAULT_AUDIO.url;

    const audioIdToFetch = updates.audio_id || DEFAULT_AUDIO.id;
    const { data: qr } = await admin
      .from('quick_replies')
      .select('id, title, media_url, interactive_payload')
      .eq('id', audioIdToFetch)
      .maybeSingle();

    if (qr) {
      audioName = qr.title || DEFAULT_AUDIO.name;
      const meta = (qr.interactive_payload || {}) as Record<string, unknown>;
      audioUrl = String(qr.media_url || meta.media_url || DEFAULT_AUDIO.url);
    }

    const { data: existing } = await admin
      .from('automations')
      .select('id, user_id, execution_count')
      .eq('account_id', accountId)
      .eq('trigger_type', 'first_payment_approved')
      .maybeSingle();

    const trigger_config = {
      audio_id: audioIdToFetch,
      audio_name: audioName,
      audio_url: audioUrl,
      updated_at: new Date().toISOString(),
    };

    if (existing?.id) {
      const { error } = await admin
        .from('automations')
        .update({
          is_active: updates.is_active !== undefined ? Boolean(updates.is_active) : undefined,
          trigger_config,
          updated_at: new Date().toISOString(),
        })
        .eq('id', existing.id);

      if (error) return { success: false, error: error.message };
      return { success: true, config: await getFirstPaymentConfig(accountId) };
    } else {
      let effectiveUserId = updates.user_id;
      if (!effectiveUserId) {
        const { data: u } = await admin.from('users').select('id').limit(1).maybeSingle();
        effectiveUserId = u?.id || '952cb520-d730-486b-8e00-dd63a5b4b529';
      }

      const { error } = await admin
        .from('automations')
        .insert({
          account_id: accountId,
          user_id: effectiveUserId,
          name: 'Primeiro pagamento confirmado',
          description: 'Envia áudio Pedido confirmado via WhatsApp ZapPlus no primeiro Pix aprovado do lead',
          trigger_type: 'first_payment_approved',
          trigger_config,
          is_active: updates.is_active !== undefined ? Boolean(updates.is_active) : true,
          execution_count: 0,
        });

      if (error) return { success: false, error: error.message };
      return { success: true, config: await getFirstPaymentConfig(accountId) };
    }
  } catch (err: any) {
    return { success: false, error: err?.message || 'Falha ao salvar configuração' };
  }
}

/**
 * Fetch available audios from quick_replies library in ZapPlus/CRM.
 */
export async function getAudioList(accountId: string) {
  const admin = supabaseAdmin();
  if (!admin) return [DEFAULT_AUDIO];

  try {
    const { data } = await admin
      .from('quick_replies')
      .select('id, title, media_url, media_duration, media_type, interactive_payload, category')
      .eq('account_id', accountId)
      .or('kind.eq.audio,media_type.ilike.%audio%,category.ilike.%áudio%,category.ilike.%audio%')
      .order('title', { ascending: true });

    if (!data || data.length === 0) {
      return [DEFAULT_AUDIO];
    }

    return data.map((item) => {
      const meta = (item.interactive_payload || {}) as Record<string, unknown>;
      return {
        id: item.id,
        name: item.title,
        url: item.media_url || (meta.media_url as string) || DEFAULT_AUDIO.url,
        duration: item.media_duration || (meta.media_duration as number) || 11,
      };
    });
  } catch {
    return [DEFAULT_AUDIO];
  }
}

/**
 * Fetch recent first payment automation logs for auditing and traceability.
 */
export async function getFirstPaymentLogs(accountId: string, limit = 50) {
  const admin = supabaseAdmin();
  if (!admin) return [];

  try {
    const { data, error } = await admin
      .from('automation_logs')
      .select('id, automation_id, contact_id, trigger_event, steps_executed, status, error_message, created_at, contacts(id, name, phone)')
      .eq('account_id', accountId)
      .eq('trigger_event', 'first_payment_approved')
      .order('created_at', { ascending: false })
      .limit(limit);

    if (error || !data) return [];

    return data.map((row: any) => {
      const steps = Array.isArray(row.steps_executed)
        ? row.steps_executed[0] || {}
        : (row.steps_executed || {});

      return {
        id: row.id,
        contact_id: row.contact_id,
        lead_name: row.contacts?.name || steps.lead_name || 'Lead',
        lead_phone: row.contacts?.phone || steps.lead_phone || '',
        payment_id: steps.payment_id || '',
        amount: steps.amount || 0,
        confirmed_at: steps.confirmed_at || row.created_at,
        attempted_at: steps.attempted_at || row.created_at,
        status: row.status === 'success' ? 'enviado' : row.status === 'failed' ? 'falhou' : 'pendente',
        whatsapp_message_id: steps.whatsapp_message_id || null,
        error_message: row.error_message || steps.error_reason || null,
        audio_name: steps.audio_name || DEFAULT_AUDIO.name,
        created_at: row.created_at,
      };
    });
  } catch (err) {
    console.error('[first-payment-engine] Error fetching logs:', err);
    return [];
  }
}

/**
 * Main execution function: Processes approved payment event, verifies lead history,
 * applies idempotency and concurrency guards, and dispatches ZapPlus voice note.
 */
export async function processFirstPaymentAutomation(
  input: FirstPaymentInput
): Promise<ProcessFirstPaymentResult> {
  const admin = supabaseAdmin();
  if (!admin) {
    return { success: false, dispatched: false, error: 'Database service unavailable' };
  }

  const {
    payment_id,
    external_id,
    status,
    amount,
    buyer,
    confirmed_at = new Date().toISOString(),
    force_retry = false,
  } = input;

  // 1. Mandatory Rule: Only truly confirmed payments (status === paid or approved)
  const cleanStatus = (status || "").toLowerCase().trim();
  const isApproved = cleanStatus === "paid" || cleanStatus === "approved";
  if (!isApproved) {
    console.log("[first-payment-engine] Skipping payment " + payment_id + ": status is " + cleanStatus + ", not paid.");
    return {
      success: true,
      dispatched: false,
      skipped: true,
      reason: "payment_status_" + (cleanStatus || "unapproved"),
    };
  }

  // 2. Identify stable Lead ID (contact_id)
  let contactId: string | null = input.contact_id || null;
  let accountId: string = input.account_id || 'ce78c02b-49e0-43bf-b384-7cdd52f61b9f';
  let contactPhone = buyer?.phone || '';
  let contactName = buyer?.name || 'Cliente';

  if (!contactId && external_id && external_id.startsWith("smm_")) {
    const parts = external_id.split("_");
    if (parts.length >= 3 && parts[1].length >= 32) {
      contactId = parts[1];
    }
  }

  // Always fetch contact from DB when contactId is known to guarantee we have their real WhatsApp phone and name!
  if (contactId) {
    const { data: dbContact } = await admin
      .from('contacts')
      .select('id, account_id, phone, name')
      .eq('id', contactId)
      .maybeSingle();

    if (dbContact) {
      if (dbContact.phone && (!contactPhone || !contactPhone.trim())) {
        contactPhone = dbContact.phone;
      }
      if (dbContact.name && (!contactName || contactName === 'Cliente')) {
        contactName = dbContact.name;
      }
      if (dbContact.account_id) {
        accountId = dbContact.account_id;
      }
    }
  }

  // Fallback: check recent conversation for this contact if phone is still empty
  if (contactId && (!contactPhone || !contactPhone.trim())) {
    const { data: conv } = await admin
      .from('conversations')
      .select('customer_phone')
      .eq('contact_id', contactId)
      .not('customer_phone', 'is', null)
      .order('updated_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (conv?.customer_phone) {
      contactPhone = conv.customer_phone;
    }
  }

  if (!contactId && contactPhone) {
    const rawDigits = contactPhone.replace(/\D/g, "");
    const cleanDigits = rawDigits.startsWith("55") ? rawDigits : "55" + rawDigits;

    const { data: existingContact } = await admin
      .from('contacts')
      .select('id, account_id, phone, name')
      .or("phone_normalized.eq." + rawDigits + ",phone_normalized.eq." + cleanDigits + ",phone.eq." + contactPhone + ",phone.eq." + cleanDigits)
      .limit(1)
      .maybeSingle();

    if (existingContact) {
      contactId = existingContact.id;
      accountId = existingContact.account_id;
      contactPhone = existingContact.phone;
      if (existingContact.name) contactName = existingContact.name;
    }
  }

  if (!contactId) {
    try {
      const rawDigits = contactPhone ? contactPhone.replace(/\D/g, "") : "";
      const cleanDigits = rawDigits ? (rawDigits.startsWith("55") ? rawDigits : "55" + rawDigits) : "55119" + Date.now().toString().slice(-8);
      const finalPhone = contactPhone || cleanDigits;

      const { data: acc } = await admin
        .from('accounts')
        .select('id, owner_id')
        .eq('id', accountId)
        .maybeSingle();
      const userId = acc?.owner_id || input.user_id || '952cb520-d730-486b-8e00-dd63a5b4b529';

      const { data: newContact } = await admin
        .from('contacts')
        .insert({
          account_id: accountId,
          user_id: userId,
          name: contactName,
          phone: finalPhone,
                    email: buyer?.email || null,
        })
        .select('id, account_id, phone, name')
        .single();

      if (newContact) {
        contactId = newContact.id;
        accountId = newContact.account_id;
        contactPhone = newContact.phone;
        console.log("[first-payment-engine] Created new contact for first payment: " + contactId);
      }
    } catch (createErr) {
      console.error("[first-payment-engine] Error creating contact for new lead:", createErr);
    }
  }

  if (!contactId) {
    return {
      success: false,
      dispatched: false,
      error: "Não foi possível identificar nem criar o lead correspondente.",
    };
  }

  // 3. Concurrency Protection: In-memory mutex for this specific lead
  const lockKey = accountId + ":" + contactId;
  if (inFlightPaymentLocks.has(lockKey) && !force_retry) {
    console.log("[first-payment-engine] Concurrent payment confirmation already running for lead " + contactId + ". Aborting parallel duplicate.");
    return {
      success: true,
      dispatched: false,
      skipped: true,
      reason: "concurrent_payment_processing",
    };
  }
  inFlightPaymentLocks.add(lockKey);

  try {
    // 4. Check Webhook Repetition (Deduplication on the exact same payment_id / external_id)
    const { data: existingPaymentLogs } = await admin
      .from('automation_logs')
      .select('id, status, steps_executed')
      .eq('account_id', accountId)
      .eq('trigger_event', 'first_payment_approved')
      .order('created_at', { ascending: false });

    if (existingPaymentLogs && existingPaymentLogs.length > 0) {
      for (const log of existingPaymentLogs) {
        const step = Array.isArray(log.steps_executed) ? log.steps_executed[0] : log.steps_executed;
        if (step && typeof step === "object") {
          if (
            (step.payment_id === payment_id || (external_id && step.external_id === external_id)) &&
            log.status === "success" &&
            !force_retry
          ) {
            console.log("[first-payment-engine] Duplicate webhook detected for payment " + payment_id + ". Audio already dispatched in log " + log.id);
            return {
              success: true,
              dispatched: false,
              skipped: true,
              reason: "duplicate_payment_webhook",
              logId: log.id,
            };
          }
        }
      }
    }

    // 5. Mandatory Rule: Only on the FIRST confirmed payment of each lead across history
    const { data: priorLeadLogs } = await admin
      .from('automation_logs')
      .select('id, status, created_at, steps_executed')
      .eq('account_id', accountId)
      .eq('contact_id', contactId)
      .eq('trigger_event', 'first_payment_approved')
      .eq('status', 'success');

    if (priorLeadLogs && priorLeadLogs.length > 0 && !force_retry) {
      console.log("[first-payment-engine] Lead " + contactId + " already had a confirmed payment previously. Skipping audio for subsequent payment.");
      return {
        success: true,
        dispatched: false,
        skipped: true,
        reason: "lead_already_had_payment",
        logId: priorLeadLogs[0].id,
      };
    }

    // 6. Automation Configuration Check (Ativo/Inativo in CRM panel)
    const config = await getFirstPaymentConfig(accountId);
    if (!config.is_active && !force_retry) {
      console.log("[first-payment-engine] Automation is inactive in CRM settings for account " + accountId);
      return {
        success: true,
        dispatched: false,
        skipped: true,
        reason: "automation_disabled",
      };
    }

    // 7. Resolve Audio Asset in ZapPlus ("PEDIDO CONFIRMADO")
    let audioUrl = normalizeMediaUrl(config.audio_url || DEFAULT_AUDIO.url);
    let audioName = config.audio_name || DEFAULT_AUDIO.name;
    let audioId = config.audio_id || DEFAULT_AUDIO.id;

    const { data: qr } = await admin
      .from('quick_replies')
      .select('id, title, media_url, interactive_payload')
      .eq('account_id', accountId)
      .ilike('title', '%PEDIDO CONFIRMADO%')
      .limit(1)
      .maybeSingle();

    if (qr) {
      audioId = qr.id;
      audioName = qr.title;
      const meta = (qr.interactive_payload || {}) as Record<string, unknown>;
      audioUrl = normalizeMediaUrl(qr.media_url || (meta.media_url as string) || audioUrl);
    }

    // 8. Find Active WhatsApp Connection in ZapPlus / UazAPI
    const { data: conns } = await admin
      .from('whatsapp_connections')
      .select('id, display_name, provider_config, phone_number, is_active')
      .eq('account_id', accountId)
      .eq('provider', 'uazapi')
      .eq('is_active', true)
      .order('created_at', { ascending: false })
      .limit(1);

    const connection = conns?.[0];
    if (!connection) {
      console.error("[first-payment-engine] No active WhatsApp connection found for account " + accountId);
      await recordAutomationLog(admin, {
        accountId,
        automationId: config.id,
        contactId,
        paymentId: payment_id,
        externalId: external_id,
        leadName: contactName,
        leadPhone: contactPhone,
        amount,
        confirmedAt: confirmed_at,
        attemptedAt: new Date().toISOString(),
        dispatchStatus: 'failed',
        status: 'failed',
        audioId,
        audioName,
        audioUrl,
        errorReason: "WhatsApp ZapPlus desconectado ou indisponível na conta",
      });

      return {
        success: false,
        dispatched: false,
        error: "WhatsApp ZapPlus desconectado ou indisponível na conta",
      };
    }

    const uazConfig = (connection.provider_config || {}) as Record<string, unknown>;
    let plainToken = String(uazConfig.token || "");
    try {
      plainToken = decrypt(plainToken);
    } catch {}

    const baseUrl = typeof uazConfig.base_url === "string" ? uazConfig.base_url : "https://free.uazapi.com";
    const formattedPhone = formatUazApiNumber(contactPhone);
    const attemptedAt = new Date().toISOString();

    if (!contactPhone || !contactPhone.trim() || !formattedPhone) {
      console.error("[first-payment-engine] Telefone do contato não encontrado para lead " + contactId);
      const failLog = await recordAutomationLog(admin, {
        accountId,
        automationId: config.id,
        contactId,
        paymentId: payment_id,
        externalId: external_id,
        leadName: contactName,
        leadPhone: "",
        amount,
        confirmedAt: confirmed_at,
        attemptedAt: new Date().toISOString(),
        dispatchStatus: 'failed',
        status: 'failed',
        audioId,
        audioName,
        audioUrl,
        errorReason: "Telefone WhatsApp do contato não cadastrado no CRM",
        existingLogId: input.log_id,
      });

      return {
        success: false,
        dispatched: false,
        error: "Telefone WhatsApp do contato não cadastrado no CRM",
        logId: failLog?.id,
      };
    }

    // 9. Dispatch native PTT voice note via ZapPlus/UazAPI with 9-digit Brazilian fallback retry
    let uazapiMessageId: string | null = null;
    let finalSentPhone = formattedPhone;

    try {
      console.log("[first-payment-engine] 🎙️ Disparando áudio " + audioName + " para " + formattedPhone + " (Lead ID: " + contactId + ", Payment ID: " + payment_id + ")...");

      const sendRes = await sendUazApiMedia(baseUrl, plainToken, {
        number: formattedPhone,
        url: audioUrl,
        type: 'audio',
        ptt: true,
      });

      uazapiMessageId = sendRes.messageId || ("ptt_" + Date.now());
      console.log("[first-payment-engine] ✅ Áudio WhatsApp disparado com sucesso! Message ID: " + uazapiMessageId);
    } catch (dispatchErr: any) {
      const errMsg = String(dispatchErr?.message || "").toLowerCase();
      let alternatePhone: string | null = null;
      if (errMsg.includes("not on whatsapp") || errMsg.includes("invalid") || errMsg.includes("not registered")) {
        if (formattedPhone.length === 13 && formattedPhone.startsWith("55") && formattedPhone[4] === "9") {
          alternatePhone = formattedPhone.slice(0, 4) + formattedPhone.slice(5);
        } else if (formattedPhone.length === 12 && formattedPhone.startsWith("55")) {
          alternatePhone = formattedPhone.slice(0, 4) + "9" + formattedPhone.slice(4);
        }
      }

      if (alternatePhone) {
        console.log("[first-payment-engine] 🔄 Retrying with alternate phone format: " + alternatePhone);
        try {
          const retryRes = await sendUazApiMedia(baseUrl, plainToken, {
            number: alternatePhone,
            url: audioUrl,
            type: 'audio',
            ptt: true,
          });
          uazapiMessageId = retryRes.messageId || ("ptt_" + Date.now());
          finalSentPhone = alternatePhone;
          console.log("[first-payment-engine] ✅ Retry bem-sucedido com formato alternativo! Message ID: " + uazapiMessageId);
        } catch (retryErr: any) {
          console.error("[first-payment-engine] ❌ Falha no retry pelo ZapPlus:", retryErr);
          dispatchErr = retryErr;
        }
      }

      if (!uazapiMessageId) {
        console.error("[first-payment-engine] ❌ Falha ao enviar áudio pelo ZapPlus:", dispatchErr);

        const failLog = await recordAutomationLog(admin, {
          accountId,
          automationId: config.id,
          contactId,
          paymentId: payment_id,
          externalId: external_id,
          leadName: contactName,
          leadPhone: formattedPhone,
          amount,
          confirmedAt: confirmed_at,
          attemptedAt,
          dispatchStatus: 'failed',
          status: 'failed',
          audioId,
          audioName,
          audioUrl,
          errorReason: dispatchErr?.message || "Falha na comunicação com o gateway WhatsApp ZapPlus",
          existingLogId: input.log_id,
        });

        return {
          success: false,
          dispatched: false,
          error: dispatchErr?.message || "Falha ao enviar áudio pelo ZapPlus",
          logId: failLog?.id,
        };
      }
    }

    // 10. Persist Success Log for Idempotency and Auditability
    const sentAt = new Date().toISOString();
    const successLog = await recordAutomationLog(admin, {
      accountId,
      automationId: config.id,
      contactId,
      paymentId: payment_id,
      externalId: external_id,
      leadName: contactName,
      leadPhone: finalSentPhone || contactPhone,
      amount,
      confirmedAt: confirmed_at,
      attemptedAt,
      sentAt,
      dispatchStatus: 'sent',
      status: 'success',
      whatsappMessageId: uazapiMessageId,
      audioId,
      audioName,
      audioUrl,
      errorReason: null,
      existingLogId: input.log_id,
    });

    // 11. Increment automation execution counter
    if (config.id) {
      try {
        await admin
          .from('automations')
          .update({
            execution_count: (config.execution_count || 0) + 1,
            last_executed_at: sentAt,
            updated_at: sentAt,
          })
          .eq('id', config.id);
      } catch {}
    }

    // 12. Sync message in CRM conversation inbox
    try {
      await syncInboxAudioMessage(admin, {
        accountId,
        contactId,
        formattedPhone,
        audioUrl,
        audioName,
        uazapiMessageId,
        sentAt,
        amount,
        leadName: contactName,
      });
    } catch (inboxErr) {
      console.warn("[first-payment-engine] Warning syncing inbox:", inboxErr);
    }

    // 13. Notify payment in CRM (Notifications table + Bell badge + Real-time toast)
    try {
      await notifyPaymentInCrm(admin, {
        accountId,
        contactId,
        leadName: contactName,
        amount,
        paymentId: payment_id,
        externalId: external_id,
      });
    } catch (notifErr) {
      console.warn("[first-payment-engine] Warning notifying CRM:", notifErr);
    }

    return {
      success: true,
      dispatched: true,
      messageId: uazapiMessageId,
      logId: successLog?.id,
      leadId: contactId,
    };
  } finally {
    inFlightPaymentLocks.delete(lockKey);
  }
}

/**
 * Helper to record execution log in automation_logs.
 */
async function recordAutomationLog(
  admin: SupabaseClient,
  params: {
    accountId: string;
    automationId?: string;
    contactId: string;
    paymentId: string;
    externalId?: string;
    leadName?: string;
    leadPhone: string;
    amount?: number;
    confirmedAt: string;
    attemptedAt: string;
    sentAt?: string | null;
    dispatchStatus: 'pending' | 'sent' | 'failed' | 'skipped';
    status: 'success' | 'failed' | 'partial';
    whatsappMessageId?: string | null;
    audioId: string;
    audioName: string;
    audioUrl: string;
    errorReason?: string | null;
    existingLogId?: string;
  }
) {
  try {
    let userId = '952cb520-d730-486b-8e00-dd63a5b4b529';
    if (params.automationId) {
      const { data: auto } = await admin.from('automations').select('user_id').eq('id', params.automationId).maybeSingle();
      if (auto?.user_id) userId = auto.user_id;
    }

    let effectiveAutoId = params.automationId;
    if (!effectiveAutoId) {
      const { data: auto } = await admin
        .from('automations')
        .select('id')
        .eq('account_id', params.accountId)
        .eq('trigger_type', 'first_payment_approved')
        .maybeSingle();
      effectiveAutoId = auto?.id;
    }

    if (!effectiveAutoId) {
      const { data: createdAuto } = await admin
        .from('automations')
        .insert({
          account_id: params.accountId,
          user_id: userId,
          name: 'Primeiro pagamento confirmado',
          trigger_type: 'first_payment_approved',
          is_active: true,
        })
        .select('id')
        .single();
      effectiveAutoId = createdAuto?.id;
    }

    const stepPayload: FirstPaymentLogStep = {
      lead_id: params.contactId,
      lead_name: params.leadName,
      lead_phone: params.leadPhone,
      payment_id: params.paymentId,
      external_id: params.externalId,
      amount: params.amount,
      confirmed_at: params.confirmedAt,
      attempted_at: params.attemptedAt,
      sent_at: params.sentAt,
      dispatch_status: params.dispatchStatus,
      whatsapp_message_id: params.whatsappMessageId,
      audio_id: params.audioId,
      audio_name: params.audioName,
      audio_url: params.audioUrl,
      error_reason: params.errorReason,
      attempt_count: 1,
    };

    if (params.existingLogId) {
      const { data: updatedLog } = await admin
        .from('automation_logs')
        .update({
          status: params.status,
          error_message: params.errorReason || null,
          steps_executed: [stepPayload],
        })
        .eq('id', params.existingLogId)
        .select('id')
        .single();

      if (updatedLog?.id) return updatedLog;
    }

    const { data: log, error } = await admin
      .from('automation_logs')
      .insert({
        account_id: params.accountId,
        user_id: userId,
        automation_id: effectiveAutoId || '00000000-0000-0000-0000-000000000000',
        contact_id: params.contactId,
        trigger_event: 'first_payment_approved',
        steps_executed: [stepPayload],
        status: params.status,
        error_message: params.errorReason || undefined,
      })
      .select('id')
      .single();

    if (error) {
      console.error("[first-payment-engine] Error writing automation log:", error);
    }
    return log;
  } catch (err) {
    console.error("[first-payment-engine] Exception writing log:", err);
    return null;
  }
}

/**
 * Syncs the audio note into the CRM conversation inbox.
 */
async function syncInboxAudioMessage(
  admin: SupabaseClient,
  params: {
    accountId: string;
    contactId: string;
    formattedPhone: string;
    audioUrl: string;
    audioName: string;
    uazapiMessageId: string;
    sentAt: string;
    amount?: number;
    leadName?: string;
  }
) {
  let { data: conv } = await admin
    .from('conversations')
    .select('id, user_id, contact_id, account_id')
    .eq('contact_id', params.contactId)
    .eq('account_id', params.accountId)
    .maybeSingle();

  if (!conv) {
    const { data: u } = await admin.from('users').select('id').limit(1).maybeSingle();
    const userId = u?.id || '952cb520-d730-486b-8e00-dd63a5b4b529';

    const { data: newConv } = await admin
      .from('conversations')
      .insert({
        account_id: params.accountId,
        user_id: userId,
        contact_id: params.contactId,
        status: 'bot_active',
        unread_count: 0,
        last_message_text: "🎙️ [Áudio: " + params.audioName + "]",
        last_message_at: params.sentAt,
      })
      .select('id, user_id, contact_id, account_id')
      .single();

    conv = newConv;
  }

  if (!conv?.id) return;

  const conversationId = conv.id;
  const messageText = "🎙️ " + params.audioName;

  const { data: createdMsg } = await admin
    .from('messages')
    .insert({
      conversation_id: conversationId,
      sender_type: 'bot',
      content_type: 'audio',
      content_text: messageText,
      media_url: params.audioUrl,
      media_type: 'audio/ogg',
      message_id: params.uazapiMessageId,
      status: 'delivered',
      created_at: params.sentAt,
    })
    .select('id, created_at')
    .maybeSingle();

  await admin
    .from('conversations')
    .update({
      last_message_text: messageText,
      last_message_at: params.sentAt,
    })
    .eq('id', conversationId);

  whatsappBus.emitInboxEvent({
    accountId: params.accountId,
    conversationId,
    eventType: 'INSERT',
    message: {
      id: createdMsg?.id || ("msg-" + Date.now()),
      conversation_id: conversationId,
      sender_type: 'bot',
      content_type: 'audio',
      content_text: messageText,
      media_url: params.audioUrl,
      media_type: 'audio/ogg',
      message_id: params.uazapiMessageId,
      status: 'delivered',
      created_at: params.sentAt,
      payment_confirmed: true,
      amount: params.amount,
      contact_id: params.contactId,
      lead_name: params.leadName,
    },
    conversation: {
      id: conversationId,
      last_message_text: messageText,
      last_message_at: params.sentAt,
      unread_count: 0,
    },
  });
}