import https from 'https';
import http from 'http';
import { createClient as createAdminClient } from '@supabase/supabase-js';
import { decrypt } from '@/lib/whatsapp/encryption';
import { normalizeBaseUrl, formatUazApiNumber } from '@/lib/whatsapp/uazapi-client';
import { processUazApiEvent } from '@/lib/whatsapp/uazapi-event-processor';
import { whatsappBus } from '@/lib/whatsapp/whatsapp-bus';
import { sendWhatsAppPresence } from '@/lib/whatsapp/unified-presence';
import {
  findOrCreateContact,
  findOrCreateConversation,
  updateConversationWithMessage,
} from '@/lib/whatsapp/conversation-helpers';

function supabaseAdmin() {
  return createAdminClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );
}

interface ActiveListener {
  accountId: string;
  connectionId: string;
  req: http.ClientRequest | null;
  reconnectTimeout: NodeJS.Timeout | null;
  pollInterval: NodeJS.Timeout | null;
  isPolling: boolean;
  isDestroyed: boolean;
  status: 'connecting' | 'connected' | 'disconnected';
  lastEventAt: number;
}

declare global {
  // eslint-disable-next-line no-var
  var __uazapiListeners: Map<string, ActiveListener> | undefined;
}

const listeners: Map<string, ActiveListener> =
  globalThis.__uazapiListeners || new Map<string, ActiveListener>();
globalThis.__uazapiListeners = listeners;

/**
 * Start or resume a persistent background sync and SSE listener for the given account.
 * Keeps a continuous connection to UazAPI's /sse endpoint directly inside Node.js,
 * paired with a lightweight 2.5s ticker that guarantees 0-delay ingestion and immediate AI replies
 * even when the user's browser tab is minimized or inactive.
 */
