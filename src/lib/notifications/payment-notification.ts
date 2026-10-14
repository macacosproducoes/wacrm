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

/**
 * Creates a notification in the CRM `notifications` table and emits a real-time event
 * so the CRM bell badge increments and an instant toast pops up on screen.
 */
export async function notifyPaymentInCrm(
  admin: SupabaseClient,
  params: NotifyPaymentParams
) {
  try {
    const amountVal = Number(params.amount || 0)
    const formattedAmount = amountVal > 0 ? `R$ ${amountVal.toFixed(2).replace('.', ',')}` : 'PIX'
    const name = params.leadName || 'Cliente'

    // 1. Resolve user_id and conversation_id
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

    // 2. Insert into notifications table (type conforms to notifications_type_check)
    const { error: notifErr } = await admin.from('notifications').insert({
      account_id: params.accountId,
      user_id: userId,
      type: 'conversation_assigned',
      conversation_id: conversationId,
      contact_id: params.contactId || null,
      title: '🎉 Pagamento Recebido!',
      body: `Recebeu pagamento de ${formattedAmount} de ${name}`,
    })

    if (notifErr) {
      console.warn('[notifyPaymentInCrm] Error inserting notification row:', notifErr)
    }

    // 3. Emit real-time bus event for toast and immediate UI reaction
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
        payment_id: params.paymentId,
        external_id: params.externalId,
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
