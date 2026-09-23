"use client";

import { Suspense, useState, useCallback, useEffect, useRef } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { createClient } from "@/lib/supabase/client";
import {
  CONVERSATION_SELECT,
  normalizeConversation,
} from "@/lib/inbox/conversations";
import type { Conversation, Message, Contact, ConversationStatus } from "@/types";
import { useRealtime } from "@/hooks/use-realtime";
import { ConversationList } from "@/components/inbox/conversation-list";
import { MessageThread } from "@/components/inbox/message-thread";
import { ContactSidebar } from "@/components/inbox/contact-sidebar";
import { toast } from "sonner";
import { WifiOff } from "lucide-react";
import { cn } from "@/lib/utils";
import { useUazApiSse } from "@/hooks/use-uazapi-sse";
import { RealtimeStatusBar } from "@/components/inbox/realtime-status-bar";
import { useAuth } from "@/hooks/use-auth";
import { ErrorBoundary } from "@/components/ui/error-boundary";

// Remembers the agent's show/hide choice for the desktop contact panel
// across reloads and sessions (device-scoped, like the theme prefs).
const CONTACT_PANEL_STORAGE_KEY = "wacrm:inbox:contact-panel-open";

// `useSearchParams` (the `?c=<id>` deep link below) requires a Suspense
// boundary or the production build bails to CSR and errors out. Thin
// wrapper supplies it; the inner component holds all the inbox state.
export default function InboxPage() {
  return (
    <Suspense fallback={null}>
      <InboxPageInner />
    </Suspense>
  );
}

