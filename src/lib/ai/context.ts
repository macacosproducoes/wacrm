import type { SupabaseClient } from '@supabase/supabase-js'
import type { ChatMessage } from './types'
import { aiContextMessageLimit } from './defaults'

interface DbMessage {
  sender_type: 'customer' | 'agent' | 'bot'
  content_text: string | null
}

/**
 * Fetch the last N text messages of a conversation and map them to the
 * provider-neutral chat shape. Customer messages become `user`; agent
 * and bot messages become `assistant`. Non-text messages (media,
 * templates, interactive) are excluded — they carry no text to model.
 *
 * Ordered oldest-first (chronological) so the transcript reads
 * naturally and the most recent customer message lands last.
 *
 * Automatically groups consecutive messages from the same sender role
 * (e.g. rapid customer messages) into a single cohesive turn separated
 * by newlines (`\n`) so the AI models process them as a single intent.
 */
export async function buildConversationContext(
  db: SupabaseClient,
  conversationId: string,
  limit: number = aiContextMessageLimit(),
): Promise<ChatMessage[]> {
  const { data, error } = await db
    .from('messages')
    .select('sender_type, content_text')
    .eq('conversation_id', conversationId)
    .eq('content_type', 'text')
    .order('created_at', { ascending: false })
    .limit(limit)

  if (error) throw error

  const rows = ((data ?? []) as DbMessage[]).reverse()
  const rawList = rows
    .filter((m) => m.content_text && m.content_text.trim())
    .map((m) => ({
      role: m.sender_type === 'customer' ? ('user' as const) : ('assistant' as const),
      content: m.content_text!.trim(),
    }))

  // Group consecutive messages from the same role into a single message turn
  const grouped: ChatMessage[] = []
  for (const item of rawList) {
    if (grouped.length > 0 && grouped[grouped.length - 1].role === item.role) {
      grouped[grouped.length - 1].content += `\n${item.content}`
    } else {
      grouped.push({ role: item.role, content: item.content })
    }
  }

  return grouped
}
