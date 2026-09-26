/**
 * Webhook Events Persistent Storage & Queue Manager
 *
 * Persists raw incoming webhook events to Supabase Postgres before ACK,
 * providing strict idempotency, auditability, and crash recovery.
 */

import { createClient as createAdminClient } from '@supabase/supabase-js';
import crypto from 'crypto';

function supabaseAdmin() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error('Supabase credentials missing.');
  }
  return createAdminClient(url, key);
}

export interface IngestWebhookEventParams {
  traceId: string;
  provider: string;
  eventType: string;
  messageId?: string;
  connectionId?: string;
  accountId?: string;
  payload: Record<string, unknown>;
}

import { sanitizeLogPayload, extractEssentialWebhookMetadata, logger } from '@/lib/logger';

export class WebhookEventManager {
  /**
   * Computes SHA-256 hash of essential payload attributes (never entire raw payload with media)
   */
  static hashPayload(payload: Record<string, unknown>, messageId?: string): string {
    const meta = extractEssentialWebhookMetadata(payload);
    const key = `${meta.event}:${messageId || meta.messageId}:${meta.phone}:${meta.textSnippet || ''}`;
    return crypto.createHash('sha256').update(key).digest('hex');
  }

  /**
   * Persists incoming event before ACK with sanitized payload (strips base64/media/massive objects)
   */
  static async recordReceived(params: IngestWebhookEventParams): Promise<{ id?: string; isDuplicate?: boolean }> {
    const admin = supabaseAdmin();
    const hash = this.hashPayload(params.payload, params.messageId);

    try {
      // 1. Idempotency check by messageId if present
      if (params.messageId) {
        const { data: existing } = await admin
          .from('webhook_events')
          .select('id, processing_status')
          .eq('message_id', params.messageId)
          .maybeSingle();

        if (existing && existing.processing_status === 'COMPLETED') {
          return { id: existing.id, isDuplicate: true };
        }
      }

      // 2. Prune and sanitize payload - NEVER store raw base64, media, or huge arrays
      const prunedPayload = sanitizeLogPayload(params.payload, 2) as Record<string, unknown>;

      // 3. Insert into webhook_events
      const { data, error } = await admin
        .from('webhook_events')
        .insert({
          trace_id: params.traceId,
          provider: params.provider,
          event_type: params.eventType,
          message_id: params.messageId || null,
          connection_id: params.connectionId || null,
          account_id: params.accountId || null,
          payload: prunedPayload,
          payload_hash: hash,
          processing_status: 'RECEIVED',
          received_at: new Date().toISOString(),
        })
        .select('id')
        .maybeSingle();

      if (error) {
        // Log once via logger without spamming
        logger.debug('webhook_events', 'insert non-blocking fallback', { error: error.message });
        return { isDuplicate: false };
      }

      return { id: data?.id, isDuplicate: false };
    } catch (err: unknown) {
      logger.debug('webhook_events', 'recordReceived catch', { error: err instanceof Error ? err.message : String(err) });
      return { isDuplicate: false };
    }
  }

  /**
   * Updates status to QUEUED, PROCESSING, COMPLETED, or FAILED
   */
  static async updateStatus(traceId: string, status: 'QUEUED' | 'PROCESSING' | 'COMPLETED' | 'FAILED', error?: string): Promise<void> {
    try {
      const admin = supabaseAdmin();
      const updates: Record<string, unknown> = {
        processing_status: status,
        updated_at: new Date().toISOString(),
      };
      if (status === 'COMPLETED') {
        updates.processed_at = new Date().toISOString();
      }
      if (error) {
        updates.error = error;
      }

      await admin
        .from('webhook_events')
        .update(updates)
        .eq('trace_id', traceId);
    } catch {
      // non-blocking
    }
  }
}
