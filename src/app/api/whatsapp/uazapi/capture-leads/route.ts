import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createClient as createAdminClient } from '@supabase/supabase-js';
import { decrypt } from '@/lib/whatsapp/encryption';
import { normalizePhone } from '@/lib/whatsapp/phone-utils';

function supabaseAdmin() {
  return createAdminClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );
}

/**
 * GET /api/whatsapp/uazapi/capture-leads
 * Returns current auto lead capture setting.
 */
export async function GET() {
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

  const { data: conn } = await supabaseAdmin()
    .from('whatsapp_connections')
    .select('provider_config')
    .eq('account_id', accountId)
    .eq('is_active', true)
    .maybeSingle();

  const isEnabled = conn?.provider_config?.auto_lead_capture ?? true;

  return NextResponse.json({
    enabled: isEnabled,
  });
}

/**
 * POST /api/whatsapp/uazapi/capture-leads
 * Toggles auto lead capture or captures all existing contacts as leads with real WhatsApp names.
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
  const { action = 'toggle', enabled } = body;

  // 1. Toggle Setting (Sim / Não)
  if (action === 'toggle') {
    const newStatus = typeof enabled === 'boolean' ? enabled : true;

    // Update active connection
    const { data: activeConn } = await supabaseAdmin()
      .from('whatsapp_connections')
      .select('*')
      .eq('account_id', accountId)
      .eq('is_active', true)
      .maybeSingle();

    if (activeConn) {
      const currentConfig = (activeConn.provider_config as Record<string, unknown>) || {};
      await supabaseAdmin()
        .from('whatsapp_connections')
        .update({
          provider_config: {
            ...currentConfig,
            auto_lead_capture: newStatus,
          },
        })
        .eq('id', activeConn.id);
    }

    return NextResponse.json({
      success: true,
      enabled: newStatus,
      message: newStatus
        ? 'Captura automática de leads ativada (Sim).'
        : 'Captura automática de leads desativada (Não).',
    });
  }

  // 2. Batch Capture Existing Contacts as Leads with WhatsApp names
  if (action === 'capture-all') {
    // 2.1 Find or create "Lead" tag
    let leadTagId: string | null = null;
    const { data: existingTag } = await supabaseAdmin()
      .from('tags')
      .select('id')
      .eq('account_id', accountId)
      .ilike('name', 'Lead')
      .maybeSingle();

    if (existingTag) {
      leadTagId = existingTag.id;
    } else {
      const { data: newTag, error: tagErr } = await supabaseAdmin()
        .from('tags')
        .insert({
          account_id: accountId,
          user_id: user.id,
          name: 'Lead',
          color: '#10B981', // Emerald green
        })
        .select('id')
        .single();

      if (!tagErr && newTag) {
        leadTagId = newTag.id;
      }
    }

    // 2.2 Query all contacts for account
    const { data: contacts } = await supabaseAdmin()
      .from('contacts')
      .select('id, name, phone, avatar_url')
      .eq('account_id', accountId);

    if (!contacts || contacts.length === 0) {
      return NextResponse.json({ success: true, count: 0, message: 'Nenhum contato para capturar.' });
    }

    // 2.3 Tag contacts as Lead
    let taggedCount = 0;
    if (leadTagId) {
      const { data: existingTagged } = await supabaseAdmin()
        .from('contact_tags')
        .select('contact_id')
        .eq('tag_id', leadTagId);

      const alreadyTaggedSet = new Set(
        (existingTagged || []).map((t: { contact_id: string }) => t.contact_id)
      );
      const toTag = contacts
        .filter((c: { id: string }) => !alreadyTaggedSet.has(c.id))
        .map((c: { id: string }) => ({
          contact_id: c.id,
          tag_id: leadTagId!,
        }));

      if (toTag.length > 0) {
        const { error: insertErr } = await supabaseAdmin()
          .from('contact_tags')
          .insert(toTag);
        if (!insertErr) {
          taggedCount = toTag.length;
        }
      }
    }

    // 2.4 Enrich contacts with names they already registered in WhatsApp
    let updatedNamesCount = 0;
    try {
      const { data: activeConn } = await supabaseAdmin()
        .from('whatsapp_connections')
        .select('*')
        .eq('account_id', accountId)
        .eq('is_active', true)
        .maybeSingle();

      if (activeConn) {
        const config = (activeConn.provider_config as Record<string, unknown>) || {};
        let token = '';
        if (config.token && typeof config.token === 'string') {
          try {
            token = decrypt(config.token);
          } catch {
            token = config.token;
          }
        }

        if (token) {
          const rawBaseUrl = typeof config.base_url === 'string' ? config.base_url : 'https://free.uazapi.com';
          const baseUrl = rawBaseUrl.trim().replace(/\/+$/, '');

          const nameMap = new Map<string, { name?: string; avatar?: string }>();

          // Query /contacts from UazAPI
          try {
            const contactsRes = await fetch(`${baseUrl}/contacts?contactScope=all`, {
              headers: { token },
              signal: AbortSignal.timeout(10000),
            });
            if (contactsRes.ok) {
              const raw = await contactsRes.json().catch(() => null);
              const list = Array.isArray(raw) ? raw : (Array.isArray(raw?.contacts) ? raw.contacts : []);
              for (const item of list) {
                const jid = String(item.jid || '');
                const phone = normalizePhone(jid.replace(/@.*$/, ''));
                const registeredName = item.contact_name || item.contact_FirstName || item.name;
                if (phone && registeredName && /[a-zA-ZÀ-ÿ]/.test(String(registeredName))) {
                  nameMap.set(phone, { name: String(registeredName).trim() });
                }
              }
            }
          } catch {
            // best-effort
          }

          // Also query /chat/find for wa_contactName, wa_name, and image previews
          try {
            const chatsRes = await fetch(`${baseUrl}/chat/find`, {
              method: 'POST',
              headers: { token, 'Content-Type': 'application/json' },
              body: JSON.stringify({ limit: 500, sort: '-wa_lastMsgTimestamp' }),
              signal: AbortSignal.timeout(10000),
            });
            if (chatsRes.ok) {
              const rawChats = await chatsRes.json().catch(() => null);
              const chatList = Array.isArray(rawChats) ? rawChats : (Array.isArray(rawChats?.chats) ? rawChats.chats : []);
              for (const c of chatList) {
                const rawPhone = String(c.phone || c.wa_chatid || '').replace(/@.*$/, '');
                const phone = normalizePhone(rawPhone);
                const registeredName = c.wa_contactName || c.name || c.wa_name || c.lead_fullName;
                const avatar = c.image || c.imagePreview || c.profilePicUrl;
                if (phone) {
                  const entry = nameMap.get(phone) || {};
                  if (registeredName && /[a-zA-ZÀ-ÿ]/.test(String(registeredName))) {
                    entry.name = String(registeredName).trim();
                  }
                  if (avatar && typeof avatar === 'string' && (avatar.startsWith('http') || avatar.startsWith('data:image/'))) {
                    entry.avatar = avatar;
                  }
                  if (entry.name || entry.avatar) {
                    nameMap.set(phone, entry);
                  }
                }
              }
            }
          } catch {
            // best-effort
          }

          // Update contacts with real registered names
          for (const contact of contacts) {
            const cleanPhone = normalizePhone(contact.phone);
            const match = nameMap.get(cleanPhone);
            const isPhoneOnlyName = !contact.name || !/[a-zA-ZÀ-ÿ]/.test(contact.name);
            const updates: Record<string, unknown> = {};

            if (match?.name && isPhoneOnlyName) {
              updates.name = match.name;
            }
            if (match?.avatar && !contact.avatar_url) {
              updates.avatar_url = match.avatar;
            }

            if (Object.keys(updates).length > 0) {
              await supabaseAdmin().from('contacts').update(updates).eq('id', contact.id);
              if (updates.name) updatedNamesCount++;
            }
          }
        }
      }
    } catch (enrichErr) {
      console.error('[capture-leads] Error enriching contacts from WhatsApp:', enrichErr);
    }

    return NextResponse.json({
      success: true,
      totalContacts: contacts.length,
      newlyTagged: taggedCount,
      updatedNames: updatedNamesCount,
      message: `${contacts.length} contatos sincronizados como leads! (${taggedCount} novos etiquetados, ${updatedNamesCount} nomes reais capturados).`,
    });
  }

  return NextResponse.json({ error: 'Ação inválida' }, { status: 400 });
}
