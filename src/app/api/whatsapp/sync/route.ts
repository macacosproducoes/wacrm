import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createClient as createAdminClient } from '@supabase/supabase-js';
import { getBaileysStatus } from '@/lib/whatsapp/baileys/baileys-manager';
import { POST as syncUazApiChats } from '@/app/api/whatsapp/uazapi/sync-chats/route';

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
 * POST /api/whatsapp/sync
 * Unified endpoint to synchronize full WhatsApp Business conversation & contact history,
 * regardless of whether the user connected directly via CRM (Baileys) or API (UazAPI).
 */
export async function POST(request: Request) {
  try {
    const { user, accountId } = await resolveUserAndAccount();
    if (!user || !accountId) {
      return NextResponse.json({ error: 'Não autorizado' }, { status: 401 });
    }

    const admin = supabaseAdmin();

    // Check active connection
    const { data: activeConn } = await admin
      .from('whatsapp_connections')
      .select('*')
      .eq('account_id', accountId)
      .eq('is_active', true)
      .maybeSingle();

    const provider = activeConn?.provider || (activeConn?.provider_config as Record<string, unknown> | undefined)?.driver || 'baileys';

    if (provider === 'uazapi' || activeConn?.provider === 'uazapi') {
      // Forward to UazAPI sync handler
      const uazRes = await syncUazApiChats(request);
      const uazData = await uazRes.json();

      const [{ count: contactsCount }, { count: convsCount }] = await Promise.all([
        admin.from('contacts').select('*', { count: 'exact', head: true }).eq('account_id', accountId),
        admin.from('conversations').select('*', { count: 'exact', head: true }).eq('account_id', accountId),
      ]);

      return NextResponse.json({
        success: true,
        provider: 'uazapi',
        synced: uazData.synced || 0,
        contactsCount: contactsCount || 0,
        conversationsCount: convsCount || 0,
        message: `${uazData.synced || 0} conversas sincronizadas com sucesso via API!`,
      });
    }

    // Baileys connection (Direct CRM QR Code)
    const statusInfo = await getBaileysStatus(accountId);

    const [{ count: contactsCount }, { count: convsCount }, { count: messagesCount }] = await Promise.all([
      admin.from('contacts').select('*', { count: 'exact', head: true }).eq('account_id', accountId),
      admin.from('conversations').select('*', { count: 'exact', head: true }).eq('account_id', accountId),
      admin.from('messages').select('id', { count: 'exact', head: true }),
    ]);

    return NextResponse.json({
      success: true,
      provider: 'baileys',
      status: statusInfo.status,
      phoneNumber: statusInfo.phoneNumber,
      userName: statusInfo.userName,
      contactsCount: contactsCount || 0,
      conversationsCount: convsCount || 0,
      messagesCount: messagesCount || 0,
      message: statusInfo.status === 'connected'
        ? `WhatsApp conectado! ${convsCount || 0} conversas e ${contactsCount || 0} contatos sincronizados.`
        : 'WhatsApp não está conectado no momento. Por favor, conecte o QR code.',
    });
  } catch (err) {
    console.error('[WhatsApp Unified Sync] Error:', err);
    return NextResponse.json({ error: 'Erro interno do servidor ao sincronizar' }, { status: 500 });
  }
}
