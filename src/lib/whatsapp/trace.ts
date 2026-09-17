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

export class TraceLogger {
  static generateTraceId(prefix = 'trc'): string {
    const ts = Date.now().toString(36);
    const rand = Math.random().toString(36).substring(2, 8);
    return `${prefix}_${ts}_${rand}`;
  }

  static log(traceId: string, stepCode: string, stepName: string, meta?: Record<string, unknown>) {
    const timestamp = new Date().toISOString();
    const metaStr = meta && Object.keys(meta).length > 0 ? ` | ${JSON.stringify(meta)}` : '';
    console.log(`[TRACE ${traceId}] [${stepCode}] ${stepName} (${timestamp})${metaStr}`);
  }
}
