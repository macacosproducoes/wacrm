/**
 * Auto-reply Debouncer & Message Grouping Coordinator
 *
 * Prevents fragmented AI replies by batching consecutive customer messages
 * within a configurable time window (default 15s) up to a max wait limit (default 40s).
 *
 * Respects customer typing presence (pauses while composing) and prevents concurrent
 * AI runs on the same conversation thread (concurrency mutex).
 */

export interface AutoReplyDebounceArgs {
  accountId: string;
  conversationId: string;
  contactId: string;
  configOwnerUserId: string;
  messageId?: string;
}

export interface DebouncerOptions {
  debounceMs?: number;
  maxWaitMs?: number;
  processor?: (args: AutoReplyDebounceArgs) => Promise<void>;
}

export function getDebounceMs(): number {
  const val = Number(process.env.MESSAGE_DEBOUNCE_MS);
  return Number.isFinite(val) && val > 0 ? val : 15000; // 15 seconds default
}

export function getMaxWaitMs(): number {
  const val = Number(process.env.MESSAGE_MAX_WAIT_MS);
  return Number.isFinite(val) && val > 0 ? val : 40000; // 40 seconds default
}

interface ConversationDebounceState {
  args: AutoReplyDebounceArgs;
  messageIds: Set<string>;
  firstMessageAt: number;
  lastMessageAt: number;
  isClientTyping: boolean;
  isAiProcessing: boolean;
  hasPendingInboundWhileProcessing: boolean;
  timer: ReturnType<typeof setTimeout> | null;
  debounceMs: number;
  maxWaitMs: number;
  processor: (args: AutoReplyDebounceArgs) => Promise<void>;
}

export class AutoReplyDebouncer {
  private states = new Map<string, ConversationDebounceState>();
  private defaultProcessor: ((args: AutoReplyDebounceArgs) => Promise<void>) | null = null;

  constructor(defaultProcessor?: (args: AutoReplyDebounceArgs) => Promise<void>) {
    if (defaultProcessor) {
      this.defaultProcessor = defaultProcessor;
    }
  }

  public setDefaultProcessor(fn: (args: AutoReplyDebounceArgs) => Promise<void>) {
    this.defaultProcessor = fn;
  }

  /**
   * Enqueue an incoming message into the conversation's debounce batch.
   */
  public enqueue(args: AutoReplyDebounceArgs, options?: DebouncerOptions): void {
    const { conversationId, messageId } = args;
    const debounceMs = options?.debounceMs ?? getDebounceMs();
    const maxWaitMs = options?.maxWaitMs ?? getMaxWaitMs();
    const processor = options?.processor ?? this.defaultProcessor;

    if (!processor) {
      throw new Error('[ai-debouncer] No processor registered for auto-reply execution.');
    }

    let state = this.states.get(conversationId);

    // 1. New batch initialization
    if (!state) {
      state = {
        args,
        messageIds: new Set(messageId ? [messageId] : []),
        firstMessageAt: Date.now(),
        lastMessageAt: Date.now(),
        isClientTyping: false,
        isAiProcessing: false,
        hasPendingInboundWhileProcessing: false,
        timer: null,
        debounceMs,
        maxWaitMs,
        processor,
      };
      this.states.set(conversationId, state);

      console.log(
        `[ai-debouncer] Started debounce timer (${debounceMs}ms) for conversation ${conversationId}. Initial message registered.`
      );

      this.scheduleTimer(state);
      return;
    }

    // 2. Check duplicate message in same batch (idempotency guard)
    if (messageId && state.messageIds.has(messageId)) {
      console.log(`[ai-debouncer] Duplicate message ${messageId} ignored in debounce batch for conversation ${conversationId}.`);
      return;
    }
    if (messageId) {
      state.messageIds.add(messageId);
    }

    state.lastMessageAt = Date.now();
    state.args = { ...state.args, ...args }; // update latest contact/user IDs if needed

    // 3. Concurrency check: If AI is actively generating for this thread, queue for next cycle
    if (state.isAiProcessing) {
      state.hasPendingInboundWhileProcessing = true;
      console.log(
        `[ai-debouncer] New message arrived while AI is processing conversation ${conversationId}. Flagged pending for next cycle.`
      );
      return;
    }

    // 4. If client is actively typing, don't tick timer — wait for stop
    if (state.isClientTyping) {
      console.log(
        `[ai-debouncer] Message added to batch while client is typing in conversation ${conversationId}. Waiting for client to stop typing.`
      );
      return;
    }

    // 5. Existing batch: calculate elapsed time against max wait ceiling
    const elapsed = Date.now() - state.firstMessageAt;
    if (elapsed + debounceMs >= maxWaitMs) {
      const remainingTime = Math.max(0, maxWaitMs - elapsed);
      if (remainingTime <= 0) {
        console.log(
          `[ai-debouncer] Max wait limit reached (${maxWaitMs}ms) for conversation ${conversationId}. Flushing batch now.`
        );
        this.clearTimer(state);
        void this.flush(conversationId);
      } else {
        console.log(
          `[ai-debouncer] Max wait limit approaching for conversation ${conversationId}. Capping remaining wait to ${remainingTime}ms.`
        );
        this.clearTimer(state);
        state.timer = setTimeout(() => {
          void this.flush(conversationId);
        }, remainingTime);
      }
    } else {
      // Reset debounce timer
      console.log(
        `[ai-debouncer] Additional message received for conversation ${conversationId}. Batch size now: ${state.messageIds.size}. Resetting debounce timer (+${debounceMs}ms). Elapsed: ${elapsed}ms.`
      );
      this.clearTimer(state);
      this.scheduleTimer(state);
    }
  }

