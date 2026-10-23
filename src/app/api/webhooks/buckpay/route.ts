import { NextResponse } from 'next/server'
import { createClient as createAdminClient } from '@supabase/supabase-js'
import { processFirstPaymentAutomation } from '@/lib/automations/first-payment-engine'
import { notifyPaymentInCrm } from '@/lib/notifications/payment-notification'
import { checkPaymentEligibility } from '@/lib/payments/payment-eligibility'

// In-memory cache to prevent duplicate processing from burst webhooks (TTL: 15 minutes)
const processedBuckpayPayments = new Map<string, number>()

function isDuplicate(key: string): boolean {
  const now = Date.now()
  const ts = processedBuckpayPayments.get(key)
  if (ts && now - ts < 15 * 60 * 1000) {
    return true
  }
  if (processedBuckpayPayments.size > 500) {
    for (const [k, t] of processedBuckpayPayments.entries()) {
      if (now - t >= 15 * 60 * 1000) processedBuckpayPayments.delete(k)
    }
  }
  return false
}

function markProcessed(key: string) {
  processedBuckpayPayments.set(key, Date.now())
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
      buyer: data?.buyer || body?.buyer,
    })

    // 1. FAST DEDUPLICATION: check in-memory cache
    if (isPaid) {
      if (isDuplicate(transactionId) || (externalId && isDuplicate(externalId))) {
        console.log(`[BuckPay Webhook] Ignorando webhook repetido em memória para transação ${transactionId}`)
        return NextResponse.json({ received: true, deduplicated: true, status: 'already_processed' }, { status: 200 })
      }
    }

    const admin = supabaseAdmin()

    // 2. DATABASE DEDUPLICATION: check if this payment was already processed as COMPLETED
    if (isPaid && admin) {
      try {
        const { data: existingCompleted } = await admin
          .from('webhook_events')
          .select('id')
          .eq('provider', 'buckpay')
          .eq('processing_status', 'COMPLETED')
          .or(`external_event_id.eq.${externalId},payload->data->>id.eq.${transactionId}`)
          .limit(1)
          .maybeSingle()

        if (existingCompleted) {
          console.log(`[BuckPay Webhook] Transação ${transactionId} já completada anteriormente no banco. Ignorando duplicação.`)
          markProcessed(transactionId)
          if (externalId) markProcessed(externalId)
          return NextResponse.json({ received: true, deduplicated: true, status: 'already_completed' }, { status: 200 })
        }
      } catch (checkErr) {
        console.warn('[BuckPay Webhook] Aviso ao checar duplicidade:', checkErr)
      }
    }

    // 3. PRODUCT & LEAD ELIGIBILITY FILTER
    // Rule: Only SMM / Edgar products and existing CRM leads trigger audios, notifications, and contacts.
    // Third-party products (e.g. Close Friends, other checkouts) MUST NOT trigger audio or CRM notifications!
    const eligibility = await checkPaymentEligibility(admin, {
      paymentId: transactionId,
      externalId,
      amount,
      buyer: data?.buyer || body?.buyer,
      offer: data?.offer || body?.offer,
      product: data?.product || body?.product,
      rawPayload: body,
      accountId: body?.account_id || data?.account_id || body?.metadata?.account_id,
    })

    const targetAccountId = eligibility.accountId || body?.account_id || data?.account_id || '512ca9fc-083c-4f59-ab46-7a065a370e77'

    if (!eligibility.isEligible) {
      console.log(`[BuckPay Webhook] 🛑 Produto ignorado pelo CRM: ${eligibility.reason}`, {
        transactionId,
        externalId,
        buyer: data?.buyer || body?.buyer,
      })

      // Audit log into webhook_events as SKIPPED
      if (admin) {
        try {
          await admin.from('webhook_events').insert({
            provider: 'buckpay',
            event_type: event || 'payment.status',
            external_event_id: externalId,
            payload: body,
            processing_status: 'SKIPPED_EXTERNAL_PRODUCT',
            trace_id: `buckpay_skip_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
          })
        } catch {}
      }

      return NextResponse.json({
        received: true,
        skipped: true,
        reason: eligibility.reason,
      }, { status: 200 })
    }

    // Mark as processed in-memory immediately to block concurrent webhooks
    if (isPaid) {
      markProcessed(transactionId)
      if (externalId) markProcessed(externalId)
    }

    // 4. Audit log into webhook_events
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

    // 5. Process Payment Automation and CRM Notification
    if (isPaid) {
      console.log(`🎉 [BuckPay Webhook] Pagamento confirmado (SMM/Edgar)! Transação ID: ${transactionId} — Motivo: ${eligibility.reason}`)

      const automationResult = await processFirstPaymentAutomation({
        payment_id: transactionId,
        external_id: externalId,
        contact_id: eligibility.contactId,
        account_id: targetAccountId,
        status: 'paid',
        amount,
        buyer: data?.buyer || body?.buyer,
        raw_payload: body,
      })

      console.log('[BuckPay Webhook] Resultado automação primeiro pagamento:', automationResult)

      if (admin) {
        await notifyPaymentInCrm(admin, {
          accountId: targetAccountId,
          contactId: automationResult?.leadId || eligibility.contactId,
          leadName: data?.buyer?.name || body?.buyer?.name,
          amount,
          paymentId: transactionId,
          externalId,
        })
      }
    } else if (event === 'transaction.created') {
      console.log(`ℹ️ [BuckPay Webhook] Transação criada: ${transactionId}`)
    }

    return NextResponse.json({ received: true, event, isPaid, eligible: true }, { status: 200 })
  } catch (err: any) {
    console.error('[BuckPay Webhook Error]:', err)
    return NextResponse.json({ error: 'Formato de webhook inválido' }, { status: 400 })
  }
}
