import fs from 'fs';
import path from 'path';
import QRCode from 'qrcode';
import pino from 'pino';
import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  Browsers,
  fetchLatestBaileysVersion,
  type WASocket,
  type proto,
} from '@whiskeysockets/baileys';
import { createClient as createAdminClient } from '@supabase/supabase-js';
import { isRealWhatsAppContact } from '@/lib/whatsapp/phone-utils';
import { formatUazApiNumber } from '@/lib/whatsapp/uazapi-client';
import { notifyClientPresence } from '@/lib/ai/auto-reply-debouncer';

function getAdminClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  return createAdminClient(url, key);
}

const SESSIONS_DIR = path.join(process.cwd(), 'whatsapp_sessions');

export interface BaileysSessionInfo {
  accountId: string;
  status: 'disconnected' | 'connecting' | 'connected';
  qrCode: string | null;
  pairingCode: string | null;
  phoneNumber: string | null;
  userName: string | null;
  profilePicUrl?: string | null;
  profileStatus?: string | null;
  lastUpdated: string;
  error?: string | null;
}

interface ActiveSession {
  sock: WASocket | null;
  qrCode: string | null;
  pairingCode: string | null;
  status: 'disconnected' | 'connecting' | 'connected';
  phoneNumber: string | null;
  userName: string | null;
  profilePicUrl?: string | null;
  profileStatus?: string | null;
  lastUpdated: string;
  error?: string | null;
}

declare global {
  // eslint-disable-next-line no-var
  var __baileysSessions: Map<string, ActiveSession> | undefined;
}

const sessions: Map<string, ActiveSession> =
  globalThis.__baileysSessions || new Map<string, ActiveSession>();
globalThis.__baileysSessions = sessions;