  /**
   * Notify client typing status (presence).
   * While the client is typing (composing/recording), we pause the timer.
   * When the client stops typing, we resume/reset the debounce timer.
   */
  public notifyPresence(conversationId: string, isTyping: boolean): void {
    const state = this.states.get(conversationId);
    if (!state) return;

    if (isTyping) {
      if (!state.isClientTyping) {
        state.isClientTyping = true;
        this.clearTimer(state);
        console.log(
          `[ai-debouncer] Client started typing in conversation ${conversationId}. Pausing debounce timer.`
        );
      }
    } else {
      if (state.isClientTyping) {
        state.isClientTyping = false;
        console.log(
          `[ai-debouncer] Client stopped typing in conversation ${conversationId}. Resuming debounce timer (${state.debounceMs}ms).`
        );
        // Resume debounce timer if not currently in active AI run
        if (!state.isAiProcessing) {
          const elapsed = Date.now() - state.firstMessageAt;
          const waitTime = Math.min(state.debounceMs, Math.max(1000, state.maxWaitMs - elapsed));
          this.clearTimer(state);
          state.timer = setTimeout(() => {
            void this.flush(conversationId);
          }, waitTime);
        }
      }
    }
  }

  /**
   * Flush and execute the AI response for a conversation.
   */
  public async flush(conversationId: string): Promise<void> {
    const state = this.states.get(conversationId);
    if (!state) return;

    this.clearTimer(state);

    if (state.isAiProcessing) {
      state.hasPendingInboundWhileProcessing = true;
      return;
    }

    state.isAiProcessing = true;
    const batchSize = Math.max(1, state.messageIds.size);

    console.log(
      `[ai-debouncer] Debounce window ended for conversation ${conversationId}. Grouped batch count: ${batchSize}. Executing AI auto-reply pipeline.`
    );

    try {
      await state.processor(state.args);
      console.log(`[ai-debouncer] AI response generated and dispatched successfully for conversation ${conversationId}.`);
    } catch (err) {
      console.error(`[ai-debouncer] Error during AI reply execution for conversation ${conversationId}:`, err);
    } finally {
      state.isAiProcessing = false;

      // If new messages arrived while AI was generating the answer:
      if (state.hasPendingInboundWhileProcessing) {
        state.hasPendingInboundWhileProcessing = false;
        state.firstMessageAt = Date.now();
        state.lastMessageAt = Date.now();
        state.messageIds.clear();

        console.log(
          `[ai-debouncer] Cycle finished with pending messages for conversation ${conversationId}. Starting new debounce cycle.`
        );
        this.scheduleTimer(state);
      } else {
        this.states.delete(conversationId);
        console.log(`[ai-debouncer] Cycle finished. Conversation ${conversationId} debounce state cleared.`);
      }
    }
  }

  /**
   * Check if a conversation has an active debounce timer or is currently processing.
   */
  public isPending(conversationId: string): boolean {
    return this.states.has(conversationId);
  }

  /**
   * Cancel and clear debounce for a conversation (e.g. if agent takes over).
   */
  public cancel(conversationId: string): void {
    const state = this.states.get(conversationId);
    if (state) {
      this.clearTimer(state);
      this.states.delete(conversationId);
      console.log(`[ai-debouncer] Debounce cancelled for conversation ${conversationId}.`);
    }
  }

  /**
   * Clear all active states (useful in test teardown).
   */
  public reset(): void {
    for (const state of this.states.values()) {
      this.clearTimer(state);
    }
    this.states.clear();
  }

  private scheduleTimer(state: ConversationDebounceState): void {
    this.clearTimer(state);
    state.timer = setTimeout(() => {
      void this.flush(state.args.conversationId);
    }, state.debounceMs);
  }

  private clearTimer(state: ConversationDebounceState): void {
    if (state.timer !== null) {
      clearTimeout(state.timer);
      state.timer = null;
    }
  }
}

// Global singleton instance
export const autoReplyDebouncer = new AutoReplyDebouncer();

/**
 * Top-level convenience functions
 */
export function enqueueInboundForAiReply(args: AutoReplyDebounceArgs, options?: DebouncerOptions): void {
  autoReplyDebouncer.enqueue(args, options);
}

export function notifyClientPresence(conversationId: string, isTyping: boolean): void {
  autoReplyDebouncer.notifyPresence(conversationId, isTyping);
}
