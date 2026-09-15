import { EventEmitter } from 'events';

export interface WhatsAppInboxEvent {
  accountId: string;
  conversationId?: string;
  eventType: 'INSERT' | 'UPDATE' | 'DELETE' | 'SYNC';
  message?: Record<string, unknown>;
  conversation?: Record<string, unknown>;
  timestamp: string;
}

class WhatsAppBus extends EventEmitter {
  constructor() {
    super();
    this.setMaxListeners(200);
  }

  emitInboxEvent(event: Omit<WhatsAppInboxEvent, 'timestamp'>) {
    const fullEvent: WhatsAppInboxEvent = {
      ...event,
      timestamp: new Date().toISOString(),
    };
    this.emit(`inbox:${event.accountId}`, fullEvent);
    this.emit('inbox:*', fullEvent);
  }

  onAccount(accountId: string, handler: (event: WhatsAppInboxEvent) => void) {
    const channel = `inbox:${accountId}`;
    this.on(channel, handler);
    return () => {
      this.off(channel, handler);
    };
  }
}

declare global {
  // eslint-disable-next-line no-var
  var __whatsappBus: WhatsAppBus | undefined;
}

export const whatsappBus = globalThis.__whatsappBus || new WhatsAppBus();

if (process.env.NODE_ENV !== 'production') {
  globalThis.__whatsappBus = whatsappBus;
}
