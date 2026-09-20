import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createClient as createAdminClient } from '@supabase/supabase-js';
import { decrypt } from '@/lib/whatsapp/encryption';
import { normalizeBaseUrl, formatUazApiNumber, getUazApiContacts } from '@/lib/whatsapp/uazapi-client';
import { isRealWhatsAppContact } from '@/lib/whatsapp/phone-utils';
import { dispatchInboundToAiReply } from '@/lib/ai/auto-reply';
import {
  findOrCreateContact,
  findOrCreateConversation,
  updateConversationWithMessage,
  isGenericContactName,
} from '@/lib/whatsapp/conversation-helpers';

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
      admin.from('contacts').select('id, phone, name, avatar_url').eq('account_id', accountId),
      admin
        .from('conversations')
        .select('id, contact_id, last_message_at, last_message_text')
        .eq('account_id', accountId),
    ]);

    interface ContactMeta {
      id: string;
      name: string | null;
      avatar_url: string | null;
    }

    const contactMap = new Map<string, ContactMeta>();
    for (const c of existingContacts || []) {
      if (c.phone) {
        contactMap.set(c.phone, { id: c.id, name: c.name, avatar_url: c.avatar_url });
      }
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

    // 2.1 Fetch WhatsApp address book (GET /contacts) from the connected instance
    const uazContacts = await getUazApiContacts(baseUrl, token);
    const waBookMap = new Map<string, { name: string; avatar?: string }>();
    for (const item of uazContacts) {
      const rawP = String(item.jid || item.phone || '').split('@')[0].replace(/\D/g, '');
      const realName = (item.contact_name || item.contact_FirstName || item.name || '').trim();
      const avatar = item.imagePreview || item.image;
      if (rawP && realName && !isGenericContactName(realName, rawP, conn.display_name)) {
        waBookMap.set(rawP, { name: realName, avatar });
        waBookMap.set(formatUazApiNumber(rawP), { name: realName, avatar });
      }
    }

    // 2.2 Pre-sync address book contacts into CRM database
    for (const [phone, bookEntry] of waBookMap.entries()) {
      const existing = contactMap.get(phone);
      if (existing) {
        // If current name is generic, update immediately to the real name from WhatsApp
        if (isGenericContactName(existing.name, phone, conn.display_name)) {
          const updates: Record<string, unknown> = {
            name: bookEntry.name,
            updated_at: new Date().toISOString(),
          };
          if (bookEntry.avatar && !existing.avatar_url) {
            updates.avatar_url = bookEntry.avatar;
          }
          await admin.from('contacts').update(updates).eq('id', existing.id);
          existing.name = bookEntry.name;
        }
      } else {
        // Create new contact from WhatsApp address book
        const newContactId = await findOrCreateContact(admin, {
          accountId,
          userId: ownerUserId,
          phone,
          name: bookEntry.name,
          instanceName: conn.display_name,
          avatarUrl: bookEntry.avatar || null,
        });
        if (newContactId) {
          contactMap.set(phone, {
            id: String(newContactId),
            name: bookEntry.name,
            avatar_url: bookEntry.avatar || null,
          });
        }
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

      // Prioritize: WhatsApp address book name > chat name > wa_name > wa_contactName > lead_fullName
      const bookEntry = waBookMap.get(formattedPhone) || waBookMap.get(rawPhone);
      const candidates = [
        bookEntry?.name,
        c.name,
        c.wa_name,
        c.wa_contactName,
        c.lead_fullName,
      ].filter(Boolean);

      let bestContactName = '';
      for (const cand of candidates) {
        const trimmed = String(cand).trim();
        if (trimmed && !isGenericContactName(trimmed, formattedPhone, conn.display_name)) {
          bestContactName = trimmed;
          break;
        }
      }

      // A. Contact resolution via resilient helper
      let contactMeta = contactMap.get(formattedPhone);
      let contactId = contactMeta?.id;

      if (!contactId) {
        const createdContactId = await findOrCreateContact(admin, {
          accountId,
          userId: ownerUserId,
          phone: formattedPhone,
          name: bestContactName || formattedPhone,
          instanceName: conn.display_name,
        });
        if (!createdContactId) return;
        contactId = String(createdContactId);
        contactMeta = { id: contactId, name: bestContactName || null, avatar_url: null };
        contactMap.set(formattedPhone, contactMeta);
      } else if (contactMeta) {
        // Contact exists: if currently generic and we now have a real name, update it!
        if (bestContactName && isGenericContactName(contactMeta.name, formattedPhone, conn.display_name)) {
          await admin
            .from('contacts')
            .update({ name: bestContactName, updated_at: new Date().toISOString() })
            .eq('id', contactId);
          contactMeta.name = bestContactName;
        }
      }

      const resolvedContactId: string = contactId;

      // Update avatar if provided
      const realAvatar = (bookEntry?.avatar || c.image || c.imagePreview || c.profilePicUrl || c.profilePictureUrl) as string | undefined;
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

      // B. Conversation resolution via resilient helper
      let convMeta = convMap.get(resolvedContactId);
      if (!convMeta) {
        const createdConvId = await findOrCreateConversation(admin, {
          accountId,
          userId: ownerUserId,
          contactId: resolvedContactId,
          connectionId: conn.id,
        });
        if (!createdConvId) return;
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
            const msgList: Array<Record<string, unknown>> = Array.isArray(msgData)
              ? msgData
              : Array.isArray(msgData.messages)
                ? msgData.messages
                : [];

            // Strictly sort messages chronologically (oldest to newest)
            const rawMsgs = msgList.sort((a, b) => {
              const tsA = Number(a.messageTimestamp || a.timestamp || 0);
              const tsB = Number(b.messageTimestamp || b.timestamp || 0);
              return tsA - tsB;
            });

            if (rawMsgs.length > 0) {
              const rawIds = rawMsgs.map((m: Record<string, unknown>) => String(m.messageid || m.id || '')).filter(Boolean);
              const cleanIds = rawIds.map((id: string) => (id.includes(':') ? id.split(':').pop()! : id));

              const { data: existingRows } = await admin
                .from('messages')
                .select('message_id')
                .eq('conversation_id', resolvedConvId)
                .in('message_id', [...rawIds, ...cleanIds]);

              const existingSet = new Set((existingRows || []).map((r) => r.message_id));
              const toInsert = [];

              const ownerPhoneDigits = conn.phone_number ? String(conn.phone_number).replace(/\D/g, '') : '';

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

                const rawId = String(m.messageid || m.id || '');
                const cleanId = rawId.includes(':') ? rawId.split(':').pop()! : rawId;
                if (!rawId || existingSet.has(rawId) || existingSet.has(cleanId)) continue;

                const mContent = m.content as Record<string, any> | undefined;
                const msgTypeStr = String(m.messageType || m.type || '');
                const isImg = /image/i.test(msgTypeStr) || Boolean(mContent?.imageMessage) || Boolean((m as any).image);
                const isAud = /audio/i.test(msgTypeStr) || Boolean(mContent?.audioMessage) || Boolean((m as any).audio);
                const isVid = /video/i.test(msgTypeStr) || Boolean(mContent?.videoMessage) || Boolean((m as any).video);
                const isDoc = /document/i.test(msgTypeStr) || Boolean(mContent?.documentMessage) || Boolean((m as any).document);

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

                const text = m.text || (m.content as Record<string, unknown> | undefined)?.text || (m.content as Record<string, unknown> | undefined)?.caption || defaultText;
                const isFromMe = Boolean(
                  m.fromMe === true ||
                  (m.key as Record<string, unknown> | undefined)?.fromMe === true ||
                  String(m.fromMe) === 'true' ||
                  String((m.key as Record<string, unknown> | undefined)?.fromMe) === 'true' ||
                  (ownerPhoneDigits && String(m.sender || '').replace(/\D/g, '').startsWith(ownerPhoneDigits))
                );

                const rawNumTs = Number(m.messageTimestamp || m.timestamp || 0);
                const msgTs = rawNumTs > 0
                  ? new Date(rawNumTs > 1e11 ? rawNumTs : rawNumTs * 1000).toISOString()
                  : new Date().toISOString();

                const resolvedMediaUrl =
                  m.fileURL ||
                  (m.content as Record<string, unknown> | undefined)?.fileURL ||
                  ((m.content as Record<string, unknown> | undefined)?.URL && !String((m.content as Record<string, unknown> | undefined)?.URL).includes('mmg.whatsapp.net') ? (m.content as Record<string, unknown> | undefined)?.URL : null) ||
                  (m.content as Record<string, unknown> | undefined)?.URL ||
                  null;

                toInsert.push({
                  conversation_id: resolvedConvId,
                  sender_type: isFromMe ? ('agent' as const) : ('customer' as const),
                  sender_id: isFromMe ? ownerUserId : undefined,
                  content_type: cType,
                  content_text: text,
                  media_url: resolvedMediaUrl,
                  message_id: cleanId,
                  status: 'delivered' as const,
                  created_at: msgTs,
                });
              }

              const last = rawMsgs[rawMsgs.length - 1];
              const lastTextMsg = String(last.text || (last.content as Record<string, any> | undefined)?.text || '[Mensagem]').trim();
              const rawLastTs = Number(last.messageTimestamp || last.timestamp || 0);
              const lastTs = rawLastTs > 0
                ? new Date(rawLastTs > 1e11 ? rawLastTs : rawLastTs * 1000).toISOString()
                : new Date().toISOString();

              const lastIsFromMe = Boolean(
                last.fromMe === true ||
                (last.key as Record<string, unknown> | undefined)?.fromMe === true ||
                String(last.fromMe) === 'true' ||
                String((last.key as Record<string, unknown> | undefined)?.fromMe) === 'true' ||
                (ownerPhoneDigits && String(last.sender || '').replace(/\D/g, '').startsWith(ownerPhoneDigits))
              );

              if (toInsert.length > 0) {
                await admin.from('messages').insert(toInsert);

                await updateConversationWithMessage(admin, {
                  conversationId: resolvedConvId,
                  messageText: lastTextMsg,
                  messageTimestamp: lastTs,
                  isInbound: !lastIsFromMe,
                  senderType: lastIsFromMe ? 'agent' : 'customer',
                });

                const isEmojiOnly = /^(\p{Extended_Pictographic}|\p{Emoji_Presentation}|\s)+$/u.test(lastTextMsg);
                const isIgnored = lastTextMsg === '[Mensagem recebida]' || lastTextMsg === '[Reação]' || lastTextMsg.startsWith('[Undecryptable]');
                const isRecent = (now - new Date(lastTs).getTime()) < 15 * 60 * 1000;

                if (!lastIsFromMe && toInsert.some((m) => m.sender_type === 'customer') && !isEmojiOnly && !isIgnored && lastTextMsg && isRecent) {
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
              } else if (convMeta.last_message_at !== lastTs) {
                await updateConversationWithMessage(admin, {
                  conversationId: resolvedConvId,
                  messageText: lastTextMsg,
                  messageTimestamp: lastTs,
                  isInbound: !lastIsFromMe,
                  senderType: lastIsFromMe ? 'agent' : 'customer',
                });
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
          await updateConversationWithMessage(admin, {
            conversationId: resolvedConvId,
            messageText: lastText,
            messageTimestamp: ts,
            isInbound: true,
            senderType: 'customer',
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
