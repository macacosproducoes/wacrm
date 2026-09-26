import { NextResponse, after } from 'next/server';
import { createClient as createAdminClient } from '@supabase/supabase-js';
import { TraceLogger } from '@/lib/whatsapp/trace';
import { WebhookEventManager } from '@/lib/whatsapp/webhook-events';
import { logger } from '@/lib/logger';

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
 * Ultra-low latency webhook pipeline:
 * 1. RECEIVE & VALIDATE (< 10ms)
 * 2. IDEMPOTENCY CHECK (< 20ms)
 * 3. PERSIST MESSAGE SYNCHRONOUSLY TO SUPABASE POSTGRES (< 150ms)
 *    -> Instantly triggers Postgres WAL -> Supabase Realtime WebSocket broadcast (< 700ms)
 * 4. QUEUED STATUS RECORDED
 * 5. RETURN 200 OK ACK TO UAZAPI (< 200ms total HTTP turnaround)
 * 6. AFTER() BACKGROUND TASK: QUEUED -> PROCESSING -> AGENT -> COMPLETED
 *    (Serverless-safe background execution, works even if browser/CRM is completely closed!)
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

    const chatData = ((body.chat || body.data || body) ?? {}) as Record<string, unknown>;
    const rawChatId = String(
      chatData.wa_chatid ||
      chatData.id ||
      msgData.chatid ||
      msgData.remoteJid ||
      key.remoteJid ||
      body.chatid ||
      ''
    ).trim();

    const isGroup = Boolean(
      chatData.isGroup ||
      chatData.wa_isGroup ||
      msgData.isGroup ||
      body.isGroup ||
      rawChatId.endsWith('@g.us') ||
      rawChatId.includes('-')
    );

    if (isGroup) {
      // Discard group messages immediately without any database insertion or logging to preserve Supabase quota
      return NextResponse.json({
        status: 'ok',
        trace_id: traceId,
        skipped: 'group_message',
      }, { status: 200 });
    }

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

    TraceLogger.log(traceId, 'T2', 'WEBHOOK RECEIVED', {
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

    // 2. Synchronously persist to database (< 150ms)
    // Guarantees the message row is in Supabase Postgres BEFORE returning 200 OK to UAZAPI.
    // This immediately fires Postgres WAL -> Supabase Realtime WebSocket broadcast directly to all open CRMs!
    const { processUazApiEvent } = await import('@/lib/whatsapp/uazapi-event-processor');
    const processResult = await processUazApiEvent(body, connectionHint, {
      traceId,
      skipAiDispatch: true, // We delegate AI/order execution to after() so HTTP response returns instantly
    });

    if (processResult.success && processResult.messageId) {
      TraceLogger.log(traceId, 'T3', 'MESSAGE PERSISTED TO DB', {
        conversationId: processResult.conversationId,
        messageId: processResult.messageId,
      });
    }

    // 3. Delegate asynchronous background processing to Next.js serverless-safe after()
    // This keeps the Vercel Lambda alive until the follower order or AI response is delivered,
    // independent of whether the CRM frontend is open or closed!
    const hasFollowerOrder = Boolean(processResult.followerOrderParams);
    const hasAiTask = Boolean(
      processResult.shouldTriggerAi &&
      processResult.conversationId &&
      processResult.accountId &&
      processResult.userId
    );

    if (hasFollowerOrder || hasAiTask) {
      after(async () => {
        try {

          // Priority 1: Automated Follower Order Workflow (Instagram Resolver -> Creative Job -> UAZAPI Send)
          let followerOrderHandled = false;
          if (processResult.followerOrderParams) {
            console.log(`[TRACE ${traceId}] Processing automated follower order inside serverless after()...`);
            const { handleFollowerOrder } = await import('@/lib/orders/follower-order-handler');
            const orderRes = await handleFollowerOrder(processResult.followerOrderParams);
            if (orderRes.handled) {
              followerOrderHandled = true;
              console.log(`[TRACE ${traceId}] Automated follower order #${orderRes.orderCode} successfully handled! Sent: ${orderRes.deliverySuccess}`);
            }
          }

          // Priority 2: AI auto-reply
          // Synchronized companion follow-up right after visual confirmation photo,
          // or normal conversational reply for customer inquiries and questions.
          if (hasAiTask || followerOrderHandled) {
            if (followerOrderHandled) {
              // Brief pause so visual confirmation photo lands on WhatsApp first
              await new Promise((resolve) => setTimeout(resolve, 1500));
            }

            TraceLogger.log(traceId, '04', 'AGENT TRIGGERED', {
              conversationId: processResult.conversationId,
              text: processResult.messageText,
              isOrderFollowup: followerOrderHandled,
            });

            const { dispatchInboundToAiReply } = await import('@/lib/ai/auto-reply');
            await dispatchInboundToAiReply({
              accountId: processResult.accountId!,
              conversationId: processResult.conversationId!,
              contactId: processResult.contactId!,
              configOwnerUserId: processResult.userId!,
              messageId: processResult.messageId,
              debounceMs: 2500,
              immediate: followerOrderHandled,
              isOrderFollowup: followerOrderHandled,
            });
            console.log(`[TRACE ${traceId}] AI auto-reply completed in after() execution context.`);
          }

          // Priority 3: Process due follow-ups in background
          try {
            const { processDueFollowUps } = await import('@/lib/automations/follow-up-engine');
            await processDueFollowUps();
          } catch (fuErr) {
            console.warn(`[TRACE ${traceId}] Non-critical error processing due follow-ups:`, fuErr);
          }

          await WebhookEventManager.updateStatus(traceId, 'COMPLETED');
        } catch (taskErr: any) {
          console.error(`[TRACE ${traceId}] Error in after() background execution:`, taskErr);
          await WebhookEventManager.updateStatus(traceId, 'FAILED', taskErr?.message || String(taskErr));
        }
      });
    } else {
      // Non-background event (e.g. status ack or outgoing message)
      await WebhookEventManager.updateStatus(traceId, 'COMPLETED');
    }

    const tTotal = performance.now() - t0;
    logger.webhook({
      provider: 'uazapi',
      event: eventType,
      messageId: messageId || undefined,
      connectionId: queryConnectionId || undefined,
      status: 'processed',
      durationMs: tTotal,
    });

    // 5. Instant 200 OK ACK to UAZAPI
    return NextResponse.json({
      status: 'ok',
      trace_id: traceId,
      received: true,
      persisted: processResult.success,
      queued: hasFollowerOrder || hasAiTask,
      is_order: hasFollowerOrder,
      conversation_id: processResult.conversationId,
      latency_ms: Math.round(tTotal),
    }, { status: 200 });

  } catch (err: any) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error('UAZAPI_WEBHOOK', `Fatal intake error: ${message}`, err, { traceId });
    await WebhookEventManager.updateStatus(traceId, 'FAILED', message);
    return NextResponse.json({
      error: 'Internal server error',
      trace_id: traceId,
      message,
    }, { status: 500 });
  }
}
