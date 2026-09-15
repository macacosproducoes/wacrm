import { supabaseAdmin } from '@/lib/ai/admin-client'
import { decrypt } from '@/lib/whatsapp/encryption'
import {
  normalizeBaseUrl,
  sendUazApiPresence,
  markUazApiMessageRead,
} from './uazapi-client'
import {
  sendBaileysPresence,
  markBaileysRead,
  isBaileysConnected,
} from './baileys/baileys-manager'

interface CachedConnConfig {
  baseUrl: string
  token: string
  expiresAt: number
}

const connConfigCache = new Map<string, CachedConnConfig>()

export interface WhatsAppPresenceOptions {
  accountId: string
  phoneNumber: string
  presence: 'composing' | 'recording' | 'paused'
  delayMs?: number
  baseUrl?: string
  token?: string
}

async function getCachedUazApiConfig(accountId: string): Promise<{ baseUrl: string; token: string } | null> {
  const cached = connConfigCache.get(accountId)
  const now = Date.now()
  if (cached && cached.expiresAt > now) {
    return { baseUrl: cached.baseUrl, token: cached.token }
  }

  const db = supabaseAdmin()
  const { data: conn } = await db
    .from('whatsapp_connections')
    .select('provider_config')
    .eq('account_id', accountId)
    .eq('provider', 'uazapi')
    .eq('is_active', true)
    .maybeSingle()

  if (!conn) return null

  const config = (conn.provider_config || {}) as Record<string, string>
  let token = ''
  try {
    token = decrypt(config.token)
  } catch {
    token = config.token || ''
  }

  if (!token) return null
  const baseUrl = normalizeBaseUrl(config.base_url)

  connConfigCache.set(accountId, {
    baseUrl,
    token,
    expiresAt: now + 60_000,
  })

  return { baseUrl, token }
}

/**
 * Send presence update (composing/digitando, recording/gravando áudio, paused)
 * to a WhatsApp contact through whichever connection is currently active
 * (Baileys or UazAPI).
 */
export async function sendWhatsAppPresence(
  opts: WhatsAppPresenceOptions,
): Promise<boolean> {
  const { accountId, phoneNumber, presence, delayMs = 5000, baseUrl: directBaseUrl, token: directToken } = opts
  if (!phoneNumber) return false

  try {
    // 1. Direct Baileys socket connection (highest responsiveness)
    if (isBaileysConnected(accountId)) {
      return await sendBaileysPresence(accountId, phoneNumber, presence)
    }

    // 2. Active UazAPI connection
    let baseUrl = directBaseUrl
    let token = directToken

    if (!baseUrl || !token) {
      const uazCfg = await getCachedUazApiConfig(accountId)
      if (!uazCfg) return false
      baseUrl = uazCfg.baseUrl
      token = uazCfg.token
    }

    return await sendUazApiPresence(baseUrl, token, {
      number: phoneNumber,
      presence,
      delay: delayMs,
    })
  } catch (err) {
    console.warn('[unified-presence] sendWhatsAppPresence error:', err)
    return false
  }
}

/**
 * Mark messages as read (blue ticks) for a contact on WhatsApp.
 */
export async function markWhatsAppMessagesRead(opts: {
  accountId: string
  phoneNumber: string
  messageIds: string[]
}): Promise<boolean> {
  const { accountId, phoneNumber, messageIds } = opts
  if (!messageIds || messageIds.length === 0) return false

  try {
    if (isBaileysConnected(accountId)) {
      let allOk = true
      for (const id of messageIds) {
        const ok = await markBaileysRead(accountId, phoneNumber, id)
        if (!ok) allOk = false
      }
      return allOk
    }

    const uazCfg = await getCachedUazApiConfig(accountId)
    if (!uazCfg) return false

    return await markUazApiMessageRead(uazCfg.baseUrl, uazCfg.token, messageIds)
  } catch (err) {
    console.warn('[unified-presence] markWhatsAppMessagesRead error:', err)
    return false
  }
}

