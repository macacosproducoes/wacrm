import { NextResponse } from 'next/server'
import { createClient as createAdminClient } from '@supabase/supabase-js'
import { processFirstPaymentAutomation } from '@/lib/automations/first-payment-engine'
import { notifyPaymentInCrm } from '@/lib/notifications/payment-notification'
import { whatsappBus } from '@/lib/whatsapp/whatsapp-bus'

function supabaseAdmin() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) return null
  return createAdminClient(url, key)
}

export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => ({}))
    const { event, data } = body

    const rawStatus = String(data?.status || body?.status || '').toLowerCase().trim()
    const isPaid =
      event === 'transaction.processed' ||
      event === 'transaction.paid' ||
      rawStatus === 'paid' ||
      rawStatus === 'approved'

    const transactionId = String(data?.id || body?.id || `buck_${Date.now()}`)
    const externalId = String(data?.external_id || body?.external_id || transactionId)
    const amount = typeof data?.total_amount === 'number' ? data.total_amount / 100 : undefined

    console.log(`[BuckPay Webhook Received] Event: ${event}, Status: '${rawStatus}' (isPaid: ${isPaid})`, {
      transaction_id: transactionId,
      external_id: externalId,
      status: rawStatus,
      amount,
    })

    // 1. Audit log into webhook_events
    const admin = supabaseAdmin()
    if (admin) {
      try {
        await admin.from('webhook_events').insert({
          provider: 'buckpay',
          event_type: event || 'payment.status',
          external_event_id: externalId,
          payload: body,
          processing_status: isPaid ? 'COMPLETED' : 'RECEIVED',
          trace_id: `buckpay_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
        })
      } catch (dbErr) {
        console.warn('[BuckPay Webhook] Erro ao registrar em webhook_events:', dbErr)
      }
    }

    if (isPaid) {
      console.log(`🎉 [BuckPay Webhook] Pagamento confirmado! Transação ID: ${transactionId}`)
      
      const automationResult = await processFirstPaymentAutomation({
        payment_id: transactionId,
        external_id: externalId,
        status: 'paid',
        amount,
        buyer: data?.buyer,
        raw_payload: body,
      })

      console.log('[BuckPay Webhook] Resultado automação primeiro pagamento:', automationResult)

      if (admin) {
        await notifyPaymentInCrm(admin, {
          accountId: 'ce78c02b-49e0-43bf-b384-7cdd52f61b9f',
          contactId: automationResult?.leadId,
          leadName: data?.buyer?.name || body?.buyer?.name,
          amount,
          paymentId: transactionId,
          externalId,
        })
      }

      // Emit realtime inbox event for instant UI update
      whatsappBus.emitInboxEvent({
        accountId: 'ce78c02b-49e0-43bf-b384-7cdd52f61b9f',
        eventType: 'UPDATE',
        conversation: {
          last_message_text: `🎉 PIX Compensado: R$ ${amount?.toFixed(2) || '0,00'}`,
          last_message_at: new Date().toISOString(),
        },
        message: {
          type: 'payment_received',
          payment_id: transactionId,
          external_id: externalId,
          amount,
          buyer: data?.buyer,
          status: 'paid',
        },
      })
    } else if (event === 'transaction.created') {
      console.log(`ℹ️ [BuckPay Webhook] Transação criada: ${transactionId}`)
    }

    return NextResponse.json({ received: true, event, isPaid }, { status: 200 })
  } catch (err: any) {
    console.error('[BuckPay Webhook Error]:', err)
    return NextResponse.json({ error: 'Formato de webhook inválido' }, { status: 400 })
  }
}
