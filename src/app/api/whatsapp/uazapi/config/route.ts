import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createClient as createAdminClient } from '@supabase/supabase-js';
import { encrypt, decrypt } from '@/lib/whatsapp/encryption';
import {
  getUazApiStatus,
  connectUazApi,
  disconnectUazApi,
  setUazApiWebhook,
  normalizeBaseUrl,
} from '@/lib/whatsapp/uazapi-client';

const MASKED_TOKEN = '••••••••••••••••';

function supabaseAdmin() {
  return createAdminClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );
}

async function resolveUserAndAccount() {
  const supabase = await createClient();
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser();

  if (authError || !user) {
    return { user: null, accountId: null };
  }

  const { data: profile } = await supabaseAdmin()
    .from('profiles')
    .select('account_id')
    .eq('user_id', user.id)
    .maybeSingle();

  return { user, accountId: profile?.account_id || null };
}

/**
 * GET /api/whatsapp/uazapi/config
 * List all UazAPI connections for the account and their statuses.
 */
export async function GET(request: Request) {
  try {
    const { user, accountId } = await resolveUserAndAccount();
    if (!user || !accountId) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { searchParams } = new URL(request.url);
    const checkStatus = searchParams.get('check_status') === 'true';

    const { data: connections, error } = await supabaseAdmin()
      .from('whatsapp_connections')
      .select('*')
      .eq('account_id', accountId)
      .eq('provider', 'uazapi')
      .order('created_at', { ascending: true });

    if (error) {
      if (error.code === 'PGRST205' || error.message?.includes('schema cache')) {
        console.warn('whatsapp_connections table not yet created in Supabase schema.');
        return NextResponse.json({ connections: [], activeConnection: null });
      }
      console.error('Error fetching whatsapp_connections:', error);
      return NextResponse.json(
        { error: 'Failed to fetch connections' },
        { status: 500 }
      );
    }

    const sanitizedConnections = await Promise.all(
      (connections || []).map(async (conn) => {
        let decryptedToken = '';
        let hasToken = false;
        const config = conn.provider_config || {};

        if (config.token) {
          try {
            decryptedToken = decrypt(config.token);
            hasToken = true;
          } catch {
            decryptedToken = config.token;
            hasToken = Boolean(config.token);
          }
        }

        let liveStatus = conn.status;
        let qrcode: string | null = null;
        let phoneNumber = conn.phone_number;

        if (checkStatus && hasToken && decryptedToken) {
          try {
            const statusRes = await getUazApiStatus(
              config.base_url || 'https://free.uazapi.com',
              decryptedToken
            );
            liveStatus = statusRes.status;
            qrcode = statusRes.qrcode || null;
            if (statusRes.phone) phoneNumber = statusRes.phone;

            // Update in background if changed
            if (liveStatus !== conn.status || phoneNumber !== conn.phone_number) {
              await supabaseAdmin()
                .from('whatsapp_connections')
                .update({
                  status: liveStatus,
                  phone_number: phoneNumber,
                  last_sync_at: new Date().toISOString(),
                })
                .eq('id', conn.id);
            }
          } catch {
            // Keep DB status on network failure
          }
        }

        return {
          id: conn.id,
          account_id: conn.account_id,
          display_name: conn.display_name,
          phone_number: phoneNumber,
          is_active: conn.is_active,
          status: liveStatus,
          qrcode,
          base_url: normalizeBaseUrl(config.base_url),
          has_token: hasToken,
          token_masked: hasToken ? MASKED_TOKEN : '',
          created_at: conn.created_at,
          updated_at: conn.updated_at,
        };
      })
    );

    return NextResponse.json({
      connections: sanitizedConnections,
      activeConnection: sanitizedConnections.find((c) => c.is_active) || null,
    });
  } catch (err) {
    console.error('Error in UazAPI config GET:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

/**
 * POST /api/whatsapp/uazapi/config
 * Manage UazAPI connections: save, connect (QR code), disconnect, status, set-active.
 */
export async function POST(request: Request) {
  try {
    const { user, accountId } = await resolveUserAndAccount();
    if (!user || !accountId) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const body = await request.json();
    const { action = 'save' } = body;

    // --- Action: CONNECT (Generate QR Code) ---
    if (action === 'connect') {
      const { id, phone } = body;
      if (!id) {
        return NextResponse.json({ error: 'Connection ID required' }, { status: 400 });
      }

      const { data: conn, error } = await supabaseAdmin()
        .from('whatsapp_connections')
        .select('*')
        .eq('id', id)
        .eq('account_id', accountId)
        .single();

      if (error || !conn) {
        return NextResponse.json({ error: 'Connection not found' }, { status: 404 });
      }

      const config = conn.provider_config || {};
      let token = '';
      try {
        token = decrypt(config.token);
      } catch {
        token = config.token;
      }

      if (!token) {
        return NextResponse.json({ error: 'No instance token configured' }, { status: 400 });
      }

      const baseUrl = normalizeBaseUrl(config.base_url);
      const connectResult = await connectUazApi(baseUrl, token, phone);

      await supabaseAdmin()
        .from('whatsapp_connections')
        .update({
          status: connectResult.status,
          phone_number: connectResult.phone || conn.phone_number,
          last_sync_at: new Date().toISOString(),
        })
        .eq('id', id);

      return NextResponse.json({
        success: true,
        status: connectResult.status,
        qrcode: connectResult.qrcode,
        pairingCode: connectResult.pairingCode,
        phone: connectResult.phone,
        message: connectResult.message,
      });
    }

    // --- Action: DISCONNECT ---
    if (action === 'disconnect') {
      const { id } = body;
      if (!id) {
        return NextResponse.json({ error: 'Connection ID required' }, { status: 400 });
      }

      const { data: conn, error } = await supabaseAdmin()
        .from('whatsapp_connections')
        .select('*')
        .eq('id', id)
        .eq('account_id', accountId)
        .single();

      if (error || !conn) {
        return NextResponse.json({ error: 'Connection not found' }, { status: 404 });
      }

      const config = conn.provider_config || {};
      let token = '';
      try {
        token = decrypt(config.token);
      } catch {
        token = config.token;
      }

      if (token) {
        const baseUrl = normalizeBaseUrl(config.base_url);
        await disconnectUazApi(baseUrl, token).catch(() => {});
      }

      await supabaseAdmin()
        .from('whatsapp_connections')
        .update({
          status: 'disconnected',
          last_sync_at: new Date().toISOString(),
        })
        .eq('id', id);

      return NextResponse.json({ success: true, status: 'disconnected' });
    }

    // --- Action: STATUS CHECK ---
    if (action === 'status') {
      const { id } = body;
      if (!id) {
        return NextResponse.json({ error: 'Connection ID required' }, { status: 400 });
      }

      const { data: conn, error } = await supabaseAdmin()
        .from('whatsapp_connections')
        .select('*')
        .eq('id', id)
        .eq('account_id', accountId)
        .single();

      if (error || !conn) {
        return NextResponse.json({ error: 'Connection not found' }, { status: 404 });
      }

      const config = conn.provider_config || {};
      let token = '';
      try {
        token = decrypt(config.token);
      } catch {
        token = config.token;
      }

      if (!token) {
        return NextResponse.json({ status: 'disconnected', phone: null });
      }

      const baseUrl = normalizeBaseUrl(config.base_url);
      const statusRes = await getUazApiStatus(baseUrl, token);

      if (statusRes.status !== conn.status || (statusRes.phone && statusRes.phone !== conn.phone_number)) {
        await supabaseAdmin()
          .from('whatsapp_connections')
          .update({
            status: statusRes.status,
            phone_number: statusRes.phone || conn.phone_number,
            last_sync_at: new Date().toISOString(),
          })
          .eq('id', id);
      }

      return NextResponse.json({
        success: true,
        status: statusRes.status,
        phone: statusRes.phone,
        qrcode: statusRes.qrcode,
        pairingCode: statusRes.pairingCode,
        name: statusRes.name,
      });
    }

    // --- Action: SET ACTIVE ---
    if (action === 'set-active') {
      const { id } = body;
      if (!id) {
        return NextResponse.json({ error: 'Connection ID required' }, { status: 400 });
      }

      // Deactivate all connections in account
      await supabaseAdmin()
        .from('whatsapp_connections')
        .update({ is_active: false })
        .eq('account_id', accountId);

      // Activate selected
      await supabaseAdmin()
        .from('whatsapp_connections')
        .update({ is_active: true })
        .eq('id', id)
        .eq('account_id', accountId);

      return NextResponse.json({ success: true, activeId: id });
    }

    // --- Action: SETUP WEBHOOK ---
    if (action === 'setup-webhook') {
      const { id, webhookUrl } = body;
      if (!id || !webhookUrl) {
        return NextResponse.json({ error: 'ID and webhookUrl required' }, { status: 400 });
      }

      const { data: conn } = await supabaseAdmin()
        .from('whatsapp_connections')
        .select('*')
        .eq('id', id)
        .eq('account_id', accountId)
        .single();

      if (!conn) {
        return NextResponse.json({ error: 'Connection not found' }, { status: 404 });
      }

      const config = conn.provider_config || {};
      let token = '';
      try {
        token = decrypt(config.token);
      } catch {
        token = config.token;
      }

      const baseUrl = normalizeBaseUrl(config.base_url);
      const res = await setUazApiWebhook(baseUrl, token, webhookUrl);

      return NextResponse.json({ success: res.success, raw: res.raw });
    }

    // --- Action: SAVE / CREATE / UPDATE ---
    const {
      id,
      display_name = 'UazAPI WhatsApp',
      base_url = 'https://free.uazapi.com',
      token,
      is_active = true,
    } = body;

    const normalizedUrl = normalizeBaseUrl(base_url);

    // If active is true, deactivate others
    if (is_active) {
      await supabaseAdmin()
        .from('whatsapp_connections')
        .update({ is_active: false })
        .eq('account_id', accountId);
    }

    if (id) {
      // Update existing
      const { data: existing } = await supabaseAdmin()
        .from('whatsapp_connections')
        .select('*')
        .eq('id', id)
        .eq('account_id', accountId)
        .single();

      if (!existing) {
        return NextResponse.json({ error: 'Connection not found' }, { status: 404 });
      }

      const currentConfig = existing.provider_config || {};
      let finalEncryptedToken = currentConfig.token;

      if (token && token !== MASKED_TOKEN && token.trim()) {
        finalEncryptedToken = encrypt(token.trim());
      }

      const { data: updated, error: updateErr } = await supabaseAdmin()
        .from('whatsapp_connections')
        .update({
          display_name: display_name.trim(),
          is_active: Boolean(is_active),
          provider_config: {
            ...currentConfig,
            base_url: normalizedUrl,
            token: finalEncryptedToken,
          },
          updated_at: new Date().toISOString(),
        })
        .eq('id', id)
        .select()
        .single();

      if (updateErr) {
        return NextResponse.json({ error: updateErr.message }, { status: 500 });
      }

      return NextResponse.json({ success: true, connection: updated });
    } else {
      // Create new
      if (!token || token === MASKED_TOKEN) {
        return NextResponse.json({ error: 'Token is required' }, { status: 400 });
      }

      const encryptedToken = encrypt(token.trim());

      const { data: created, error: createErr } = await supabaseAdmin()
        .from('whatsapp_connections')
        .insert({
          account_id: accountId,
          provider: 'uazapi',
          display_name: display_name.trim(),
          is_active: Boolean(is_active),
          status: 'disconnected',
          provider_config: {
            base_url: normalizedUrl,
            token: encryptedToken,
          },
          mirror_inbound_media: true,
        })
        .select()
        .single();

      if (createErr) {
        return NextResponse.json({ error: createErr.message }, { status: 500 });
      }

      return NextResponse.json({ success: true, connection: created });
    }
  } catch (err) {
    console.error('Error in UazAPI config POST:', err);
    const msg = err instanceof Error ? err.message : 'Falha na comunicação com o servidor UazAPI';
    return NextResponse.json({ error: msg }, { status: 400 });
  }
}
