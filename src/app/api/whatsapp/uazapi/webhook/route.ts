import { NextResponse } from 'next/server';
import { createClient as createAdminClient } from '@supabase/supabase-js';
import { processUazApiEvent } from '@/lib/whatsapp/uazapi-event-processor';

function supabaseAdmin() {
  return createAdminClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );
}

/**
 * GET /api/whatsapp/uazapi/webhook
 * Healthcheck / verification for UazAPI webhooks.
 */
export async function GET() {
  return NextResponse.json({ status: 'ok', provider: 'uazapi' }, { status: 200 });
}

/**
 * POST /api/whatsapp/uazapi/webhook
 * Inbound webhook handler for UazAPI instances.
 */
export async function POST(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const queryConnectionId = searchParams.get('connection_id');

    const body = await request.json().catch(() => null);
    if (!body) {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
    }

    const admin = supabaseAdmin();
    let connectionHint = null;

    if (queryConnectionId) {
      const { data } = await admin
        .from('whatsapp_connections')
        .select('id, account_id, display_name, provider_config')
        .eq('id', queryConnectionId)
        .maybeSingle();
      if (data) connectionHint = data;
    }

    const result = await processUazApiEvent(body, connectionHint);
    return NextResponse.json(result);
  } catch (err) {
    console.error('[UazAPI Webhook] Error processing event:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
