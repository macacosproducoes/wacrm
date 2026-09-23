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

  // 2. Continuous lightweight background sync with smart throttling
  useEffect(() => {
    let timer: NodeJS.Timeout | null = null;
    let isMounted = true;

    async function tick() {
      if (!isMounted || isSyncingRef.current) return;
      
      const isRefreshDisabled = typeof window !== 'undefined' && (
        Boolean((window as unknown as Record<string, unknown>).DEBUG_DISABLE_INBOX_REFRESH) ||
        Boolean(process.env.NEXT_PUBLIC_DEBUG_DISABLE_INBOX_REFRESH)
      );
      if (isRefreshDisabled) {
        console.log('[TIMELINE] WhatsAppRealtimeBridge: tick SKIPPED (DEBUG_DISABLE_INBOX_REFRESH=true)');
        timer = setTimeout(tick, 10000);
        return;
      }

      // Pause completely if tab is in background / hidden to save connections
      if (typeof document !== 'undefined' && document.hidden) {
        timer = setTimeout(tick, 10000);
        return;
      }

      console.log(`[TIMELINE] ${new Date().toLocaleTimeString('pt-BR')} SOURCE=WhatsAppRealtimeBridge:tick starting sync-realtime`);
      isSyncingRef.current = true;
      let nextDelay = 25000; // 25s base heartbeat to prevent exhausting Supabase connection pool
      try {
        const controller = new AbortController();
        const abortTimeout = setTimeout(() => controller.abort(), 8000);
        const res = await fetch('/api/whatsapp/uazapi/sync-realtime', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          signal: controller.signal,
        });
        clearTimeout(abortTimeout);

        if (!res.ok) {
          nextDelay = 35000;
        }
      } catch {
        nextDelay = 45000;
      } finally {
        isSyncingRef.current = false;
        if (isMounted) {
          timer = setTimeout(tick, nextDelay);
        }
      }
    }

    // Initial trigger after 3s to let the page settle
    timer = setTimeout(tick, 3000);

    // Resync when tab becomes visible after being hidden
    const onVisibility = () => {
      if (document.visibilityState === 'visible' && !isSyncingRef.current) {
        if (timer) clearTimeout(timer);
        timer = setTimeout(tick, 1000);
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
