'use client';

import { useEffect, useRef } from 'react';
import { useUazApiSse } from '@/hooks/use-uazapi-sse';
import { toast } from 'sonner';
import { createClient } from '@/lib/supabase/client';
import {
  playPaymentNotificationSound,
  unlockAudioOnFirstInteraction,
} from '@/lib/audio/payment-sound';

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

  // 1a. Unlock audio for browser autoplay policy on first user gesture
  useEffect(() => {
    const cleanup = unlockAudioOnFirstInteraction();
    return cleanup;
  }, []);

  // 1b. Global celebration toast & audio whenever any PIX payment is received in CRM
  useEffect(() => {
    if (typeof window === 'undefined') return;

    // Tracker to prevent double-firing between SSE event and Supabase postgres_changes
    const handledCelebrations = new Set<string>();
    let lastSoundPlayedAt = 0;

    const triggerPaymentCelebration = (
      uniqueId: string | undefined,
      title: string,
      description: string
    ) => {
      const now = Date.now();
      // If we already handled this specific payment/notification within the last 60s, skip
      if (uniqueId && handledCelebrations.has(uniqueId)) {
        return;
      }

      // Enforce minimum 4 seconds gap between sound plays to avoid acoustic echo/repetition
      if (now - lastSoundPlayedAt < 4000) {
        return;
      }

      if (uniqueId) {
        handledCelebrations.add(uniqueId);
        setTimeout(() => handledCelebrations.delete(uniqueId), 60000);
      }
      lastSoundPlayedAt = now;

      toast.success(title, {
        description,
        duration: 8000,
      });

      playPaymentNotificationSound();
    };

    const handleRealtime = (e: any) => {
      const detail = e.detail;
      if (!detail) return;
      const msg = detail.message;
      const isPayment =
        msg?.type === 'payment_received' ||
        msg?.payment_confirmed === true ||
        detail.eventType === 'PAYMENT_RECEIVED' ||
        (msg?.status === 'paid' && (msg?.external_id || msg?.payment_id));

      if (isPayment) {
        const paymentKey = String(msg?.payment_id || msg?.external_id || detail.conversationId || 'pix_' + Date.now());
        const amountNum = typeof msg?.amount === 'number' ? msg.amount : Number(msg?.amount || 0);
        const amountStr = amountNum > 0 ? `R$ ${amountNum.toFixed(2).replace('.', ',')}` : 'PIX';
        const leadName = msg?.buyer?.name || msg?.lead_name || msg?.leadName || 'Cliente';

        triggerPaymentCelebration(
          paymentKey,
          `🎉 PIX Compensado! Pagamento de ${amountStr} confirmado!`,
          `Lead: ${leadName} — Áudio de confirmação liberado automaticamente!`
        );
      }
    };

    window.addEventListener('wacrm:realtime', handleRealtime);

    // Also listen directly to Supabase realtime table 'notifications' for payment rows
    const supabase = createClient();
    const channel = supabase
      .channel('global-payment-notifications-sound')
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'notifications' },
        (payload) => {
          const row = payload.new as Record<string, any>;
          const title = String(row?.title || '').toLowerCase();
          const body = String(row?.body || '').toLowerCase();
          if (title.includes('pagamento') || body.includes('pagamento') || body.includes('recebeu pagamento')) {
            const notifKey = String(row?.id || row?.contact_id || 'notif_' + Date.now());
            triggerPaymentCelebration(
              notifKey,
              row.title || '🎉 Pagamento Recebido!',
              row.body || 'Um novo pagamento foi confirmado no sistema.'
            );
          }
        }
      )
      .subscribe();

    return () => {
      window.removeEventListener('wacrm:realtime', handleRealtime);
      supabase.removeChannel(channel);
    };
  }, []);

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

      if (Boolean((window as unknown as Record<string, unknown>).DEBUG_LOGS)) {
        console.log(`[TIMELINE] ${new Date().toLocaleTimeString('pt-BR')} SOURCE=WhatsAppRealtimeBridge:tick starting sync-realtime`);
      }
      isSyncingRef.current = true;
      let nextDelay = 60000; // 60s base heartbeat to prevent exhausting Supabase connection pool and API log volume
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
          nextDelay = 90000;
        }
      } catch {
        nextDelay = 120000;
      } finally {
        isSyncingRef.current = false;
        if (isMounted) {
          timer = setTimeout(tick, nextDelay);
        }
      }
    }

    // Initial trigger after 15s to let the page settle with 0 contention
    timer = setTimeout(tick, 15000);

    // Periodic check for due conditional follow-ups (every 90s to save Vercel quotas)
    let followUpTimer: NodeJS.Timeout | null = null;
    const checkFollowUps = async () => {
      if (!isMounted || (typeof document !== 'undefined' && document.hidden)) {
        followUpTimer = setTimeout(checkFollowUps, 60000);
        return;
      }
      try {
        await fetch('/api/follow-ups/cron', { method: 'POST' });
      } catch {
        // Silently catch background errors
      } finally {
        if (isMounted) {
          followUpTimer = setTimeout(checkFollowUps, 90000);
        }
      }
    };
    followUpTimer = setTimeout(checkFollowUps, 8000);

    // Resync when tab becomes visible after being hidden
    const onVisibility = () => {
      if (document.visibilityState === 'visible') {
        if (!isSyncingRef.current) {
          if (timer) clearTimeout(timer);
          timer = setTimeout(tick, 5000);
        }
        void fetch('/api/follow-ups/cron', { method: 'POST' }).catch(() => {});
      }
    };

    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('focus', onVisibility);

    return () => {
      isMounted = false;
      if (timer) clearTimeout(timer);
      if (followUpTimer) clearTimeout(followUpTimer);
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('focus', onVisibility);
    };
  }, []);

  return null;
}
