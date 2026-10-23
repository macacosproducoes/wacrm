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

      if (admin) {
        // Check if already processed by webhook to avoid duplicate executions
        const { data: existingEvent } = await admin
          .from('webhook_events')
          .select('id, processing_status')
          .eq('external_event_id', external_id)
          .maybeSingle()

        if (existingEvent?.processing_status !== 'COMPLETED') {
          // Mark as COMPLETED immediately
          await admin
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

          let contactIdFromExt: string | undefined = undefined;
          if (external_id.startsWith('smm_')) {
            const parts = external_id.split('_');
            if (parts.length >= 3 && parts[1].length >= 32) {
              contactIdFromExt = parts[1];
            }
          }

          processFirstPaymentAutomation({
            payment_id: result.data.id,
            external_id,
            contact_id: contactIdFromExt,
            account_id: '512ca9fc-083c-4f59-ab46-7a065a370e77',
            status: 'paid',
            amount,
            buyer: result.data.buyer,
            raw_payload: result.data as unknown as Record<string, unknown>,
          }).catch((err) =>
            console.error('[API /api/smm/status] Erro assíncrono na automação de primeiro pagamento:', err)
          )

          notifyPaymentInCrm(admin, {
            accountId: '512ca9fc-083c-4f59-ab46-7a065a370e77',
            contactId: contactIdFromExt,
            amount,
            leadName: result.data.buyer?.name,
            paymentId: result.data.id,
            externalId: external_id,
          }).catch((err) => console.warn('[smm/status] Erro notificando CRM:', err))
        }
      }
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
