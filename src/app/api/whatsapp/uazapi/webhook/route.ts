import { NextResponse } from 'next/server';
import { createClient as createAdminClient } from '@supabase/supabase-js';

function supabaseAdmin() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error(`Supabase credentials missing: url=${!!url}, key=${!!key}`);
  }
  return createAdminClient(url, key);
}

// Allow maximum execution duration allowed by hosting platform
export const maxDuration = 30;
export const dynamic = 'force-dynamic';

/**
 * GET /api/whatsapp/uazapi/webhook
 * Healthcheck / verification for UazAPI webhooks.
 */
export async function GET() {
  return NextResponse.json({
    status: 'ok',
    provider: 'uazapi',
    healthy: true,
    timestamp: new Date().toISOString()
  }, { status: 200 });
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

    const { processUazApiEvent } = await import('@/lib/whatsapp/uazapi-event-processor');
    const result = await processUazApiEvent(body, connectionHint);
    return NextResponse.json(result);
  } catch (err: any) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[UazAPI Webhook] Error processing event:', message, err);
    return NextResponse.json({
      error: 'Internal server error',
      message,
    }, { status: 500 });
  }
}
