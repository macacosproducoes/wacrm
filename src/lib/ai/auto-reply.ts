import { supabaseAdmin } from './admin-client'
import { loadAiConfig } from './config'
import { buildConversationContext } from './context'
import { retrieveKnowledge } from './knowledge'
import { generateReply } from './generate'
import { buildSystemPrompt } from './defaults'
import { buildHandoffSummary } from './handoff'
import { logAiUsage } from './usage'
import { latestUserMessage } from './query'
import { engineSendText } from '@/lib/flows/meta-send'
import { decrypt } from '@/lib/whatsapp/encryption'
import { sendUazApiText, sendUazApiMedia, normalizeBaseUrl } from '@/lib/whatsapp/uazapi-client'
import { sendBaileysText, isBaileysConnected } from '@/lib/whatsapp/baileys/baileys-manager'
import { sendWhatsAppPresence } from '@/lib/whatsapp/unified-presence'
import { checkRateLimit, RATE_LIMITS } from '@/lib/rate-limit'
import { whatsappBus } from '@/lib/whatsapp/whatsapp-bus'
import { autoReplyDebouncer, AutoReplyDebounceArgs } from './auto-reply-debouncer'

export interface DispatchArgs extends AutoReplyDebounceArgs {
  /** If true, bypasses the debounce window and executes immediately. */
  immediate?: boolean;
  debounceMs?: number;
}

/**
 * Execute the full AI reply generation and delivery pipeline for a conversation.
 * Handles context preparation, knowledge retrieval, presence, LLM generation,
 * slot claiming, message delivery, and status updates.
 */