function getSessionPath(accountId: string) {
  const dir = path.join(SESSIONS_DIR, accountId);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

/**
 * Check if the account has saved credentials on disk
 */
export function hasSavedSession(accountId: string): boolean {
  const credsPath = path.join(SESSIONS_DIR, accountId, 'creds.json');
  return fs.existsSync(credsPath);
}

/**
 * Get the current status of the Baileys session for an account
 */
export async function getBaileysStatus(accountId: string): Promise<BaileysSessionInfo> {
  const active = sessions.get(accountId);

  if (active && active.sock && active.status === 'connected') {
    return {
      accountId,
      status: 'connected',
      qrCode: null,
      pairingCode: null,
      phoneNumber: active.phoneNumber,
      userName: active.userName,
      profilePicUrl: active.profilePicUrl || null,
      profileStatus: active.profileStatus || null,
      lastUpdated: active.lastUpdated,
    };
  }

  if (active && active.status === 'connecting') {
    return {
      accountId,
      status: 'connecting',
      qrCode: active.qrCode,
      pairingCode: active.pairingCode,
      phoneNumber: active.phoneNumber,
      userName: active.userName,
      profilePicUrl: active.profilePicUrl || null,
      profileStatus: active.profileStatus || null,
      lastUpdated: active.lastUpdated,
      error: active.error,
    };
  }

  let currentActive = active;
  if (!currentActive && hasSavedSession(accountId)) {
    void connectBaileys(accountId).catch(() => {});
    currentActive = sessions.get(accountId);
  }

  // Check DB for record
  const admin = getAdminClient();
  let dbConn: Record<string, unknown> | null = null;
  if (admin) {
    const { data } = await admin
      .from('whatsapp_connections')
      .select('*')
      .eq('account_id', accountId)
      .filter('provider_config->>driver', 'eq', 'baileys')
      .limit(1);
    dbConn = data?.[0] || null;
  }

  const isBaileys = dbConn?.provider_config && (dbConn.provider_config as Record<string, unknown>).driver === 'baileys';
  const isConnected = (currentActive?.sock && currentActive.status === 'connected') || (isBaileys && dbConn?.status === 'connected' && hasSavedSession(accountId));
  const config = (dbConn?.provider_config || {}) as Record<string, unknown>;

  return {
    accountId,
    status: isConnected ? 'connected' : (currentActive?.status === 'connecting' ? 'connecting' : 'disconnected'),
    qrCode: currentActive?.qrCode || null,
    pairingCode: currentActive?.pairingCode || null,
    phoneNumber: currentActive?.phoneNumber || (dbConn?.phone_number as string) || (config?.phone as string) || null,
    userName: currentActive?.userName || (dbConn?.display_name as string) || (config?.userName as string) || null,
    profilePicUrl: currentActive?.profilePicUrl || (config?.profilePicUrl as string) || null,
    profileStatus: currentActive?.profileStatus || (config?.profileStatus as string) || null,
    lastUpdated: currentActive?.lastUpdated || (dbConn?.updated_at as string) || new Date().toISOString(),
  };
}

/**
 * Start or retrieve connection with QR code generation
 */
export async function connectBaileys(accountId: string): Promise<BaileysSessionInfo> {
  const existing = sessions.get(accountId);

  if (existing && existing.sock && existing.status === 'connected') {
    return {
      accountId,
      status: 'connected',
      qrCode: null,
      pairingCode: null,
      phoneNumber: existing.phoneNumber,
      userName: existing.userName,
      lastUpdated: existing.lastUpdated,
    };
  }

  // If already connecting with a fresh QR code, return current QR
  if (existing && existing.status === 'connecting' && existing.qrCode) {
    return {
      accountId,
      status: 'connecting',
      qrCode: existing.qrCode,
      pairingCode: existing.pairingCode,
      phoneNumber: existing.phoneNumber,
      userName: existing.userName,
      lastUpdated: existing.lastUpdated,
    };
  }

  // If existing socket exists but is not connected, clean it up
  if (existing?.sock) {
    try {
      existing.sock.end(undefined);
    } catch {}
  }

  const sessionPath = getSessionPath(accountId);
  const { state, saveCreds } = await useMultiFileAuthState(sessionPath);

  const session: ActiveSession = {
    sock: null,
    qrCode: null,
    pairingCode: null,
    status: 'connecting',
    phoneNumber: null,
    userName: null,
    lastUpdated: new Date().toISOString(),
  };
  sessions.set(accountId, session);

  try {
    const { version } = await fetchLatestBaileysVersion().catch(() => ({ version: undefined }));

    const sock = makeWASocket({
      auth: state,
      version,
      printQRInTerminal: false,
      logger: pino({ level: 'silent' }),
      browser: Browsers.appropriate('Chrome'),
      syncFullHistory: true,
    });

    session.sock = sock;

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        try {
          const qrDataUrl = await QRCode.toDataURL(qr, {
            margin: 2,
            scale: 8,
            color: {
              dark: '#000000',
              light: '#ffffff',
            },
          });
          session.qrCode = qrDataUrl;
          session.status = 'connecting';
          session.lastUpdated = new Date().toISOString();
        } catch (qrErr) {
          console.error('[Baileys] Error generating QR data URL:', qrErr);
        }
      }

      if (connection === 'open') {
        const rawId = sock.user?.id || '';
        const phone = rawId.split(':')[0] || rawId.split('@')[0];

        // 1. Resolve real profile display name
        const credsMe = (sock.authState?.creds as unknown as { me?: { name?: string } })?.me;
        let name = sock.user?.name || credsMe?.name || (sock.user as unknown as { verifiedName?: string })?.verifiedName;
        if (!name || name.trim() === '') {
          name = `WhatsApp (${phone})`;
        }

        // 2. Fetch real WhatsApp profile picture (avatar)
        let profilePicUrl: string | null = null;
        try {
          const pic = await sock.profilePictureUrl(sock.user?.id || `${phone}@s.whatsapp.net`, 'image');
          profilePicUrl = pic || null;
        } catch {
          profilePicUrl = null;
        }

        // 3. Fetch real WhatsApp profile status ("Recado")
        let profileStatus: string | null = null;
        try {
          const statusObj = (await sock.fetchStatus(sock.user?.id || `${phone}@s.whatsapp.net`)) as { status?: string } | undefined;
          profileStatus = statusObj?.status || null;
        } catch {
          profileStatus = null;
        }

        session.status = 'connected';
        session.qrCode = null;
        session.phoneNumber = phone;
        session.userName = name || null;
        session.profilePicUrl = profilePicUrl;
        session.profileStatus = profileStatus;
        session.lastUpdated = new Date().toISOString();
        session.error = null;

        console.log(`[Baileys] Successfully connected account ${accountId} (Phone: ${phone}, Name: ${name}, Avatar: ${Boolean(profilePicUrl)})`);

        // Upsert connection in database
        try {
          const admin = getAdminClient();
          if (admin) {
            // 1. Deactivate ALL other connections for this account to guarantee exactly one active connection
            await admin
              .from('whatsapp_connections')
              .update({ is_active: false, updated_at: new Date().toISOString() })
              .eq('account_id', accountId);

            // 2. Look for existing Baileys connection
            const { data: existingBaileys } = await admin
              .from('whatsapp_connections')
              .select('id')
              .eq('account_id', accountId)
              .filter('provider_config->>driver', 'eq', 'baileys')
              .limit(1);

            const targetId = existingBaileys?.[0]?.id;

            const configPayload = {
              driver: 'baileys',
              profilePicUrl,
              profileStatus,
              userName: name,
              phone,
            };

            if (targetId) {
              await admin
                .from('whatsapp_connections')
                .update({
                  provider: 'uazapi',
                  display_name: name,
                  phone_number: phone,
                  is_active: true,
                  status: 'connected',
                  provider_config: configPayload,
                  last_sync_at: new Date().toISOString(),
                  updated_at: new Date().toISOString(),
                })
                .eq('id', targetId);
            } else {
              await admin.from('whatsapp_connections').insert({
                account_id: accountId,
                provider: 'uazapi',
                display_name: name,
                phone_number: phone,
                is_active: true,
                status: 'connected',
                provider_config: configPayload,
                created_at: new Date().toISOString(),
                updated_at: new Date().toISOString(),
              });
            }
          }
        } catch (dbErr) {
          console.error('[Baileys] Error syncing connection to DB:', dbErr);
        }
      }

      if (connection === 'close') {
        const statusCode = (lastDisconnect?.error as { output?: { statusCode?: number } })?.output?.statusCode;
        const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

        console.log(`[Baileys] Connection closed. Status code: ${statusCode}. Reconnecting: ${shouldReconnect}`);

        if (statusCode === DisconnectReason.loggedOut) {
          session.status = 'disconnected';
          session.qrCode = null;
          session.sock = null;
          session.lastUpdated = new Date().toISOString();

          // Remove credentials on disk
          try {
            fs.rmSync(sessionPath, { recursive: true, force: true });
          } catch {}

          // Update DB status
          try {
            const admin = getAdminClient();
            if (admin) {
              await admin
                .from('whatsapp_connections')
                .update({ status: 'disconnected', is_active: false, updated_at: new Date().toISOString() })
                .eq('account_id', accountId)
                .filter('provider_config->>driver', 'eq', 'baileys');
            }
          } catch {}
        } else if (shouldReconnect) {
          // Reconnect with exponential backoff
          setTimeout(() => {
            void connectBaileys(accountId);
          }, 3000);
        }
      }
    });

    // 1. Process genuine WhatsApp Business contacts from Baileys
    async function syncBaileysContactsList(
      rawContacts: Array<{ id?: string; notify?: string; name?: string; verifiedName?: string }>,
      ownerUserId: string
    ) {
      if (!rawContacts || !Array.isArray(rawContacts) || rawContacts.length === 0) return;
      const adminClient = getAdminClient();
      if (!adminClient) return;

      for (const contact of rawContacts) {
        const jid = String(contact?.id || '');
        if (!jid || !isRealWhatsAppContact(jid)) continue;

        const rawPhone = jid.split('@')[0].replace(/\D/g, '');
        if (!isRealWhatsAppContact(rawPhone)) continue;

        const formattedPhone = formatUazApiNumber(rawPhone);
        const pushName = String(
          contact.notify || contact.name || contact.verifiedName || `+${formattedPhone}`
        ).trim();

        try {
          await adminClient.rpc('find_or_create_contact', {
            p_account_id: accountId,
            p_user_id: ownerUserId,
            p_phone: formattedPhone,
            p_name: pushName,
          });
        } catch {}
      }
    }

    // 2. Process genuine WhatsApp Business chats (1-to-1 conversations) from Baileys
    async function syncBaileysChatsList(
      rawChats: Array<Record<string, unknown>>,
      ownerUserId: string,
      connectionId: string
    ) {
      if (!rawChats || !Array.isArray(rawChats) || rawChats.length === 0) return;
      const adminClient = getAdminClient();
      if (!adminClient) return;

      const validChats = rawChats.filter((c) => {
        const jid = String(c?.id || '');
        if (!jid || !isRealWhatsAppContact(jid)) return false;
        const rawPhone = jid.split('@')[0].replace(/\D/g, '');
        return isRealWhatsAppContact(rawPhone);
      });

      if (validChats.length === 0) return;

      console.log(`[Baileys] Syncing ${validChats.length} genuine WhatsApp Business chats for account ${accountId}`);

      const [{ data: existingContacts }, { data: existingConvs }] = await Promise.all([
        adminClient.from('contacts').select('id, phone').eq('account_id', accountId),
        adminClient.from('conversations').select('id, contact_id, last_message_at, last_message_text').eq('account_id', accountId),
      ]);

      const contactMap = new Map<string, string>();
      for (const c of existingContacts || []) {
        if (c.phone) contactMap.set(c.phone, c.id);
      }

      const convMap = new Map<string, { id: string; last_message_at: string | null; last_message_text: string | null }>();
      for (const conv of existingConvs || []) {
        if (conv.contact_id) {
          convMap.set(conv.contact_id, {
            id: conv.id,
            last_message_at: conv.last_message_at,
            last_message_text: conv.last_message_text,
          });
        }
      }

      for (const chat of validChats) {
        try {
          const rawPhone = String(chat.id).split('@')[0].replace(/\D/g, '');
          const formattedPhone = formatUazApiNumber(rawPhone);
          const contactName = String(
            chat.name ||
            chat.verifiedName ||
            chat.notify ||
            `+${formattedPhone}`
          ).trim();

          // A. Contact resolution
          let contactId = contactMap.get(formattedPhone);
          if (!contactId) {
            const { data: createdContactId, error: contactErr } = await adminClient.rpc('find_or_create_contact', {
              p_account_id: accountId,
              p_user_id: ownerUserId,
              p_phone: formattedPhone,
              p_name: contactName,
            });
            if (contactErr || !createdContactId) continue;
            contactId = String(createdContactId);
            contactMap.set(formattedPhone, contactId);
          }

          // B. Conversation resolution
          let convMeta = convMap.get(contactId);
          if (!convMeta) {
            const { data: createdConvId, error: convErr } = await adminClient.rpc('find_or_create_conversation', {
              p_account_id: accountId,
              p_user_id: ownerUserId,
              p_contact_id: contactId,
              p_connection_id: connectionId,
            });
            if (convErr || !createdConvId) continue;
            convMeta = {
              id: String(createdConvId),
              last_message_at: null,
              last_message_text: null,
            };
            convMap.set(contactId, convMeta);
          }

          // C. Timestamp & Unread count update
          const rawTs = (chat.conversationTimestamp || chat.lastMessageRecvTimestamp) as number | string | undefined;
          const tsNum = typeof rawTs === 'number' ? rawTs : Number(rawTs);
          const tsIso = tsNum > 0
            ? new Date(tsNum > 10000000000 ? tsNum : tsNum * 1000).toISOString()
            : null;

          const unread = Number(chat.unreadCount) || 0;
          const updates: Record<string, unknown> = {};

          if (tsIso && (!convMeta.last_message_at || new Date(tsIso) > new Date(convMeta.last_message_at))) {
            updates.last_message_at = tsIso;
          }
          if (unread > 0) {
            updates.unread_count = unread;
          }
          if (!convMeta.last_message_text) {
            updates.last_message_text = '[Histórico do WhatsApp]';
          }

          if (Object.keys(updates).length > 0) {
            await adminClient.from('conversations').update(updates).eq('id', convMeta.id);
          }
        } catch (e) {
          console.error('[Baileys] Error syncing chat item:', chat.id, e);
        }
      }
    }

    // History sync from WhatsApp on connection
    sock.ev.on('messaging-history.set', async ({ chats, contacts, messages: historyMessages }) => {
      console.log(`[Baileys] Received history sync for account ${accountId}: ${chats?.length || 0} chats, ${contacts?.length || 0} contacts, ${historyMessages?.length || 0} messages`);

      const adminClient = getAdminClient();
      let connRow = null;
      let ownerUserId = '';

      if (adminClient) {
        const [{ data: conns }, { data: acc }] = await Promise.all([
          adminClient
            .from('whatsapp_connections')
            .select('id, account_id, display_name, provider_config')
            .eq('account_id', accountId)
            .filter('provider_config->>driver', 'eq', 'baileys')
            .limit(1),
          adminClient.from('accounts').select('owner_user_id').eq('id', accountId).single(),
        ]);

        connRow = conns?.[0] || {
          id: `baileys-${accountId}`,
          account_id: accountId,
          display_name: session.userName || 'WhatsApp QR Code',
          provider_config: { driver: 'baileys' },
        };
        ownerUserId = acc?.owner_user_id || '';
      }

      const connectionId = connRow?.id || `baileys-${accountId}`;

      // 1. Process contacts
      if (contacts && contacts.length > 0 && ownerUserId) {
        await syncBaileysContactsList(contacts, ownerUserId);
      }

      // 2. Process genuine chats
      if (chats && chats.length > 0 && ownerUserId) {
        await syncBaileysChatsList(chats as Array<Record<string, unknown>>, ownerUserId, connectionId);
      }

      // 3. Process history messages in batches of 25
      if (historyMessages && historyMessages.length > 0) {
        const genuineMsgs = historyMessages.filter((msg) => {
          const jid = msg?.key?.remoteJid;
          return jid && isRealWhatsAppContact(jid);
        });

        console.log(`[Baileys] Processing ${genuineMsgs.length} genuine history messages`);
        const { processUazApiEvent } = await import('@/lib/whatsapp/uazapi-event-processor');
        const BATCH_SIZE = 25;
        for (let i = 0; i < genuineMsgs.length; i += BATCH_SIZE) {
          const batch = genuineMsgs.slice(i, i + BATCH_SIZE);
          await Promise.all(
            batch.map((msg) =>
              processUazApiEvent(
                {
                  event: 'messages',
                  data: msg,
                },
                connRow
              ).catch((err) => {
                console.error('[Baileys] Error processing history message:', err);
              })
            )
          );
        }
      }
    });

    // Handle streamed chat updates from WhatsApp
    sock.ev.on('chats.upsert', async (newChats) => {
      const adminClient = getAdminClient();
      if (!adminClient) return;
      const { data: acc } = await adminClient.from('accounts').select('owner_user_id').eq('id', accountId).single();
      const ownerUserId = acc?.owner_user_id;
      if (!ownerUserId) return;

      const { data: conn } = await adminClient
        .from('whatsapp_connections')
        .select('id')
        .eq('account_id', accountId)
        .filter('provider_config->>driver', 'eq', 'baileys')
        .maybeSingle();

      const connectionId = conn?.id || `baileys-${accountId}`;
      await syncBaileysChatsList(newChats as Array<Record<string, unknown>>, ownerUserId, connectionId);
    });

    // Handle streamed contact updates from WhatsApp
    sock.ev.on('contacts.upsert', async (newContacts) => {
      const adminClient = getAdminClient();
      if (!adminClient) return;
      const { data: acc } = await adminClient.from('accounts').select('owner_user_id').eq('id', accountId).single();
      const ownerUserId = acc?.owner_user_id;
      if (!ownerUserId) return;

      await syncBaileysContactsList(newContacts, ownerUserId);
    });

    // Handle presence updates (typing / composing) from contacts
    sock.ev.on('presence.update', async (update) => {
      const remoteJid = update?.id;
      if (!remoteJid || !isRealWhatsAppContact(remoteJid)) return;
      const cleanPhone = remoteJid.split('@')[0].replace(/\D/g, '');
      const formattedPhone = formatUazApiNumber(cleanPhone);

      const presences = Object.values(update.presences || {});
      const isTyping = presences.some(
        (p) => p.lastKnownPresence === 'composing' || p.lastKnownPresence === 'recording'
      );

      const adminClient = getAdminClient();
      if (!adminClient) return;

      const { data: contactRow } = await adminClient
        .from('contacts')
        .select('id')
        .eq('account_id', accountId)
        .eq('phone', formattedPhone)
        .maybeSingle();

      if (contactRow) {
        const { data: convRow } = await adminClient
          .from('conversations')
          .select('id')
          .eq('contact_id', contactRow.id)
          .eq('account_id', accountId)
          .maybeSingle();

        if (convRow) {
          notifyClientPresence(convRow.id, isTyping);
        }
      }
    });

    // Handle inbound and outbound messages
    sock.ev.on('messages.upsert', async ({ messages: rawMessages }) => {
      const adminClient = getAdminClient();
      let connRow = null;
      if (adminClient) {
        const { data } = await adminClient
          .from('whatsapp_connections')
          .select('id, account_id, display_name, provider_config')
          .eq('account_id', accountId)
          .filter('provider_config->>driver', 'eq', 'baileys')
          .limit(1);
        connRow = data?.[0] || {
          id: `baileys-${accountId}`,
          account_id: accountId,
          display_name: session.userName || 'WhatsApp QR Code',
          provider_config: { driver: 'baileys' },
        };
      }

      const { processUazApiEvent } = await import('@/lib/whatsapp/uazapi-event-processor');
      for (const msg of rawMessages) {
        const jid = msg.key?.remoteJid;
        if (!jid || !isRealWhatsAppContact(jid)) continue;

        try {
          await processUazApiEvent(
            {
              event: 'messages',
              data: msg,
            },
            connRow
          );
        } catch (procErr) {
          console.error('[Baileys] Error processing message upsert:', procErr);
        }
      }
    });

    // Wait up to 10s for the initial QR Code to be produced
    const startTime = Date.now();
    while (Date.now() - startTime < 10000) {
      if (session.qrCode || session.status === 'connected') {
        console.log(`[Baileys] Socket ready after ${Date.now() - startTime}ms (Status: ${session.status}, QR: ${!!session.qrCode})`);
        break;
      }
      await new Promise((r) => setTimeout(r, 200));
    }

    return {
      accountId,
      status: session.status,
      qrCode: session.qrCode,
      pairingCode: session.pairingCode,
      phoneNumber: session.phoneNumber,
      userName: session.userName,
      lastUpdated: session.lastUpdated,
    };
  } catch (err: unknown) {
    console.error('[Baileys] Error initializing socket:', err);
    session.status = 'disconnected';
    session.error = err instanceof Error ? err.message : String(err);
    return {
      accountId,
      status: 'disconnected',
      qrCode: null,
      pairingCode: null,
      phoneNumber: null,
      userName: null,
      lastUpdated: new Date().toISOString(),
      error: session.error,
    };
  }
}

