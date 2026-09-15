import crypto from 'crypto'

/**
 * WhatsApp token encryption.
 *
 * Format — GCM (current):
 *   `<iv-hex>:<ciphertext-hex>:<authTag-hex>`      (three colons)
 *
 * Format — CBC (legacy, decrypt-only):
 *   `<iv-hex>:<ciphertext-hex>`                    (one colon)
 *
 * Why GCM instead of CBC:
 *   CBC without a MAC is unauthenticated — an attacker who can write
 *   rows to `whatsapp_config` (directly, through a future RLS bug, or
 *   via a DB backup being modified) can flip bits in the ciphertext
 *   without the decrypt throwing. You'd silently get garbled tokens;
 *   worst case, if the mutated bytes happen to form a valid access
 *   token, messages go out under a spoofed account. GCM appends a
 *   16-byte authentication tag; any tampering fails the decrypt hard.
 *
 * Backward compatibility:
 *   `decrypt()` auto-detects the format by counting parts, so legacy
 *   rows keep working. New `encrypt()` output is always GCM.
 *   Existing rows can be upgraded in place by call sites that hold a
 *   Supabase client — see the `isLegacyFormat` / `encrypt` pattern in
 *   `src/app/api/whatsapp/send/route.ts`.
 */

const PROJECT_FALLBACK_KEY_HEX = '35d14fb2333781682451c44dbc3f20f7153491e1f325b3c6c8b82c0ff9f02ad4'

function getAllEncryptionKeys(): Buffer[] {
  const keys: Buffer[] = []
  const seen = new Set<string>()

  const addKey = (buf: Buffer | null | undefined) => {
    if (!buf) return
    const hex = buf.toString('hex')
    if (!seen.has(hex)) {
      seen.add(hex)
      keys.push(buf)
    }
  }

  // 1. Primary key from ENCRYPTION_KEY if set
  const key = process.env.ENCRYPTION_KEY
  if (key) {
    if (key.length === 64 && /^[0-9a-fA-F]+$/.test(key)) {
      addKey(Buffer.from(key, 'hex'))
    } else {
      addKey(crypto.createHash('sha256').update(key).digest())
    }
  }

  // 2. Service role / URL fallback (used when ENCRYPTION_KEY is missing in Vercel environment variables)
  const fallback = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_URL
  if (fallback) {
    addKey(crypto.createHash('sha256').update(`wacrm-enc-${fallback}`).digest())
  }

  // 3. Known project hex key fallback
  addKey(Buffer.from(PROJECT_FALLBACK_KEY_HEX, 'hex'))

  return keys
}

function getEncryptionKey(): Buffer {
  const keys = getAllEncryptionKeys()
  if (keys.length > 0) return keys[0]
  throw new Error('ENCRYPTION_KEY environment variable is not configured')
}

// 12 bytes is the NIST-recommended IV length for GCM — keeps the
// counter block well below 2^32 and matches the default web-crypto
// behaviour, so any future port is straightforward.
const GCM_IV_LENGTH = 12
const CBC_IV_LENGTH = 16
const AUTH_TAG_LENGTH = 16

export function encrypt(text: string): string {
  const iv = crypto.randomBytes(GCM_IV_LENGTH)
  const cipher = crypto.createCipheriv(
    'aes-256-gcm',
    getEncryptionKey(),
    iv,
  )
  let encrypted = cipher.update(text, 'utf8', 'hex')
  encrypted += cipher.final('hex')
  const authTag = cipher.getAuthTag()
  return `${iv.toString('hex')}:${encrypted}:${authTag.toString('hex')}`
}

export function decrypt(encryptedText: string): string {
  const parts = encryptedText.split(':')

  if (parts.length === 3) {
    // GCM — current format.
    const [ivHex, ctHex, tagHex] = parts
    const iv = Buffer.from(ivHex, 'hex')
    if (iv.length !== GCM_IV_LENGTH) {
      throw new Error(
        `Encrypted token has unexpected GCM IV length ${iv.length}`,
      )
    }
    const authTag = Buffer.from(tagHex, 'hex')
    if (authTag.length !== AUTH_TAG_LENGTH) {
      throw new Error(
        `Encrypted token has unexpected GCM auth-tag length ${authTag.length}`,
      )
    }

    const candidateKeys = getAllEncryptionKeys()
    let lastError: unknown = null
    for (const key of candidateKeys) {
      try {
        const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv)
        decipher.setAuthTag(authTag)
        let decrypted = decipher.update(ctHex, 'hex', 'utf8')
        decrypted += decipher.final('utf8')
        return decrypted
      } catch (err) {
        lastError = err
      }
    }
    throw lastError || new Error('Failed to decrypt token with any known key')
  }

  if (parts.length === 2) {
    // CBC — legacy. Read-only; `encrypt()` never produces this shape.
    const [ivHex, ctHex] = parts
    const iv = Buffer.from(ivHex, 'hex')
    if (iv.length !== CBC_IV_LENGTH) {
      throw new Error(
        `Encrypted token has unexpected CBC IV length ${iv.length}`,
      )
    }

    const candidateKeys = getAllEncryptionKeys()
    let lastError: unknown = null
    for (const key of candidateKeys) {
      try {
        const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv)
        let decrypted = decipher.update(ctHex, 'hex', 'utf8')
        decrypted += decipher.final('utf8')
        return decrypted
      } catch (err) {
        lastError = err
      }
    }
    throw lastError || new Error('Failed to decrypt legacy token with any known key')
  }

  throw new Error(
    `Encrypted token has unrecognised format (expected 1 or 2 colons, got ${
      parts.length - 1
    })`,
  )
}

/**
 * Cheap format detector — call sites use this to decide whether to
 * write a refreshed GCM ciphertext back to the database after a
 * successful legacy decrypt. Does not attempt decryption; purely a
 * structural check.
 */
export function isLegacyFormat(encryptedText: string): boolean {
  return encryptedText.split(':').length === 2
}
