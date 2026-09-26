/**
 * Unified Trace & Telemetry Logger for WhatsApp CRM Pipeline
 *
 * Tracks every message end-to-end:
 * Webhook -> Storage -> Event Queue -> Agent -> Order -> Instagram -> Creative -> UAZAPI Send -> Delivery
 */

export interface TraceContext {
  traceId: string;
  messageId?: string;
  phone?: string;
  accountId?: string;
  step?: string;
}

import { sanitizeLogPayload, logger } from '@/lib/logger';

export class TraceLogger {
  static generateTraceId(prefix = 'trc'): string {
    const ts = Date.now().toString(36);
    const rand = Math.random().toString(36).substring(2, 8);
    return `${prefix}_${ts}_${rand}`;
  }

  static log(traceId: string, stepCode: string, stepName: string, meta?: Record<string, unknown>) {
    // Only log trace details if debug is enabled or in development
    if (!logger.isDebugEnabled() && process.env.NODE_ENV === 'production') {
      return;
    }

    const timestamp = new Date().toISOString();
    let metaStr = '';
    if (meta && Object.keys(meta).length > 0) {
      const sanitized = sanitizeLogPayload(meta, 2);
      metaStr = ` | ${JSON.stringify(sanitized)}`;
    }
    console.log(`[TRACE ${traceId}] [${stepCode}] ${stepName} (${timestamp})${metaStr}`);
  }
}
