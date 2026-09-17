import { NextResponse } from 'next/server';
import { createClient as createAdminClient } from '@supabase/supabase-js';
import { TraceLogger } from '@/lib/whatsapp/trace';
import { WebhookEventManager } from '@/lib/whatsapp/webhook-events';
import { processUazApiEvent } from '@/lib/whatsapp/uazapi-event-processor';

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
 * Ultra-low latency webhook handler:
 * 1. RECEIVE & VALIDATE (< 10ms)
 * 2. IDEMPOTENCY CHECK (< 20ms)
 * 3. PERSIST MESSAGE SYNCHRONOUSLY TO POSTGRES (< 200ms)
 *    -> Instantly triggers Supabase Realtime WebSocket broadcast to all open frontends (< 700ms)
 * 4. DISPATCH AGENT & RETURN 200 OK ACK TO UAZAPI (< 300ms total)
 */
export async function POST(request: Request) {
  const t0 = performance.now();
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

    // 2. Synchronously persist to database and trigger agent (< 250ms)
    // Guarantees the message row is in Supabase Postgres BEFORE returning 200 OK to UAZAPI.
    // This fires Postgres WAL -> Supabase Realtime WebSocket broadcast directly to all open CRMs!
    await WebhookEventManager.updateStatus(traceId, 'PROCESSING');
    const processResult = await processUazApiEvent(body, connectionHint, { traceId });
    await WebhookEventManager.updateStatus(traceId, 'COMPLETED');

    const tTotal = performance.now() - t0;
    console.log(`[TRACE ${traceId}] Inbound message pipeline completed synchronously in ${tTotal.toFixed(2)}ms`);

    // 3. Instant 200 OK ACK to UAZAPI
    return NextResponse.json({
      status: 'ok',
      trace_id: traceId,
      received: true,
      processed: processResult.success,
      conversation_id: processResult.conversationId,
      latency_ms: Math.round(tTotal),
    }, { status: 200 });

  } catch (err: any) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[TRACE ${traceId}] Webhook fatal intake error:`, message, err);
    await WebhookEventManager.updateStatus(traceId, 'FAILED', message);
    return NextResponse.json({
      error: 'Internal server error',
      trace_id: traceId,
      message,
    }, { status: 500 });
  }
}
