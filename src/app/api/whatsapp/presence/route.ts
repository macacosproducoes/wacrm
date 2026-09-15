import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createClient as createAdminClient } from '@supabase/supabase-js'
import { sendWhatsAppPresence } from '@/lib/whatsapp/unified-presence'

export const dynamic = 'force-dynamic'

function supabaseAdmin() {
  return createAdminClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  )
}

export async function POST(request: Request) {
  try {
    const admin = supabaseAdmin()
    const supabase = await createClient()
    const { data: authData } = await supabase.auth.getUser()

    if (!authData?.user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const body = await request.json().catch(() => ({}))
    const { conversationId, presence = 'composing', delayMs = 5000 } = body

    if (!conversationId) {
      return NextResponse.json({ error: 'conversationId is required' }, { status: 400 })
    }

    if (!['composing', 'recording', 'paused'].includes(presence)) {
      return NextResponse.json({ error: 'invalid presence value' }, { status: 400 })
    }

    // Lookup conversation and contact
    const { data: conv } = await admin
      .from('conversations')
      .select('account_id, contact_id')
      .eq('id', conversationId)
      .maybeSingle()

    if (!conv) {
      return NextResponse.json({ error: 'conversation not found' }, { status: 404 })
    }

    const { data: contact } = await admin
      .from('contacts')
      .select('phone')
      .eq('id', conv.contact_id)
      .maybeSingle()

    if (!contact?.phone) {
      return NextResponse.json({ error: 'contact phone not found' }, { status: 404 })
    }

    const ok = await sendWhatsAppPresence({
      accountId: conv.account_id,
      phoneNumber: contact.phone,
      presence,
      delayMs,
    })

    return NextResponse.json({ success: ok, presence })
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Internal Server Error'
    console.error('[api/whatsapp/presence] error:', err)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
