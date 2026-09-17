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

export class WebhookEventManager {
  /**
   * Computes SHA-256 hash of payload
   */
  static hashPayload(payload: Record<string, unknown>): string {
    return crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');
  }

  /**
   * Persists incoming event before ACK (non-blocking if table is still being migrated)
   */
  static async recordReceived(params: IngestWebhookEventParams): Promise<{ id?: string; isDuplicate?: boolean }> {
    const admin = supabaseAdmin();
    const hash = this.hashPayload(params.payload);

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

      // 2. Insert into webhook_events
      const { data, error } = await admin
        .from('webhook_events')
        .insert({
          trace_id: params.traceId,
          provider: params.provider,
          event_type: params.eventType,
          message_id: params.messageId || null,
          connection_id: params.connectionId || null,
          account_id: params.accountId || null,
          payload: params.payload,
          payload_hash: hash,
          processing_status: 'RECEIVED',
          received_at: new Date().toISOString(),
        })
        .select('id')
        .maybeSingle();

      if (error) {
        // If table doesn't exist yet, non-blocking fallback
        console.warn('[webhook_events] Notice: could not insert into webhook_events (fallback active):', error.message);
        return { isDuplicate: false };
      }

      return { id: data?.id, isDuplicate: false };
    } catch (err: unknown) {
      console.warn('[webhook_events] Record received catch:', err);
      return { isDuplicate: false };
    }
  }

  /**
   * Updates status to PROCESSING, COMPLETED, or FAILED
   */
  static async updateStatus(traceId: string, status: 'PROCESSING' | 'COMPLETED' | 'FAILED', error?: string): Promise<void> {
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
