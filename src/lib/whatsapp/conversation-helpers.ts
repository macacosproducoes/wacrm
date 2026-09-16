import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * Resilient helpers for Contact and Conversation management.
 * Replaces hard-coded calls to non-existent database RPCs (find_or_create_contact,
 * find_or_create_conversation, update_conversation_with_message) with direct,
 * reliable Supabase queries that work identically in all environments.
 */

export interface FindOrCreateContactParams {
  accountId: string;
  userId: string;
  phone: string;
  name?: string | null;
}

export interface FindOrCreateConversationParams {
  accountId: string;
  userId: string;
  contactId: string;
  connectionId?: string | null;
}

export interface UpdateConversationWithMessageParams {
  conversationId: string;
  messageText: string;
  messageTimestamp?: string | null;
  isInbound: boolean;
  senderType?: 'customer' | 'agent' | 'bot';
}

/**
 * Normalize phone number to digits only
 */
export function normalizePhoneDigits(phone: string): string {
  return String(phone || '').replace(/\D/g, '');
}

/**
 * Find or create a contact by account_id and phone number.
 * Updates the contact's name if it was previously generic and a better name is provided.
 */
export async function findOrCreateContact(
  admin: SupabaseClient,
  params: FindOrCreateContactParams
): Promise<string | null> {
  const normPhone = normalizePhoneDigits(params.phone);
  if (!normPhone || normPhone.length < 8) return null;

  try {
    // 1. Look up existing contact by exact phone or phone_normalized
    const { data: existing, error: findErr } = await admin
      .from('contacts')
      .select('id, name')
      .eq('account_id', params.accountId)
      .or(`phone.eq.${normPhone},phone_normalized.eq.${normPhone}`)
      .maybeSingle();

    if (findErr) {
      console.warn('[conversation-helpers] Contact search warning:', findErr.message);
    }

    if (existing?.id) {
      // If contact exists and we now have a real person/business name, update it
      const providedName = params.name?.trim();
      const currentName = existing.name?.trim() || '';
      const isCurrentGeneric =
        !currentName ||
        currentName.startsWith('+') ||
        currentName.startsWith('Cliente ') ||
        currentName === normPhone;

      if (providedName && isCurrentGeneric && providedName !== currentName) {
        await admin
          .from('contacts')
          .update({ name: providedName, updated_at: new Date().toISOString() })
          .eq('id', existing.id);
      }
      return existing.id;
    }

    // 2. Insert new contact
    const displayName = params.name?.trim() || `Cliente ${normPhone.slice(-4)}`;
    const { data: created, error: insertErr } = await admin
      .from('contacts')
      .insert({
        account_id: params.accountId,
        user_id: params.userId,
        phone: normPhone,
        name: displayName,
      })
      .select('id')
      .single();

    if (insertErr) {
      // Handle race condition: check if inserted concurrently
      if (insertErr.code === '23505') {
        const { data: recheck } = await admin
          .from('contacts')
          .select('id')
          .eq('account_id', params.accountId)
          .eq('phone', normPhone)
          .maybeSingle();
        if (recheck?.id) return recheck.id;
      }
      console.error('[conversation-helpers] Error inserting contact:', insertErr);
      return null;
    }

    return created.id;
  } catch (err) {
    console.error('[conversation-helpers] Fatal error in findOrCreateContact:', err);
    return null;
  }
}

/**
 * Find or create a conversation for an account and contact.
 */
export async function findOrCreateConversation(
  admin: SupabaseClient,
  params: FindOrCreateConversationParams
): Promise<string | null> {
  if (!params.accountId || !params.contactId) return null;

  try {
    // 1. Look up existing conversation
    const { data: existing, error: findErr } = await admin
      .from('conversations')
      .select('id')
      .eq('account_id', params.accountId)
      .eq('contact_id', params.contactId)
      .maybeSingle();

    if (findErr) {
      console.warn('[conversation-helpers] Conversation search warning:', findErr.message);
    }

    if (existing?.id) {
      return existing.id;
    }

    // 2. Create new conversation
    const { data: created, error: insertErr } = await admin
      .from('conversations')
      .insert({
        account_id: params.accountId,
        user_id: params.userId,
        contact_id: params.contactId,
        status: 'open',
        ai_autoreply_disabled: false,
        ai_reply_count: 0,
        unread_count: 0,
      })
      .select('id')
      .single();

    if (insertErr) {
      // Handle race condition
      if (insertErr.code === '23505') {
        const { data: recheck } = await admin
          .from('conversations')
          .select('id')
          .eq('account_id', params.accountId)
          .eq('contact_id', params.contactId)
          .maybeSingle();
        if (recheck?.id) return recheck.id;
      }
      console.error('[conversation-helpers] Error inserting conversation:', insertErr);
      return null;
    }

    return created.id;
  } catch (err) {
    console.error('[conversation-helpers] Fatal error in findOrCreateConversation:', err);
    return null;
  }
}

/**
 * Update conversation summary (last_message_text, last_message_at, unread_count).
 * Replaces the missing RPC `update_conversation_with_message`.
 */
export async function updateConversationWithMessage(
  admin: SupabaseClient,
  params: UpdateConversationWithMessageParams
): Promise<void> {
  if (!params.conversationId) return;

  try {
    const text = (params.messageText || '[Mensagem]').trim();
    const ts = params.messageTimestamp || new Date().toISOString();

    const updates: Record<string, unknown> = {
      last_message_text: text,
      last_message_at: ts,
      updated_at: new Date().toISOString(),
    };

    if (params.isInbound) {
      // Increment unread count for inbound customer messages
      const { data: curr } = await admin
        .from('conversations')
        .select('unread_count')
        .eq('id', params.conversationId)
        .maybeSingle();

      updates.unread_count = ((curr?.unread_count as number) || 0) + 1;
      updates.ai_reply_count = 0; // Reset reply count on customer message so AI can reply
    } else {
      // Outbound agent/bot message clears unread
      updates.unread_count = 0;
    }

    const { error: updateErr } = await admin
      .from('conversations')
      .update(updates)
      .eq('id', params.conversationId);

    if (updateErr) {
      console.error('[conversation-helpers] Error updating conversation:', updateErr);
    }
  } catch (err) {
    console.error('[conversation-helpers] Fatal in updateConversationWithMessage:', err);
  }
}
