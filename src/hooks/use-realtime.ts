"use client";

import { useEffect, useRef, useCallback, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import type { Message, Conversation } from "@/types";
import type { RealtimeChannel } from "@supabase/supabase-js";

export interface RealtimeEvent<T> {
  eventType: "INSERT" | "UPDATE" | "DELETE";
  new: T;
  old: Partial<T>;
}

export interface RealtimeTelemetry {
  isConnected: boolean;
  connectedAt: string | null;
  disconnectedAt: string | null;
  reconnectAttempts: number;
  lastEventAt: string | null;
}

interface UseRealtimeOptions {
  channelName: string;
  onMessageEvent?: (event: RealtimeEvent<Message>) => void;
  onConversationEvent?: (event: RealtimeEvent<Conversation>) => void;
  enabled?: boolean;
}

export function useRealtime({
  channelName,
  onMessageEvent,
  onConversationEvent,
  enabled = true,
}: UseRealtimeOptions) {
  const channelRef = useRef<RealtimeChannel | null>(null);
  const reconnectTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const reconnectAttemptsRef = useRef(0);

  const [telemetry, setTelemetry] = useState<RealtimeTelemetry>({
    isConnected: false,
    connectedAt: null,
    disconnectedAt: null,
    reconnectAttempts: 0,
    lastEventAt: null,
  });

  const onMessageRef = useRef(onMessageEvent);
  const onConversationRef = useRef(onConversationEvent);
  useEffect(() => {
    onMessageRef.current = onMessageEvent;
    onConversationRef.current = onConversationEvent;
  });

  useEffect(() => {
    if (!enabled) return;

    const supabase = createClient();
    let isMounted = true;
    let activeChannel: RealtimeChannel | null = null;

    async function subscribeWithReconnect() {
      if (!isMounted) return;

      // Clean up any stale channel before subscribing
      if (activeChannel) {
        try {
          await supabase.removeChannel(activeChannel);
        } catch {}
        activeChannel = null;
      }

      // 1. Authenticate WebSocket connection with session JWT before subscribing
      // Essential for Supabase Realtime RLS evaluation on postgres_changes
      try {
        const { data: { session } } = await supabase.auth.getSession();
        if (session?.access_token) {
          await supabase.realtime.setAuth(session.access_token);
        }
      } catch (authErr) {
        console.warn("[realtime] setAuth error:", authErr);
      }

      if (!isMounted) return;

      // Stable channel identifier allows Supabase Realtime to reuse topic
      const activeChannelName = channelName;

      activeChannel = supabase
        .channel(activeChannelName)
        .on(
          "postgres_changes",
          { event: "*", schema: "public", table: "messages" },
          (payload) => {
            const now = new Date().toISOString();
            setTelemetry((prev) => ({ ...prev, lastEventAt: now }));
            onMessageRef.current?.({
              eventType: payload.eventType as RealtimeEvent<Message>["eventType"],
              new: payload.new as Message,
              old: payload.old as Partial<Message>,
            });
          }
        )
        .on(
          "postgres_changes",
          { event: "*", schema: "public", table: "conversations" },
          (payload) => {
            const now = new Date().toISOString();
            setTelemetry((prev) => ({ ...prev, lastEventAt: now }));
            onConversationRef.current?.({
              eventType: payload.eventType as RealtimeEvent<Conversation>["eventType"],
              new: payload.new as Conversation,
              old: payload.old as Partial<Conversation>,
            });
          }
        )
        .subscribe((status, err) => {
          if (!isMounted) return;

          const now = new Date().toISOString();
          if (status === "SUBSCRIBED") {
            reconnectAttemptsRef.current = 0;
            setTelemetry((prev) => ({
              ...prev,
              isConnected: true,
              connectedAt: now,
              reconnectAttempts: 0,
            }));

            if (typeof window !== "undefined") {
              window.dispatchEvent(
                new CustomEvent("wacrm:realtime-status", {
                  detail: { isConnected: true, timestamp: now },
                })
              );
            }
          } else if (status === "CLOSED" || status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
            reconnectAttemptsRef.current += 1;
            setTelemetry((prev) => ({
              ...prev,
              isConnected: false,
              disconnectedAt: now,
              reconnectAttempts: reconnectAttemptsRef.current,
            }));

            if (typeof window !== "undefined") {
              window.dispatchEvent(
                new CustomEvent("wacrm:realtime-status", {
                  detail: { isConnected: false, timestamp: now, error: err },
                })
              );
            }

            // Exponential backoff reconnect: 2s, 4s, 8s, 16s, capped at 30s
            // Prevents rapid reconnect loops flooding Supabase Realtime logs
            const delay = Math.min(2000 * Math.pow(1.5, reconnectAttemptsRef.current - 1), 30000);
            
            if (reconnectTimeoutRef.current) clearTimeout(reconnectTimeoutRef.current);
            reconnectTimeoutRef.current = setTimeout(() => {
              if (isMounted) {
                void subscribeWithReconnect();
              }
            }, delay);
          }
        });

      channelRef.current = activeChannel;
    }

    void subscribeWithReconnect();

    // Listen to internal custom realtime event bridge
    const handleCustomRealtime = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (!detail) return;

      const now = new Date().toISOString();
      setTelemetry((prev) => ({ ...prev, lastEventAt: now }));

      if (detail.message && onMessageRef.current) {
        onMessageRef.current({
          eventType: (detail.eventType as RealtimeEvent<Message>["eventType"]) || "INSERT",
          new: detail.message as Message,
          old: {} as Partial<Message>,
        });
      }

      if (detail.conversation && onConversationRef.current) {
        onConversationRef.current({
          eventType: (detail.eventType as RealtimeEvent<Conversation>["eventType"]) || "UPDATE",
          new: detail.conversation as Conversation,
          old: {} as Partial<Conversation>,
        });
      }
    };

    if (typeof window !== "undefined") {
      window.addEventListener("wacrm:realtime", handleCustomRealtime);
    }

    return () => {
      isMounted = false;
      if (reconnectTimeoutRef.current) clearTimeout(reconnectTimeoutRef.current);
      if (typeof window !== "undefined") {
        window.removeEventListener("wacrm:realtime", handleCustomRealtime);
      }
      if (activeChannel) {
        supabase.removeChannel(activeChannel);
      } else if (channelRef.current) {
        supabase.removeChannel(channelRef.current);
      }
      channelRef.current = null;
      setTelemetry((prev) => ({ ...prev, isConnected: false }));
    };
  }, [channelName, enabled]);

  const unsubscribe = useCallback(() => {
    if (channelRef.current) {
      const supabase = createClient();
      supabase.removeChannel(channelRef.current);
      channelRef.current = null;
      setTelemetry((prev) => ({ ...prev, isConnected: false }));
    }
  }, []);

  return {
    isConnected: telemetry.isConnected,
    telemetry,
    unsubscribe,
  };
}
