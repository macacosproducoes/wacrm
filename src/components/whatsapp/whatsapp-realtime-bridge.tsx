'use client';

import { useEffect, useRef } from 'react';
import { useUazApiSse } from '@/hooks/use-uazapi-sse';

/**
 * Global Realtime Bridge for WhatsApp.
 * Mounts in the dashboard shell to guarantee 0-latency real-time synchronization
 * across the entire application (Inbox, Contacts, Dashboard, Settings, etc.).
 *
 * Combines:
 * 1. Persistent local SSE stream (/api/whatsapp/uazapi/sse) for 0ms push.
 * 2. Ultra-fast background heartbeat (/api/whatsapp/uazapi/sync-realtime) every 3.5s
 *    to ensure that even during network blips or tab throttle, messages are captured
 *    and AI answers within seconds.
 */
export function WhatsAppRealtimeBridge() {
  const isSyncingRef = useRef(false);

  // 1. Listen to real-time events via internal SSE bridge
  useUazApiSse({
    enabled: true,
  });

  // 2. Continuous lightweight background sync (runs in ~100ms)
  useEffect(() => {
    let timer: NodeJS.Timeout | null = null;
    let isMounted = true;

    async function tick() {
      if (!isMounted || isSyncingRef.current) return;
      isSyncingRef.current = true;
      let nextDelay = 3000;
      try {
        const res = await fetch('/api/whatsapp/uazapi/sync-realtime', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
        });
        if (!res.ok) {
          // If disconnected or error, back off to 8s to prevent hammering
          nextDelay = 8000;
        }
      } catch {
        nextDelay = 10000;
      } finally {
        isSyncingRef.current = false;
        if (isMounted) {
          timer = setTimeout(tick, nextDelay);
        }
      }
    }

    // Initial trigger
    timer = setTimeout(tick, 1000);

    // Resync immediately when tab becomes visible or gains focus
    const onVisibility = () => {
      if (document.visibilityState === 'visible') {
        void fetch('/api/whatsapp/uazapi/sync-realtime', { method: 'POST' }).catch(() => {});
      }
    };

    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('focus', onVisibility);

    return () => {
      isMounted = false;
      if (timer) clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('focus', onVisibility);
    };
  }, []);

  return null;
}
