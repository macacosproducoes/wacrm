import { NextResponse } from 'next/server'
import { createClient as createAdminClient } from '@supabase/supabase-js'
import { getBuckPayTransaction } from '@/lib/buckpay'
import { processFirstPaymentAutomation } from '@/lib/automations/first-payment-engine'
import { notifyPaymentInCrm } from '@/lib/notifications/payment-notification'
import { whatsappBus } from '@/lib/whatsapp/whatsapp-bus'

function supabaseAdmin() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) return null
  return createAdminClient(url, key)
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url)
  const external_id = searchParams.get('external_id')

  if (!external_id) {
    return NextResponse.json({ error: 'external_id é obrigatório.' }, { status: 400 })
  }

  try {
    const result = await getBuckPayTransaction(external_id)

    if (result.error) {
      return NextResponse.json(
        { error: result.error.message, detail: result.error.detail },
        { status: 404 }
      )
    }

    if (result.data?.status === 'paid') {
      const amount = typeof result.data.total_amount === 'number' ? result.data.total_amount / 100 : undefined
      const admin = supabaseAdmin()

      processFirstPaymentAutomation({
        payment_id: result.data.id,
        external_id,
        status: 'paid',
        amount,
        raw_payload: result.data as unknown as Record<string, unknown>,
      }).catch((err) =>
        console.error('[API /api/smm/status] Erro assíncrono na automação de primeiro pagamento:', err)
      )

      if (admin) {
        notifyPaymentInCrm(admin, {
          accountId: 'ce78c02b-49e0-43bf-b384-7cdd52f61b9f',
          amount,
          paymentId: result.data.id,
          externalId: external_id,
        }).catch((err) => console.warn('[smm/status] Erro notificando CRM:', err))

        // Update webhook_events record if exists
        admin
          .from('webhook_events')
          .update({
            processing_status: 'COMPLETED',
            payload: {
              ...(result.data as any),
              status: 'paid',
              confirmed_at: new Date().toISOString(),
            },
          })
          .eq('external_event_id', external_id)
          .then(() => {})
      }

      whatsappBus.emitInboxEvent({
        accountId: 'ce78c02b-49e0-43bf-b384-7cdd52f61b9f',
        eventType: 'UPDATE',
        conversation: {
          last_message_text: `🎉 PIX Compensado: R$ ${amount?.toFixed(2) || '0,00'}`,
          last_message_at: new Date().toISOString(),
        },
        message: {
          type: 'payment_received',
          payment_id: result.data.id,
          external_id,
          amount,
          status: 'paid',
        },
      })
    }

    return NextResponse.json({
      success: true,
      status: result.data?.status || 'pending',
      data: result.data,
    })
  } catch (err: any) {
    console.error('[API /api/smm/status] Error:', err)
    return NextResponse.json(
      { error: 'Erro ao consultar status da transação SMM' },
      { status: 500 }
    )
  }
}
