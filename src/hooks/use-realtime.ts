"use client";

import { useEffect, useRef, useCallback, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import type { Message, Conversation } from "@/types";
import type { RealtimeChannel } from "@supabase/supabase-js";

interface RealtimeEvent<T> {
  eventType: "INSERT" | "UPDATE" | "DELETE";
  new: T;
  old: Partial<T>;
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
  const [isConnected, setIsConnected] = useState(false);

  // Store latest callbacks in refs to avoid re-subscribing when the
  // parent re-renders with fresh closures. Assigned inside an effect
  // so the mutation doesn't happen during render (React 19's refs
  // rule) — subscribers only read `.current` inside async Realtime
  // callbacks, which always run after the render that updates it.
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
    let channel: RealtimeChannel | null = null;

    (async () => {
      // Ensure WebSocket connection is authenticated so Supabase RLS allows postgres_changes
      try {
        const { data: { session } } = await supabase.auth.getSession();
        if (session?.access_token) {
          supabase.realtime.setAuth(session.access_token);
        }
      } catch {
        // Non-blocking
      }

      if (!isMounted) return;

      channel = supabase
        .channel(channelName)
        .on(
          "postgres_changes",
          { event: "*", schema: "public", table: "messages" },
          (payload) => {
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
            onConversationRef.current?.({
              eventType: payload.eventType as RealtimeEvent<Conversation>["eventType"],
              new: payload.new as Conversation,
              old: payload.old as Partial<Conversation>,
            });
          }
        )
        .subscribe((status) => {
          if (isMounted) {
            setIsConnected(status === "SUBSCRIBED");
          }
        });

      channelRef.current = channel;
    })();

    // Also listen to internal WhatsApp SSE bridge events for instant local dispatch
    const handleCustomRealtime = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (!detail) return;

      if (detail.message && onMessageRef.current) {
        onMessageRef.current({
          eventType: (detail.eventType as RealtimeEvent<Message>['eventType']) || 'INSERT',
          new: detail.message as Message,
          old: {} as Partial<Message>,
        });
      }

      if (detail.conversation && onConversationRef.current) {
        onConversationRef.current({
          eventType: (detail.eventType as RealtimeEvent<Conversation>['eventType']) || 'UPDATE',
          new: detail.conversation as Conversation,
          old: {} as Partial<Conversation>,
        });
      }
    };

    if (typeof window !== 'undefined') {
      window.addEventListener('wacrm:realtime', handleCustomRealtime);
    }

    return () => {
      isMounted = false;
      if (typeof window !== 'undefined') {
        window.removeEventListener('wacrm:realtime', handleCustomRealtime);
      }
      if (channel) {
        supabase.removeChannel(channel);
      } else if (channelRef.current) {
        supabase.removeChannel(channelRef.current);
      }
      channelRef.current = null;
      setIsConnected(false);
    };
  }, [channelName, enabled]);

  const unsubscribe = useCallback(() => {
    if (channelRef.current) {
      const supabase = createClient();
      supabase.removeChannel(channelRef.current);
      channelRef.current = null;
      setIsConnected(false);
    }
  }, []);

  return { isConnected, unsubscribe };
}
