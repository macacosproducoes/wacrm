/**
 * Unified Production Logger & Payload Sanitizer
 *
 * Prevents log ingestion bloat, eliminates massive raw payloads,
 * strips base64/media, and enforces structured log levels.
 *
 * Configurable via:
 *   DEBUG_LOGS=true (defaults to false in production)
 */

export type LogLevel = 'ERROR' | 'WARN' | 'INFO' | 'DEBUG';

const LOG_LEVEL_PRIORITY: Record<LogLevel, number> = {
  ERROR: 4,
  WARN: 3,
  INFO: 2,
  DEBUG: 1,
};

function isDebugEnabled(): boolean {
  if (typeof process === 'undefined') return false;
  return process.env.DEBUG_LOGS === 'true' || process.env.NEXT_PUBLIC_DEBUG_LOGS === 'true';
}

function getMinLogLevel(): LogLevel {
  if (isDebugEnabled()) return 'DEBUG';
  if (process.env.NODE_ENV === 'development') return 'INFO';
  return 'INFO';
}

/**
 * Strips base64, media binaries, long strings, tokens, and massive arrays
 * to prevent inflating log files and Supabase PostgREST payload logs.
 */
export function sanitizeLogPayload(input: unknown, maxDepth = 2): unknown {
  if (input === null || input === undefined) return input;
  if (typeof input === 'string') {
    if (input.startsWith('data:') && input.includes(';base64,')) {
      return `[base64 data URI (${input.length} chars)]`;
    }
    if (input.length > 250) {
      return `${input.slice(0, 120)}... [truncated ${input.length} chars]`;
    }
    return input;
  }
  if (typeof input !== 'object') return input;

  if (Array.isArray(input)) {
    if (input.length > 5) {
      return [
        ...input.slice(0, 3).map((item) => sanitizeLogPayload(item, maxDepth - 1)),
        `[+${input.length - 3} more items]`,
      ];
    }
    return input.map((item) => sanitizeLogPayload(item, maxDepth - 1));
  }

  if (maxDepth <= 0) return '[Object]';

  const sanitized: Record<string, unknown> = {};
  const blockedKeys = /^(base64|jpegThumbnail|thumbnailDirectPath|mediaData|buffer|token|secret|password|client_secret|raw_payload)$/i;

  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (blockedKeys.test(key)) {
      sanitized[key] = `[stripped ${key}]`;
      continue;
    }
    sanitized[key] = sanitizeLogPayload(value, maxDepth - 1);
  }

  return sanitized;
}

/**
 * Extracts only essential metadata from an incoming UazAPI webhook payload.
 * Guarantees zero base64, zero media bytes, and minimal footprint.
 */
export function extractEssentialWebhookMetadata(body: Record<string, unknown>): {
  event: string;
  messageId: string;
  phone: string;
  senderType: 'customer' | 'agent';
  hasMedia: boolean;
  mediaType?: string;
  textSnippet?: string;
} {
  const event = String(body.EventType || body.event || body.type || (body.message ? 'messages' : 'unknown')).toLowerCase();
  const msgData = ((body.message || body.data || body) ?? {}) as Record<string, unknown>;
  const key = (msgData.key || {}) as Record<string, unknown>;
  const rawMsgId = String(key.id || msgData.messageid || msgData.id || body.id || '').trim();
  const messageId = rawMsgId.includes(':') ? rawMsgId.split(':').pop()! : rawMsgId;

  const rawPhone = String(
    msgData.phone ||
    msgData.chatid ||
    msgData.sender ||
    key.remoteJid ||
    body.phone ||
    ''
  ).replace(/\D/g, '');

  const isFromMe = Boolean(msgData.fromMe || key.fromMe);
  const msgType = String(msgData.messageType || msgData.type || '');
  const content = (msgData.content || {}) as Record<string, unknown>;

  const hasMedia = /image|audio|video|document/i.test(msgType) || Boolean(content.image || content.audio || content.video);
  const text = String(msgData.text || content.text || content.caption || '').trim();

  return {
    event,
    messageId,
    phone: rawPhone ? rawPhone.slice(-8) : 'unknown',
    senderType: isFromMe ? 'agent' : 'customer',
    hasMedia,
    mediaType: hasMedia ? msgType : undefined,
    textSnippet: text ? (text.length > 50 ? `${text.slice(0, 47)}...` : text) : undefined,
  };
}

export const logger = {
  isDebugEnabled,

  error(tag: string, message: string, error?: unknown, meta?: Record<string, unknown>) {
    const errStr = error instanceof Error ? error.stack || error.message : error ? String(error) : '';
    const metaStr = meta ? ` | meta=${JSON.stringify(sanitizeLogPayload(meta))}` : '';
    console.error(`[ERROR] [${tag}] ${message}${errStr ? ` | error=${errStr}` : ''}${metaStr}`);
  },

  warn(tag: string, message: string, meta?: Record<string, unknown>) {
    if (LOG_LEVEL_PRIORITY.WARN < LOG_LEVEL_PRIORITY[getMinLogLevel()]) return;
    const metaStr = meta ? ` | meta=${JSON.stringify(sanitizeLogPayload(meta))}` : '';
    console.warn(`[WARN] [${tag}] ${message}${metaStr}`);
  },

  info(tag: string, message: string, meta?: Record<string, unknown>) {
    if (LOG_LEVEL_PRIORITY.INFO < LOG_LEVEL_PRIORITY[getMinLogLevel()]) return;
    const metaStr = meta ? ` | meta=${JSON.stringify(sanitizeLogPayload(meta))}` : '';
    console.log(`[INFO] [${tag}] ${message}${metaStr}`);
  },

  debug(tag: string, message: string, meta?: Record<string, unknown>) {
    if (!isDebugEnabled()) return;
    const metaStr = meta ? ` | meta=${JSON.stringify(sanitizeLogPayload(meta))}` : '';
    console.log(`[DEBUG] [${tag}] ${message}${metaStr}`);
  },

  /**
   * Standard production-format webhook logger
   * Example: [UAZAPI_WEBHOOK] event=messages message_id=abc123 connection_id=xyz status=processed
   */
  webhook(params: {
    provider: string;
    event: string;
    messageId?: string;
    connectionId?: string;
    phone?: string;
    status: string;
    durationMs?: number;
    error?: string;
  }) {
    const parts = [
      `[${params.provider.toUpperCase()}_WEBHOOK]`,
      `event=${params.event}`,
      `message_id=${params.messageId || 'none'}`,
      `connection_id=${params.connectionId || 'none'}`,
    ];
    if (params.phone) parts.push(`phone=***${params.phone.slice(-4)}`);
    parts.push(`status=${params.status}`);
    if (params.durationMs !== undefined) parts.push(`duration=${Math.round(params.durationMs)}ms`);
    if (params.error) parts.push(`error="${params.error}"`);

    console.log(parts.join(' '));
  },
};
