import { NextResponse } from 'next/server';
import { createClient as createAdminClient } from '@supabase/supabase-js';
import { decrypt } from '@/lib/whatsapp/encryption';
import { normalizeBaseUrl } from '@/lib/whatsapp/uazapi-client';

export const dynamic = 'force-dynamic';

function getAdminClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error('Missing Supabase credentials');
  }
  return createAdminClient(url, key);
}

export async function GET() {
  const startTime = Date.now();
  let whatsappStatus = 'DISCONNECTED';
  let webhookStatus = 'UNKNOWN';
  let lastMessageAgo = 'N/A';
  let lastMessageMinutes = null;
  let agentStatus = 'RUNNING';
  let pendingCount = 0;
  let lastError = 'NONE';
  let activePhone = 'N/A';
  let activeInstance = 'N/A';

  try {
    const supabase = getAdminClient();

    // 1. WhatsApp Connection Status
    const { data: conn } = await supabase
      .from('whatsapp_connections')
      .select('*')
      .eq('is_active', true)
      .order('updated_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (conn) {
      activePhone = conn.phone_number || 'N/A';
      if (conn.last_error) {
        lastError = conn.last_error;
      }

      const config = (conn.provider_config || {}) as Record<string, any>;
      let plainToken = '';
      try {
        plainToken = decrypt(config.token);
      } catch {
        plainToken = config.token || '';
      }

      if (config.base_url && plainToken) {
        try {
          const statusRes = await fetch(`${normalizeBaseUrl(config.base_url)}/instance/status`, {
            headers: { token: plainToken },
            signal: AbortSignal.timeout(4000),
          });

          if (statusRes.ok) {
            const statusData = await statusRes.json();
            if (statusData?.status?.connected || statusData?.instance?.status === 'connected') {
              whatsappStatus = 'CONNECTED';
              activeInstance = statusData?.instance?.name || statusData?.instance?.id || 'connected';
            } else {
              whatsappStatus = statusData?.instance?.status?.toUpperCase() || 'DISCONNECTED';
            }
          } else {
            whatsappStatus = `HTTP_${statusRes.status}`;
            lastError = `UAZAPI returned HTTP ${statusRes.status}`;
          }

          // Check webhook on UAZAPI
          const whRes = await fetch(`${normalizeBaseUrl(config.base_url)}/webhook`, {
            headers: { token: plainToken },
            signal: AbortSignal.timeout(4000),
          });

          if (whRes.ok) {
            const whData = await whRes.json();
            const webhooks = Array.isArray(whData) ? whData : [whData];
            const activeWh = webhooks.find((w: any) => w.enabled && Array.isArray(w.events) && w.events.includes('messages'));
            if (activeWh) {
              webhookStatus = 'HEALTHY';
            } else {
              webhookStatus = 'MISCONFIGURED_NO_MESSAGES_EVENT';
            }
          }
        } catch (uazErr: any) {
          whatsappStatus = 'ERROR';
          lastError = `UAZAPI Ping: ${uazErr.message}`;
        }
      }
    }

    // 2. Last Message Ingestion
    const { data: latestMsg } = await supabase
      .from('messages')
      .select('created_at')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (latestMsg?.created_at) {
      const msgTime = new Date(latestMsg.created_at).getTime();
      const diffMinutes = Math.floor((Date.now() - msgTime) / 60000);
      lastMessageMinutes = diffMinutes;
      lastMessageAgo = diffMinutes === 0 ? 'Agora mesmo' : `${diffMinutes} minutos atrás`;
    }

    // 3. Pending Messages / Executions
    const { count: pendingExecs } = await supabase
      .from('automation_pending_executions')
      .select('id', { count: 'exact', head: true })
      .eq('status', 'pending');

    pendingCount = pendingExecs || 0;

    // Check AI config presence
    const { data: aiConfig } = await supabase
      .from('ai_configs')
      .select('is_active')
      .eq('is_active', true)
      .limit(1)
      .maybeSingle();

    if (!aiConfig) {
      agentStatus = 'NOT_CONFIGURED';
    }

    const isSystemHealthy = whatsappStatus === 'CONNECTED' && webhookStatus === 'HEALTHY';

    return NextResponse.json({
      status: isSystemHealthy ? 'HEALTHY' : 'DEGRADED',
      checks: {
        WHATSAPP: whatsappStatus,
        WEBHOOK: webhookStatus,
        'LAST MESSAGE': lastMessageAgo,
        AGENT: agentStatus,
        PENDING: pendingCount,
        'LAST ERROR': lastError,
      },
      details: {
        phone: activePhone,
        instance: activeInstance,
        lastMessageMinutes,
        responseTimeMs: Date.now() - startTime,
        timestamp: new Date().toISOString(),
      },
    }, { status: 200 });
  } catch (err: any) {
    return NextResponse.json({
      status: 'UNHEALTHY',
      error: err.message,
      checks: {
        WHATSAPP: 'ERROR',
        WEBHOOK: 'ERROR',
        'LAST ERROR': err.message,
      },
      timestamp: new Date().toISOString(),
    }, { status: 500 });
  }
}
