import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createClient as createAdminClient } from '@supabase/supabase-js';
import { decrypt } from '@/lib/whatsapp/encryption';
import { normalizeBaseUrl, formatUazApiNumber } from '@/lib/whatsapp/uazapi-client';
import { dispatchInboundToAiReply } from '@/lib/ai/auto-reply';

function supabaseAdmin() {
  return createAdminClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );
}

interface CachedConn {
  conn: any | null;
  cachedAt: number;
}
const connCache = new Map<string, CachedConn>();

async function getCachedUazConn(admin: ReturnType<typeof supabaseAdmin>, accountId: string) {
  const cached = connCache.get(accountId);
  if (cached && Date.now() - cached.cachedAt < 60000) {
    return cached.conn;
  }
  const { data: uazConn } = await admin
    .from('whatsapp_connections')
    .select('*')
    .eq('account_id', accountId)
    .eq('provider', 'uazapi')
    .eq('is_active', true)
    .maybeSingle();

  connCache.set(accountId, { conn: uazConn, cachedAt: Date.now() });
  return uazConn;
}

/**
 * GET /api/inbox/messages?conversation_id=...
 * Returns messages for a conversation, auto-syncing latest WhatsApp messages if UazAPI is active.
 */
export async function GET(request: Request) {
  try {
    const supabase = await createClient();
    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser();

    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { searchParams } = new URL(request.url);
    const conversationId = searchParams.get('conversation_id');

    if (!conversationId) {
      return NextResponse.json({ error: 'conversation_id is required' }, { status: 400 });
    }

    const admin = supabaseAdmin();

    // 1. Concurrently fetch conversation metadata and existing database messages
    const [{ data: conv }, { data: existingMessages, error: msgErr }] = await Promise.all([
      admin
        .from('conversations')
        .select('id, contact_id, account_id, last_message_at, last_message_text, last_message_sender, contacts (id, phone, name)')
        .eq('id', conversationId)
        .maybeSingle(),
      admin
        .from('messages')
        .select('*')
        .eq('conversation_id', conversationId)
        .order('created_at', { ascending: true }),
    ]);

    if (msgErr) {
      console.error('Error fetching messages via admin API:', msgErr);
      return NextResponse.json({ error: msgErr.message }, { status: 500 });
    }

    const messages = existingMessages || [];

    // If DB has 0 messages but conversation has last_message_text, insert it into messages table
    // so the thread is never trapped in a blank state
    if (messages.length === 0 && conv?.last_message_text) {
      const isAgent = conv.last_message_sender === 'agent' || conv.last_message_sender === 'bot';
      const fallbackMsg = {
        conversation_id: conversationId,
        sender_type: isAgent ? ('agent' as const) : ('customer' as const),
        content_type: 'text' as const,
        content_text: conv.last_message_text,
        status: 'delivered' as const,
        created_at: conv.last_message_at || new Date().toISOString(),
      };
      const { data: insertedMsg } = await admin.from('messages').insert(fallbackMsg).select('*').maybeSingle();
      if (insertedMsg) {
        messages.push(insertedMsg);
      }
    }

    // 2. Check if messages are already complete & up-to-date with conversation.last_message_at
    const latestDbMsg = messages.length > 0 ? messages[messages.length - 1] : null;
    const isUpToDate =
      latestDbMsg &&
      conv?.last_message_at &&
      new Date(latestDbMsg.created_at).getTime() >= new Date(conv.last_message_at).getTime() - 2000;

    if (isUpToDate) {
      return NextResponse.json({ messages });
    }

    // 3. If missing messages or no messages in DB, sync from UazAPI
    if (conv?.account_id) {
      try {
        const uazConn = await getCachedUazConn(admin, conv.account_id);
        if (uazConn) {
          const config = uazConn.provider_config || {};
          let token = '';
          try {
            token = decrypt(config.token);
          } catch {
            token = config.token;
          }
          const contactPhone = (conv as unknown as { contacts?: { phone?: string } })?.contacts?.phone;
          if (token && contactPhone) {
            const formattedPhone = formatUazApiNumber(contactPhone);
            const baseUrl = normalizeBaseUrl(config.base_url);
            const uazRes = await fetch(`${baseUrl}/message/find`, {
              method: 'POST',
              headers: { token, 'Content-Type': 'application/json' },
              body: JSON.stringify({
                chatid: `${formattedPhone}@s.whatsapp.net`,
                limit: 50,
              }),
            });

            if (uazRes.ok) {
              const uazData = await uazRes.json();
              const rawMsgs = (uazData.messages || []).reverse();
              if (rawMsgs.length > 0) {
                const existingSet = new Set(messages.map((m) => m.message_id));
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
                    const msgTs = m.messageTimestamp
                      ? new Date(m.messageTimestamp).toISOString()
                      : new Date().toISOString();

                    const resolvedMediaUrl =
                      m.fileURL ||
                      m.content?.fileURL ||
                      (m.content?.URL && !String(m.content.URL).includes('mmg.whatsapp.net') ? m.content.URL : null) ||
                      m.content?.URL ||
                      null;

                    toInsert.push({
                      conversation_id: conversationId,
                      sender_type: isFromMe ? ('agent' as const) : ('customer' as const),
                      sender_id: isFromMe ? user.id : undefined,
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
                  const { data: inserted } = await admin.from('messages').insert(toInsert).select('*');
                  if (inserted && inserted.length > 0) {
                    messages.push(...inserted);
                    messages.sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
                  }

                  const last = toInsert[toInsert.length - 1];
                  const lastText = (last?.content_text || '').trim();
                  const isEmojiOnly = /^(\p{Extended_Pictographic}|\p{Emoji_Presentation}|\s)+$/u.test(lastText);
                  const isIgnored = lastText === '[Mensagem recebida]' || lastText === '[Reação]' || lastText.startsWith('[Undecryptable]');

                  const hasCustomerInbound = toInsert.some((m) => m.sender_type === 'customer');
                  if (hasCustomerInbound && conv?.contact_id && conv?.account_id && !isEmojiOnly && !isIgnored && lastText) {
                    void dispatchInboundToAiReply({
                      accountId: conv.account_id,
                      conversationId,
                      contactId: conv.contact_id,
                      configOwnerUserId: user.id,
                    }).catch((err) => {
                      console.error('[Inbox Messages API] AI auto-reply dispatch error:', err);
                    });
                  }
                }

              }
            }
          }
        }
      } catch (syncErr) {
        console.error('[Inbox Messages API] UazAPI live sync error (ignored):', syncErr);
      }
    }

    return NextResponse.json({ messages });
  } catch (err) {
    console.error('Internal error in messages API:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

/**
 * POST /api/inbox/messages
 * Mark messages in conversation as read.
 */
export async function POST(request: Request) {
  try {
    const supabase = await createClient();
    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser();

    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const body = await request.json();
    const { conversation_id } = body;

    if (!conversation_id) {
      return NextResponse.json({ error: 'conversation_id is required' }, { status: 400 });
    }

    const admin = supabaseAdmin();

    await admin
      .from('conversations')
      .update({ unread_count: 0 })
      .eq('id', conversation_id);

    return NextResponse.json({ success: true });
  } catch (err) {
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
