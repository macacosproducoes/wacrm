import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AutoReplyDebouncer, AutoReplyDebounceArgs } from './auto-reply-debouncer';

describe('AutoReplyDebouncer', () => {
  let debouncer: AutoReplyDebouncer;
  let processorMock: ReturnType<typeof vi.fn<(args: AutoReplyDebounceArgs) => Promise<void>>>;

  const BASE_ARGS: AutoReplyDebounceArgs = {
    accountId: 'acct-1',
    conversationId: 'conv-1',
    contactId: 'contact-1',
    configOwnerUserId: 'user-1',
  };

  beforeEach(() => {
    vi.useFakeTimers();
    processorMock = vi.fn<(args: AutoReplyDebounceArgs) => Promise<void>>().mockImplementation(async () => {
      // Simulate small async work
      await new Promise((r) => setTimeout(r, 50));
    });
    debouncer = new AutoReplyDebouncer(processorMock);
  });

  afterEach(() => {
    debouncer.reset();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  // TESTE 1: 1 mensagem → aguardar → 1 resposta
  it('TESTE 1: 1 message -> waits debounce (15s) -> 1 call to AI processor', async () => {
    debouncer.enqueue({ ...BASE_ARGS, messageId: 'msg-1' }, { debounceMs: 15000 });

    expect(processorMock).not.toHaveBeenCalled();
    expect(debouncer.isPending('conv-1')).toBe(true);

    // Fast-forward 14.9 seconds: still waiting
    vi.advanceTimersByTime(14900);
    expect(processorMock).not.toHaveBeenCalled();

    // Fast-forward past 15 seconds
    await vi.advanceTimersByTimeAsync(200);

    expect(processorMock).toHaveBeenCalledTimes(1);
    expect(processorMock).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: 'conv-1',
      })
    );
    expect(debouncer.isPending('conv-1')).toBe(false);
  });

  // TESTE 2: 3 mensagens rápidas → 1 chamada para IA → 1 resposta
  it('TESTE 2: 3 rapid messages -> timer resets each time -> 1 single AI call', async () => {
    // Message 1 at t = 0s
    debouncer.enqueue({ ...BASE_ARGS, messageId: 'msg-1' }, { debounceMs: 15000 });

    // Advance 4 seconds (t = 4s)
    vi.advanceTimersByTime(4000);
    expect(processorMock).not.toHaveBeenCalled();

    // Message 2 at t = 4s (resets 15s timer)
    debouncer.enqueue({ ...BASE_ARGS, messageId: 'msg-2' }, { debounceMs: 15000 });

    // Advance 5 seconds (t = 9s, 5s since msg-2)
    vi.advanceTimersByTime(5000);
    expect(processorMock).not.toHaveBeenCalled();

    // Message 3 at t = 9s (resets 15s timer)
    debouncer.enqueue({ ...BASE_ARGS, messageId: 'msg-3' }, { debounceMs: 15000 });

    // Advance 14.5s since msg-3 (t = 23.5s): still waiting
    vi.advanceTimersByTime(14500);
    expect(processorMock).not.toHaveBeenCalled();

    // Advance 1s (t = 24.5s): 15s elapsed since msg-3!
    await vi.advanceTimersByTimeAsync(1000);

    expect(processorMock).toHaveBeenCalledTimes(1);
    expect(debouncer.isPending('conv-1')).toBe(false);
  });

  // TESTE 3: cliente manda mensagem → começa a digitar → manda outra → sistema aguarda → 1 resposta
  it('TESTE 3: client sends message -> starts typing -> sends another -> stops typing -> waits -> 1 reply', async () => {
    debouncer.enqueue({ ...BASE_ARGS, messageId: 'msg-1' }, { debounceMs: 15000 });

    // Client starts typing after 3s
    vi.advanceTimersByTime(3000);
    debouncer.notifyPresence('conv-1', true); // typing: true

    // Even if 20 seconds elapse while client is typing, AI must NOT be called
    vi.advanceTimersByTime(20000);
    expect(processorMock).not.toHaveBeenCalled();

    // Client sends another message while typing
    debouncer.enqueue({ ...BASE_ARGS, messageId: 'msg-2' }, { debounceMs: 15000 });
    expect(processorMock).not.toHaveBeenCalled();

    // Client stops typing
    debouncer.notifyPresence('conv-1', false); // typing: false

    // System now waits the debounce period (15s)
    vi.advanceTimersByTime(14000);
    expect(processorMock).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(2000);

    // Exactly 1 AI call made
    expect(processorMock).toHaveBeenCalledTimes(1);
    expect(debouncer.isPending('conv-1')).toBe(false);
  });

  // TESTE 4: mesma mensagem enviada duas vezes pelo webhook → processar apenas uma vez
  it('TESTE 4: duplicate message ID received twice -> processed only once', async () => {
    debouncer.enqueue({ ...BASE_ARGS, messageId: 'duplicate-wamid-123' }, { debounceMs: 15000 });

    // Webhook delivers exact same message 2 seconds later
    vi.advanceTimersByTime(2000);
    debouncer.enqueue({ ...BASE_ARGS, messageId: 'duplicate-wamid-123' }, { debounceMs: 15000 });

    // Should still fire at t = 15s, not reset to t = 17s
    vi.advanceTimersByTime(12900);
    expect(processorMock).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(200);

    expect(processorMock).toHaveBeenCalledTimes(1);
  });

  // TESTE 5: nova mensagem chega enquanto a IA está respondendo → não criar respostas concorrentes ou duplicadas
  it('TESTE 5: new message arrives while AI is generating -> concurrency protected -> queues next cycle cleanly', async () => {
    let resolveFirstAiCall: () => void = () => {};
    const slowProcessor = vi.fn<(args: AutoReplyDebounceArgs) => Promise<void>>().mockImplementation(() => {
      return new Promise<void>((resolve) => {
        resolveFirstAiCall = resolve;
      });
    });

    const concurrentDebouncer = new AutoReplyDebouncer(slowProcessor);

    // Initial message
    concurrentDebouncer.enqueue({ ...BASE_ARGS, messageId: 'msg-1' }, { debounceMs: 15000 });

    // Debounce expires -> starts processing (slowProcessor is pending)
    await vi.advanceTimersByTimeAsync(15000);
    expect(slowProcessor).toHaveBeenCalledTimes(1);

    // WHILE slowProcessor is running, a new message arrives from the client!
    concurrentDebouncer.enqueue({ ...BASE_ARGS, messageId: 'msg-2' }, { debounceMs: 15000 });

    // Crucial: slowProcessor must NOT be called concurrently a 2nd time!
    expect(slowProcessor).toHaveBeenCalledTimes(1);

    // Now first AI execution finishes:
    resolveFirstAiCall();
    await vi.advanceTimersByTimeAsync(10);

    // Still only 1 call finished so far
    expect(slowProcessor).toHaveBeenCalledTimes(1);

    // The new message was automatically placed into a fresh 15s debounce cycle:
    vi.advanceTimersByTime(14000);
    expect(slowProcessor).toHaveBeenCalledTimes(1);

    // Debounce for 2nd cycle expires:
    await vi.advanceTimersByTimeAsync(1500);

    // Now called a second time cleanly, sequenced, with zero concurrency collisions!
    expect(slowProcessor).toHaveBeenCalledTimes(2);

    concurrentDebouncer.reset();
  });

  // TESTE 6: cliente envia várias mensagens com poucos segundos entre elas → todas devem ser interpretadas juntas (max wait limit)
  it('TESTE 6: multiple messages streaming continuously -> flushes at max wait limit (40s)', async () => {
    const maxWaitMs = 40000;
    const debounceMs = 15000;

    // Msg 1 at t = 0s
    debouncer.enqueue({ ...BASE_ARGS, messageId: 'msg-1' }, { debounceMs, maxWaitMs });

    // Msg 2 at t = 10s
    vi.advanceTimersByTime(10000);
    debouncer.enqueue({ ...BASE_ARGS, messageId: 'msg-2' }, { debounceMs, maxWaitMs });

    // Msg 3 at t = 20s
    vi.advanceTimersByTime(10000);
    debouncer.enqueue({ ...BASE_ARGS, messageId: 'msg-3' }, { debounceMs, maxWaitMs });

    // Msg 4 at t = 30s
    vi.advanceTimersByTime(10000);
    debouncer.enqueue({ ...BASE_ARGS, messageId: 'msg-4' }, { debounceMs, maxWaitMs });

    // Msg 5 at t = 38s (2s before max wait limit 40s)
    vi.advanceTimersByTime(8000);
    debouncer.enqueue({ ...BASE_ARGS, messageId: 'msg-5' }, { debounceMs, maxWaitMs });

    // At t = 39.5s: still within max limit
    vi.advanceTimersByTime(1500);
    expect(processorMock).not.toHaveBeenCalled();

    // At t = 40.5s: Max wait limit reached! Flushes accumulated batch
    await vi.advanceTimersByTimeAsync(1000);

    expect(processorMock).toHaveBeenCalledTimes(1);
    expect(debouncer.isPending('conv-1')).toBe(false);
  });
});
