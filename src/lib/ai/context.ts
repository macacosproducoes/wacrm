import type { SupabaseClient } from '@supabase/supabase-js'
import type { ChatMessage } from './types'
import { aiContextMessageLimit } from './defaults'

interface DbMessage {
  sender_type: 'customer' | 'agent' | 'bot'
  content_type?: string | null
  content_text: string | null
}

/**
 * Fetch the last N messages of a conversation (text and captioned images)
 * and map them to the provider-neutral chat shape. Customer messages become `user`;
 * agent and bot messages become `assistant`.
 *
 * Ordered oldest-first (chronological) so the transcript reads
 * naturally and the most recent customer message lands last.
 *
 * Automatically groups consecutive messages from the same sender role
 * into a single cohesive turn separated by newlines (`\n`).
 */
export async function buildConversationContext(
  db: SupabaseClient,
  conversationId: string,
  limit: number = aiContextMessageLimit(),
): Promise<ChatMessage[]> {
  const { data, error } = await db
    .from('messages')
    .select('sender_type, content_type, content_text')
    .eq('conversation_id', conversationId)
    .in('content_type', ['text', 'image', 'audio', 'video', 'document'])
    .order('created_at', { ascending: false })
    .limit(limit)

  if (error) throw error

  const rows = ((data ?? []) as DbMessage[]).reverse()
  const rawList = rows
    .filter((m) => {
      const text = m.content_text?.trim()
      if (!text && m.content_type !== 'audio' && m.content_type !== 'image') return false
      if (text === '[Mensagem recebida]' || text === '[Reação]' || text?.startsWith('[Undecryptable]')) {
        return false
      }
      return true
    })
    .map((m) => {
      let content = (m.content_text || '').trim()
      if (m.content_type === 'image') {
        content = content ? `[Foto/Imagem]: ${content}` : '[Foto/Imagem enviada]'
      } else if (m.content_type === 'audio') {
        content = `[Mensagem de áudio/voz enviada pelo ${m.sender_type === 'customer' ? 'cliente' : 'atendente'}]`
      } else if (m.content_type === 'video') {
        content = content ? `[Vídeo]: ${content}` : '[Vídeo enviado]'
      } else if (m.content_type === 'document') {
        content = content ? `[Documento]: ${content}` : '[Documento enviado]'
      }
      return {
        role: m.sender_type === 'customer' ? ('user' as const) : ('assistant' as const),
        content,
      }
    })

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
