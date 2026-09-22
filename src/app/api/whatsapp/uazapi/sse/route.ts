import { createClient } from '@/lib/supabase/server';
import { createClient as createAdminClient } from '@supabase/supabase-js';
import { decrypt } from '@/lib/whatsapp/encryption';
import { normalizeBaseUrl } from '@/lib/whatsapp/uazapi-client';
import { processUazApiEvent } from '@/lib/whatsapp/uazapi-event-processor';
import { whatsappBus, type WhatsAppInboxEvent } from '@/lib/whatsapp/whatsapp-bus';
import { startUazApiListener } from '@/lib/whatsapp/uazapi-manager';
import https from 'https';
import http from 'http';

export const dynamic = 'force-dynamic';

function supabaseAdmin() {
  return createAdminClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );
}

async function resolveUserAndAccount(request?: Request) {
  const admin = supabaseAdmin();
  let user: { id: string; email?: string } | null = null;

  // 1. Check Bearer token in Authorization header
  const authHeader = request?.headers.get('authorization');
  if (authHeader?.startsWith('Bearer ')) {
    const token = authHeader.slice(7).trim();
    if (token) {
      const { data } = await admin.auth.getUser(token);
      if (data?.user) {
        user = data.user;
      }
    }
  }

  // 2. Check query parameter ?access_token= or ?token= (essential for browser EventSource)
  if (!user && request) {
    try {
      const { searchParams } = new URL(request.url);
      const queryToken = searchParams.get('access_token') || searchParams.get('token');
      if (queryToken) {
        const { data } = await admin.auth.getUser(queryToken);
        if (data?.user) {
          user = data.user;
        }
      }
    } catch {
      // Non-url context
    }
  }

  // 3. Check Cookie session via createClient()
  if (!user) {
    try {
      const supabase = await createClient();
      const {
        data: { user: cookieUser },
      } = await supabase.auth.getUser();
      if (cookieUser) {
        user = cookieUser;
      }
    } catch {
      // Non-cookie context
    }
  }

  if (!user) {
    return { user: null, accountId: null };
  }

  const { data: profile } = await admin
    .from('profiles')
    .select('account_id')
    .eq('user_id', user.id)
    .maybeSingle();

  return { user, accountId: profile?.account_id || null };
}

/**
 * GET /api/whatsapp/uazapi/sse
 * Real-time SSE bridge between WhatsApp engines (Baileys & UazAPI) and the CRM Inbox.
 * Enables zero-setup, zero-latency real-time message receiving everywhere.
 */
export async function GET(request: Request) {
  const { user, accountId } = await resolveUserAndAccount(request);
  if (!user || !accountId) {
    return new Response('Unauthorized', { status: 401 });
  }

  // Ensure persistent background listener is running
  void startUazApiListener(accountId).catch(() => {});

  const admin = supabaseAdmin();
  const { data: conns } = await admin
    .from('whatsapp_connections')
    .select('*')
    .eq('account_id', accountId)
    .eq('is_active', true)
    .order('updated_at', { ascending: false });
  const conn = conns?.find((c) => c.status === 'connected') || conns?.[0] || null;

  const config = conn?.provider_config || {};
  let token = '';
  try {
    token = decrypt(config.token);
  } catch {
    token = config.token || '';
  }

  const encoder = new TextEncoder();
  let upstreamReq: http.ClientRequest | null = null;
  let unsubscribeBus: (() => void) | null = null;
  let heartbeatTimer: NodeJS.Timeout | null = null;

  const stream = new ReadableStream({
    start(controller) {
      // Announce connection to client
      controller.enqueue(encoder.encode(': sse-connected\n\n'));

      // 1. Subscribe to internal in-memory WhatsApp event bus (0ms latency for Baileys & Webhooks)
      unsubscribeBus = whatsappBus.onAccount(accountId, (event: WhatsAppInboxEvent) => {
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
        } catch {
          // Client stream closed
        }
      });

      // 2. Keepalive heartbeat every 15s to prevent timeouts
      heartbeatTimer = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(': ping\n\n'));
        } catch {
          if (heartbeatTimer) clearInterval(heartbeatTimer);
        }
      }, 15000);
    },
    cancel() {
      if (unsubscribeBus) {
        unsubscribeBus();
      }
      if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}
