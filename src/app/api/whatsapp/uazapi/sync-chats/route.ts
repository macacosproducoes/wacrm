import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createClient as createAdminClient } from '@supabase/supabase-js';
import { decrypt } from '@/lib/whatsapp/encryption';
import { normalizeBaseUrl, formatUazApiNumber } from '@/lib/whatsapp/uazapi-client';
import { isRealWhatsAppContact } from '@/lib/whatsapp/phone-utils';
import { dispatchInboundToAiReply } from '@/lib/ai/auto-reply';

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
 * POST /api/whatsapp/uazapi/sync-chats
 * Fetches all recent WhatsApp chats and messages from UazAPI and syncs them into the CRM.
 */
export async function POST(request: Request) {
  try {
    const { user, accountId } = await resolveUserAndAccount();
    if (!user || !accountId) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const admin = supabaseAdmin();
    const { data: conn } = await admin
      .from('whatsapp_connections')
      .select('*')
      .eq('account_id', accountId)
      .eq('provider', 'uazapi')
      .eq('is_active', true)
      .maybeSingle();

    if (!conn) {
      return NextResponse.json({ error: 'No active UazAPI connection found' }, { status: 404 });
    }

    const config = conn.provider_config || {};
    let token = '';
    try {
      token = decrypt(config.token);
    } catch {
      token = config.token;
    }

    if (!token) {
      return NextResponse.json({ error: 'No token configured' }, { status: 400 });
    }

    const { limit = 500 } = await request.json().catch(() => ({ limit: 500 }));
    const baseUrl = normalizeBaseUrl(config.base_url);

    // Get account owner user_id
    const { data: accountRow } = await admin
      .from('accounts')
      .select('owner_user_id')
      .eq('id', accountId)
      .single();

    const ownerUserId = accountRow?.owner_user_id || user.id;

    // 1. Pre-fetch Lead tag once if auto_lead_capture enabled
    let leadTagId: string | null = null;
    if (config.auto_lead_capture !== false) {
      try {
        const { data: leadTag } = await admin
          .from('tags')
          .select('id')
          .eq('account_id', accountId)
          .ilike('name', 'Lead')
          .maybeSingle();

        if (leadTag?.id) {
          leadTagId = leadTag.id;
        } else {
          const { data: newTag } = await admin
            .from('tags')
            .insert({
              account_id: accountId,
              user_id: ownerUserId,
              name: 'Lead',
              color: '#10B981',
            })
            .select('id')
            .single();
          leadTagId = newTag?.id || null;
        }
      } catch {
        // best-effort
      }
    }

    // 2. Pre-fetch existing contacts and conversations in this account
    const [{ data: existingContacts }, { data: existingConvs }] = await Promise.all([
      admin.from('contacts').select('id, phone').eq('account_id', accountId),
      admin
        .from('conversations')
        .select('id, contact_id, last_message_at, last_message_text')
        .eq('account_id', accountId),
    ]);

    const contactMap = new Map<string, string>();
    for (const c of existingContacts || []) {
      if (c.phone) contactMap.set(c.phone, c.id);
    }

    interface ConvMeta {
      id: string;
      last_message_at: string | null;
      last_message_text: string | null;
    }

    const convMap = new Map<string, ConvMeta>();
    for (const conv of existingConvs || []) {
      if (conv.contact_id) {
        convMap.set(conv.contact_id, {
          id: conv.id,
          last_message_at: conv.last_message_at,
          last_message_text: conv.last_message_text,
        });
      }
    }

    // 3. Query chats from UazAPI (support up to 1000)
    const fetchLimit = Math.min(Math.max(Number(limit) || 500, 100), 1000);
    const res = await fetch(`${baseUrl}/chat/find`, {
      method: 'POST',
      headers: {
        token,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        limit: fetchLimit,
        sort: '-wa_lastMsgTimestamp',
      }),
    });

    if (!res.ok) {
      return NextResponse.json(
        { error: `UazAPI /chat/find failed with HTTP ${res.status}` },
        { status: 502 }
      );
    }

    const data = await res.json();
    const chats: Array<Record<string, unknown>> = Array.isArray(data)
      ? data
      : Array.isArray(data?.chats)
        ? data.chats
        : [];

    let syncedCount = 0;
    const now = Date.now();
    const thirtyDaysMs = 30 * 24 * 3600 * 1000;

    // Process a single chat
    async function syncSingleChat(c: Record<string, unknown>, index: number) {
      // STRICT GROUP AND LID VETO
      const isGroupChat = Boolean(
        c.isGroup ||
        c.wa_isGroup ||
        String(c.wa_chatid || '').endsWith('@g.us') ||
        String(c.id || '').endsWith('@g.us') ||
        String(c.chatid || '').endsWith('@g.us')
      );
      if (isGroupChat) return;

      const jid = String(c.wa_chatid || c.id || c.chatid || c.jid || '');
      const rawPhone = String(
        c.phone || (jid ? jid.split('@')[0] : '')
      ).replace(/\D/g, '');

      if (!isRealWhatsAppContact(jid) && !isRealWhatsAppContact(rawPhone)) return;
      if (!isRealWhatsAppContact(rawPhone)) return;

      const formattedPhone = formatUazApiNumber(rawPhone);

      const contactName =
        (c.wa_contactName as string) ||
        (c.name as string) ||
        (c.lead_fullName as string) ||
        `+${formattedPhone}`;

      // A. Contact resolution (use cached ID if available)
      let contactId = contactMap.get(formattedPhone);
      if (!contactId) {
        const { data: createdContactId, error: contactErr } = await admin.rpc('find_or_create_contact', {
          p_account_id: accountId,
          p_user_id: ownerUserId,
          p_phone: formattedPhone,
          p_name: contactName,
        });
        if (contactErr || !createdContactId) return;
        contactId = String(createdContactId);
        contactMap.set(formattedPhone, contactId);
      }

      const resolvedContactId: string = contactId;

      // Update avatar if provided
      const realAvatar = (c.image || c.imagePreview || c.profilePicUrl || c.profilePictureUrl) as string | undefined;
      if (realAvatar && typeof realAvatar === 'string' && (realAvatar.startsWith('http') || realAvatar.startsWith('data:image/'))) {
        void admin.from('contacts').update({ avatar_url: realAvatar }).eq('id', resolvedContactId);
      }

      // Auto lead tag
      if (leadTagId) {
        void admin
          .from('contact_tags')
          .upsert({ contact_id: resolvedContactId, tag_id: leadTagId }, { onConflict: 'contact_id,tag_id' })
          .then(() => {}, () => {});
      }

      // B. Conversation resolution (use cached ID if available)
      let convMeta = convMap.get(resolvedContactId);
      if (!convMeta) {
        const { data: createdConvId, error: convErr } = await admin.rpc('find_or_create_conversation', {
          p_account_id: accountId,
          p_user_id: ownerUserId,
          p_contact_id: resolvedContactId,
          p_connection_id: conn.id,
        });
        if (convErr || !createdConvId) return;
        convMeta = {
          id: String(createdConvId),
          last_message_at: null,
          last_message_text: null,
        };
        convMap.set(resolvedContactId, convMeta);
      }

      const resolvedConvId: string = convMeta.id;

      const lastText = (c.wa_lastMessageTextVote || c.wa_lastMessage) as string | undefined;
      const ts = c.wa_lastMsgTimestamp
        ? new Date(Number(c.wa_lastMsgTimestamp)).toISOString()
        : new Date().toISOString();
      const chatAge = now - Number(c.wa_lastMsgTimestamp || 0);

      // C. Fast sync message history for recent active chats (top 20, active within 30d, or unread)
      const shouldFetchMessages = index < 20 || chatAge < thirtyDaysMs || Number(c.wa_unreadCount || 0) > 0;
      if (shouldFetchMessages) {
        try {
          const msgRes = await fetch(`${baseUrl}/message/find`, {
            method: 'POST',
            headers: {
              token,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              chatid: `${formattedPhone}@s.whatsapp.net`,
              limit: 30,
            }),
          });

          if (msgRes.ok) {
            const msgData = await msgRes.json();
            const rawMsgs = (msgData.messages || []).reverse();
            if (rawMsgs.length > 0) {
              const externalIds = rawMsgs.map((m: Record<string, unknown>) => String(m.messageid || m.id || '')).filter(Boolean);
              const { data: existingRows } = await admin
                .from('messages')
                .select('message_id')
                .eq('conversation_id', resolvedConvId)
                .in('message_id', externalIds);

              const existingSet = new Set((existingRows || []).map((r) => r.message_id));
              const toInsert = [];

              for (const m of rawMsgs) {
                // STRICT REACTION VETO
                const isReactionMsg = Boolean(
                  m.messageType === 'reactionMessage' ||
                  m.messageType === 'ReactionMessage' ||
                  m.type === 'reaction' ||
                  m.reaction ||
                  (m.content as Record<string, unknown> | undefined)?.reactionMessage ||
                  (m.content as Record<string, unknown> | undefined)?.reaction
                );
                if (isReactionMsg) continue;

                const extId = String(m.messageid || m.id || '');
                if (extId && !existingSet.has(extId)) {
                  const msgTypeStr = String(m.messageType || m.type || '');
                  const isImg = /image/i.test(msgTypeStr) || Boolean(m.content?.imageMessage) || Boolean(m.image);
                  const isAud = /audio/i.test(msgTypeStr) || Boolean(m.content?.audioMessage) || Boolean(m.audio);
                  const isVid = /video/i.test(msgTypeStr) || Boolean(m.content?.videoMessage) || Boolean(m.video);
                  const isDoc = /document/i.test(msgTypeStr) || Boolean(m.content?.documentMessage) || Boolean(m.document);

                  let cType: 'text' | 'image' | 'audio' | 'video' | 'document' = 'text';
                  let defaultText = '[Mensagem]';
                  if (isImg) {
                    cType = 'image';
                    defaultText = '[Imagem]';
                  } else if (isAud) {
                    cType = 'audio';
                    defaultText = '[Áudio]';
                  } else if (isVid) {
                    cType = 'video';
                    defaultText = '[Vídeo]';
                  } else if (isDoc) {
                    cType = 'document';
                    defaultText = '[Documento]';
                  }

                  const text = m.text || m.content?.text || m.content?.caption || defaultText;
                  const isFromMe = Boolean(m.fromMe);
                  const rawTs = m.messageTimestamp || m.timestamp;
                  let msgTs = new Date().toISOString();
                  if (rawTs) {
                    const n = Number(rawTs);
                    if (!isNaN(n) && n > 0) {
                      msgTs = new Date(n > 10000000000 ? n : n * 1000).toISOString();
                    }
                  }

                  const resolvedMediaUrl =
                    m.fileURL ||
                    m.content?.fileURL ||
                    (m.content?.URL && !String(m.content.URL).includes('mmg.whatsapp.net') ? m.content.URL : null) ||
                    m.content?.URL ||
                    null;

                  toInsert.push({
                    conversation_id: resolvedConvId,
                    sender_type: isFromMe ? ('agent' as const) : ('customer' as const),
                    sender_id: isFromMe ? ownerUserId : undefined,
                    content_type: cType,
                    content_text: text,
                    media_url: resolvedMediaUrl,
                    message_id: extId,
                    status: 'delivered' as const,
                    created_at: msgTs,
                  });
                }
              }

              if (toInsert.length > 0) {
                await admin.from('messages').insert(toInsert);
              }

              const last = rawMsgs[rawMsgs.length - 1];
              const lastTextMsg = (last.text || last.content?.text || '[Mensagem]').trim();
              const rawLastTs = last.messageTimestamp || last.timestamp;
              let lastTs = new Date().toISOString();
              if (rawLastTs) {
                const n = Number(rawLastTs);
                if (!isNaN(n) && n > 0) {
                  lastTs = new Date(n > 10000000000 ? n : n * 1000).toISOString();
                }
              }

              await admin.rpc('update_conversation_with_message', {
                p_conversation_id: resolvedConvId,
                p_message_text: lastTextMsg,
                p_message_timestamp: lastTs,
                p_is_inbound: !last.fromMe,
              });

              const isEmojiOnly = /^(\p{Extended_Pictographic}|\p{Emoji_Presentation}|\s)+$/u.test(lastTextMsg);
              const isIgnored = lastTextMsg === '[Mensagem recebida]' || lastTextMsg === '[Reação]' || lastTextMsg.startsWith('[Undecryptable]');
              const isRecent = (now - new Date(lastTs).getTime()) < 5 * 60 * 1000;

              if (!last.fromMe && toInsert.some((m) => m.sender_type === 'customer') && !isEmojiOnly && !isIgnored && lastTextMsg && isRecent) {
                try {
                  await dispatchInboundToAiReply({
                    accountId,
                    conversationId: resolvedConvId,
                    contactId: resolvedContactId,
                    configOwnerUserId: ownerUserId,
                    messageId: toInsert[toInsert.length - 1]?.message_id,
                    immediate: true,
                  });
                } catch (err) {
                  console.error('[sync-chats] AI auto-reply dispatch error:', err);
                }
              }

            }
          }
        } catch {
          // Non-blocking fallback
        }
      } else if (lastText) {
        // For older chats, only update if the conversation has actual new content
        const existingTs = convMeta.last_message_at ? new Date(convMeta.last_message_at).getTime() : 0;
        const newTs = c.wa_lastMsgTimestamp ? Number(c.wa_lastMsgTimestamp) : 0;
        const textChanged = Boolean(convMeta.last_message_text !== lastText);
        const timeNewer = newTs > existingTs;

        if (timeNewer || textChanged) {
          await admin.rpc('update_conversation_with_message', {
            p_conversation_id: resolvedConvId,
            p_message_text: lastText,
            p_message_timestamp: ts,
            p_is_inbound: true,
          });
        }
      }

      syncedCount++;
    }

    // Process in parallel batches of 20 for blazing fast throughput
    const BATCH_SIZE = 20;
    for (let i = 0; i < chats.length; i += BATCH_SIZE) {
      const batch = chats.slice(i, i + BATCH_SIZE);
      await Promise.all(batch.map((c, idx) => syncSingleChat(c, i + idx)));
    }

    return NextResponse.json({
      success: true,
      synced: syncedCount,
      totalReturned: chats.length,
    });
  } catch (err) {
    console.error('[UazAPI Sync Chats] Error:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
