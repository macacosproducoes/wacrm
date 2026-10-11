import { NextResponse } from 'next/server'
import { createClient as createAdminClient } from '@supabase/supabase-js'
import { processFirstPaymentAutomation } from '@/lib/automations/first-payment-engine'

function supabaseAdmin() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) return null
  return createAdminClient(url, key)
}

export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => ({}))
    
    // WiinPay webhook structure
    // Status returns "PAID" when payment is confirmed
    const rawStatus = String(body.status || body.payment_status || '').trim()
    const isPaid = rawStatus === 'PAID' || rawStatus.toLowerCase() === 'paid'

    const transactionId = String(body.id || body.payment_id || body.transaction_id || `wiin_${Date.now()}`)
    const externalId = String(body.metadata?.external_id || body.external_id || transactionId)
    const amount = typeof body.value === 'number' ? body.value : typeof body.amount === 'number' ? body.amount : undefined

    console.log(`[WiinPay Webhook Received] Status: '${rawStatus}' (isPaid: ${isPaid})`, {
      id: transactionId,
      external_id: externalId,
      amount,
    })

    // Persist event into webhook_events table for auditing and status polling
    const admin = supabaseAdmin()
    if (admin) {
      try {
        await admin.from('webhook_events').insert({
          provider: 'wiinpay',
          event_type: 'payment.status',
          external_event_id: externalId,
          payload: {
            id: transactionId,
            status: rawStatus,
            value: amount,
            metadata: body.metadata || {},
            raw_body: body,
          },
          processing_status: isPaid ? 'COMPLETED' : 'RECEIVED',
          trace_id: `wiinpay_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
        })
      } catch (dbErr) {
        console.warn('[WiinPay Webhook] Erro ao registrar em webhook_events:', dbErr)
      }
    }

    // If payment is confirmed as PAID, trigger first payment automation if lead info is present
    if (isPaid) {
      console.log(`🎉 [WiinPay Webhook] Mimo confirmado e pago! Transação ID: ${transactionId}`)
      
      try {
        await processFirstPaymentAutomation({
          payment_id: transactionId,
          external_id: externalId,
          status: 'paid',
          amount,
          buyer: {
            name: body.name || body.metadata?.donor_name,
            email: body.email,
            phone: body.phone,
          },
          raw_payload: body,
        })
      } catch (autoErr) {
        console.warn('[WiinPay Webhook] Aviso no processamento de automação:', autoErr)
      }
    }

    return NextResponse.json({
      received: true,
      status: rawStatus,
      isPaid,
    }, { status: 200 })
  } catch (err: any) {
    console.error('[WiinPay Webhook Error]:', err)
    return NextResponse.json({ error: 'Formato de webhook inválido' }, { status: 400 })
  }
}