/**
 * Request an 8-character pairing code for phone number authentication
 */
export async function requestBaileysPairingCode(
  accountId: string,
  phoneNumber: string
): Promise<{ success: boolean; pairingCode?: string; error?: string }> {
  const cleanPhone = phoneNumber.replace(/\D/g, '');
  if (!cleanPhone || cleanPhone.length < 10) {
    return {
      success: false,
      error: 'Número inválido. Informe o código do país + DDD + número (ex: 5511999998888).',
    };
  }

  let active = sessions.get(accountId);

  if (active && active.sock && active.status === 'connected') {
    return { success: false, error: 'WhatsApp já está conectado nesta conta.' };
  }

  // If no active socket or disconnected, initialize one
  if (!active || !active.sock || active.status !== 'connecting') {
    await connectBaileys(accountId);
    active = sessions.get(accountId);
  }

  if (!active?.sock) {
    return { success: false, error: 'Falha ao inicializar socket do WhatsApp.' };
  }

  // Wait for the socket connection to be ready for pairing code
  for (let i = 0; i < 20; i++) {
    try {
      const code = await active.sock.requestPairingCode(cleanPhone);
      if (code) {
        active.pairingCode = code;
        active.lastUpdated = new Date().toISOString();
        return { success: true, pairingCode: code };
      }
    } catch {
      await new Promise((r) => setTimeout(r, 250));
    }
  }

  return {
    success: false,
    error: 'Tempo limite ao gerar código. Tente novamente em instantes.',
  };
}

