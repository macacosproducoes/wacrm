import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from '@/lib/rate-limit'
import {
  sendMessageToConversation,
  validateSendMessageParams,
  SendMessageError,
} from '@/lib/whatsapp/send-message'
import { createClient as createAdminClient } from '@supabase/supabase-js'
import { decrypt } from '@/lib/whatsapp/encryption'
import {
  sendUazApiText,
  sendUazApiMedia,
  normalizeBaseUrl,
} from '@/lib/whatsapp/uazapi-client'
import {
  sendBaileysText,
  sendBaileysMedia,
  isBaileysConnected,
} from '@/lib/whatsapp/baileys/baileys-manager'
import { whatsappBus } from '@/lib/whatsapp/whatsapp-bus'
import { autoReplyDebouncer } from '@/lib/ai/auto-reply-debouncer'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function getAdminClient(fallbackClient: any) {
  if (process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return createAdminClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY
    )
  }
  return fallbackClient
}

// The dashboard's outbound-send endpoint. It owns auth, per-user rate
// limiting, and the two ways the UI targets a thread — an existing
// `conversation_id` (inbox) or a `contact_id` (Contact detail →
// find-or-create the conversation). The actual Meta plumbing (validate
// → send → persist → pause flows) lives in the shared
// `sendMessageToConversation` core, which the public `/api/v1/messages`
// endpoint reuses. This route is a thin adapter: resolve the
// conversation, delegate, then map `SendMessageError` back onto the
// dashboard's internal `{ error }` shape.
export async function POST(request: Request) {
  try {
    // Requires the 'agent' role, matching both `canSendMessages` and the
    // `messages_modify` RLS policy (migration 017).
    //
    // Resolving `account_id` off the profile — which any 'viewer' has —
    // was previously the only gate. RLS did block the message INSERT, but
    // the send core calls Meta BEFORE it persists, so a viewer's request
    // still delivered a real WhatsApp message to the customer and merely
    // failed to record it (surfacing as "sent to Meta but failed to save
    // to DB"). RLS can't un-send that, so the role check belongs here.
    const { supabase, accountId, userId } = await requireRole('agent')

    // Per-user rate limit. Bucket key is scoped to this route so
    // `/broadcast` has an independent budget.
    const limit = checkRateLimit(`send:${userId}`, RATE_LIMITS.send)
    if (!limit.success) {
      return rateLimitResponse(limit)
    }

    const body = await request.json()
    const {
      // `conversation_id` targets an existing thread (inbox). `contact_id`
      // lets a caller initiate from a contact that may have no conversation
      // yet (Contact detail → Send template) — we find-or-create one below.
      conversation_id: conversationIdInput,
      contact_id,
      message_type,
      content_text,
      media_url,
      filename,
      template_name,
      template_language,
      template_params,
      template_message_params,
      interactive_payload,
      reply_to_message_id,
    } = body

    if ((!conversationIdInput && !contact_id) || !message_type) {
      return NextResponse.json(
        {
          error:
            'Either conversation_id or contact_id, plus message_type, are required',
        },
        { status: 400 }
      )
    }

    // Validate the message shape up front — before the contact_id path
    // finds-or-creates a conversation — so an invalid payload 400s
    // without leaving an orphan empty conversation behind.
    try {
      validateSendMessageParams({
        messageType: message_type,
        contentText: content_text,
        mediaUrl: media_url,
        templateName: template_name,
        interactivePayload: interactive_payload,
      })
    } catch (err) {
      if (err instanceof SendMessageError) {
        return NextResponse.json({ error: err.message }, { status: err.status })
      }
      throw err
    }

    // Resolve the target conversation. With `conversation_id` we load the
    // existing thread; with `contact_id` we find-or-create one for the
    // contact so a business-initiated template send (Contact detail view)
    // reuses the shared send core below.
    let conversationId: string | null = null

    if (conversationIdInput) {
      const { data, error: convError } = await supabase
        .from('conversations')
        .select('id')
        .eq('id', conversationIdInput)
        .eq('account_id', accountId)
        .single()

      if (convError || !data) {
        return NextResponse.json(
          { error: 'Conversation not found' },
          { status: 404 }
        )
      }
      conversationId = data.id
    } else {
      // contact_id path: verify the contact is in this account first so a
      // caller can't open a conversation against someone else's contact.
      const { data: contactRow, error: contactErr } = await supabase
        .from('contacts')
        .select('id')
        .eq('id', contact_id)
        .eq('account_id', accountId)
        .maybeSingle()

      if (contactErr || !contactRow) {
        return NextResponse.json(
          { error: 'Contact not found' },
          { status: 404 }
        )
      }

      const resolved = await findOrCreateConversation(
        supabase,
        accountId,
        userId,
        contact_id
      )
      if (!resolved) {
        return NextResponse.json(
          { error: 'Failed to open a conversation for this contact' },
          { status: 500 }
        )
      }
      conversationId = resolved
    }

    if (!conversationId) {
      return NextResponse.json(
        { error: 'Conversation not found' },
        { status: 404 }
      )
    }

    // ⚡ Cancel any pending AI debounce for this conversation (human intervention took over)
    autoReplyDebouncer.cancel(conversationId);


    // Check if account is configured with active WhatsApp connection (Baileys or UazAPI)
    try {
      const admin = getAdminClient(supabase)
      const baileysActive = isBaileysConnected(accountId);

      const { data: activeConns } = await admin
        .from('whatsapp_connections')
        .select('*')
        .eq('account_id', accountId)
        .eq('is_active', true)
        .limit(1);
      const uazConn = activeConns?.[0] || null;

      if (baileysActive || uazConn) {
        const config = (uazConn?.provider_config || {}) as Record<string, unknown>

        const { data: convData } = await admin
          .from('conversations')
          .select('id, contact_id, contacts (id, phone, name)')
          .eq('id', conversationId)
          .single()

        const contactPhone = (convData as unknown as { contacts?: { phone?: string } })?.contacts?.phone
        if (!contactPhone) {
          return NextResponse.json({ error: 'Contact has no phone number' }, { status: 400 })
        }

        // 1. Check if Baileys (direct WhatsApp QR Code) is active
        if (baileysActive || config.driver === 'baileys') {
        let sendRes: { messageId: string }
        if (media_url && message_type !== 'text') {
          const mediaType = (['image', 'video', 'audio', 'document'].includes(message_type)
            ? message_type
            : 'image') as 'image' | 'video' | 'audio' | 'document'

          sendRes = await sendBaileysMedia(accountId, contactPhone, media_url, mediaType, content_text)
        } else {
          sendRes = await sendBaileysText(accountId, contactPhone, content_text || '', reply_to_message_id)
        }

        // Persist message in database
        const { data: newMsg } = await admin
          .from('messages')
          .insert({
            conversation_id: conversationId,
            sender_type: 'agent',
            sender_id: userId,
            content_type: message_type === 'template' ? 'text' : message_type,
            content_text: content_text || '[Mensagem]',
            media_url: media_url || null,
            message_id: sendRes.messageId,
            status: 'sent',
            created_at: new Date().toISOString(),
          })
          .select('id')
          .single()

        // Update conversation summary
        await admin.rpc('update_conversation_with_message', {
          p_conversation_id: conversationId,
          p_message_text: content_text || '[Mensagem]',
          p_message_timestamp: new Date().toISOString(),
          p_is_inbound: false,
        })

        whatsappBus.emitInboxEvent({
          accountId,
          conversationId,
          eventType: 'INSERT',
          message: {
            id: newMsg?.id || sendRes.messageId,
            conversation_id: conversationId,
            sender_type: 'agent',
            sender_id: userId,
            content_type: message_type === 'template' ? 'text' : message_type,
            content_text: content_text || '[Mensagem]',
            media_url: media_url || null,
            message_id: sendRes.messageId,
            status: 'sent',
            created_at: new Date().toISOString(),
          },
          conversation: {
            id: conversationId,
            last_message_text: content_text || '[Mensagem]',
            last_message_at: new Date().toISOString(),
          },
        })

        return NextResponse.json({
          success: true,
          message_id: newMsg?.id || sendRes.messageId,
          whatsapp_message_id: sendRes.messageId,
        })
      }

      let token = ''
      try {
        token = decrypt(config.token as string)
      } catch {
        token = (config.token as string) || ''
      }

      if (token) {
        const baseUrl = normalizeBaseUrl(config.base_url as string)
        let sendRes: { messageId: string; status: string }

        try {
          if (media_url && message_type !== 'text') {
            const mediaType = (['image', 'video', 'audio', 'document'].includes(message_type)
              ? message_type
              : 'image') as 'image' | 'video' | 'audio' | 'document'

            sendRes = await sendUazApiMedia(baseUrl, token, {
              number: contactPhone,
              url: media_url,
              type: mediaType,
              caption: content_text,
            })
          } else {
            sendRes = await sendUazApiText(baseUrl, token, {
              number: contactPhone,
              text: content_text || '',
              replyId: reply_to_message_id,
            })
          }

          // Persist message in database
          const { data: newMsg } = await admin
            .from('messages')
            .insert({
              conversation_id: conversationId,
              sender_type: 'agent',
              sender_id: userId,
              content_type: message_type === 'template' ? 'text' : message_type,
              content_text: content_text || '[Mensagem]',
              media_url: media_url || null,
              message_id: sendRes.messageId,
              status: 'sent',
              created_at: new Date().toISOString(),
            })
            .select('id')
            .single()

          // Update conversation summary
          await admin.rpc('update_conversation_with_message', {
            p_conversation_id: conversationId,
            p_message_text: content_text || '[Mensagem]',
            p_message_timestamp: new Date().toISOString(),
            p_is_inbound: false,
          })

          whatsappBus.emitInboxEvent({
            accountId,
            conversationId,
            eventType: 'INSERT',
            message: {
              id: newMsg?.id || sendRes.messageId,
              conversation_id: conversationId,
              sender_type: 'agent',
              sender_id: userId,
              content_type: message_type === 'template' ? 'text' : message_type,
              content_text: content_text || '[Mensagem]',
              media_url: media_url || null,
              message_id: sendRes.messageId,
              status: 'sent',
              created_at: new Date().toISOString(),
            },
            conversation: {
              id: conversationId,
              last_message_text: content_text || '[Mensagem]',
              last_message_at: new Date().toISOString(),
            },
          })

          return NextResponse.json({
            success: true,
            message_id: newMsg?.id || sendRes.messageId,
            whatsapp_message_id: sendRes.messageId,
          })
        } catch (uazErr) {
          const msg = uazErr instanceof Error ? uazErr.message : 'UazAPI sending failed'
          return NextResponse.json({ error: msg }, { status: 502 })
        }
      }
    }
  } catch {
    // Fall through to Meta provider if UazAPI check fails or is unconfigured in test
  }

    // Delegate to the shared send core (validates, sends to Meta with
    // phone-variant retry, persists, pauses active flow runs). Its
    // `SendMessageError` carries a machine code + HTTP status; the
    // dashboard maps it to the internal `{ error }` shape.
    try {
      const result = await sendMessageToConversation(supabase, accountId, {
        conversationId,
        messageType: message_type,
        contentText: content_text,
        mediaUrl: media_url,
        filename,
        templateName: template_name,
        templateLanguage: template_language,
        templateParams: template_params,
        templateMessageParams: template_message_params,
        interactivePayload: interactive_payload,
        replyToMessageId: reply_to_message_id,
      })

      whatsappBus.emitInboxEvent({
        accountId,
        conversationId,
        eventType: 'INSERT',
        message: {
          id: result.messageId,
          conversation_id: conversationId,
          sender_type: 'agent',
          sender_id: userId,
          content_type: message_type === 'template' ? 'text' : message_type,
          content_text: content_text || '[Mensagem]',
          media_url: media_url || null,
          message_id: result.whatsappMessageId,
          status: 'sent',
          created_at: new Date().toISOString(),
        },
        conversation: {
          id: conversationId,
          last_message_text: content_text || '[Mensagem]',
          last_message_at: new Date().toISOString(),
        },
      })

      return NextResponse.json({
        success: true,
        message_id: result.messageId,
        whatsapp_message_id: result.whatsappMessageId,
      })
    } catch (err) {
      if (err instanceof SendMessageError) {
        return NextResponse.json(
          { error: err.message },
          { status: err.status }
        )
      }
      throw err
    }
  } catch (error) {
    // requireRole throws Unauthorized/Forbidden; toErrorResponse maps
    // those to 401/403 and collapses anything else to a generic 500.
    console.error('Error in WhatsApp send POST:', error)
    return toErrorResponse(error)
  }
}

type SendSupabase = Awaited<ReturnType<typeof createClient>>

/**
 * Return the contact's conversation id in this account, creating one if
 * it doesn't exist yet. Mirrors the webhook's find-or-create so an
 * inbound-then-outbound (or outbound-first) sequence converges on a single
 * thread per contact. Runs under the caller's RLS — the conversations_insert
 * policy requires account agent membership, which the caller already is.
 */
async function findOrCreateConversation(
  supabase: SendSupabase,
  accountId: string,
  userId: string,
  contactId: string,
): Promise<string | null> {
  const { data: existing } = await supabase
    .from('conversations')
    .select('id')
    .eq('account_id', accountId)
    .eq('contact_id', contactId)
    .maybeSingle()

  if (existing) return existing.id

  const { data: created, error } = await supabase
    .from('conversations')
    .insert({
      account_id: accountId,
      user_id: userId,
      contact_id: contactId,
    })
    .select('id')
    .single()

  if (error) {
    console.error('Error creating conversation for contact send:', error.message)
    return null
  }

  return created.id
}
