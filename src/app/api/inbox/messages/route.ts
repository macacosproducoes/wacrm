import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createClient as createAdminClient } from '@supabase/supabase-js';
import { decrypt } from '@/lib/whatsapp/encryption';
import { normalizeBaseUrl, formatUazApiNumber } from '@/lib/whatsapp/uazapi-client';

function supabaseAdmin() {
  return createAdminClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );
}

interface CachedConns {
  conns: any[];
  cachedAt: number;
}
const connCache = new Map<string, CachedConns>();

async function getCachedUazConns(admin: ReturnType<typeof supabaseAdmin>, accountId: string) {
  const cached = connCache.get(accountId);
  if (cached && Date.now() - cached.cachedAt < 60000) {
    return cached.conns;
  }
  const { data: uazConns } = await admin
    .from('whatsapp_connections')
    .select('*')
    .eq('account_id', accountId)
    .eq('provider', 'uazapi')
    .eq('is_active', true);

  const conns = uazConns || [];
  connCache.set(accountId, { conns, cachedAt: Date.now() });
  return conns;
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
        .select('id, contact_id, account_id, last_message_at, last_message_text, contacts (id, phone, name)')
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

    // 1.1 If this conversation has 0 messages, check if messages exist under another conversation for the same contact
    if (messages.length === 0 && conv?.contact_id) {
      const { data: siblingConvs } = await admin
        .from('conversations')
        .select('id')
        .eq('contact_id', conv.contact_id);

      if (siblingConvs && siblingConvs.length > 0) {
        const siblingIds = siblingConvs.map((s) => s.id).filter((id) => id !== conversationId);
        if (siblingIds.length > 0) {
          const { data: siblingMsgs } = await admin
            .from('messages')
            .select('*')
            .in('conversation_id', siblingIds)
            .order('created_at', { ascending: true });

          if (siblingMsgs && siblingMsgs.length > 0) {
            // Re-assign sibling messages to this conversation so the thread is complete
            await admin
              .from('messages')
              .update({ conversation_id: conversationId })
              .in('conversation_id', siblingIds);

            for (const sm of siblingMsgs) {
              messages.push({ ...sm, conversation_id: conversationId });
            }
          }
        }
      }
    }

    // 2. Check if messages are already complete & up-to-date with conversation.last_message_at
    const latestDbMsg = messages.length > 0 ? messages[messages.length - 1] : null;
    const isUpToDate =
      latestDbMsg &&
      conv?.last_message_at &&
      new Date(latestDbMsg.created_at).getTime() >= new Date(conv.last_message_at).getTime() - 2000;

    if (isUpToDate && messages.length > 0) {
      return NextResponse.json({ messages });
    }

    // 3. If missing messages or no messages in DB, sync from UazAPI across all active connections and phone variants
    if (conv?.account_id) {
      try {
        const uazConns = await getCachedUazConns(admin, conv.account_id);
        const contactPhone = (conv as unknown as { contacts?: { phone?: string } })?.contacts?.phone;

        if (uazConns.length > 0 && contactPhone) {
          const basePhone = formatUazApiNumber(contactPhone);
          const phoneVariants = [basePhone];
          if (basePhone.startsWith('55') && basePhone.length === 13 && basePhone[4] === '9') {
            // 5511999998888 -> also try 551199998888
            phoneVariants.push(`55${basePhone.slice(2, 4)}${basePhone.slice(5)}`);
          } else if (basePhone.startsWith('55') && basePhone.length === 12) {
            // 551199998888 -> also try 5511999998888
            phoneVariants.push(`55${basePhone.slice(2, 4)}9${basePhone.slice(4)}`);
          }

          let foundInUaz = false;

          for (const uazConn of uazConns) {
            if (foundInUaz) break;
            const config = uazConn.provider_config || {};
            let token = '';
            try {
              token = decrypt(config.token);
            } catch {
              token = config.token;
            }
            if (!token || !config.base_url) continue;

            const baseUrl = normalizeBaseUrl(config.base_url);

            for (const phoneVariant of phoneVariants) {
              try {
                const uazRes = await fetch(`${baseUrl}/message/find`, {
                  method: 'POST',
                  headers: { token, 'Content-Type': 'application/json' },
                  body: JSON.stringify({
                    chatid: `${phoneVariant}@s.whatsapp.net`,
                    limit: 50,
                  }),
                });

                if (uazRes.ok) {
                  const uazData = await uazRes.json();
                  const rawMsgs = (uazData.messages || []).reverse();
                  if (rawMsgs.length > 0) {
                    foundInUaz = true;
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
                        let msgTs = new Date().toISOString();
                        if (m.messageTimestamp) {
                          const num = typeof m.messageTimestamp === 'number' ? m.messageTimestamp : Number(m.messageTimestamp);
                          if (!isNaN(num) && num > 0) {
                            const ms = num < 10000000000 ? num * 1000 : num;
                            msgTs = new Date(ms).toISOString();
                          }
                        }

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
                    }

                    break; // Found messages for this phone variant, break variant loop
                  }
                }
              } catch (variantErr) {
                console.warn(`[Inbox Messages API] Error fetching variant ${phoneVariant}:`, variantErr);
              }
            }
          }
        }
      } catch (syncErr) {
        console.error('[Inbox Messages API] UazAPI live sync error (ignored):', syncErr);
      }
    }

    // 4. If DB still has 0 messages but conversation has last_message_text, insert it into messages table
    // so the thread is never trapped in a blank state
    if (messages.length === 0 && conv?.last_message_text) {
      const isAgent = (conv as any)?.last_message_sender === 'agent' || (conv as any)?.last_message_sender === 'bot';
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

    const sanitizedMessages = messages.map((m) => {
      if (
        m.media_url &&
        (m.media_url.includes('mmg.whatsapp.net') || m.media_url.includes('.enc'))
      ) {
        return {
          ...m,
          media_url: `/api/whatsapp/uazapi/media?messageId=${encodeURIComponent(m.message_id || m.id)}`,
        };
      }
      return m;
    });

    return NextResponse.json({ messages: sanitizedMessages });
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
