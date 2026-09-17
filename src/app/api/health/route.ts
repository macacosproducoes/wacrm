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

    // 2. Database Connectivity & Inbound / Outbound Messages
    let dbStatus = 'HEALTHY';
    let lastInboundAgo = 'N/A';
    let lastInboundMinutes: number | null = null;
    let lastOutboundAgo = 'N/A';
    let lastOutboundMinutes: number | null = null;

    try {
      // Inbound
      const { data: latestInbound, error: inErr } = await supabase
        .from('messages')
        .select('created_at')
        .eq('sender_type', 'customer')
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();

      if (inErr) dbStatus = 'DEGRADED';
      if (latestInbound?.created_at) {
        const inTime = new Date(latestInbound.created_at).getTime();
        const diffM = Math.floor((Date.now() - inTime) / 60000);
        lastInboundMinutes = diffM;
        lastInboundAgo = diffM === 0 ? 'Agora mesmo' : `${diffM} min atrás`;
      }

      // Outbound
      const { data: latestOutbound } = await supabase
        .from('messages')
        .select('created_at')
        .eq('sender_type', 'agent')
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();

      if (latestOutbound?.created_at) {
        const outTime = new Date(latestOutbound.created_at).getTime();
        const diffM = Math.floor((Date.now() - outTime) / 60000);
        lastOutboundMinutes = diffM;
        lastOutboundAgo = diffM === 0 ? 'Agora mesmo' : `${diffM} min atrás`;
      }
    } catch {
      dbStatus = 'ERROR';
    }

    // 3. Pending & Failed Creative Jobs
    let failedCreativeJobs = 0;
    let pendingCreativeJobs = 0;
    try {
      const { count: failedCount } = await supabase
        .from('creative_jobs')
        .select('id', { count: 'exact', head: true })
        .eq('status', 'FAILED');
      failedCreativeJobs = failedCount || 0;

      const { count: processingCount } = await supabase
        .from('creative_jobs')
        .select('id', { count: 'exact', head: true })
        .eq('status', 'PROCESSING');
      pendingCreativeJobs = processingCount || 0;
    } catch {
      // non-blocking
    }

    // 4. Pending Automations
    const { count: pendingExecs } = await supabase
      .from('automation_pending_executions')
      .select('id', { count: 'exact', head: true })
      .eq('status', 'pending');

    pendingCount = (pendingExecs || 0) + pendingCreativeJobs;

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

    // Silence detection: WhatsApp connected but no inbound for > 360m (6h)
    const silenceWarning = whatsappStatus === 'CONNECTED' && lastInboundMinutes !== null && lastInboundMinutes > 360;

    const isSystemHealthy = whatsappStatus === 'CONNECTED' && webhookStatus === 'HEALTHY' && dbStatus === 'HEALTHY';

    return NextResponse.json({
      status: isSystemHealthy ? 'HEALTHY' : 'DEGRADED',
      checks: {
        DATABASE: dbStatus,
        WHATSAPP: whatsappStatus,
        WEBHOOK: webhookStatus,
        AGENT: agentStatus,
        'LAST INBOUND': lastInboundAgo,
        'LAST OUTBOUND': lastOutboundAgo,
        'PENDING JOBS': pendingCount,
        'FAILED JOBS': failedCreativeJobs,
        'SILENCE WARNING': silenceWarning ? 'YES (>6h sem mensagens)' : 'NO',
        'LAST ERROR': lastError,
      },
      details: {
        phone: activePhone,
        instance: activeInstance,
        lastInboundMinutes,
        lastOutboundMinutes,
        responseTimeMs: Date.now() - startTime,
        timestamp: new Date().toISOString(),
      },
    }, { status: 200 });
  } catch (err: any) {
    return NextResponse.json({
      status: 'UNHEALTHY',
      error: err.message,
      checks: {
        DATABASE: 'ERROR',
        WHATSAPP: 'ERROR',
        WEBHOOK: 'ERROR',
        'LAST ERROR': err.message,
      },
      timestamp: new Date().toISOString(),
    }, { status: 500 });
  }
}
