'use client';

import { useEffect, useRef } from 'react';
import { createClient } from '@/lib/supabase/client';

interface UseUazApiSseOptions {
  enabled?: boolean;
  onEvent?: (data: Record<string, unknown>) => void;
  onMessage?: (data: Record<string, unknown>) => void;
}

/**
 * Hook to connect to the local UazAPI SSE bridge.
 * Receives real-time WhatsApp events without needing public webhook tunnels.
 */
export function useUazApiSse({
  enabled = true,
  onEvent,
  onMessage,
}: UseUazApiSseOptions = {}) {
  const eventSourceRef = useRef<EventSource | null>(null);
  const reconnectTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  const onEventRef = useRef(onEvent);
  const onMessageRef = useRef(onMessage);
  useEffect(() => {
    onEventRef.current = onEvent;
    onMessageRef.current = onMessage;
  });

  useEffect(() => {
    if (!enabled || typeof window === 'undefined') return;

    let isMounted = true;
    let reconnectDelay = 1000;

    async function connect() {
      if (!isMounted) return;

      try {
        let tokenQuery = '';
        try {
          const supabase = createClient();
          const { data } = await supabase.auth.getSession();
          if (data.session?.access_token) {
            tokenQuery = `?access_token=${encodeURIComponent(data.session.access_token)}`;
          }
        } catch {
          // Fallback to cookie
        }

        if (!isMounted) return;

        const es = new EventSource(`/api/whatsapp/uazapi/sse${tokenQuery}`);
        eventSourceRef.current = es;

        es.onopen = () => {
          reconnectDelay = 1000;
        };

        es.onmessage = (e) => {
          if (!isMounted) return;
          try {
            const parsed = JSON.parse(e.data);
            if (onEventRef.current) onEventRef.current(parsed);
            if (onMessageRef.current) onMessageRef.current(parsed);

            // Dispatch global event for zero-latency UI updates across all components
            window.dispatchEvent(new CustomEvent('wacrm:realtime', { detail: parsed }));
            if (parsed.message) {
              window.dispatchEvent(
                new CustomEvent('wacrm:realtime-message', { detail: parsed.message })
              );
            }
          } catch {
            // Non-JSON or keep-alive comment
          }
        };

        es.onerror = () => {
          if (!isMounted) return;
          es.close();
          // Attempt fast reconnect
          if (reconnectTimeoutRef.current) clearTimeout(reconnectTimeoutRef.current);
          reconnectTimeoutRef.current = setTimeout(() => {
            if (isMounted) void connect();
          }, reconnectDelay);
          reconnectDelay = Math.min(reconnectDelay * 1.5, 10000);
        };
      } catch {
        // EventSource unsupported or failed
      }
    }

    void connect();

    return () => {
      isMounted = false;
      if (eventSourceRef.current) {
        eventSourceRef.current.close();
        eventSourceRef.current = null;
      }
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
      }
    };
  }, [enabled]);
}
