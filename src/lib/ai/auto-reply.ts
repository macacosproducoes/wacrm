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
import { sendUazApiText, normalizeBaseUrl } from '@/lib/whatsapp/uazapi-client'
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

    const config = await loadAiConfig(db, accountId)
    if (!config || !config.autoReplyEnabled) return

    // Deterministic, user-configured responders win over the LLM — the
    // caller already excludes messages a Flow consumed. Message-level
    // automations (`new_message_received` / `keyword_match`) are
    // dispatched independently for this same inbound and may send their
    // own reply, so if the account has any active one we stand down to
    // avoid double-texting the customer.
    const { data: autoResponders } = await db
      .from('automations')
      .select('id')
      .eq('account_id', accountId)
      .eq('is_active', true)
      .in('trigger_type', ['new_message_received', 'keyword_match'])
      .limit(1)
    if (autoResponders && autoResponders.length > 0) return

    const { data: conv, error: convErr } = await db
      .from('conversations')
      .select('contact_id, assigned_agent_id, ai_autoreply_disabled, ai_reply_count')
      .eq('id', conversationId)
      .maybeSingle()
    if (convErr || !conv) return
    if (conv.assigned_agent_id) return // a human owns this thread
    if (conv.ai_autoreply_disabled) return // handed off / turned off here

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

    const systemPrompt = buildSystemPrompt({
      userPrompt: config.systemPrompt,
      mode: 'auto_reply',
      knowledge,
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
  if (args.immediate || isTest) {
    return executeAiReplyProcess(args);
  }

  autoReplyDebouncer.enqueue(args, {
    debounceMs: args.debounceMs,
    processor: executeAiReplyProcess,
  });
}
