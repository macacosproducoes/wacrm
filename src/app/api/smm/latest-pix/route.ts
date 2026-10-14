import { NextResponse } from 'next/server'
import { createClient as createAdminClient } from '@supabase/supabase-js'

function supabaseAdmin() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) return null
  return createAdminClient(url, key)
}

export const dynamic = 'force-dynamic'

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url)
  const contactId = searchParams.get('contact_id')

  if (!contactId) {
    return NextResponse.json({ error: 'contact_id é obrigatório.' }, { status: 400 })
  }

  const admin = supabaseAdmin()
  if (!admin) {
    return NextResponse.json({ error: 'Database service unavailable' }, { status: 500 })
  }

  try {
    // 1. Search in webhook_events by contact_id inside payload or in external_event_id prefix
    const { data: events, error } = await admin
      .from('webhook_events')
      .select('id, provider, event_type, external_event_id, payload, processing_status, created_at')
      .or(`external_event_id.ilike.smm_${contactId}_%,external_event_id.ilike.%${contactId}%`)
      .order('created_at', { ascending: false })
      .limit(5)

    if (error) {
      console.warn('[latest-pix] Error querying webhook_events:', error)
      return NextResponse.json({ success: false, pix: null })
    }

    if (!events || events.length === 0) {
      return NextResponse.json({ success: true, pix: null })
    }

    // Find the newest event that has PIX code
    const event = events.find((e) => e.payload?.pix?.code) || events[0]
    const p = event.payload || {}
    const isPaid =
      event.processing_status === 'COMPLETED' ||
      p.status === 'paid' ||
      p.event === 'transaction.processed' ||
      p.event === 'transaction.paid'

    return NextResponse.json({
      success: true,
      pix: {
        code: p.pix?.code || '',
        qrcode_base64: p.pix?.qrcode_base64 || '',
        external_id: event.external_event_id || p.external_id || '',
        amount: Number(p.amount) || 0,
        status: isPaid ? 'paid' : 'pending',
        service_name: p.service_name || 'Recarga SMM',
        created_at: p.created_at || new Date(event.created_at).getTime(),
      },
    })
  } catch (err: any) {
    console.error('[latest-pix] Unexpected error:', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