export async function executeAiReplyProcess(args: AutoReplyDebounceArgs): Promise<void> {
  const { accountId, conversationId, contactId, configOwnerUserId } = args

  try {
    const db = supabaseAdmin()

    const { data: conv, error: convErr } = await db
      .from('conversations')
      .select('contact_id, assigned_agent_id, ai_autoreply_disabled, ai_reply_count')
      .eq('id', conversationId)
      .maybeSingle()
    if (convErr || !conv) return

    // If AI is explicitly turned OFF for this conversation, stand down
    if (conv.ai_autoreply_disabled === true) {
      console.log(`[ai auto-reply] SKIP: AI auto-reply disabled for conversation ${conversationId}`)
      return
    }

    const config = await loadAiConfig(db, accountId)
    if (!config) return

    // When "IA Ativa nesta conversa" is turned ON (ai_autoreply_disabled === false),
    // the AI MUST ALWAYS respond to incoming customer messages without fail!
    const isExplicitlyEnabledOnThread = conv.ai_autoreply_disabled === false

    if (!isExplicitlyEnabledOnThread) {
      if (conv.assigned_agent_id) return // human owns thread unless IA Ativa is explicitly ON
      if (!config.autoReplyEnabled) return

      const { data: autoResponders } = await db
        .from('automations')
        .select('id')
        .eq('account_id', accountId)
        .eq('is_active', true)
        .in('trigger_type', ['new_message_received', 'keyword_match'])
        .limit(1)
      if (autoResponders && autoResponders.length > 0) return
    } else {
      console.log(`[ai auto-reply] FORCE: "IA Ativa nesta conversa" is ON for conversation ${conversationId}`)
    }

    const targetContactId = contactId || (conv as unknown as { contact_id?: string }).contact_id || ''

    const isUncapped = !config.autoReplyMaxPerConversation || config.autoReplyMaxPerConversation >= 20

    if (
      !isUncapped &&
      conv.ai_reply_count >= config.autoReplyMaxPerConversation
    ) {
      return
    }

    // 1. STRICT GROUP VETO: Verify contact is not a WhatsApp group
    const { data: contact } = await db
      .from('contacts')
      .select('phone, name')
      .eq('id', targetContactId)
      .maybeSingle()

    const cleanPhone = (contact?.phone || '').replace(/\D/g, '')
    if (
      cleanPhone.startsWith('120363') ||
      cleanPhone.length > 15 ||
      (contact?.phone || '').includes('@g.us')
    ) {
      console.log('[ai auto-reply] VETO: skipping group conversation:', conversationId, contact?.phone)
      return
    }

    const messages = await buildConversationContext(db, conversationId)
    if (messages.length === 0) return
    // Auto-reply only responds to customer turns — if the latest message is already
    // from an agent or bot, stand down to prevent replying to ourselves.
    if (messages[messages.length - 1].role === 'assistant') return

    // DUPLICATE GUARD: Check if the latest customer message was already
    // processed by a previous AI run. This prevents duplicate replies when
    // multiple sources (webhook, poller, sync) dispatch for the same turn.
    const { data: latestCustomerMsg } = await db
      .from('messages')
      .select('ai_processed_at')
      .eq('conversation_id', conversationId)
      .eq('sender_type', 'customer')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()
    if (latestCustomerMsg?.ai_processed_at) {
      console.log(`[ai auto-reply] SKIP: latest customer message already processed at ${latestCustomerMsg.ai_processed_at} for conv ${conversationId}`)
      return
    }

    // 2. STRICT REACTION & EMOJI VETO: Never reply to emoji reactions or system placeholders
    const lastUserTurn = (messages[messages.length - 1].content || '').trim()
    const isEmojiOnly = /^(\p{Extended_Pictographic}|\p{Emoji_Presentation}|\s)+$/u.test(lastUserTurn)
    const isIgnoredText =
      lastUserTurn === '[Mensagem recebida]' ||
      lastUserTurn === '[Reação]' ||
      lastUserTurn.startsWith('[Undecryptable]')

    if (!lastUserTurn || isEmojiOnly || isIgnoredText) {
      console.log('[ai auto-reply] VETO: skipping reaction or emoji-only customer turn:', lastUserTurn)
      if (contact?.phone) {
        void sendWhatsAppPresence({
          accountId,
          phoneNumber: contact.phone,
          presence: 'paused',
        })
      }
      return
    }

    // ⚡ Real-time presence: show "digitando..." on customer's phone
    // while the AI model is processing and generating the answer
    if (contact?.phone) {
      void sendWhatsAppPresence({
        accountId,
        phoneNumber: contact.phone,
        presence: 'composing',
        delayMs: 15000,
      })
    }

    // Account-wide throttle on the shared BYO key.
    const acctLimit = checkRateLimit(
      `ai-autoreply:${accountId}`,
      RATE_LIMITS.aiAutoReplyAccount,
    )
    if (!acctLimit.success) {
      console.warn(
        `[ai auto-reply] account ${accountId} hit the per-account rate limit — skipping this inbound.`,
      )
      return
    }

    // Ground the reply in the account's knowledge base (best-effort).
    // Using the combined/grouped lastUserTurn gives complete context!
    const knowledge = await retrieveKnowledge(
      db,
      accountId,
      config,
      latestUserMessage(messages),
    )

    // Fetch active Quick Replies & Audio Library for this account
    let quickReplies: Array<{
      id: string
      title: string
      shortcut?: string | null
      kind: string
      content_text?: string | null
      media_url?: string | null
    }> = []

    try {
      const { data: qrData } = await db
        .from('quick_replies')
        .select('*')
        .eq('account_id', accountId)
        .eq('is_active', true)

      if (Array.isArray(qrData)) {
        quickReplies = qrData.map((row: Record<string, unknown>) => {
          const meta = ((row.interactive_payload as Record<string, unknown>) || {}) as Record<string, unknown>
          return {
            id: String(row.id),
            title: String(row.title || ''),
            shortcut: (row.shortcut as string) || (meta.shortcut as string) || null,
            kind: String(meta.type || row.kind || 'text'),
            content_text: (row.content_text as string) || null,
            media_url: (row.media_url as string) || (meta.media_url as string) || null,
          }
        })
      }
    } catch {
      // non-blocking
    }

    const systemPrompt = buildSystemPrompt({
      userPrompt: config.systemPrompt,
      mode: 'auto_reply',
      knowledge,
      quickReplies,
      contactInfo: {
        name: contact?.name || null,
        phone: contact?.phone || null,
      },
    })

    console.log(
      `[ai auto-reply] Calling AI model ${config.model} for conversation ${conversationId}. Prompt turns: ${messages.length}.`
    )

    const { text, handoff, usage } = await generateReply({
      config,
      systemPrompt,
      messages,
    })

    // Record token spend on the account's BYO key.
    void logAiUsage(db, {
      accountId,
      conversationId,
      mode: 'auto_reply',
      provider: config.provider,
      model: config.model,
      usage,
    })

    // If an explicit human handoff was triggered:
    if (handoff) {
      if (contact?.phone) {
        void sendWhatsAppPresence({
          accountId,
          phoneNumber: contact.phone,
          presence: 'paused',
        })
      }

      const summary = buildHandoffSummary({
        messages,
        replyCount: conv.ai_reply_count ?? 0,
      })
      const update: Record<string, unknown> = {
        ai_handoff_summary: summary,
      }
      if (config.handoffAgentId && !conv.assigned_agent_id) {
        update.assigned_agent_id = config.handoffAgentId
      }
      await db.from('conversations').update(update).eq('id', conversationId)
      return
    }

    // If no text was returned due to transient upstream issues, leave thread active
    if (!text) {
      if (contact?.phone) {
        void sendWhatsAppPresence({
          accountId,
          phoneNumber: contact.phone,
          presence: 'paused',
        })
      }
      console.warn(`[ai auto-reply] No text returned from model for conv ${conversationId} — leaving thread active.`)
      return
    }

    // 🎙️ Humanization: realistic "digitando..." vs "gravando áudio..."
    if (contact?.phone && text) {
      const isAudio =
        /^\[(áudio|audio|gravando|voz)\]/i.test(text.trim()) ||
        text.toLowerCase().includes('[áudio]') ||
        text.toLowerCase().includes('[audio]') ||
        text.trim().startsWith('🎙️')

      const presenceType = isAudio ? 'recording' : 'composing'

      void sendWhatsAppPresence({
        accountId,
        phoneNumber: contact.phone,
        presence: presenceType,
        delayMs: 10000,
      })

      if (isAudio && process.env.NODE_ENV !== 'test') {
        await new Promise((resolve) => setTimeout(resolve, 1200))
      }
    }

    // Atomically claim a reply slot: the cap check + increment happen in
    // one UPDATE, so concurrent inbounds can never overshoot the cap.
    const effectiveMaxReplies = isUncapped ? 999999 : config.autoReplyMaxPerConversation

    const { data: claimed, error: claimErr } = await db.rpc(
      'claim_ai_reply_slot',
      {
        conversation_id: conversationId,
        max_replies: effectiveMaxReplies,
      },
    )
    if (claimErr) {
      console.error('[ai auto-reply] claim_ai_reply_slot failed:', claimErr)
    }
    if (!isUncapped && claimed !== true) return

    // 1. Direct Baileys socket connection (highest responsiveness, zero latency)
    if (isBaileysConnected(accountId) && contact?.phone) {
      try {
        const sendRes = await sendBaileysText(accountId, contact.phone, text)

        const cleanMsgId = String(sendRes.messageId || '').includes(':')
          ? String(sendRes.messageId).split(':').pop()!
          : String(sendRes.messageId || `bot_${Date.now()}`)

        const botMsgRow = {
          conversation_id: conversationId,
          sender_type: 'bot' as const,
          content_type: 'text' as const,
          content_text: text,
          message_id: cleanMsgId,
          status: 'sent' as const,
          ai_generated: true,
          created_at: new Date().toISOString(),
        }

        const { data: insertedMsg } = await db.from('messages').insert(botMsgRow).select('id, created_at').maybeSingle()

        await db.rpc('update_conversation_with_message', {
          p_conversation_id: conversationId,
          p_message_text: text,
          p_message_timestamp: botMsgRow.created_at,
          p_is_inbound: false,
        })

        whatsappBus.emitInboxEvent({
          accountId,
          conversationId,
          eventType: 'INSERT',
          message: {
            id: insertedMsg?.id || sendRes.messageId,
            ...botMsgRow,
          },
          conversation: {
            id: conversationId,
            last_message_text: text,
            last_message_at: botMsgRow.created_at,
            unread_count: 0,
          },
        })

        // Mark processed customer messages in this turn
        try {
          await db
            .from('messages')
            .update({ ai_processed_at: new Date().toISOString() })
            .eq('conversation_id', conversationId)
            .eq('sender_type', 'customer')
            .is('ai_processed_at', null)
        } catch {
          // non-blocking
        }

        void sendWhatsAppPresence({
          accountId,
          phoneNumber: contact.phone,
          presence: 'paused',
        })
        return
      } catch (baileysErr) {
        console.warn('[ai auto-reply] Baileys send failed, trying other providers:', baileysErr)
      }
    }

    // 2. Active UazAPI connection
    try {
      const { data: uazConn } = await db
        .from('whatsapp_connections')
        .select('*')
        .eq('account_id', accountId)
        .eq('provider', 'uazapi')
        .eq('is_active', true)
        .maybeSingle()

      if (uazConn) {
        const config = (uazConn.provider_config || {}) as Record<string, string>
        let token = ''
        try {
          token = decrypt(config.token)
        } catch {
          token = config.token || ''
        }

        if (token && contact?.phone) {
          const baseUrl = normalizeBaseUrl(config.base_url)
          const sendRes = await sendUazApiText(baseUrl, token, {
            number: contact.phone,
            text,
          })

          const cleanMsgId = String(sendRes.messageId || '').includes(':')
            ? String(sendRes.messageId).split(':').pop()!
            : String(sendRes.messageId || `bot_${Date.now()}`)

          const botMsgRow = {
            conversation_id: conversationId,
            sender_type: 'bot' as const,
            content_type: 'text' as const,
            content_text: text,
            message_id: cleanMsgId,
            status: 'sent' as const,
            ai_generated: true,
            created_at: new Date().toISOString(),
          }

          const { data: insertedMsg } = await db.from('messages').insert(botMsgRow).select('id, created_at').maybeSingle()

          await db.rpc('update_conversation_with_message', {
            p_conversation_id: conversationId,
            p_message_text: text,
            p_message_timestamp: botMsgRow.created_at,
            p_is_inbound: false,
          })

          whatsappBus.emitInboxEvent({
            accountId,
            conversationId,
            eventType: 'INSERT',
            message: {
              id: insertedMsg?.id || sendRes.messageId,
              ...botMsgRow,
            },
            conversation: {
              id: conversationId,
              last_message_text: text,
              last_message_at: botMsgRow.created_at,
              unread_count: 0,
            },
          })

          // Mark processed customer messages in this turn
          try {
            await db
              .from('messages')
              .update({ ai_processed_at: new Date().toISOString() })
              .eq('conversation_id', conversationId)
              .eq('sender_type', 'customer')
              .is('ai_processed_at', null)
          } catch {
            // non-blocking
          }

          void sendWhatsAppPresence({
            accountId,
            phoneNumber: contact.phone,
            presence: 'paused',
          })
          return
        }
      }
    } catch (uazSendErr) {
      console.error('[ai auto-reply] UazAPI send error, checking engineSendText:', uazSendErr)
    }

    // 3. Fallback to Meta Official Cloud API (if configured)
    await engineSendText({
      accountId,
      userId: configOwnerUserId,
      conversationId,
      contactId: targetContactId,
      text,
      aiGenerated: true,
    })

    // Mark processed customer messages in this turn
    try {
      await db
        .from('messages')
        .update({ ai_processed_at: new Date().toISOString() })
        .eq('conversation_id', conversationId)
        .eq('sender_type', 'customer')
        .is('ai_processed_at', null)
    } catch {
      // non-blocking
    }

    if (contact?.phone) {
      void sendWhatsAppPresence({
        accountId,
        phoneNumber: contact.phone,
        presence: 'paused',
      })
    }
  } catch (err) {
    console.error('[ai auto-reply] dispatch failed:', err)
  }
}

// Register default processor in debouncer
autoReplyDebouncer.setDefaultProcessor(executeAiReplyProcess);

/**
 * AI auto-reply for an incoming customer message.
 * Routes through `autoReplyDebouncer` to buffer rapid messages and group them
 * into a single unified intention before querying the AI.
 */
export async function dispatchInboundToAiReply(
  args: DispatchArgs,
): Promise<void> {
  const isTest = process.env.NODE_ENV === 'test' && !process.env.ENABLE_TEST_DEBOUNCE;
  // In serverless deployment (Vercel / API routes), execute pipeline immediately
  // so background timers aren't frozen after the HTTP webhook response returns.
  const isServerless = process.env.VERCEL === '1' || process.env.NEXT_RUNTIME === 'nodejs' || process.env.NODE_ENV === 'production';
  if (args.immediate || isTest || isServerless) {
    return executeAiReplyProcess(args);
  }

  autoReplyDebouncer.enqueue(args, {
    debounceMs: args.debounceMs,
    processor: executeAiReplyProcess,
  });
}
