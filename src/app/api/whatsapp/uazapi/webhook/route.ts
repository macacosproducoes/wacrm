import { NextResponse, after } from 'next/server';
import { createClient as createAdminClient } from '@supabase/supabase-js';
import { TraceLogger } from '@/lib/whatsapp/trace';
import { WebhookEventManager } from '@/lib/whatsapp/webhook-events';

function supabaseAdmin() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error(`Supabase credentials missing: url=${!!url}, key=${!!key}`);
  }
  return createAdminClient(url, key);
}

// Allow maximum execution duration allowed by hosting platform for background processing
export const maxDuration = 60;
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
    timestamp: new Date().toISOString(),
  }, { status: 200 });
}

/**
 * POST /api/whatsapp/uazapi/webhook
 *
 * Lean, non-blocking webhook handler:
 * 1. RECEIVE
 * 2. VALIDATE & IDEMPOTENCY CHECK
 * 3. PERSIST RAW EVENT TO QUEUE (webhook_events)
 * 4. INSTANT ACK 200 OK TO UAZAPI (< 50ms)
 * 5. ASYNC HEAVY PROCESSING VIA after()
 */
export async function POST(request: Request) {
  const traceId = TraceLogger.generateTraceId('trc');
  const now = new Date().toISOString();

  try {
    const { searchParams } = new URL(request.url);
    const queryConnectionId = searchParams.get('connection_id');

    const body = await request.json().catch(() => null);
    if (!body || typeof body !== 'object') {
      return NextResponse.json({ error: 'Invalid JSON body', trace_id: traceId }, { status: 400 });
    }

    const eventType = String(body.EventType || body.event || body.type || (body.message ? 'messages' : 'unknown')).toLowerCase();
    const msgData = ((body.message || body.data || body) ?? {}) as Record<string, unknown>;
    const key = (msgData.key || {}) as Record<string, unknown>;
    const rawMsgId = String(key.id || msgData.messageid || msgData.id || body.id || '').trim();
    const messageId = rawMsgId.includes(':') ? rawMsgId.split(':').pop()! : rawMsgId;

    TraceLogger.log(traceId, '01', 'UAZAPI RECEIVED', {
      eventType,
      messageId: messageId || undefined,
      connectionId: queryConnectionId || undefined,
    });

    // 1. Persist raw event & Check idempotency before ACK
    const ingestResult = await WebhookEventManager.recordReceived({
      traceId,
      provider: 'uazapi',
      eventType,
      messageId: messageId || undefined,
      connectionId: queryConnectionId || undefined,
      payload: body,
    });

    if (ingestResult.isDuplicate) {
      console.log(`[TRACE ${traceId}] Duplicate message event deduplicated: ${messageId}`);
      return NextResponse.json({
        status: 'ok',
        trace_id: traceId,
        deduplicated: true,
      }, { status: 200 });
    }

    TraceLogger.log(traceId, '02', 'WEBHOOK RECEIVED', {
      eventId: ingestResult.id,
      timestamp: now,
    });

    // Resolve connection hint if provided
    let connectionHint: any = null;
    if (queryConnectionId) {
      const admin = supabaseAdmin();
      const { data } = await admin
        .from('whatsapp_connections')
        .select('id, account_id, display_name, provider_config')
        .eq('id', queryConnectionId)
        .maybeSingle();
      if (data) connectionHint = data;
    }

    // 2. Schedule asynchronous background processing via after()
    // This keeps the serverless execution context alive until the promise settles,
    // while returning an immediate 200 OK response to the UAZAPI server.
    after(async () => {
      await WebhookEventManager.updateStatus(traceId, 'PROCESSING');
      try {
        const { processUazApiEvent } = await import('@/lib/whatsapp/uazapi-event-processor');
        await processUazApiEvent(body, connectionHint, { traceId });
        await WebhookEventManager.updateStatus(traceId, 'COMPLETED');
      } catch (procErr: any) {
        const errStr = procErr instanceof Error ? procErr.message : String(procErr);
        console.error(`[TRACE ${traceId}] Error in async event processor:`, errStr, procErr);
        await WebhookEventManager.updateStatus(traceId, 'FAILED', errStr);
      }
    });

    // 3. Instant 200 OK ACK to UAZAPI
    return NextResponse.json({
      status: 'ok',
      trace_id: traceId,
      received: true,
    }, { status: 200 });

  } catch (err: any) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[TRACE ${traceId}] Webhook fatal intake error:`, message, err);
    return NextResponse.json({
      error: 'Internal server error',
      trace_id: traceId,
      message,
    }, { status: 500 });
  }
}
