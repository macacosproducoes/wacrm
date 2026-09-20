import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createClient as createAdminClient } from '@supabase/supabase-js';
import { decrypt } from '@/lib/whatsapp/encryption';
import { addUazApiContact, formatUazApiNumber } from '@/lib/whatsapp/uazapi-client';

function supabaseAdmin() {
  return createAdminClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );
}

/**
 * POST /api/whatsapp/uazapi/contacts/save
 *
 * Saves or updates a contact both in the CRM database and directly
 * in the phone's WhatsApp address book via UAZAPI POST /contact/add.
 * This guarantees the contact can view WhatsApp Status / Stories posted by the operator.
 */
export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { data: profile } = await supabaseAdmin()
    .from('profiles')
    .select('account_id')
    .eq('user_id', user.id)
    .single();

  const accountId = profile?.account_id;
  if (!accountId) {
    return NextResponse.json({ error: 'Account not found' }, { status: 404 });
  }

  const body = await request.json().catch(() => ({}));
  const { contactId, name, phone } = body;

  if (!contactId && !phone) {
    return NextResponse.json(
      { error: 'contactId or phone is required' },
      { status: 400 }
    );
  }

  const admin = supabaseAdmin();

  // 1. Fetch contact
  let targetContact: { id: string; name: string | null; phone: string; account_id: string } | null = null;
  if (contactId) {
    const { data } = await admin
      .from('contacts')
      .select('id, name, phone, account_id')
      .eq('id', contactId)
      .eq('account_id', accountId)
      .maybeSingle();
    targetContact = data;
  } else if (phone) {
    const formatted = formatUazApiNumber(phone);
    const { data } = await admin
      .from('contacts')
      .select('id, name, phone, account_id')
      .eq('account_id', accountId)
      .eq('phone', formatted)
      .maybeSingle();
    targetContact = data;
  }

  if (!targetContact) {
    return NextResponse.json({ error: 'Contact not found' }, { status: 404 });
  }

  const saveName = (name && String(name).trim()) || targetContact.name || targetContact.phone;

  // 2. Update contact name in CRM database
  const { data: updatedContact, error: updateErr } = await admin
    .from('contacts')
    .update({
      name: saveName,
      updated_at: new Date().toISOString(),
    })
    .eq('id', targetContact.id)
    .select('*')
    .single();

  if (updateErr) {
    return NextResponse.json({ error: updateErr.message }, { status: 500 });
  }

  // 3. Find active WhatsApp connection to save to phone address book
  let { data: conns } = await admin
    .from('whatsapp_connections')
    .select('*')
    .eq('account_id', accountId)
    .eq('is_active', true)
    .limit(1);

  if (!conns || conns.length === 0) {
    const { data: fallbackConns } = await admin
      .from('whatsapp_connections')
      .select('*')
      .eq('account_id', accountId)
      .order('updated_at', { ascending: false })
      .limit(1);
    conns = fallbackConns;
  }

  const conn = conns?.[0] || null;

  let uazapiSaved = false;
  let uazapiMessage = '';

  if (conn && conn.provider === 'uazapi') {
    const config = (conn.provider_config as Record<string, unknown>) || {};
    let token = '';
    if (config.token && typeof config.token === 'string') {
      try {
        token = decrypt(config.token);
      } catch {
        token = config.token;
      }
    }

    if (token) {
      const baseUrl = typeof config.base_url === 'string' ? config.base_url : 'https://free.uazapi.com';
      const uazResult = await addUazApiContact(baseUrl, token, {
        number: targetContact.phone,
        name: saveName,
      });

      uazapiSaved = uazResult.success;
      uazapiMessage = uazResult.message || uazResult.error || '';
    }
  }

  return NextResponse.json({
    success: true,
    contact: updatedContact,
    whatsapp_saved: uazapiSaved,
    message: uazapiSaved
      ? `✓ Contato "${saveName}" salvo na agenda do WhatsApp com sucesso! O cliente agora poderá visualizar seus Status.`
      : `Contato "${saveName}" atualizado no CRM.`,
    detail: uazapiMessage,
  });
}
