import { SupabaseClient } from '@supabase/supabase-js'
import { whatsappBus } from '@/lib/whatsapp/whatsapp-bus'

export interface NotifyPaymentParams {
  accountId: string
  contactId?: string | null
  conversationId?: string | null
  leadName?: string | null
  amount?: number | null
  paymentId: string
  externalId?: string | null
}

// In-memory cache to deduplicate simultaneous or rapid webhook retries (TTL: 15 minutes)
const notifiedPaymentsCache = new Map<string, number>()

function isRecentlyNotified(key: string): boolean {
  const now = Date.now()
  const timestamp = notifiedPaymentsCache.get(key)
  if (timestamp && now - timestamp < 15 * 60 * 1000) {
    return true
  }
  // Housekeeping: remove old keys
  if (notifiedPaymentsCache.size > 500) {
    for (const [k, t] of notifiedPaymentsCache.entries()) {
      if (now - t >= 15 * 60 * 1000) {
        notifiedPaymentsCache.delete(k)
      }
    }
  }
  return false
}

function markAsNotified(key: string) {
  notifiedPaymentsCache.set(key, Date.now())
}

/**
 * Creates a notification in the CRM `notifications` table and emits a real-time event
 * so the CRM bell badge increments and an instant toast pops up on screen.
 *
 * Fully protected against duplicate webhooks and rapid polling loops.
 */
export async function notifyPaymentInCrm(
  admin: SupabaseClient,
  params: NotifyPaymentParams
) {
  try {
    const paymentId = String(params.paymentId || '').trim()
    const externalId = String(params.externalId || '').trim()

    // 0. Fast In-Memory Deduplication Check
    if (paymentId && isRecentlyNotified(paymentId)) {
      console.log(`[notifyPaymentInCrm] Ignorando duplicação em memória para paymentId: ${paymentId}`)
      return
    }
    if (externalId && isRecentlyNotified(externalId)) {
      console.log(`[notifyPaymentInCrm] Ignorando duplicação em memória para externalId: ${externalId}`)
      return
    }

    const amountVal = Number(params.amount || 0)
    const formattedAmount = amountVal > 0 ? `R$ ${amountVal.toFixed(2).replace('.', ',')}` : 'PIX'
    const name = params.leadName || 'Cliente'

    // 1. Database Deduplication Check (look back 10 minutes)
    const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString()

    if (params.contactId) {
      const { data: recentForContact } = await admin
        .from('notifications')
        .select('id, body, created_at')
        .eq('account_id', params.accountId)
        .eq('contact_id', params.contactId)
        .eq('title', '🎉 Pagamento Recebido!')
        .gte('created_at', tenMinutesAgo)
        .limit(1)
        .maybeSingle()

      if (recentForContact) {
        console.log(`[notifyPaymentInCrm] Notificação recente já existe para lead ${params.contactId}. Ignorando duplicação.`)
        if (paymentId) markAsNotified(paymentId)
        if (externalId) markAsNotified(externalId)
        return
      }
    }

    // Also check if same notification text was recorded recently for this account
    const searchBody = `Recebeu pagamento de ${formattedAmount} de ${name}`
    const { data: recentDuplicate } = await admin
      .from('notifications')
      .select('id')
      .eq('account_id', params.accountId)
      .eq('title', '🎉 Pagamento Recebido!')
      .eq('body', searchBody)
      .gte('created_at', tenMinutesAgo)
      .limit(1)
      .maybeSingle()

    if (recentDuplicate) {
      console.log(`[notifyPaymentInCrm] Notificação idêntica já disparada recentemente. Ignorando duplicação.`)
      if (paymentId) markAsNotified(paymentId)
      if (externalId) markAsNotified(externalId)
      return
    }

    // 2. Resolve user_id and conversation_id
    let userId: string = '952cb520-d730-486b-8e00-dd63a5b4b529'
    let conversationId = params.conversationId || null

    if (params.contactId) {
      const { data: conv } = await admin
        .from('conversations')
        .select('id, user_id')
        .eq('account_id', params.accountId)
        .eq('contact_id', params.contactId)
        .maybeSingle()

      if (conv) {
        if (!conversationId) conversationId = conv.id
        if (conv.user_id) userId = conv.user_id
      }
    }

    if (!userId) {
      const { data: acc } = await admin
        .from('accounts')
        .select('owner_id')
        .eq('id', params.accountId)
        .maybeSingle()
      if (acc?.owner_id) userId = acc.owner_id
    }

    // 3. Mark as notified in memory before inserting to prevent race conditions
    if (paymentId) markAsNotified(paymentId)
    if (externalId) markAsNotified(externalId)

    // 4. Insert into notifications table (type conforms to notifications_type_check)
    const { error: notifErr } = await admin.from('notifications').insert({
      account_id: params.accountId,
      user_id: userId,
      type: 'conversation_assigned',
      conversation_id: conversationId,
      contact_id: params.contactId || null,
      title: '🎉 Pagamento Recebido!',
      body: searchBody,
    })

    if (notifErr) {
      console.warn('[notifyPaymentInCrm] Error inserting notification row:', notifErr)
    }

    // 5. Emit real-time bus event for toast and immediate UI reaction
    whatsappBus.emitInboxEvent({
      accountId: params.accountId,
      eventType: 'UPDATE',
      conversation: {
        id: conversationId || undefined,
        last_message_text: `🎉 Pagamento recebido: ${formattedAmount}`,
        last_message_at: new Date().toISOString(),
      },
      message: {
        type: 'payment_received',
        payment_id: paymentId,
        external_id: externalId,
        amount: amountVal,
        status: 'paid',
        lead_name: name,
        contact_id: params.contactId,
      },
    })
  } catch (err) {
    console.warn('[notifyPaymentInCrm] Unexpected error in notifyPaymentInCrm:', err)
  }
}