export async function startUazApiListener(accountId: string): Promise<boolean> {
  const existing = listeners.get(accountId);
  if (existing && !existing.isDestroyed && existing.status === 'connected') {
    return true;
  }

  const admin = supabaseAdmin();
  const { data: conns } = await admin
    .from('whatsapp_connections')
    .select('*')
    .eq('account_id', accountId)
    .eq('provider', 'uazapi')
    .eq('is_active', true)
    .order('updated_at', { ascending: false });

  const conn = conns?.[0] || null;
  if (!conn) return false;

  const config = (conn.provider_config || {}) as Record<string, string>;
  let token = '';
  try {
    token = decrypt(config.token);
  } catch {
    token = config.token || '';
  }

  if (!token || !config.base_url) return false;

  const baseUrl = normalizeBaseUrl(config.base_url);

  if (existing) {
    existing.isDestroyed = true;
    if (existing.req) existing.req.destroy();
    if (existing.reconnectTimeout) clearTimeout(existing.reconnectTimeout);
    if (existing.pollInterval) clearInterval(existing.pollInterval);
    listeners.delete(accountId);
  }

  const listener: ActiveListener = {
    accountId,
    connectionId: conn.id,
    req: null,
    reconnectTimeout: null,
    pollInterval: null,
    isPolling: false,
    isDestroyed: false,
    status: 'connecting',
    lastEventAt: Date.now(),
  };
  listeners.set(accountId, listener);

  let reconnectDelay = 2000;

  // 1. Start Server-Side Fast Poller (Runs every 2.5s in Node.js independent of browser tabs)
  function startServerPoller() {
    if (listener.isDestroyed) return;

    async function pollBatch() {
      if (listener.isDestroyed || listener.isPolling) return;
      listener.isPolling = true;

      try {
        const chatsRes = await fetch(`${baseUrl}/chat/find`, {
          method: 'POST',
          headers: { token, 'Content-Type': 'application/json' },
          body: JSON.stringify({ limit: 50 }),
          signal: AbortSignal.timeout(4000),
        });

        if (!chatsRes.ok) return;
        const chatsData = await chatsRes.json();
        const rawChats = (chatsData.chats || []) as Record<string, unknown>[];
        if (rawChats.length === 0) return;

        // Fetch account owner
        const { data: acct } = await admin
          .from('accounts')
          .select('owner_user_id')
          .eq('id', accountId)
          .single();
        const ownerUserId = acct?.owner_user_id;
        if (!ownerUserId) return;

        // Fetch existing conversations (bounded to 50 recent)
        const { data: convs } = await admin
          .from('conversations')
          .select('id, contact_id, last_message_at, contacts(phone)')
          .eq('account_id', accountId)
          .order('last_message_at', { ascending: false, nullsFirst: false })
          .limit(50);

        const convMapByPhone = new Map<string, { id: string; contact_id: string; last_message_at: string | null }>();
        for (const c of convs || []) {
          const p = (c as unknown as { contacts?: { phone?: string } })?.contacts?.phone;
          if (p) {
            const clean = p.replace(/\D/g, '');
            convMapByPhone.set(clean, { id: c.id, contact_id: c.contact_id, last_message_at: c.last_message_at });
          }
        }

        const now = Date.now();

        const processChat = async (chat: Record<string, unknown>) => {
          if (listener.isDestroyed) return;

          // Strict group veto
          const isGroup = Boolean(
            chat.isGroup ||
            chat.wa_isGroup ||
            String(chat.wa_chatid || '').endsWith('@g.us') ||
            String(chat.id || '').endsWith('@g.us') ||
            String(chat.chatid || '').endsWith('@g.us')
          );
          if (isGroup) return;

          const rawPhone = String(chat.phone || '').replace(/\D/g, '');
          if (!rawPhone || rawPhone.length < 8 || rawPhone.startsWith('120363') || rawPhone.length > 15) return;
          const formattedPhone = formatUazApiNumber(rawPhone);
          if (!formattedPhone || formattedPhone.length < 8) return;

          const matchedConv = convMapByPhone.get(formattedPhone) || convMapByPhone.get(rawPhone);
          const chatLastMsgTs = Number(chat.wa_lastMsgTimestamp || 0);
          const dbLastMsgTs = matchedConv?.last_message_at
            ? new Date(matchedConv.last_message_at).getTime()
            : 0;

          const hasUnread = Number(chat.wa_unreadCount || 0) > 0;
          const tsDiff = Math.abs(chatLastMsgTs - dbLastMsgTs);
          const isRecent = (now - chatLastMsgTs) < 300000; // within 5 minutes
          const needsSync = !matchedConv || hasUnread || (tsDiff > 1000 && isRecent);

          if (!needsSync) {
            // Recovery check removed: the webhook and SSE already guarantee
            // AI dispatch. Re-triggering here without a messageId caused
            // the debouncer to treat each poll tick as a new inbound turn,
            // producing duplicate AI replies.
            return;
          }

          // Resolve contact & conversation via resilient helper
          let convId = matchedConv?.id;
          let contactId = matchedConv?.contact_id;

          if (!convId || !contactId) {
            const contactName = String(chat.wa_name || chat.name || `+${formattedPhone}`);
            const resContactId = await findOrCreateContact(admin, {
              accountId,
              userId: ownerUserId,
              phone: formattedPhone,
              name: contactName,
            });
            if (!resContactId) return;
            contactId = resContactId;

            const resConvId = await findOrCreateConversation(admin, {
              accountId,
              userId: ownerUserId,
              contactId,
              connectionId: conn.id,
            });
            if (!resConvId) return;
            convId = resConvId;
          }

          // Fetch recent messages
          const msgRes = await fetch(`${baseUrl}/message/find`, {
            method: 'POST',
            headers: { token, 'Content-Type': 'application/json' },
            body: JSON.stringify({ chatid: `${formattedPhone}@s.whatsapp.net`, limit: 15 }),
            signal: AbortSignal.timeout(4000),
          });

          if (!msgRes.ok) return;
          const msgData = await msgRes.json();
          const rawMsgs = ((msgData.messages || []) as Record<string, unknown>[]).reverse();
          if (rawMsgs.length === 0) return;

          // Extract message IDs (stripping owner prefix to prevent duplicate outgoing messages)
          const rawIds = rawMsgs.map((m) => String(m.messageid || m.id || '')).filter(Boolean);
          const cleanIds = rawIds.map((id: string) => (id.includes(':') ? id.split(':').pop()! : id));

          const { data: existingRows } = await admin
            .from('messages')
            .select('message_id')
            .eq('conversation_id', convId)
            .in('message_id', [...rawIds, ...cleanIds]);

          const existingSet = new Set((existingRows || []).map((r) => r.message_id));
          const toInsert = [];

          for (const m of rawMsgs) {
            const rawId = String(m.messageid || m.id || '');
            const cleanId = rawId.includes(':') ? rawId.split(':').pop()! : rawId;
            if (!rawId || existingSet.has(rawId) || existingSet.has(cleanId)) continue;

            const isReaction = Boolean(
              m.messageType === 'reactionMessage' ||
              m.messageType === 'ReactionMessage' ||
              m.type === 'reaction' ||
              m.reaction
            );
            if (isReaction) continue;

            const isFromMe = Boolean(m.fromMe);
            const contentObj = (m.content || {}) as Record<string, unknown>;
            const msgTypeStr = String(m.messageType || m.type || '');
            const isImg = /image/i.test(msgTypeStr) || Boolean(contentObj.imageMessage) || Boolean(m.image);
            const isAud = /audio/i.test(msgTypeStr) || Boolean(contentObj.audioMessage) || Boolean(m.audio);
            const isVid = /video/i.test(msgTypeStr) || Boolean(contentObj.videoMessage) || Boolean(m.video);
            const isDoc = /document/i.test(msgTypeStr) || Boolean(contentObj.documentMessage) || Boolean(m.document);

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

            const text = String(m.text || contentObj.text || contentObj.caption || defaultText);
            const msgTs = m.messageTimestamp ? new Date(Number(m.messageTimestamp)).toISOString() : new Date().toISOString();

            const resolvedMediaUrl =
              m.fileURL ||
              contentObj.fileURL ||
              (contentObj.URL && !String(contentObj.URL).includes('mmg.whatsapp.net') ? contentObj.URL : null) ||
              contentObj.URL ||
              null;

            toInsert.push({
              conversation_id: convId,
              sender_type: isFromMe ? ('agent' as const) : ('customer' as const),
              sender_id: isFromMe ? ownerUserId : undefined,
              content_type: cType,
              content_text: text,
              media_url: resolvedMediaUrl as string | null,
              message_id: cleanId,
              status: 'delivered' as const,
              created_at: msgTs,
            });
          }

          if (toInsert.length > 0) {
            const { data: inserted } = await admin.from('messages').insert(toInsert).select('*');
            const last = rawMsgs[rawMsgs.length - 1];
            const contentObj = (last.content || {}) as Record<string, unknown>;
            const lastText = String(last.text || contentObj.text || '[Mensagem]').trim();
            const lastTs = last.messageTimestamp ? new Date(Number(last.messageTimestamp)).toISOString() : new Date().toISOString();

            await updateConversationWithMessage(admin, {
              conversationId: convId,
              messageText: lastText,
              messageTimestamp: lastTs,
              isInbound: !last.fromMe,
              senderType: last.fromMe ? 'agent' : 'customer',
            });

            if (!last.fromMe) {
              void admin
                .from('conversations')
                .update({ ai_reply_count: 0 })
                .eq('id', convId);
            }

            if (inserted) {
              for (const row of inserted) {
                whatsappBus.emitInboxEvent({
                  accountId,
                  conversationId: convId,
                  eventType: 'INSERT',
                  message: row,
                  conversation: {
                    id: convId,
                    last_message_text: lastText,
                    last_message_at: lastTs,
                    unread_count: last.fromMe ? 0 : 1,
                  },
                });
              }
            }

            // AI auto-reply trigger removed from poller: the webhook SSE
            // listener already dispatches AI for every real inbound message
            // with proper messageId deduplication. Triggering here as well
            // was the primary source of duplicate AI replies because the
            // poller runs every few seconds and would re-detect the same
            // messages that the webhook already processed.
          }
        };

        await Promise.allSettled(rawChats.map(processChat));
      } catch {
        // Non-blocking
      } finally {
        listener.isPolling = false;
      }
    }

    // Run first batch immediately.
    // Webhooks (/api/whatsapp/uazapi/webhook) deliver messages in real time.
    // Use a conservative 60s fallback poll instead of 5s to avoid exhausting Supabase connection pool.
    void pollBatch();
    if (process.env.VERCEL !== '1') {
      listener.pollInterval = setInterval(pollBatch, 60000);
    }
  }

  // 2. Start Persistent Upstream SSE Connection
  function connect() {
    if (listener.isDestroyed) return;
    // On Vercel serverless, long-lived upstream HTTP streams keep lambda CPU active.
    // Webhooks (/api/whatsapp/uazapi/webhook) provide real-time delivery with zero idle compute.
    if (process.env.VERCEL === '1') return;

    try {
      const sseUrl = `${baseUrl}/sse?token=${encodeURIComponent(token)}`;
      const parsedUrl = new URL(sseUrl);
      const isHttps = parsedUrl.protocol === 'https:';
      const client = isHttps ? https : http;

      const req = client.get(
        sseUrl,
        {
          headers: {
            token,
            Accept: 'text/event-stream',
          },
        },
        (res) => {
          if (res.statusCode !== 200) {
            scheduleReconnect();
            return;
          }

          listener.status = 'connected';
          reconnectDelay = 2000;

          let buffer = '';

          res.on('data', (chunk: Buffer) => {
            if (listener.isDestroyed) return;
            listener.lastEventAt = Date.now();

            buffer += chunk.toString();
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';

            for (const line of lines) {
              const trimmed = line.trim();
              if (trimmed.startsWith('data:')) {
                const jsonStr = trimmed.slice(5).trim();
                if (jsonStr && jsonStr !== '[DONE]') {
                  try {
                    const eventData = JSON.parse(jsonStr);
                    processUazApiEvent(eventData, conn, { skipAiDispatch: true }).catch((err) => {
                      console.error('[UazAPI Background SSE] Event processing error:', err);
                    });
                  } catch {
                    // Non-JSON chunk
                  }
                }
              }
            }
          });

          res.on('end', () => {
            scheduleReconnect();
          });

          res.on('error', () => {
            scheduleReconnect();
          });
        }
      );

      req.on('error', () => {
        scheduleReconnect();
      });

      listener.req = req;
    } catch {
      scheduleReconnect();
    }
  }

  function scheduleReconnect() {
    if (listener.isDestroyed) return;
    listener.status = 'disconnected';
    if (listener.req) {
      try {
        listener.req.destroy();
      } catch {
        // Ignored
      }
      listener.req = null;
    }

    if (listener.reconnectTimeout) clearTimeout(listener.reconnectTimeout);
    listener.reconnectTimeout = setTimeout(() => {
      if (!listener.isDestroyed) {
        connect();
      }
    }, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 1.5, 15000);
  }

  connect();
  startServerPoller();
  return true;
}

/**
 * Stop background SSE listener and poller for an account.
 */
export function stopUazApiListener(accountId: string) {
  const existing = listeners.get(accountId);
  if (existing) {
    existing.isDestroyed = true;
    if (existing.req) existing.req.destroy();
    if (existing.reconnectTimeout) clearTimeout(existing.reconnectTimeout);
    if (existing.pollInterval) clearInterval(existing.pollInterval);
    listeners.delete(accountId);
  }
}

/**
 * Check if the background listener is currently active for an account.
 */
export function isUazApiListenerActive(accountId: string): boolean {
  const l = listeners.get(accountId);
  return Boolean(l && !l.isDestroyed && (l.status === 'connected' || l.pollInterval !== null));
}