function InboxPageInner() {
  const t = useTranslations("Inbox.page");
  const router = useRouter();
  const searchParams = useSearchParams();
  /**
   * `?c=<id>` deep-link support. Used when landing here from the
   * dashboard's recent-conversations list so the right thread opens
   * automatically instead of showing the empty center panel.
   */
  const deepLinkConvId = searchParams.get("c");
  const { user, accountId } = useAuth();

  // Diagnostic Flag (ETAPA 9): DEBUG_DISABLE_INBOX_REALTIME
  const isRealtimeDisabled = typeof window !== "undefined" && (
    Boolean((window as unknown as Record<string, unknown>).DEBUG_DISABLE_INBOX_REALTIME) ||
    Boolean(process.env.NEXT_PUBLIC_DEBUG_DISABLE_INBOX_REALTIME)
  );

  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeConversation, setActiveConversation] =
    useState<Conversation | null>(null);
  const [activeContact, setActiveContact] = useState<Contact | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);

  const stateRef = useRef({
    conversationsCount: 0,
    messagesCount: 0,
    selectedId: null as string | null,
    contactName: null as string | null,
  });
  useEffect(() => {
    stateRef.current = {
      conversationsCount: conversations.length,
      messagesCount: messages.length,
      selectedId: activeConversation?.id ?? null,
      contactName: activeContact?.name || activeContact?.phone || null,
    };
  }, [conversations.length, messages.length, activeConversation?.id, activeContact]);

  const logTimeline = useCallback((source: string, extra?: Record<string, unknown>) => {
    try {
      const timestamp = new Date().toLocaleTimeString("pt-BR");
      let extraStr = "";
      if (extra) {
        try {
          extraStr = ` payload=${JSON.stringify(extra)}`;
        } catch {
          extraStr = " payload=[Unserializable]";
        }
      }
      console.log(
        `[TIMELINE] ${timestamp} SOURCE=${source} user_id=${user?.id ?? "none"} account_id=${accountId ?? "none"} selected_id=${stateRef.current?.selectedId ?? "none"} convs_count=${stateRef.current?.conversationsCount ?? 0} msgs_count=${stateRef.current?.messagesCount ?? 0} contact=${stateRef.current?.contactName ?? "none"}${extraStr}`
      );
    } catch {}
  }, [user?.id, accountId]);
  const [whatsappConnected, setWhatsappConnected] = useState<boolean | null>(
    null
  );
  const [isUazApi, setIsUazApi] = useState<boolean>(true);
  /**
   * Bumped whenever we want children (ConversationList, MessageThread)
   * to refetch from the DB — used as a safety net against missed
   * realtime events. Bumped on WS reconnect and on tab visibility →
   * visible. The initial mount fetches don't depend on this; they fire
   * once on conversationId-change as usual.
   */
  const [resyncToken, setResyncToken] = useState(0);

  /**
   * Whether the desktop contact sidebar (tags / deals / notes) is shown.
   * Defaults to `true` (the historical behaviour) and is restored from
   * localStorage after mount. We deliberately do NOT read localStorage in
   * the initializer: the server renders with `true`, so reading a stored
   * `false` synchronously would produce a hydration mismatch. The effect
   * below reconciles to the stored value right after mount instead.
   */
  const [contactPanelOpen, setContactPanelOpen] = useState(true);
  useEffect(() => {
    try {
      const stored = localStorage.getItem(CONTACT_PANEL_STORAGE_KEY);
      if (stored !== null) setContactPanelOpen(stored === "true");
    } catch {
      // localStorage can throw in private-browsing / sandboxed contexts.
    }
  }, []);

  const handleToggleContactPanel = useCallback(() => {
    setContactPanelOpen((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(CONTACT_PANEL_STORAGE_KEY, String(next));
      } catch {
        // Persistence is best-effort; ignore storage failures.
      }
      return next;
    });
  }, []);

  // Fire the deep-link auto-select strictly ONCE on initial mount —
  // subsequent list updates, realtime events, or manual selections must never
  // snap the user back to the deep-linked conversation.
  const initialDeepLinkConsumedRef = useRef(false);

  // In-memory cache of messages by conversation ID to eliminate delay and flickering when switching chats
  const messagesCacheRef = useRef<Map<string, Message[]>>(new Map());

  // Tracks conversations whose hydrate fetch is currently in flight. The
  // conv-INSERT and the first-message-INSERT events both call into
  // hydrateConversation; the dedupe here keeps it at one refetch per
  // new conversation even when both events arrive within milliseconds.
  const hydratingConvIdsRef = useRef<Set<string>>(new Set());

  /**
   * Synchronous mirror of the conversation ids currently in `conversations`
   * state. Event handlers need to know "do we already have this conv?"
   * without waiting for a setState updater to run — updaters fire during
   * reconciliation, *after* the synchronous handler code returns, so a
   * `let foundInList = false; setState(p => { foundInList = ...; return ... })`
   * flag reads as `false` in the same tick (this exact bug shipped in #105
   * and caused #106: every incoming message and every status flip fired a
   * redundant DB hydrate, swamping the supabase client and starving the
   * realtime channel). The ref is kept in sync via the effect below.
   */
  const knownConvIdsRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    const next = new Set<string>();
    for (const c of conversations) next.add(c.id);
    knownConvIdsRef.current = next;
  }, [conversations]);

  // Pull the conversation row with its `contact` joined and merge it
  // into state. Needed because Supabase Realtime payloads only carry the
  // row's own columns — a brand-new conversation arrives without a
  // contact, which surfaced as "Unknown" names, empty avatars, and
  // (when the conv-INSERT event was delayed past the message-INSERT)
  // conversations stuck on "No messages yet" until the user reloaded.
  // Also self-heals if a realtime event was missed: callers can invoke
  const hydrateConversation = useCallback(async (convId: string) => {
    if (
      !convId ||
      typeof convId !== "string" ||
      convId === "undefined" ||
      convId === "null" ||
      hydratingConvIdsRef.current.has(convId)
    ) {
      return;
    }
    hydratingConvIdsRef.current.add(convId);
    try {
      const supabase = createClient();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let row: any = null;
      const { data, error } = await supabase
        .from("conversations")
        .select(CONVERSATION_SELECT)
        .eq("id", convId)
        .maybeSingle();

      if (error || !data) {
        // Fallback to internal server API (bypasses potential client RLS/parsing edge cases)
        try {
          const apiRes = await fetch(
            `/api/inbox/conversations?id=${encodeURIComponent(convId)}`
          ).then((r) => r.json());
          row = apiRes?.conversation || apiRes?.conversations?.[0] || null;
        } catch {
          // Silent fallback
        }
        if (!row) {
          return;
        }
      } else {
        row = data;
      }

      if (!row) return;
      const fetched = normalizeConversation(row);
      logTimeline("hydrateConversation", { convId, contact: fetched.contact?.name });
      setConversations((prev) => {
        const existing = prev.find((c) => c.id === fetched.id);
        if (existing) {
          // Already in state — keep its fields (a realtime UPDATE may
          // have landed while the fetch was in flight and patched
          // last_message_text / unread_count to fresher values than
          // the row we just read). Only backfill `contact`, which the
          // realtime payloads never carry.
          return prev.map((c) =>
            c.id === fetched.id
              ? { ...c, contact: c.contact ?? fetched.contact }
              : c,
          );
        }
        return [fetched, ...prev];
      });
    } finally {
      hydratingConvIdsRef.current.delete(convId);
    }
  }, []);

  // Check WhatsApp connection status on mount and when tab regains focus / resyncs
  const checkConnection = useCallback(async () => {
    const supabase = createClient();
    const {
      data: { session },
    } = await supabase.auth.getSession();
    const user = session?.user;

    if (!user) return;

    // whatsapp_config is one-row-per-account post-multi-user, so
    // resolve account_id via the profile and query by that.
    const { data: profile } = await supabase
      .from("profiles")
      .select("account_id")
      .eq("user_id", user.id)
      .maybeSingle();
    const accountId = profile?.account_id as string | undefined;
    if (!accountId) {
      setWhatsappConnected(false);
      return;
    }

    // 1. Check Baileys status (direct WhatsApp QR Code in CRM) first
    try {
      const baileysRes = await fetch("/api/whatsapp/baileys/status");
      if (baileysRes.ok) {
        const baileysData = await baileysRes.json();
        if (baileysData.status === "connected") {
          setWhatsappConnected(true);
          setIsUazApi(false);
          return;
        }
      }
    } catch {
      // Fallback to database check
    }

    // 2. Check UazAPI status via server-side route (bypasses RLS issues)
    try {
      const uazRes = await fetch("/api/whatsapp/uazapi/config");
      if (uazRes.ok) {
        const uazConfig = await uazRes.json();
        if (uazConfig.activeConnection?.status === "connected") {
          setWhatsappConnected(true);
          setIsUazApi(true);
          return;
        }
      }
    } catch {
      // Continue to fallback
    }

    // 3. Check Meta Cloud API config
    const { data: metaData } = await supabase
      .from("whatsapp_config")
      .select("status")
      .eq("account_id", accountId)
      .maybeSingle();

    if (metaData?.status === "connected") {
      setWhatsappConnected(true);
      setIsUazApi(false);
      return;
    }

    // 4. Check active connection in whatsapp_connections (use limit(1) to avoid PGRST116)
    const { data: activeConns } = await supabase
      .from("whatsapp_connections")
      .select("status, provider, provider_config")
      .eq("account_id", accountId)
      .eq("status", "connected")
      .limit(1);

    const activeConn = activeConns?.[0];
    const isConnected = activeConn?.status === "connected";
    setWhatsappConnected(isConnected);
    const isBaileys = (activeConn?.provider_config as { driver?: string })?.driver === "baileys";
    setIsUazApi(!isBaileys && activeConn?.provider !== "meta");
  }, []);

  useEffect(() => {
    void checkConnection();
  }, [checkConnection, resyncToken]);

  // Handle realtime message events
  const handleMessageEvent = useCallback(
    (event: { eventType: string; new: Message; old: Partial<Message> }) => {
      const newMsg = event.new;

      if (event.eventType === "INSERT") {
        // Add to messages if it belongs to active conversation
        const isForActiveThread = Boolean(
          activeConversation &&
          (newMsg.conversation_id === activeConversation.id ||
            (activeContact?.id && (newMsg as unknown as Record<string, unknown>).contact_id === activeContact.id))
        );

        if (isForActiveThread) {
          logTimeline("handleMessageEvent:INSERT", { msgId: newMsg.id, convId: newMsg.conversation_id, forActive: true });
          setMessages((prev) => {
            // Avoid duplicates
            if (prev.some((m) => m.id === newMsg.id || (newMsg.message_id && m.message_id === newMsg.message_id))) return prev;
            // Replace optimistic/preview message if it exists
            const withoutOptimistic = prev.filter(
              (m) => !m.id.startsWith("temp-") && !m.id.startsWith("preview-")
            );
            return [...withoutOptimistic, newMsg];
          });
        }

        // Always update in-memory cache for this conversation
        if (newMsg.conversation_id) {
          const currentCached = messagesCacheRef.current.get(newMsg.conversation_id) || [];
          if (!currentCached.some((m) => m.id === newMsg.id || (newMsg.message_id && m.message_id === newMsg.message_id))) {
            const nextCached = [
              ...currentCached.filter((m) => !m.id.startsWith("temp-") && !m.id.startsWith("preview-")),
              newMsg,
            ];
            messagesCacheRef.current.set(newMsg.conversation_id, nextCached);
          }
        }

        // Update conversation list preview. We need to know *synchronously*
        // whether the conv is already in state to decide between patching
        // the preview and triggering a hydrate — see the comment on
        // knownConvIdsRef for why a closure flag inside the updater would
        // always read false here.
        if (knownConvIdsRef.current.has(newMsg.conversation_id)) {
          setConversations((prev) => {
            const updated = prev.map((c) =>
              c.id === newMsg.conversation_id
                ? {
                    ...c,
                    last_message_text: newMsg.content_text ?? "",
                    last_message_at: newMsg.created_at,
                    unread_count:
                      activeConversation?.id === newMsg.conversation_id
                        ? 0
                        : c.unread_count + 1,
                  }
                : c,
            );
            // Re-sort so the conversation with the newest message rises to
            // the top — matching WhatsApp's real-time ordering behavior.
            return updated.sort((a, b) => {
              const ta = a.last_message_at ? new Date(a.last_message_at).getTime() : 0;
              const tb = b.last_message_at ? new Date(b.last_message_at).getTime() : 0;
              return tb - ta;
            });
          });
        } else {
          // First time we're seeing this conv: the conv-INSERT event
          // hasn't landed yet, or was missed. Hydrate from the DB so
          // the row surfaces with its `contact` joined; the conv-UPDATE
          // event the webhook emits right after the message INSERT will
          // converge state when it arrives.
          hydrateConversation(newMsg.conversation_id);
        }
      }

      if (event.eventType === "UPDATE") {
        logTimeline("handleMessageEvent:UPDATE", { msgId: newMsg.id, status: newMsg.status });
        // Update message status
        setMessages((prev) =>
          prev.map((m) => (m.id === newMsg.id ? { ...m, ...newMsg } : m))
        );
      }
    },
    [activeConversation, hydrateConversation, logTimeline]
  );

  // Handle realtime conversation events
  const handleConversationEvent = useCallback(
    (event: {
      eventType: string;
      new: Conversation;
      old: Partial<Conversation>;
    }) => {
      const conv = event.new;

      if (event.eventType === "INSERT") {
        logTimeline("handleConversationEvent:INSERT", { convId: conv.id });
        // Prepend immediately for snappy UX so the new conv shows in the
        // list right away, then hydrate to fill in the `contact` join
        // (realtime payloads never include joins). Skip both if we
        // already have the row — that shouldn't happen normally, but
        // out-of-order delivery would have us prepending a duplicate.
        if (!knownConvIdsRef.current.has(conv.id)) {
          setConversations((prev) => {
            if (prev.some((c) => c.id === conv.id)) return prev;
            return [conv, ...prev];
          });
          hydrateConversation(conv.id);
        }
      }

      if (event.eventType === "UPDATE") {
        logTimeline("handleConversationEvent:UPDATE", { convId: conv.id, last_message_text: conv.last_message_text });
        if (knownConvIdsRef.current.has(conv.id)) {
          // If this UPDATE is for the conv the user is currently viewing,
          // suppress the incoming unread_count — the user is reading it
          // RIGHT NOW, so any positive value would just flicker the badge
          // back on for the ~100ms it takes for the reset effect's server
          // UPDATE to round-trip. Non-active convs take the value as-is.
          const isActive = activeConversation?.id === conv.id;
          setConversations((prev) =>
            prev.map((c) =>
              c.id === conv.id
                ? {
                    ...c,
                    ...conv,
                    contact: c.contact ?? conv.contact,
                    last_message_text: conv.last_message_text ?? c.last_message_text,
                    last_message_at: conv.last_message_at ?? c.last_message_at,
                    unread_count: isActive ? 0 : conv.unread_count,
                  }
                : c,
            ),
          );
        } else {
          // UPDATE arrived before the INSERT (or after a missed INSERT)
          // — fetch the row so it surfaces with its contact joined. The
          // patch contained in `conv` will already be reflected in what
          // the hydrate fetch returns.
          hydrateConversation(conv.id);
        }

        // Update active conversation if it changed, strictly preserving contact join
        if (activeConversation && conv.id === activeConversation.id) {
          setActiveConversation((prev) =>
            prev
              ? {
                  ...prev,
                  ...conv,
                  contact: prev.contact ?? conv.contact,
                  last_message_text: conv.last_message_text ?? prev.last_message_text,
                  last_message_at: conv.last_message_at ?? prev.last_message_at,
                }
              : prev
          );
        }
      }
    },
    [activeConversation, hydrateConversation, logTimeline]
  );

  // Subscribe to realtime. The `isConnected` flag below feeds the
  // reconnect resync: realtime is best-effort and events sent while the
  // WS was disconnected (laptop sleep, network blip, background-tab
  // throttle) are simply lost. We need a way to catch up.
  const { isConnected } = useRealtime({
    channelName: "inbox-realtime",
    onMessageEvent: handleMessageEvent,
    onConversationEvent: handleConversationEvent,
    enabled: !isRealtimeDisabled,
  });

  /**
   * Bump `resyncToken` whenever the realtime channel transitions from
   * disconnected → connected *after* the initial connect. The initial
   * connect is covered by the children's on-mount fetches; only later
   * reconnects need a manual refetch to fill the gap.
   *
   * Tracked via a `was-connected` ref rather than a count so that React
   * strict-mode's dev-only effect double-fire doesn't read as a
   * reconnect.
   */
  const wasConnectedRef = useRef(false);
  const initialConnectDoneRef = useRef(false);
  useEffect(() => {
    if (isConnected && !wasConnectedRef.current) {
      // false → true transition
      if (initialConnectDoneRef.current) {
        setResyncToken((n) => n + 1);
      } else {
        initialConnectDoneRef.current = true;
      }
    }
    wasConnectedRef.current = isConnected;
  }, [isConnected]);

  /**
   * Refetch when the tab regains focus. Background tabs may have their
   * WS throttled by the browser even without a full disconnect, so a
   * visibilitychange → visible is a reliable signal that we may have
   * missed events. Cheap to fire; the children dedupe on their own.
   */
  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState === "visible") {
        setResyncToken((n) => n + 1);
      }
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);

  /**
   * Realtime bridge for WhatsApp events (Baileys + UazAPI + Webhooks).
   * Ingests messages directly with 0ms delay and syncs conversation summaries.
   */
  useUazApiSse({
    enabled: !isRealtimeDisabled,
    onMessage: useCallback((payload: Record<string, unknown>) => {
      // If event contains message data from internal whatsappBus or upstream
      if (payload.message && typeof payload.message === "object") {
        handleMessageEvent({
          eventType: (payload.eventType as string) || "INSERT",
          new: payload.message as Message,
          old: {},
        });
      }
    }, [handleMessageEvent]),
  });

  /**
   * Manual refresh trigger for the thread-header refresh button.
   * Bumps the same resyncToken the reconnect / visibility paths use,
   * so it goes through the existing dedupe & refetch plumbing — no
   * separate code path to keep in sync.
   */
  const handleManualRefresh = useCallback(() => {
    setResyncToken((n) => n + 1);
  }, []);

  const handleConversationsLoaded = useCallback(
    (loaded: Conversation[]) => {
      logTimeline("handleConversationsLoaded", { incomingCount: loaded.length });
      console.log(`[INBOX] handleConversationsLoaded: incoming count=${loaded.length}`);

      // DEFENSIVE STATE PRESERVATION (ETAPA 7):
      // If incoming list is unexpectedly empty but we already have conversations in state, preserve them!
      if (loaded.length === 0) {
        setConversations((prev) => {
          if (prev.length > 0) {
            console.warn(`[INBOX] Preserving ${prev.length} conversations in page state; ignoring empty loaded array`);
            return prev;
          }
          return loaded;
        });
        return;
      }

      setConversations(loaded);

      // PRESERVE SELECTED CONVERSATION & UPDATE IT (ETAPA 8):
      setActiveConversation((currentActive) => {
        if (!currentActive) return currentActive;
        const fresh = loaded.find((c) => c.id === currentActive.id);
        if (!fresh) return currentActive;
        return {
          ...currentActive,
          ...fresh,
          contact: fresh.contact || currentActive.contact,
          last_message_text: fresh.last_message_text || currentActive.last_message_text,
          last_message_at: fresh.last_message_at || currentActive.last_message_at,
        };
      });

      // Synchronize activeContact with fresh contact data from loaded conversations
      const currentSelectedId = stateRef.current.selectedId;
      if (currentSelectedId) {
        const fresh = loaded.find((c) => c.id === currentSelectedId);
        if (fresh?.contact) {
          setActiveContact((prev) => (fresh.contact ? { ...(prev || {}), ...fresh.contact } : prev));
        }
      }

      // Resolve a pending deep-link strictly ONCE on initial mount.
      // Subsequent realtime list refreshes or manual selections must never
      // snap the user back to the initial deep-link.
      if (
        deepLinkConvId &&
        !initialDeepLinkConsumedRef.current &&
        loaded.length > 0
      ) {
        initialDeepLinkConsumedRef.current = true;
        const match = loaded.find((c) => c.id === deepLinkConvId);
        if (match) {
          logTimeline("handleConversationsLoaded:deepLinkAutoSelect", { matchId: match.id });
          setActiveConversation(match);
          setActiveContact(match.contact ?? null);
          const cached = messagesCacheRef.current.get(match.id);
          if (cached && cached.length > 0) {
            setMessages(cached);
          } else if (match.last_message_text) {
            const isAgent = match.last_message_sender === "agent" || match.last_message_sender === "bot";
            setMessages([
              {
                id: `preview-${match.id}`,
                conversation_id: match.id,
                sender_type: isAgent ? "agent" : "customer",
                content_type: "text",
                content_text: match.last_message_text,
                status: "delivered",
                created_at: match.last_message_at || new Date().toISOString(),
              },
            ]);
          } else {
            // PRESERVE LAST VALID STATE: do not wipe if existing messages already belong to this conversation
            setMessages((prev) => (prev.length > 0 && prev.some((m) => m.conversation_id === match.id) ? prev : []));
          }
          if (match.unread_count > 0) {
            setConversations((prev) =>
              prev.map((c) =>
                c.id === match.id ? { ...c, unread_count: 0 } : c,
              ),
            );
          }
        } else {
          // If not in the initial 50 loaded conversations, explicitly hydrate it from the database
          void hydrateConversation(deepLinkConvId);
        }
      }
    },
    [deepLinkConvId, hydrateConversation, logTimeline]
  );

  const handleSelectConversation = useCallback(
    (conv: Conversation) => {
      // Re-clicking the already-active conversation is a no-op
      if (activeConversation?.id === conv.id) return;
      logTimeline("handleSelectConversation", { selectedId: conv.id, last_msg: conv.last_message_text });
      setActiveConversation(conv);
      setActiveContact(conv.contact ?? null);
      
      // Instant switch using memory cache or optimistic preview to eliminate delay
      const cached = messagesCacheRef.current.get(conv.id);
      if (cached && cached.length > 0) {
        setMessages(cached);
      } else if (conv.last_message_text) {
        const isAgent = conv.last_message_sender === "agent" || conv.last_message_sender === "bot";
        setMessages([
          {
            id: `preview-${conv.id}`,
            conversation_id: conv.id,
            sender_type: isAgent ? "agent" : "customer",
            content_type: "text",
            content_text: conv.last_message_text,
            status: "delivered",
            created_at: conv.last_message_at || new Date().toISOString(),
          },
        ]);
      } else {
        // PRESERVE LAST VALID STATE: do not wipe if existing messages already belong to this conversation
        setMessages((prev) => (prev.length > 0 && prev.some((m) => m.conversation_id === conv.id) ? prev : []));
      }

      // Optimistically clear the unread badge for this conv.
      setConversations((prev) =>
        prev.map((c) =>
          c.id === conv.id && c.unread_count > 0
            ? { ...c, unread_count: 0 }
            : c,
        ),
      );

      // Deep link is consumed — user is actively navigating
      initialDeepLinkConsumedRef.current = true;

      // Update URL silently in browser history so refresh preserves conversation
      // without triggering Next.js route re-renders or navigation race conditions
      if (typeof window !== "undefined") {
        window.history.replaceState(null, "", `/inbox?c=${conv.id}`);
      }
    },
    [activeConversation?.id, logTimeline]
  );

  // Mobile "back" — deselect the conversation so the list pane comes
  // back. Also clears the ?c= param silently so a refresh lands on the list
  // instead of re-opening the thread the user just backed out of.
  const handleCloseConversation = useCallback(() => {
    logTimeline("handleCloseConversation", {});
    setActiveConversation(null);
    setActiveContact(null);
    setMessages([]);
    initialDeepLinkConsumedRef.current = true;
    if (typeof window !== "undefined") {
      window.history.replaceState(null, "", "/inbox");
    }
  }, [logTimeline]);


  const handleMessagesLoaded = useCallback((loaded: Message[]) => {
    logTimeline("handleMessagesLoaded", { incomingCount: loaded?.length ?? 0 });
    console.log(`[INBOX] handleMessagesLoaded: count=${loaded?.length ?? 0}`);
    if (loaded && loaded.length > 0) {
      setMessages(loaded);
      if (loaded[0]?.conversation_id) {
        messagesCacheRef.current.set(loaded[0].conversation_id, loaded);
      }
    } else if (loaded && loaded.length === 0) {
      setMessages((prev) => {
        if (prev.length > 0) {
          console.warn(`[INBOX] Preserving ${prev.length} existing messages; ignoring empty incoming messages array`);
          return prev;
        }
        return [];
      });
    }
  }, [logTimeline]);

  const handleNewMessage = useCallback((msg: Message) => {
    logTimeline("handleNewMessage", { msgId: msg.id, convId: msg.conversation_id });
    setMessages((prev) => {
      if (prev.some((m) => m.id === msg.id)) return prev;
      const withoutOptimistic = prev.filter((m) => !m.id.startsWith("temp-"));
      const next = [...withoutOptimistic, msg];
      if (msg.conversation_id) {
        messagesCacheRef.current.set(msg.conversation_id, next);
      }
      return next;
    });
  }, [logTimeline]);

  const handleUpdateMessage = useCallback(
    (id: string, updates: Partial<Message>) => {
      logTimeline("handleUpdateMessage", { id, updates });
      setMessages((prev) => {
        const next = prev.map((m) => (m.id === id ? { ...m, ...updates } : m));
        if (next.length > 0 && next[0]?.conversation_id) {
          messagesCacheRef.current.set(next[0].conversation_id, next);
        }
        return next;
      });
    },
    [logTimeline]
  );

  const handleStatusChange = useCallback(
    (conversationId: string, status: ConversationStatus) => {
      setConversations((prev) =>
        prev.map((c) => (c.id === conversationId ? { ...c, status } : c))
      );
      if (activeConversation?.id === conversationId) {
        setActiveConversation((prev) => (prev ? { ...prev, status } : prev));
      }
    },
    [activeConversation]
  );

  const handleAssignChange = useCallback(
    (conversationId: string, assignedAgentId: string | null) => {
      setConversations((prev) =>
        prev.map((c) =>
          c.id === conversationId
            ? { ...c, assigned_agent_id: assignedAgentId ?? undefined }
            : c
        )
      );
      if (activeConversation?.id === conversationId) {
        setActiveConversation((prev) =>
          prev
            ? { ...prev, assigned_agent_id: assignedAgentId ?? undefined }
            : prev
        );
      }
    },
    [activeConversation]
  );

  const handleContactUpdated = useCallback((updatedContact: Contact) => {
    setActiveContact(updatedContact);
    setActiveConversation((prev) =>
      prev && prev.contact_id === updatedContact.id
        ? {
            ...prev,
            contact: {
              ...prev.contact,
              ...updatedContact,
            },
          }
        : prev
    );
    setConversations((prev) =>
      prev.map((c) =>
        c.contact_id === updatedContact.id
          ? {
              ...c,
              contact: {
                ...c.contact,
                ...updatedContact,
              },
            }
          : c
      )
    );
  }, []);

  // On mobile (<lg) we show a SINGLE pane — either the list or the
  // thread — rather than cramming both side-by-side. Selecting a
  // conversation slides the thread in; the thread's back button pops
  // it back to the list. On lg+ both panes render side-by-side as
  // before, unchanged.
  const hasActiveConv = !!activeConversation;

  return (
    <div className="-m-4 flex h-[calc(100vh-3.5rem)] flex-col overflow-hidden sm:-m-6">
      <RealtimeStatusBar isRealtimeConnected={isConnected} />

      {/* WhatsApp connection banner — in the flex column, not absolute,
          so it pushes the panels down instead of overlapping them. */}
      {whatsappConnected === false && (
        <div className="flex shrink-0 items-center justify-between gap-2 border-b border-amber-500/20 bg-amber-500/10 px-4 py-2">
          <div className="flex items-center gap-2">
            <WifiOff className="h-4 w-4 text-amber-400 shrink-0" />
            <p className="text-xs text-amber-400">
              {t("whatsappNotConnected")}
            </p>
          </div>
          <a
            href="/settings?tab=whatsapp"
            className="text-xs font-semibold text-amber-400 hover:text-amber-300 underline underline-offset-2 shrink-0 transition-colors"
          >
            Conectar conta
          </a>
        </div>
      )}

      <div className="flex flex-1 overflow-hidden">
        {/* Left panel: Conversation list.
            Hidden on mobile when a conversation is selected so the
            thread can occupy the full width. Always visible on lg+. */}
        <div
          className={cn(
            "flex h-full flex-1 lg:flex-none",
            hasActiveConv ? "hidden lg:flex" : "flex",
          )}
        >
          <ConversationList
            activeConversationId={activeConversation?.id ?? null}
            onSelect={handleSelectConversation}
            conversations={conversations}
            onConversationsLoaded={handleConversationsLoaded}
            resyncToken={resyncToken}
          />
        </div>

        {/* Center panel: Message thread.
            Hidden on mobile when no conversation is selected so the
            list can occupy the full width. Always visible on lg+
            (shows its own empty-state if no thread is picked yet).

            `min-w-0` is load-bearing: without it, a single wide piece
            of content inside the thread (long quote preview, very
            long URL in a message body) forces the flex child past
            its share and pushes the contact-sidebar panel off-screen
            on the right. Issue #165. */}
        <div
          className={cn(
            "flex h-full min-w-0 flex-1 lg:flex",
            hasActiveConv ? "flex" : "hidden lg:flex",
          )}
        >
          <ErrorBoundary
            fallbackTitle="Falha ao carregar mensagens da conversa"
            fallbackMessage="Ocorreu um erro ao renderizar as mensagens desta conversa. Clique em recarregar ou selecione outra conversa."
            onReset={handleManualRefresh}
          >
            <MessageThread
              conversation={activeConversation}
              contact={activeContact}
              messages={messages}
              onMessagesLoaded={handleMessagesLoaded}
              onNewMessage={handleNewMessage}
              onUpdateMessage={handleUpdateMessage}
              onStatusChange={handleStatusChange}
              onAssignChange={handleAssignChange}
              onBack={handleCloseConversation}
              resyncToken={resyncToken}
              onRefresh={handleManualRefresh}
              contactPanelOpen={contactPanelOpen}
              onToggleContactPanel={handleToggleContactPanel}
              isUazApi={isUazApi}
              onContactUpdated={handleContactUpdated}
            />
          </ErrorBoundary>
        </div>

        {/* Right panel: Contact sidebar — desktop only, and only when the
            agent hasn't collapsed it via the thread-header toggle (#258).
            On mobile it's always hidden (the `lg:block` below), so the
            toggle — which is itself desktop-only — never affects it. */}
        {contactPanelOpen && (
          <div className="hidden lg:block">
            <ErrorBoundary
              fallbackTitle="Falha ao carregar dados do contato"
              fallbackMessage="Não foi possível carregar os detalhes deste contato."
            >
              <ContactSidebar contact={activeContact} onContactUpdated={handleContactUpdated} />
            </ErrorBoundary>
          </div>
        )}
      </div>
    </div>
  );
}
