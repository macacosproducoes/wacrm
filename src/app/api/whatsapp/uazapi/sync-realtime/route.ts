import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createClient as createAdminClient } from '@supabase/supabase-js';
import { decrypt } from '@/lib/whatsapp/encryption';
import { normalizeBaseUrl, formatUazApiNumber } from '@/lib/whatsapp/uazapi-client';
import { whatsappBus } from '@/lib/whatsapp/whatsapp-bus';
import { startUazApiListener } from '@/lib/whatsapp/uazapi-manager';
import { dispatchInboundToAiReply } from '@/lib/ai/auto-reply';
import {
  findOrCreateContact,
  findOrCreateConversation,
  updateConversationWithMessage,
} from '@/lib/whatsapp/conversation-helpers';
import { handleInboundMessageInstagram } from '@/lib/instagram-resolver';
import { handleFollowerOrder } from '@/lib/orders/follower-order-handler';

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
    const { data: conns } = await admin
      .from('whatsapp_connections')
      .select('*')
      .eq('account_id', accountId)
      .eq('provider', 'uazapi')
      .eq('is_active', true)
      .order('updated_at', { ascending: false });

    const conn = conns?.find((c) => c.status === 'connected') || conns?.[0] || null;

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
      body: JSON.stringify({ limit: 200 }),
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
          // Recovery check removed: the webhook SSE listener already
          // dispatches AI for every real inbound message with proper
          // messageId deduplication. Re-triggering here without a
          // messageId caused the debouncer to treat each sync tick as
          // a new inbound turn, producing duplicate AI replies.
          return;
        }

        // Resolve or create contact & conversation via resilient helper
        let convId = matchedConv?.id;
        let contactId = matchedConv?.contact_id;

        if (!convId || !contactId) {
          const candidateName = String(chat.wa_name || chat.name || chat.wa_contactName || '').trim();
          const resolvedContactId = await findOrCreateContact(admin, {
            accountId,
            userId: user.id,
            phone: formattedPhone,
            name: candidateName || undefined,
            instanceName: conn.display_name,
          });
          if (!resolvedContactId) return;
          contactId = resolvedContactId;

          const resolvedConvId = await findOrCreateConversation(admin, {
            accountId,
            userId: user.id,
            contactId,
            connectionId: conn.id,
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
              .eq('conversation_id', convId)
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

              const text = m.text || mContent?.text || mContent?.caption || defaultText;
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
                (m as any).fileURL ||
                mContent?.fileURL ||
                (mContent?.URL && !String(mContent.URL).includes('mmg.whatsapp.net') ? mContent.URL : null) ||
                mContent?.URL ||
                null;

              toInsert.push({
                conversation_id: convId,
                sender_type: isFromMe ? ('agent' as const) : ('customer' as const),
                sender_id: isFromMe ? user.id : undefined,
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
              const { data: inserted } = await admin.from('messages').insert(toInsert).select('*');
              totalSyncedMessages += toInsert.length;

              await updateConversationWithMessage(admin, {
                conversationId: convId,
                messageText: lastTextMsg,
                messageTimestamp: lastTs,
                isInbound: !lastIsFromMe,
                senderType: lastIsFromMe ? 'agent' : 'customer',
              });

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
                      unread_count: lastIsFromMe ? 0 : 1,
                    },
                  });
                }
              }

              // Handle Follower Order or AI auto-reply for newly synced inbound customer messages
              if (!lastIsFromMe && toInsert.some((m) => m.sender_type === 'customer')) {
                let orderHandled = false;
                if (lastTextMsg && contactId) {
                  try {
                    const orderRes = await handleFollowerOrder({
                      accountId,
                      contactId,
                      conversationId: convId,
                      phone: formattedPhone,
                      messageText: lastTextMsg,
                      messageId: toInsert[toInsert.length - 1]?.message_id,
                      pushName: String(chat.wa_name || chat.name || chat.wa_contactName || '').trim() || undefined,
                    });
                    if (orderRes.handled) {
                      orderHandled = true;
                      console.log(`[sync-realtime] Follower order handled successfully for contact ${contactId}`);
                    }
                  } catch (err) {
                    console.error('[sync-realtime] Error handling follower order:', err);
                  }
                }

                if (!orderHandled) {
                  try {
                    await dispatchInboundToAiReply({
                      accountId,
                      conversationId: convId,
                      contactId,
                      configOwnerUserId: user.id,
                      messageId: toInsert[toInsert.length - 1]?.message_id,
                      immediate: false,
                    });
                  } catch (err) {
                    console.error('[sync-realtime] AI auto-reply dispatch error:', err);
                  }
                }

                // Auto-detect and resolve Instagram handle in background (non-blocking)
                if (lastTextMsg && contactId && !orderHandled) {
                  void handleInboundMessageInstagram({
                    accountId,
                    contactId,
                    messageText: lastTextMsg,
                  }).catch((err) => console.warn('[sync-realtime-instagram] Background resolve error:', err));
                }
              }
            } else if (matchedConv?.last_message_at !== lastTs) {
              // Ensure conversation header matches latest WhatsApp state even if messages were already inserted
              await updateConversationWithMessage(admin, {
                conversationId: convId,
                messageText: lastTextMsg,
                messageTimestamp: lastTs,
                isInbound: !lastIsFromMe,
                senderType: lastIsFromMe ? 'agent' : 'customer',
              });
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
