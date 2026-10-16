import { NextResponse } from 'next/server'
import { createClient as createAdminClient } from '@supabase/supabase-js'
import { processFirstPaymentAutomation } from '@/lib/automations/first-payment-engine'
import { notifyPaymentInCrm } from '@/lib/notifications/payment-notification'
import { checkPaymentEligibility } from '@/lib/payments/payment-eligibility'

// In-memory cache to prevent duplicate processing from burst webhooks (TTL: 15 minutes)
const processedWiinpayPayments = new Map<string, number>()

function isDuplicate(key: string): boolean {
  const now = Date.now()
  const ts = processedWiinpayPayments.get(key)
  if (ts && now - ts < 15 * 60 * 1000) {
    return true
  }
  if (processedWiinpayPayments.size > 500) {
    for (const [k, t] of processedWiinpayPayments.entries()) {
      if (now - t >= 15 * 60 * 1000) processedWiinpayPayments.delete(k)
    }
  }
  return false
}

function markProcessed(key: string) {
  processedWiinpayPayments.set(key, Date.now())
}

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

    // 1. FAST DEDUPLICATION: check in-memory cache
    if (isPaid) {
      if (isDuplicate(transactionId) || (externalId && isDuplicate(externalId))) {
        console.log(`[WiinPay Webhook] Ignorando webhook repetido em memória para transação ${transactionId}`)
        return NextResponse.json({ received: true, deduplicated: true, status: 'already_processed' }, { status: 200 })
      }
    }

    const admin = supabaseAdmin()

    // 2. DATABASE DEDUPLICATION: check if already completed
    if (isPaid && admin) {
      try {
        const { data: existingCompleted } = await admin
          .from('webhook_events')
          .select('id')
          .eq('provider', 'wiinpay')
          .eq('processing_status', 'COMPLETED')
          .or(`external_event_id.eq.${externalId},payload->>id.eq.${transactionId}`)
          .limit(1)
          .maybeSingle()

        if (existingCompleted) {
          console.log(`[WiinPay Webhook] Transação ${transactionId} já completada anteriormente no banco. Ignorando duplicação.`)
          markProcessed(transactionId)
          if (externalId) markProcessed(externalId)
          return NextResponse.json({ received: true, deduplicated: true, status: 'already_completed' }, { status: 200 })
        }
      } catch (checkErr) {
        console.warn('[WiinPay Webhook] Aviso ao checar duplicidade:', checkErr)
      }
    }

    // 3. PRODUCT & LEAD ELIGIBILITY FILTER
    const eligibility = await checkPaymentEligibility(admin, {
      paymentId: transactionId,
      externalId,
      amount,
      buyer: {
        name: body.name || body.metadata?.donor_name,
        email: body.email,
        phone: body.phone,
      },
      product: { name: body.description || body.metadata?.message || 'Apoio VIP Edgar Katsumi' },
      rawPayload: body,
      accountId: 'ce78c02b-49e0-43bf-b384-7cdd52f61b9f',
    })

    if (!eligibility.isEligible) {
      console.log(`[WiinPay Webhook] 🛑 Produto ignorado pelo CRM: ${eligibility.reason}`, {
        transactionId,
        externalId,
      })

      if (admin) {
        try {
          await admin.from('webhook_events').insert({
            provider: 'wiinpay',
            event_type: 'payment.status',
            external_event_id: externalId,
            payload: body,
            processing_status: 'SKIPPED_EXTERNAL_PRODUCT',
            trace_id: `wiinpay_skip_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
          })
        } catch {}
      }

      return NextResponse.json({
        received: true,
        skipped: true,
        reason: eligibility.reason,
      }, { status: 200 })
    }

    // Mark as processed in-memory
    if (isPaid) {
      markProcessed(transactionId)
      if (externalId) markProcessed(externalId)
    }

    // 4. Persist event into webhook_events table for auditing
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

    // 5. If payment is confirmed as PAID, trigger first payment automation and CRM notification
    if (isPaid) {
      console.log(`🎉 [WiinPay Webhook] Apoio VIP confirmado e pago! Transação ID: ${transactionId} — Motivo: ${eligibility.reason}`)

      let automationResult: any = null
      try {
        automationResult = await processFirstPaymentAutomation({
          payment_id: transactionId,
          external_id: externalId,
          contact_id: eligibility.contactId,
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

      if (admin) {
        await notifyPaymentInCrm(admin, {
          accountId: 'ce78c02b-49e0-43bf-b384-7cdd52f61b9f',
          contactId: automationResult?.leadId || eligibility.contactId,
          leadName: body.name || body.metadata?.donor_name,
          amount,
          paymentId: transactionId,
          externalId,
        })
      }
    }

    return NextResponse.json({
      received: true,
      status: rawStatus,
      isPaid,
      eligible: true,
    }, { status: 200 })
  } catch (err: any) {
    console.error('[WiinPay Webhook Error]:', err)
    return NextResponse.json({ error: 'Formato de webhook inválido' }, { status: 400 })
  }
}