/**
 * Disconnect and remove credentials
 */
export async function disconnectBaileys(accountId: string): Promise<void> {
  const session = sessions.get(accountId);
  if (session?.sock) {
    try {
      session.sock.end(undefined);
    } catch {}
  }

  sessions.delete(accountId);

  const sessionPath = path.join(SESSIONS_DIR, accountId);
  try {
    fs.rmSync(sessionPath, { recursive: true, force: true });
  } catch {}

  try {
    const admin = getAdminClient();
    if (admin) {
      await admin
        .from('whatsapp_connections')
        .update({ status: 'disconnected', is_active: false, updated_at: new Date().toISOString() })
        .eq('account_id', accountId);
    }
  } catch {}
}

/**
 * Send text message via active Baileys socket
 */
export async function sendBaileysText(
  accountId: string,
  phoneNumber: string,
  text: string,
  replyMessageId?: string | null
): Promise<{ messageId: string }> {
  let session = sessions.get(accountId);

  // If not currently in memory but credentials exist on disk, attempt reconnect
  if ((!session || session.status !== 'connected' || !session.sock) && hasSavedSession(accountId)) {
    await connectBaileys(accountId);
    session = sessions.get(accountId);
  }

  if (!session?.sock || session.status !== 'connected') {
    throw new Error('WhatsApp não está conectado via QR Code.');
  }

  // Format remote JID: e.g. "5511999999999@s.whatsapp.net"
  const cleanPhone = phoneNumber.replace(/\D/g, '');
  const jid = cleanPhone.includes('@') ? cleanPhone : `${cleanPhone}@s.whatsapp.net`;

  let quoted: proto.IWebMessageInfo | undefined;
  if (replyMessageId) {
    quoted = {
      key: {
        id: replyMessageId,
        remoteJid: jid,
        fromMe: false,
      },
      message: {},
    };
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sendOptions: any = quoted ? { quoted } : undefined;
  const result = await session.sock.sendMessage(jid, { text }, sendOptions);
  return { messageId: result?.key.id || `baileys_${Date.now()}` };
}

/**
 * Send media message via active Baileys socket
 */
export async function sendBaileysMedia(
  accountId: string,
  phoneNumber: string,
  mediaUrl: string,
  mediaType: 'image' | 'video' | 'audio' | 'document',
  caption?: string | null
): Promise<{ messageId: string }> {
  let session = sessions.get(accountId);

  if ((!session || session.status !== 'connected' || !session.sock) && hasSavedSession(accountId)) {
    await connectBaileys(accountId);
    session = sessions.get(accountId);
  }

  if (!session?.sock || session.status !== 'connected') {
    throw new Error('WhatsApp não está conectado via QR Code.');
  }

  const cleanPhone = phoneNumber.replace(/\D/g, '');
  const jid = cleanPhone.includes('@') ? cleanPhone : `${cleanPhone}@s.whatsapp.net`;

  let messageContent: Record<string, unknown> = {};

  if (mediaType === 'image') {
    messageContent = { image: { url: mediaUrl }, caption: caption || undefined };
  } else if (mediaType === 'video') {
    messageContent = { video: { url: mediaUrl }, caption: caption || undefined };
  } else if (mediaType === 'audio') {
    messageContent = { audio: { url: mediaUrl }, ptt: true };
  } else {
    messageContent = {
      document: { url: mediaUrl },
      caption: caption || undefined,
      fileName: 'arquivo',
      mimetype: 'application/octet-stream',
    };
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const result = await session.sock.sendMessage(jid, messageContent as any);
  return { messageId: result?.key.id || `baileys_${Date.now()}` };
}

/**
 * Check if the account is currently connected to Baileys
 */
export function isBaileysConnected(accountId: string): boolean {
  const session = sessions.get(accountId);
  return Boolean(session?.sock && session.status === 'connected');
}

/**
 * Send presence update via Baileys (composing, recording, paused)
 */
export async function sendBaileysPresence(
  accountId: string,
  phoneNumber: string,
  presence: 'composing' | 'recording' | 'paused'
): Promise<boolean> {
  const session = sessions.get(accountId);
  if (!session?.sock || session.status !== 'connected') {
    return false;
  }

  try {
    const cleanPhone = phoneNumber.replace(/\D/g, '');
    const jid = cleanPhone.includes('@') ? cleanPhone : `${cleanPhone}@s.whatsapp.net`;
    await session.sock.sendPresenceUpdate(presence, jid);
    return true;
  } catch (err) {
    console.warn('[baileys] sendPresence error:', err);
    return false;
  }
}

/**
 * Mark message as read via Baileys
 */
export async function markBaileysRead(
  accountId: string,
  phoneNumber: string,
  messageId: string
): Promise<boolean> {
  const session = sessions.get(accountId);
  if (!session?.sock || session.status !== 'connected') {
    return false;
  }

  try {
    const cleanPhone = phoneNumber.replace(/\D/g, '');
    const jid = cleanPhone.includes('@') ? cleanPhone : `${cleanPhone}@s.whatsapp.net`;
    await session.sock.readMessages([
      {
        remoteJid: jid,
        id: messageId,
        fromMe: false,
      },
    ]);
    return true;
  } catch (err) {
    console.warn('[baileys] markRead error:', err);
    return false;
  }
}

