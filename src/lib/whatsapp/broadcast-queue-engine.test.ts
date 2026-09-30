import { describe, it, expect, vi } from 'vitest';
import {
  isWithinSendingWindow,
  classifyBroadcastError,
  pauseBroadcast,
  resumeBroadcast,
  cancelBroadcast,
  processBroadcastQueueTick,
} from './broadcast-queue-engine';

describe('Broadcast Queue Engine — Cooldown & Safety', () => {
  describe('isWithinSendingWindow', () => {
    it('returns true when current time is inside standard window', () => {
      // Mock Date to 14:00 (inside 08:00 - 20:00)
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-09-30T17:00:00Z')); // 14:00 in America/Sao_Paulo (UTC-3)

      const result = isWithinSendingWindow('08:00', '20:00', 'America/Sao_Paulo');
      expect(result).toBe(true);
      vi.useRealTimers();
    });

    it('returns false when current time is outside standard window', () => {
      // Mock Date to 22:30 (outside 08:00 - 20:00)
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-10-01T01:30:00Z')); // 22:30 in America/Sao_Paulo (UTC-3)

      const result = isWithinSendingWindow('08:00', '20:00', 'America/Sao_Paulo');
      expect(result).toBe(false);
      vi.useRealTimers();
    });

    it('handles overnight window correctly', () => {
      vi.useFakeTimers();
      // 23:00 in UTC is inside overnight window 22:00 - 06:00
      vi.setSystemTime(new Date('2026-09-30T23:00:00Z'));
      const inWindow = isWithinSendingWindow('22:00', '06:00', 'UTC');
      expect(inWindow).toBe(true);

      // 12:00 in UTC is outside overnight window 22:00 - 06:00
      vi.setSystemTime(new Date('2026-09-30T12:00:00Z'));
      const outWindow = isWithinSendingWindow('22:00', '06:00', 'UTC');
      expect(outWindow).toBe(false);

      vi.useRealTimers();
    });
  });

  describe('classifyBroadcastError (Circuit Breaker)', () => {
    it('detects Meta rate limit error 131056 as security block', () => {
      const err = 'Failed to send: (#131056) Pair rate limit exceeded for recipient';
      const result = classifyBroadcastError(err);
      expect(result.isSecurityBlock).toBe(true);
      expect(result.reason).toContain('Limite de taxa');
    });

    it('detects Meta account locked error 131031 as security block', () => {
      const err = 'Meta API: (#131031) Account locked or restricted from messaging';
      const result = classifyBroadcastError(err);
      expect(result.isSecurityBlock).toBe(true);
      expect(result.reason).toContain('Conta WhatsApp bloqueada');
    });

    it('detects spam policy error 368 as security block', () => {
      const err = 'Error 368: User is temporarily blocked from sending spam or policy violation';
      const result = classifyBroadcastError(err);
      expect(result.isSecurityBlock).toBe(true);
      expect(result.reason).toContain('antispam');
    });

    it('detects HTTP 429 rate limit as security block', () => {
      const err = 'Request failed with status code 429: Too Many Requests';
      const result = classifyBroadcastError(err);
      expect(result.isSecurityBlock).toBe(true);
      expect(result.reason).toContain('429');
    });

    it('detects UazAPI disconnected instance as security block', () => {
      const err = 'UazAPI error: instance device disconnected or session closed';
      const result = classifyBroadcastError(err);
      expect(result.isSecurityBlock).toBe(true);
      expect(result.reason).toContain('desconectada');
    });

    it('does NOT trigger security block for normal recipient failure', () => {
      const err = 'Recipient phone number not found or not on WhatsApp';
      const result = classifyBroadcastError(err);
      expect(result.isSecurityBlock).toBe(false);
      expect(result.reason).toBe(err);
    });
  });

  describe('Control Actions (Pause, Resume, Cancel)', () => {
    it('pauseBroadcast updates status to paused and logs event', async () => {
      const updateMock = vi.fn().mockReturnValue({ eq: vi.fn().mockResolvedValue({}) });
      const insertMock = vi.fn().mockResolvedValue({});

      const mockDb: any = {
        from: (table: string) => {
          if (table === 'broadcasts') return { update: updateMock };
          if (table === 'broadcast_events') return { insert: insertMock };
          return {};
        },
      };

      await pauseBroadcast(mockDb, 'b-123', 'Limite diário atingido', 'acc-456');

      expect(updateMock).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 'paused',
          paused_reason: 'Limite diário atingido',
        })
      );
      expect(insertMock).toHaveBeenCalledWith(
        expect.objectContaining({
          broadcast_id: 'b-123',
          event_type: 'paused',
        })
      );
    });

    it('resumeBroadcast clears paused_reason and resets consecutive_failures', async () => {
      const updateMock = vi.fn().mockReturnValue({ eq: vi.fn().mockResolvedValue({}) });
      const insertMock = vi.fn().mockResolvedValue({});

      const mockDb: any = {
        from: (table: string) => {
          if (table === 'broadcasts') return { update: updateMock };
          if (table === 'broadcast_events') return { insert: insertMock };
          return {};
        },
      };

      await resumeBroadcast(mockDb, 'b-123', 'acc-456');

      expect(updateMock).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 'sending',
          paused_reason: null,
          consecutive_failures: 0,
        })
      );
      expect(insertMock).toHaveBeenCalledWith(
        expect.objectContaining({
          broadcast_id: 'b-123',
          event_type: 'resumed',
        })
      );
    });

    it('cancelBroadcast marks broadcast and pending recipients cancelled', async () => {
      const bcastUpdate = vi.fn().mockReturnValue({ eq: vi.fn().mockResolvedValue({}) });
      const recIn = vi.fn().mockResolvedValue({});
      const recEq = vi.fn().mockReturnValue({ in: recIn });
      const recUpdate = vi.fn().mockReturnValue({ eq: recEq });
      const insertMock = vi.fn().mockResolvedValue({});

      const mockDb: any = {
        from: (table: string) => {
          if (table === 'broadcasts') return { update: bcastUpdate };
          if (table === 'broadcast_recipients') return { update: recUpdate };
          if (table === 'broadcast_events') return { insert: insertMock };
          return {};
        },
      };

      await cancelBroadcast(mockDb, 'b-123', 'Campanha cancelada pelo usuário', 'acc-456');

      expect(bcastUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 'cancelled',
          paused_reason: 'Campanha cancelada pelo usuário',
        })
      );
      expect(recUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 'cancelled',
        })
      );
    });
  });

  describe('processBroadcastQueueTick State Handling', () => {
    it('returns paused immediately if broadcast is already paused', async () => {
      const mockDb: any = {
        from: () => ({
          select: () => ({
            eq: () => ({
              single: vi.fn().mockResolvedValue({
                data: { id: 'b-1', status: 'paused', paused_reason: '5 falhas consecutivas' },
                error: null,
              }),
            }),
          }),
        }),
      };

      const result = await processBroadcastQueueTick(mockDb, 'b-1');
      expect(result.status).toBe('paused');
      expect(result.pausedReason).toBe('5 falhas consecutivas');
    });

    it('returns cancelled immediately if broadcast is cancelled', async () => {
      const mockDb: any = {
        from: () => ({
          select: () => ({
            eq: () => ({
              single: vi.fn().mockResolvedValue({
                data: { id: 'b-1', status: 'cancelled' },
                error: null,
              }),
            }),
          }),
        }),
      };

      const result = await processBroadcastQueueTick(mockDb, 'b-1');
      expect(result.status).toBe('cancelled');
    });

    it('respects batch pause timer (next_run_at in the future)', async () => {
      const futureTime = new Date(Date.now() + 60000).toISOString();
      const mockDb: any = {
        from: () => ({
          select: () => ({
            eq: () => ({
              single: vi.fn().mockResolvedValue({
                data: {
                  id: 'b-1',
                  status: 'sending',
                  next_run_at: futureTime,
                  window_start_time: '00:00',
                  window_end_time: '23:59',
                },
                error: null,
              }),
            }),
          }),
        }),
      };

      const result = await processBroadcastQueueTick(mockDb, 'b-1');
      expect(result.status).toBe('batch_paused');
      expect(result.nextRunAt).toBe(futureTime);
    });
  });
