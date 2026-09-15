import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createClient as createAdminClient } from '@supabase/supabase-js';
import { decrypt } from '@/lib/whatsapp/encryption';
import { normalizeBaseUrl, formatUazApiNumber } from '@/lib/whatsapp/uazapi-client';
import { dispatchInboundToAiReply } from '@/lib/ai/auto-reply';
import { whatsappBus } from '@/lib/whatsapp/whatsapp-bus';
import { startUazApiListener } from '@/lib/whatsapp/uazapi-manager';
import { sendWhatsAppPresence } from '@/lib/whatsapp/unified-presence';

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

  // 2. Check Cookie session via createClient()
  if (!user) {
    try {
      const supabase = await createClient();
      const { data } = await supabase.auth.getUser();
      if (data?.user) {
        user = data.user;
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

async function handleSync(request: Request) {
  try {
    const { user, accountId } = await resolveUserAndAccount(request);
    if (!user || !accountId) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // 1. Ensure persistent server-side background SSE listener is running
    void startUazApiListener(accountId).catch((err) => {
      console.error('[sync-realtime] Error starting background listener:', err);
    });

    const admin = supabaseAdmin();

    // 2. Fetch active UazAPI connection
    const { data: conn } = await admin
      .from('whatsapp_connections')
      .select('*')
      .eq('account_id', accountId)
      .eq('provider', 'uazapi')
      .eq('is_active', true)
      .maybeSingle();

    if (!conn || conn.status === 'disconnected') {
      return NextResponse.json({ success: true, reason: 'uazapi_disconnected' });
    }

    const config = (conn.provider_config || {}) as Record<string, string>;
    let token = '';
    try {
      token = decrypt(config.token);
    } catch {
      token = config.token || '';
    }

    if (!token || !config.base_url) {
      return NextResponse.json({ success: true, reason: 'unconfigured_credentials' });
    }

    const baseUrl = normalizeBaseUrl(config.base_url);

    // 3. Fast pull recent active chats from UazAPI (takes ~80-120ms)
    const chatsRes = await fetch(`${baseUrl}/chat/find`, {
      method: 'POST',
      headers: {
        token,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ limit: 50 }),
    });

    if (!chatsRes.ok) {
      if (chatsRes.status === 401) {
        // Token is expired/invalid. Mark as disconnected in DB so UI stops reporting 'connecting'
        await admin
          .from('whatsapp_connections')
          .update({ status: 'disconnected', updated_at: new Date().toISOString() })
          .eq('id', conn.id);
        return NextResponse.json({
          success: false,
          error: 'UazAPI token invalid or expired (401)',
          disconnected: true,
        }, { status: 401 });
      }
      return NextResponse.json({
        success: false,
        error: `UazAPI error ${chatsRes.status}`,
      }, { status: 502 });
    }

    const chatsData = await chatsRes.json();
    const rawChats: Array<Record<string, unknown>> = chatsData.chats || [];

    if (rawChats.length === 0) {
      return NextResponse.json({ success: true, syncedMessages: 0, chatsChecked: 0 });
    }

    // 4. Fetch existing conversations to compare timestamps
    const { data: existingConvs } = await admin
      .from('conversations')
      .select('id, contact_id, last_message_at, contacts (phone)')
      .eq('account_id', accountId);

    const convMapByPhone = new Map<string, { id: string; contact_id: string; last_message_at: string | null }>();
    for (const c of existingConvs || []) {
      const p = (c as unknown as { contacts?: { phone?: string } })?.contacts?.phone;
      if (p) {
        convMapByPhone.set(p.replace(/\D/g, ''), {
          id: c.id,
          contact_id: c.contact_id,
          last_message_at: c.last_message_at,
        });
      }
    }

    let totalSyncedMessages = 0;
    const now = Date.now();

    // 5. Process any chats with new messages concurrently
    const syncChat = async (chat: Record<string, unknown>) => {
      try {
        // STRICT GROUP VETO
        const isGroupChat = Boolean(
          chat.isGroup ||
          chat.wa_isGroup ||
          String(chat.wa_chatid || '').endsWith('@g.us') ||
          String(chat.id || '').endsWith('@g.us') ||
          String(chat.chatid || '').endsWith('@g.us')
        );
        if (isGroupChat) return;

        const rawPhone = String(chat.phone || '').replace(/\D/g, '');
        if (!rawPhone || rawPhone.length < 8 || rawPhone.startsWith('120363') || rawPhone.length > 15) return;
        const formattedPhone = formatUazApiNumber(rawPhone);
        if (!formattedPhone || formattedPhone.length < 8) return;

        const matchedConv = convMapByPhone.get(formattedPhone) || convMapByPhone.get(rawPhone);
        const chatLastMsgTs = Number(chat.wa_lastMsgTimestamp || 0);
        const dbLastMsgTs = matchedConv?.last_message_at
          ? new Date(matchedConv.last_message_at).getTime()
          : 0;

        const hasNewerMessage = chatLastMsgTs > dbLastMsgTs;
        const hasUnread = Number(chat.wa_unreadCount || 0) > 0;
        const tsDiff = Math.abs(chatLastMsgTs - dbLastMsgTs);
        const isRecent = (now - chatLastMsgTs) < 300000;
        const needsSync = !matchedConv || hasUnread || hasNewerMessage || (tsDiff > 1000 && isRecent);

        if (!needsSync) {
          // Recovery check: if latest turn in DB is from customer without reply in last 15 min, trigger AI
          if (matchedConv && isRecent) {
            const { data: lastMsg } = await admin
              .from('messages')
              .select('sender_type, content_text, created_at')
              .eq('conversation_id', matchedConv.id)
              .order('created_at', { ascending: false })
              .limit(1)
              .maybeSingle();

            if (lastMsg && lastMsg.sender_type === 'customer' && (now - new Date(lastMsg.created_at).getTime() < 900000)) {
              const text = (lastMsg.content_text || '').trim();
              const isEmojiOnly = /^(\p{Extended_Pictographic}|\p{Emoji_Presentation}|\s)+$/u.test(text);
              const isIgnored = text === '[Mensagem recebida]' || text === '[Reação]' || text.startsWith('[Undecryptable]');
              if (text && !isEmojiOnly && !isIgnored) {
                void sendWhatsAppPresence({
                  accountId,
                  phoneNumber: formattedPhone,
                  presence: 'composing',
                  delayMs: 15000,
                  baseUrl,
                  token,
                });
                void dispatchInboundToAiReply({
                  accountId,
                  conversationId: matchedConv.id,
                  contactId: matchedConv.contact_id,
                  configOwnerUserId: user.id,
                }).catch(() => {});
              }
            }
          }
          return;
        }

        // Resolve or create contact & conversation if not found
        let convId = matchedConv?.id;
        let contactId = matchedConv?.contact_id;

        if (!convId || !contactId) {
          const contactName = String(chat.wa_name || chat.name || `+${formattedPhone}`);
          const { data: resolvedContactId } = await admin.rpc('find_or_create_contact', {
            p_account_id: accountId,
            p_user_id: user.id,
            p_phone: formattedPhone,
            p_name: contactName,
          });
          if (!resolvedContactId) return;
          contactId = resolvedContactId;

          const { data: resolvedConvId } = await admin.rpc('find_or_create_conversation', {
            p_account_id: accountId,
            p_user_id: user.id,
            p_contact_id: contactId,
            p_connection_id: conn.id,
          });
          if (!resolvedConvId) return;
          convId = resolvedConvId;
        }

        // Fetch recent messages for this chat
        const msgRes = await fetch(`${baseUrl}/message/find`, {
          method: 'POST',
          headers: {
            token,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            chatid: `${formattedPhone}@s.whatsapp.net`,
            limit: 20,
          }),
        });

        if (msgRes.ok) {
          const msgData = await msgRes.json();
          const rawMsgs = (msgData.messages || []).reverse();
          if (rawMsgs.length > 0) {
            const rawIds = rawMsgs.map((m: Record<string, unknown>) => String(m.messageid || m.id || '')).filter(Boolean);
            const cleanIds = rawIds.map((id: string) => (id.includes(':') ? id.split(':').pop()! : id));

            const { data: existingRows } = await admin
              .from('messages')
              .select('message_id')
              .eq('conversation_id', convId)
              .in('message_id', [...rawIds, ...cleanIds]);

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

              const rawId = String(m.messageid || m.id || '');
              const cleanId = rawId.includes(':') ? rawId.split(':').pop()! : rawId;
              if (!rawId || existingSet.has(rawId) || existingSet.has(cleanId)) continue;

              const text =
                m.text ||
                m.content?.text ||
                (m.messageType === 'ImageMessage' ? '[Imagem]' : '[Mensagem]');
              const isFromMe = Boolean(m.fromMe);
              const msgTs = m.messageTimestamp
                ? new Date(m.messageTimestamp).toISOString()
                : new Date().toISOString();

              toInsert.push({
                conversation_id: convId,
                sender_type: isFromMe ? ('agent' as const) : ('customer' as const),
                sender_id: isFromMe ? user.id : undefined,
                content_type: m.messageType === 'ImageMessage' ? ('image' as const) : ('text' as const),
                content_text: text,
                media_url: m.content?.URL || m.fileURL || null,
                message_id: cleanId,
                status: 'delivered' as const,
                created_at: msgTs,
              });
            }

            if (toInsert.length > 0) {
              const { data: inserted } = await admin.from('messages').insert(toInsert).select('*');
              totalSyncedMessages += toInsert.length;

              const last = rawMsgs[rawMsgs.length - 1];
              const lastTextMsg = (last.text || last.content?.text || '[Mensagem]').trim();
              const lastTs = last.messageTimestamp
                ? new Date(last.messageTimestamp).toISOString()
                : new Date().toISOString();

              await admin.rpc('update_conversation_with_message', {
                p_conversation_id: convId,
                p_message_text: lastTextMsg,
                p_message_timestamp: lastTs,
                p_is_inbound: !last.fromMe,
              });

              if (!last.fromMe) {
                void admin
                  .from('conversations')
                  .update({ ai_reply_count: 0 })
                  .eq('id', convId);
              }

              // Broadcast new messages through internal WhatsApp bus
              if (inserted && inserted.length > 0) {
                for (const row of inserted) {
                  whatsappBus.emitInboxEvent({
                    accountId,
                    conversationId: convId,
                    eventType: 'INSERT',
                    message: row,
                    conversation: {
                      id: convId,
                      last_message_text: lastTextMsg,
                      last_message_at: lastTs,
                      unread_count: last.fromMe ? 0 : 1,
                    },
                  });
                }
              }

              // Trigger AI auto-reply for newly detected incoming customer messages
              const isEmojiOnly = /^(\p{Extended_Pictographic}|\p{Emoji_Presentation}|\s)+$/u.test(lastTextMsg);
              const isIgnored = lastTextMsg === '[Mensagem recebida]' || lastTextMsg === '[Reação]' || lastTextMsg.startsWith('[Undecryptable]');

              const hasCustomerInbound = toInsert.some((m) => m.sender_type === 'customer');
              if (hasCustomerInbound && contactId && convId && !isEmojiOnly && !isIgnored && lastTextMsg) {
                if (formattedPhone) {
                  void sendWhatsAppPresence({
                    accountId,
                    phoneNumber: formattedPhone,
                    presence: 'composing',
                    delayMs: 15000,
                    baseUrl,
                    token,
                  });
                }
                void dispatchInboundToAiReply({
                  accountId,
                  conversationId: convId,
                  contactId,
                  configOwnerUserId: user.id,
                }).catch((err) => {
                  console.error('[sync-realtime] AI auto-reply dispatch error:', err);
                });
              }
            }
          }
        }
      } catch (err) {
        console.error('[sync-realtime] Error syncing chat messages:', err);
      }
    };

    await Promise.allSettled(rawChats.map(syncChat));

    return NextResponse.json({
      success: true,
      syncedMessages: totalSyncedMessages,
      chatsChecked: rawChats.length,
      elapsedMs: Date.now() - now,
    });
  } catch (err) {
    console.error('[sync-realtime] Fatal error:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function GET(request: Request) {
  return handleSync(request);
}

export async function POST(request: Request) {
  return handleSync(request);
}
