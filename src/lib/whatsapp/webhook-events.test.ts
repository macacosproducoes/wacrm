import { describe, it, expect, vi } from 'vitest';
import { WebhookEventManager } from './webhook-events';
import { TraceLogger } from './trace';
import { parseFollowerOrder } from '@/lib/orders/follower-order-handler';

describe('Webhook & Order Processing Tests', () => {
  it('generates consistent payload hashes for idempotency', () => {
    const p1 = { message: 'hello', from: '123' };
    const p2 = { message: 'hello', from: '123' };
    expect(WebhookEventManager.hashPayload(p1)).toBe(WebhookEventManager.hashPayload(p2));
  });

  it('TraceLogger creates and formats milestone steps accurately', () => {
    const traceId = TraceLogger.generateTraceId();
    expect(traceId).toBeTruthy();
    expect(traceId.startsWith('trc_')).toBe(true);

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    TraceLogger.log(traceId, '01', 'UAZAPI RECEIVED', { test: true });
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining(`[TRACE ${traceId}] [01] UAZAPI RECEIVED`)
    );
    logSpy.mockRestore();
  });

  it('correctly handles Portuguese follower order variations', () => {
    const variations = [
      'Sou @cristiano, quero 5.000 seguidores',
      'Sou o @cristiano quero 5.000 seguidores',
      'eu sou @cristiano e quero 5000 seguidores',
      'Olá @cristiano quer 10.000 seguidores',
    ];

    for (const msg of variations) {
      const parsed = parseFollowerOrder(msg);
      expect(parsed.isFollowerOrder).toBe(true);
      expect(parsed.username).toBe('cristiano');
      expect(parsed.quantity).toBeGreaterThanOrEqual(5000);
    }
  });

  it('does not falsely detect orders in ordinary conversation', () => {
    const nonOrders = [
      'Oi',
      'Pode confirmar?',
      'Tudo bem com você?',
      'Já paguei o pedido anterior',
    ];

    for (const msg of nonOrders) {
      const parsed = parseFollowerOrder(msg);
      expect(parsed.isFollowerOrder).toBe(false);
    }
  });
});