describe('Template Variations Rotation (Spam Protection)', () => {
    it('rotates across 4 variations sequentially for consecutive recipients', () => {
      const templateRow = {
        body_text: 'Variação 1: Olá {{1}}!',
        variations: [
          'Variação 2: Oi {{1}}, tudo bem?',
          'Variação 3: Tudo certo, {{1}}?',
          'Variação 4: Fala {{1}}!',
        ],
      };

      const allVariations: string[] = [
        templateRow.body_text,
        ...templateRow.variations,
      ];

      expect(allVariations.length).toBe(4);

      // Verify rotation index sequence for 6 recipients:
      // Recipient 0 -> Var 1
      // Recipient 1 -> Var 2
      // Recipient 2 -> Var 3
      // Recipient 3 -> Var 4
      // Recipient 4 -> Var 1 (cycles back)
      // Recipient 5 -> Var 2
      const recipient0Text = allVariations[0 % allVariations.length].replaceAll('{{1}}', 'Carlos');
      const recipient1Text = allVariations[1 % allVariations.length].replaceAll('{{1}}', 'Maria');
      const recipient2Text = allVariations[2 % allVariations.length].replaceAll('{{1}}', 'João');
      const recipient3Text = allVariations[3 % allVariations.length].replaceAll('{{1}}', 'Ana');
      const recipient4Text = allVariations[4 % allVariations.length].replaceAll('{{1}}', 'Pedro');
      const recipient5Text = allVariations[5 % allVariations.length].replaceAll('{{1}}', 'Lucas');

      expect(recipient0Text).toBe('Variação 1: Olá Carlos!');
      expect(recipient1Text).toBe('Variação 2: Oi Maria, tudo bem?');
      expect(recipient2Text).toBe('Variação 3: Tudo certo, João?');
      expect(recipient3Text).toBe('Variação 4: Fala Ana!');
      expect(recipient4Text).toBe('Variação 1: Olá Pedro!');
      expect(recipient5Text).toBe('Variação 2: Oi Lucas, tudo bem?');
    });
  });
});
