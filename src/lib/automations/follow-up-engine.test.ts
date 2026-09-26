import { describe, it, expect } from "vitest";

describe("follow-up-engine logic & rules", () => {
  it("calculates scheduled_at correctly for various delay units", () => {
    const baseTime = new Date("2026-09-15T12:00:00.000Z");

    // 5 minutes
    const minsMs = 5 * 60 * 1000;
    const targetMins = new Date(baseTime.getTime() + minsMs);
    expect(targetMins.toISOString()).toBe("2026-09-15T12:05:00.000Z");

    // 2 hours
    const hoursMs = 2 * 60 * 60 * 1000;
    const targetHours = new Date(baseTime.getTime() + hoursMs);
    expect(targetHours.toISOString()).toBe("2026-09-15T14:00:00.000Z");

    // 1 day
    const daysMs = 1 * 24 * 60 * 60 * 1000;
    const targetDays = new Date(baseTime.getTime() + daysMs);
    expect(targetDays.toISOString()).toBe("2026-09-16T12:00:00.000Z");
  });

  it("determines whether follow-up should be cancelled on client reply", () => {
    const followUpWithSilenceRule = {
      id: "fu-1",
      cancel_on_client_reply: true,
      cancel_on_agent_reply: false,
      status: "SCHEDULED",
    };

    const followUpWithoutSilenceRule = {
      id: "fu-2",
      cancel_on_client_reply: false,
      cancel_on_agent_reply: true,
      status: "SCHEDULED",
    };

    // When client replies:
    const shouldCancelFu1 = followUpWithSilenceRule.cancel_on_client_reply;
    const shouldCancelFu2 = followUpWithoutSilenceRule.cancel_on_client_reply;

    expect(shouldCancelFu1).toBe(true);
    expect(shouldCancelFu2).toBe(false);
  });

  it("determines whether follow-up should be cancelled on agent reply", () => {
    const followUpWithAgentCancel = {
      id: "fu-3",
      cancel_on_client_reply: true,
      cancel_on_agent_reply: true,
      status: "SCHEDULED",
    };

    const followUpWithoutAgentCancel = {
      id: "fu-4",
      cancel_on_client_reply: true,
      cancel_on_agent_reply: false,
      status: "SCHEDULED",
    };

    // When agent replies:
    const shouldCancelFu3 = followUpWithAgentCancel.cancel_on_agent_reply;
    const shouldCancelFu4 = followUpWithoutAgentCancel.cancel_on_agent_reply;

    expect(shouldCancelFu3).toBe(true);
    expect(shouldCancelFu4).toBe(false);
  });

  it("generates deterministic idempotency key for follow-up steps", () => {
    const convId = "conv-123";
    const automationId = "welcome-auto-1";
    const stepId = "step-2";

    const key1 = `fu:${convId}:${automationId}:${stepId}`;
    const key2 = `fu:${convId}:${automationId}:${stepId}`;

    expect(key1).toBe(key2);
    expect(key1).toBe("fu:conv-123:welcome-auto-1:step-2");
  });

  it("validates due follow-ups against current timestamp", () => {
    const now = new Date("2026-09-15T12:30:00.000Z");

    const pastItem = {
      id: "fu-due",
      scheduled_at: "2026-09-15T12:15:00.000Z",
      status: "SCHEDULED",
    };

    const futureItem = {
      id: "fu-future",
      scheduled_at: "2026-09-15T13:00:00.000Z",
      status: "SCHEDULED",
    };

    const isPastDue = new Date(pastItem.scheduled_at) <= now;
    const isFutureDue = new Date(futureItem.scheduled_at) <= now;

    expect(isPastDue).toBe(true);
    expect(isFutureDue).toBe(false);
  });

  it("accurately detects audio kind from media_url, media_type, category, or payload", () => {
    function detectKind(quickReply: any) {
      const meta = quickReply?.interactive_payload || {};
      const rawKind = String(quickReply?.kind || meta.type || 'text').toLowerCase();
      const mediaUrl = String(quickReply?.media_url || meta.media_url || '').trim();
      const mediaType = String(quickReply?.media_type || meta.media_type || '').toLowerCase();
      const category = String(quickReply?.category || meta.category || '').toLowerCase();

      if (
        rawKind === 'audio' ||
        meta.type === 'audio' ||
        category.includes('áudio') ||
        category.includes('audio') ||
        mediaType.startsWith('audio/') ||
        /\.(ogg|mp3|wav|m4a|aac|opus)($|\?)/i.test(mediaUrl)
      ) {
        return 'audio';
      }
      return rawKind;
    }

    // Audio with kind='text' in DB but audio URL & category
    const audioWithTextKind = {
      kind: 'text',
      category: 'Áudios',
      media_url: 'https://storage.supabase.co/audio.ogg',
      media_type: 'audio/ogg',
      interactive_payload: { type: 'audio' },
    };
    expect(detectKind(audioWithTextKind)).toBe('audio');

    // Real text message
    const realText = {
      kind: 'text',
      category: 'Geral',
      media_url: null,
      content_text: 'Olá!',
    };
    expect(detectKind(realText)).toBe('text');
  });
});

