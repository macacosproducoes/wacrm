import type { SupabaseClient } from '@supabase/supabase-js';
import { whatsappBus } from '@/lib/whatsapp/whatsapp-bus';

export interface AiExecutionStep {
  name: string;
  status: 'success' | 'skipped' | 'warning' | 'error' | 'info';
  detail: string;
  timestamp: string;
}

export interface AiTraceData {
  status: 'replied' | 'skipped' | 'handed_off' | 'error' | 'processing';
  reason: string;
  summaryText?: string;
  steps: AiExecutionStep[];
  updatedAt: string;
  model?: string;
  provider?: string;
}

/**
 * Parses raw ai_handoff_summary column into structured AiTraceData.
 * Supports JSON trace objects, prefixed strings, and legacy plain text notes.
 */
export function parseAiTrace(raw: string | null | undefined): AiTraceData | null {
  if (!raw || typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;

  try {
    if (trimmed.startsWith('{')) {
      const parsed = JSON.parse(trimmed) as AiTraceData;
      if (parsed && typeof parsed === 'object' && parsed.status) {
        return parsed;
      }
    }
    if (trimmed.startsWith('[AI_TRACE]')) {
      const parsed = JSON.parse(trimmed.slice(10)) as AiTraceData;
      if (parsed && typeof parsed === 'object' && parsed.status) {
        return parsed;
      }
    }
  } catch {
    // Fall back to plain text interpretation
  }

  // Legacy or plain text string
  const isSkip = trimmed.toLowerCase().includes('não responderá') || trimmed.toLowerCase().includes('skip') || trimmed.toLowerCase().includes('veto');
  return {
    status: isSkip ? 'skipped' : 'handed_off',
    reason: trimmed,
    summaryText: trimmed,
    steps: [
      {
        name: 'Registro de Avaliação',
        status: isSkip ? 'skipped' : 'warning',
        detail: trimmed,
        timestamp: new Date().toISOString(),
      },
    ],
    updatedAt: new Date().toISOString(),
  };
}

/**
 * Persists the AI decision (replied, skipped, handed_off, error) and detailed steps
 * to conversations.ai_handoff_summary, and immediately broadcasts via WhatsApp Realtime Bus.
 */
export async function recordAiDecision(
  db: SupabaseClient,
  args: {
    conversationId: string;
    accountId: string;
    status: 'replied' | 'skipped' | 'handed_off' | 'error' | 'processing';
    reason: string;
    steps: AiExecutionStep[];
    model?: string;
    provider?: string;
    extraUpdate?: Record<string, unknown>;
  }
): Promise<void> {
  const { conversationId, accountId, status, reason, steps, model, provider, extraUpdate } = args;
  const now = new Date().toISOString();

  const traceData: AiTraceData = {
    status,
    reason,
    summaryText: reason,
    steps,
    updatedAt: now,
    model,
    provider,
  };

  const serialized = JSON.stringify(traceData);

  try {
    await db
      .from('conversations')
      .update({
        ai_handoff_summary: serialized,
        ...(extraUpdate || {}),
      })
      .eq('id', conversationId);

    // 0ms Real-time broadcast to all connected agents
    whatsappBus.emitInboxEvent({
      accountId,
      conversationId,
      eventType: 'UPDATE',
      conversation: {
        id: conversationId,
        ai_handoff_summary: serialized,
        ...(extraUpdate || {}),
      },
    });
  } catch (err) {
    console.error('[ai-trace] Error recording AI decision trace:', err);
  }
}
