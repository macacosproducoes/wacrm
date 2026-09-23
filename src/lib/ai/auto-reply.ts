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
import { sendWhatsAppPresence } from '@/lib/whatsapp/unified-presence'
import { checkRateLimit, RATE_LIMITS } from '@/lib/rate-limit'
import { whatsappBus } from '@/lib/whatsapp/whatsapp-bus'
import { autoReplyDebouncer, AutoReplyDebounceArgs, getDebounceMs, getMaxWaitMs } from './auto-reply-debouncer'
import { updateConversationWithMessage } from '@/lib/whatsapp/conversation-helpers'
import { recordAiDecision } from './trace'

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
      await recordAiDecision(db, {
        conversationId,
        accountId,
        status: 'skipped',
        reason: 'IA pausada nesta conversa pelo operador',
        steps: [
          {
            name: '1. Recebimento da Mensagem',
            status: 'success',
            detail: 'Mensagem recebida e analisada',
            timestamp: new Date().toISOString(),
          },
          {
            name: '2. Status da IA na Conversa',
            status: 'skipped',
            detail: 'A IA está explicitamente pausada para esta conversa (ai_autoreply_disabled = true)',
            timestamp: new Date().toISOString(),
          },
        ],
      })
      return
    }

    const config = await loadAiConfig(db, accountId)
    if (!config) {
      await recordAiDecision(db, {
        conversationId,
        accountId,
        status: 'error',
        reason: 'Configuração ou chave de IA não encontrada',
        steps: [
          {
            name: '1. Recebimento da Mensagem',
            status: 'success',
            detail: 'Mensagem recebida e analisada',
            timestamp: new Date().toISOString(),
          },
          {
            name: '2. Configuração da Conta',
            status: 'error',
            detail: 'Nenhum provedor de IA ou chave BYO ativa encontrada para a conta',
            timestamp: new Date().toISOString(),
          },
        ],
      })
      return
    }

    // When "IA Ativa nesta conversa" is turned ON (ai_autoreply_disabled === false),
    // the AI responds to incoming customer messages even if an agent was previously assigned or conversation has history.
    const isExplicitlyEnabledOnThread = conv.ai_autoreply_disabled === false

    // Mode: IA APENAS EM CONVERSAS NOVAS (only_new_conversations = true)
    // When enabled, AI responds only to new customer contacts who have no prior conversation history.
    // If the operator explicitly enabled AI on this thread, this filter is bypassed.
    if (config.onlyNewConversations && !isExplicitlyEnabledOnThread) {
      const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
      const { data: oldMsgs } = await db
        .from('messages')
        .select('id, sender_type, created_at, ai_generated')
        .eq('conversation_id', conversationId)
        .or(`created_at.lt.${oneDayAgo},and(sender_type.eq.agent,ai_generated.eq.false)`)
        .limit(1)

      if (oldMsgs && oldMsgs.length > 0) {
        console.log(`[ai auto-reply] SKIP: conversa antiga detectada para conv ${conversationId} — direcionando para atendimento humanizado (only_new_conversations=true)`)
        await recordAiDecision(db, {
          conversationId,
          accountId,
          status: 'skipped',
          reason: 'Conversa antiga com histórico prévio — direcionado para atendimento humanizado',
          steps: [
            {
              name: '1. Recebimento da Mensagem',
              status: 'success',
              detail: 'Mensagem recebida e analisada',
              timestamp: new Date().toISOString(),
            },
            {
              name: '2. Filtro de Conversas Novas',
              status: 'skipped',
              detail: 'Esta conversa possui mensagens antigas ou histórico prévio com atendente. Conforme configuração da conta, contatos com histórico são direcionados exclusivamente para atendimento humanizado.',
              timestamp: new Date().toISOString(),
            },
          ],
        })
        return
      }
    }

    if (!isExplicitlyEnabledOnThread) {
      if (conv.assigned_agent_id) {
        await recordAiDecision(db, {
          conversationId,
          accountId,
          status: 'skipped',
          reason: 'Atendimento humano ativo — IA em espera',
          steps: [
            {
              name: '1. Recebimento da Mensagem',
              status: 'success',
              detail: 'Mensagem recebida e analisada',
              timestamp: new Date().toISOString(),
            },
            {
              name: '2. Atendente Humano',
              status: 'skipped',
              detail: 'Atendente humano atribuído à conversa. A IA fica em espera para evitar conflito com o operador.',
              timestamp: new Date().toISOString(),
            },
          ],
        })
        return // human owns thread unless IA Ativa is explicitly ON
      }
      if (!config.autoReplyEnabled) {
        await recordAiDecision(db, {
          conversationId,
          accountId,
          status: 'skipped',
          reason: 'Auto-resposta desativada nas configurações gerais',
          steps: [
            {
              name: '1. Recebimento da Mensagem',
              status: 'success',
              detail: 'Mensagem recebida e analisada',
              timestamp: new Date().toISOString(),
            },
            {
              name: '2. Chave Geral de Auto-resposta',
              status: 'skipped',
              detail: 'Auto-resposta geral desligada nas configurações da conta.',
              timestamp: new Date().toISOString(),
            },
          ],
        })
        return
      }

      const { data: autoResponders } = await db
        .from('automations')
        .select('id')
        .eq('account_id', accountId)
        .eq('is_active', true)
        .in('trigger_type', ['new_message_received', 'keyword_match'])
        .limit(1)
      if (autoResponders && autoResponders.length > 0) {
        await recordAiDecision(db, {
          conversationId,
          accountId,
          status: 'skipped',
          reason: 'Automação ativa tem prioridade sobre a IA',
          steps: [
            {
              name: '1. Recebimento da Mensagem',
              status: 'success',
              detail: 'Mensagem recebida e analisada',
              timestamp: new Date().toISOString(),
            },
            {
              name: '2. Concorrência de Automações',
              status: 'skipped',
              detail: 'Existe uma automação de palavras-chave ou fluxo prioritário em execução.',
              timestamp: new Date().toISOString(),
            },
          ],
        })
        return
      }
    } else {
      console.log(`[ai auto-reply] FORCE: "IA Ativa nesta conversa" is ON for conversation ${conversationId}`)
    }

    const targetContactId = contactId || (conv as unknown as { contact_id?: string }).contact_id || ''

    const isUncapped =
      isExplicitlyEnabledOnThread ||
      !config.autoReplyMaxPerConversation ||
      config.autoReplyMaxPerConversation >= 20

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

    // Auto-reply only responds to customer turns — unless this execution is explicitly
    // following up an automated order confirmation (where the system just delivered the photo).
    const isOrderFollowup = Boolean(args.isOrderFollowup)
    if (!isOrderFollowup && messages[messages.length - 1].role === 'assistant') return

    // DUPLICATE GUARD: Check if the latest customer message was already
    // processed by a previous AI run. This prevents duplicate replies when
    // multiple sources (webhook, poller, sync) dispatch for the same turn.
    if (!isOrderFollowup) {
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

      // Pre-claim all unprocessed customer messages in this turn immediately so concurrent pollers
      // or workers never race or produce duplicate replies during LLM generation and network calls
      await db
        .from('messages')
        .update({ ai_processed_at: new Date().toISOString() })
        .eq('conversation_id', conversationId)
        .eq('sender_type', 'customer')
        .is('ai_processed_at', null)
    }

    // For order follow-up, append an instructional user turn so chat models have a valid
    // final user turn and know precisely to follow up the delivered photo.
    if (isOrderFollowup) {
      messages.push({
        role: 'user',
        content: '(A foto de confirmação de pedido acima acabou de ser gerada e entregue no WhatsApp do cliente. Envie agora uma mensagem curta, cordial e simpática confirmando o recebimento do pedido e perguntando se ele prefere finalizar via Pix ou Cartão de Crédito.)',
      })
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
      await recordAiDecision(db, {
        conversationId,
        accountId,
        status: 'skipped',
        reason: 'Mensagem descartada (apenas emoji ou reação)',
        steps: [
          {
            name: '1. Recebimento da Mensagem',
            status: 'success',
            detail: 'Mensagem recebida do cliente',
            timestamp: new Date().toISOString(),
          },
          {
            name: '2. Filtro de Conteúdo',
            status: 'skipped',
            detail: `Mensagem contém apenas emoji ou reação (${lastUserTurn || 'vazio'})`,
            timestamp: new Date().toISOString(),
          },
        ],
      })
      if (contact?.phone) {
        void sendWhatsAppPresence({
          accountId,
          phoneNumber: contact.phone,
          presence: 'paused',
        })
      }
      return
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
      media_duration?: number | null
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
            media_duration: (row.media_duration as number) || (meta.media_duration as number) || null,
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

    if (contact?.phone) {
      void sendWhatsAppPresence({
        accountId,
        phoneNumber: contact.phone,
        presence: 'composing',
        delayMs: 10000,
      })
    }

    let { text, handoff, usage } = await generateReply({
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
      if (!isExplicitlyEnabledOnThread && config.handoffAgentId && !conv.assigned_agent_id) {
        update.assigned_agent_id = config.handoffAgentId
      }
      await db.from('conversations').update(update).eq('id', conversationId)

      // When "IA Ativa nesta conversa" is explicitly enabled, don't leave customer in silence
      if (!text && isExplicitlyEnabledOnThread) {
        text = 'Vou verificar essa informação para você agora mesmo! Um instante, por favor 😊'
      } else {
        return
      }
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

    // 🎙️ / 💬 Humanization: Send live presence to WhatsApp BEFORE sending
    let isAudioReply = false
    let audioUrlToSend: string | null = null
    let audioDurationSec = 5
    let textToSend = text

    // Check if the AI referenced a saved Quick Reply (e.g. [quick_reply: /audio_1] or ID)
    const qrMatch = text.match(/\[quick_reply:\s*([^\]]+)\]/i)
    if (qrMatch) {
      const qTarget = qrMatch[1].trim().replace(/^\//, '').toLowerCase()
      const foundQr = quickReplies.find((q) =>
        q.id?.toLowerCase() === qTarget ||
        (q.shortcut && q.shortcut.replace(/^\//, '').toLowerCase() === qTarget) ||
        (q.title && q.title.toLowerCase() === qTarget)
      )
      if (foundQr) {
        if (foundQr.kind === 'audio' || foundQr.media_url) {
          isAudioReply = true
          audioUrlToSend = foundQr.media_url || null
          audioDurationSec = Math.max(2, Number(foundQr.media_duration) || 5)
          textToSend = `[Áudio: ${foundQr.title}]`
        } else if (foundQr.content_text) {
          textToSend = text.replace(qrMatch[0], foundQr.content_text).trim()
        }
      }
    }

    if (!isAudioReply) {
      isAudioReply =
        /^\[(áudio|audio|gravando|voz)\]/i.test(text.trim()) ||
        text.toLowerCase().includes('[áudio]') ||
        text.toLowerCase().includes('[audio]') ||
        text.trim().startsWith('🎙️')
    }

    // 1. Live WhatsApp Presence:
    // Audio: "Gravando áudio..." with realistic recording duration
    // Text: "Digitando..." with realistic typing speed (~28 chars/sec)
    if (contact?.phone) {
      if (isAudioReply) {
        const recordingMs = Math.min(Math.max(audioDurationSec * 1000, 3200), 7500)
        void sendWhatsAppPresence({
          accountId,
          phoneNumber: contact.phone,
          presence: 'recording',
          delayMs: recordingMs + 2000,
        })

        if (process.env.NODE_ENV !== 'test') {
          await new Promise((resolve) => setTimeout(resolve, recordingMs))
        }
      } else {
        const typingMs = Math.min(5200, Math.max(2000, Math.round(textToSend.length * 28)))
        void sendWhatsAppPresence({
          accountId,
          phoneNumber: contact.phone,
          presence: 'composing',
          delayMs: typingMs + 2000,
        })

        if (process.env.NODE_ENV !== 'test') {
          await new Promise((resolve) => setTimeout(resolve, typingMs))
        }
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

    // 1. Direct Baileys socket connection (if explicitly enabled in environment)
    if (process.env.ENABLE_BAILEYS === 'true' && contact?.phone) {
      try {
        const baileys = await import('@/lib/whatsapp/baileys/baileys-manager');
        if (baileys.isBaileysConnected(accountId)) {
          let sendRes: { messageId: string }
          if (isAudioReply && audioUrlToSend) {
            sendRes = await baileys.sendBaileysMedia(
              accountId,
              contact.phone,
              audioUrlToSend,
              'audio',
            )
          } else {
            sendRes = await baileys.sendBaileysText(accountId, contact.phone, textToSend)
          }

          const cleanMsgId = String(sendRes.messageId || '').includes(':')
            ? String(sendRes.messageId).split(':').pop()!
            : String(sendRes.messageId || `bot_${Date.now()}`)

          const botMsgRow = {
            conversation_id: conversationId,
            sender_type: 'bot' as const,
            content_type: (isAudioReply && audioUrlToSend ? 'audio' : 'text') as 'audio' | 'text',
            content_text: textToSend,
            media_url: audioUrlToSend || null,
            message_id: cleanMsgId,
            status: 'sent' as const,
            ai_generated: true,
            created_at: new Date().toISOString(),
          }

          const { data: insertedMsg } = await db.from('messages').insert(botMsgRow).select('id, created_at').maybeSingle()

          await updateConversationWithMessage(db, {
            conversationId,
            messageText: textToSend,
            messageTimestamp: botMsgRow.created_at,
            isInbound: false,
            senderType: 'bot',
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
              last_message_text: textToSend,
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
      } catch (baileysErr) {
        console.warn('[ai auto-reply] Baileys send failed, trying other providers:', baileysErr)
      }
    }

    // 2. Active UazAPI connection
    try {
      const { data: uazConns } = await db
        .from('whatsapp_connections')
        .select('*')
        .eq('account_id', accountId)
        .eq('provider', 'uazapi')
        .eq('is_active', true)
        .order('updated_at', { ascending: false })

      const uazConn = uazConns?.find((c) => c.status === 'connected') || uazConns?.[0] || null

      if (uazConn) {
        const uazProviderConfig = (uazConn.provider_config || {}) as Record<string, string>
        let token = ''
        try {
          token = decrypt(uazProviderConfig.token)
        } catch {
          token = uazProviderConfig.token || ''
        }

        if (token && contact?.phone) {
          const baseUrl = normalizeBaseUrl(uazProviderConfig.base_url)
          let sendRes: { messageId: string; status?: string }

          if (isAudioReply && audioUrlToSend) {
            sendRes = await sendUazApiMedia(baseUrl, token, {
              number: contact.phone,
              url: audioUrlToSend,
              type: 'ptt',
              ptt: true,
            })
          } else {
            sendRes = await sendUazApiText(baseUrl, token, {
              number: contact.phone,
              text: textToSend,
            })
          }

          const cleanMsgId = String(sendRes.messageId || '').includes(':')
            ? String(sendRes.messageId).split(':').pop()!
            : String(sendRes.messageId || `bot_${Date.now()}`)

          const botMsgRow = {
            conversation_id: conversationId,
            sender_type: 'bot' as const,
            content_type: (isAudioReply && audioUrlToSend ? 'audio' : 'text') as 'audio' | 'text',
            content_text: textToSend,
            media_url: audioUrlToSend || null,
            message_id: cleanMsgId,
            status: 'sent' as const,
            ai_generated: true,
            created_at: new Date().toISOString(),
          }

          const { data: insertedMsg } = await db.from('messages').insert(botMsgRow).select('id, created_at').maybeSingle()

          await updateConversationWithMessage(db, {
            conversationId,
            messageText: textToSend,
            messageTimestamp: botMsgRow.created_at,
            isInbound: false,
            senderType: 'bot',
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
              last_message_text: textToSend,
              last_message_at: botMsgRow.created_at,
              unread_count: 0,
            },
          })

          // Record successful AI reply decision & steps
          await recordAiDecision(db, {
            conversationId,
            accountId,
            status: 'replied',
            reason: `Resposta enviada com sucesso via WhatsApp (${config.model})`,
            steps: [
              {
                name: '1. Recebimento & Triagem',
                status: 'success',
                detail: 'Mensagem recebida e analisada com sucesso',
                timestamp: new Date().toISOString(),
              },
              {
                name: '2. Filtros de Elegibilidade',
                status: 'success',
                detail: 'Todos os filtros de validação e segurança aprovados',
                timestamp: new Date().toISOString(),
              },
              {
                name: '3. Contexto & Conhecimento',
                status: 'success',
                detail: `Histórico montado (${messages.length} mensagens) e diretrizes de negócio aplicadas`,
                timestamp: new Date().toISOString(),
              },
              {
                name: '4. Modelo Gemini',
                status: 'success',
                detail: `Resposta gerada com sucesso pelo modelo ${config.model}`,
                timestamp: new Date().toISOString(),
              },
              {
                name: '5. Entrega WhatsApp',
                status: 'success',
                detail: 'Mensagem entregue via WhatsApp e sincronizada no CRM',
                timestamp: new Date().toISOString(),
              },
            ],
            model: config.model,
            provider: config.provider,
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
      text: textToSend,
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
 * Execute debounced AI reply for a conversation.
 * Buffers consecutive customer messages (e.g. 12-15 seconds) so that when a customer
 * sends multiple rapid thoughts, questions, or follow-ups, the AI responds to everything
 * at once in a single consolidated message instead of fragmenting into duplicate replies.
 */
async function executeDebouncedAiReply(args: DispatchArgs): Promise<void> {
  const { conversationId, messageId } = args;
  const db = supabaseAdmin();
  const startTime = Date.now();
  const debounceMs = args.debounceMs ?? getDebounceMs();
  const maxWaitMs = getMaxWaitMs();

  console.log(
    `[ai-debouncer] Buffering inbound message for conv ${conversationId} (debounce: ${debounceMs}ms, maxWait: ${maxWaitMs}ms)`
  );

  // 1. Notify in-memory coordinator (manages client typing presence & batch sizing)
  autoReplyDebouncer.enqueue(args, {
    debounceMs,
    maxWaitMs,
  });

  // 2. Wait the initial debounce window
  await new Promise((resolve) => setTimeout(resolve, debounceMs));

  // 3. If client is actively typing or recording, extend wait briefly (up to maxWait limit)
  while (autoReplyDebouncer.isClientTyping(conversationId) && Date.now() - startTime < maxWaitMs) {
    console.log(`[ai-debouncer] Client is currently typing in conv ${conversationId}. Extending buffer...`);
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }

  // 4. Multi-instance & serverless check: see if a subsequent customer message arrived in DB
  try {
    const { data: latestInConv } = await db
      .from('messages')
      .select('id, message_id, created_at, ai_processed_at')
      .eq('conversation_id', conversationId)
      .eq('sender_type', 'customer')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (latestInConv) {
      // If the latest message was already answered or claimed by another worker, stand down
      if (latestInConv.ai_processed_at) {
        console.log(`[ai-debouncer] Latest customer message already processed/claimed for conv ${conversationId}. Bailing out.`);
        return;
      }

      // If a newer customer message was received and we haven't reached the max wait limit,
      // yield execution to the newer message's debounce cycle to consolidate both into a single answer
      if (messageId && latestInConv.message_id && latestInConv.message_id !== messageId) {
        const elapsed = Date.now() - startTime;
        if (elapsed < maxWaitMs) {
          console.log(
            `[ai-debouncer] Newer customer message (${latestInConv.message_id}) arrived for conv ${conversationId}. Yielding to consolidate.`
          );
          return;
        }
      }
    }
  } catch (err) {
    console.warn('[ai-debouncer] Error checking latest message for debounce consolidation:', err);
  }

  // 5. This worker is the designated executor for this conversation batch!
  console.log(
    `[ai-debouncer] Debounce window elapsed for conv ${conversationId}. Generating single consolidated AI response.`
  );
  await executeAiReplyProcess(args);
}

/**
 * AI auto-reply for an incoming customer message.
 * Routes through debouncing to buffer rapid messages and group them
 * into a single unified intention before querying the AI.
 */
export async function dispatchInboundToAiReply(
  args: DispatchArgs,
): Promise<void> {
  const isTest = process.env.NODE_ENV === 'test' && !process.env.ENABLE_TEST_DEBOUNCE;
  if (args.immediate || isTest || args.isOrderFollowup) {
    return executeAiReplyProcess(args);
  }

  return executeDebouncedAiReply(args);
}
