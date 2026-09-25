"use client";

import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { createClient } from "@/lib/supabase/client";
import {
  CONVERSATION_SELECT,
  matchesContactFilters,
  normalizeConversations,
} from "@/lib/inbox/conversations";
import { cn } from "@/lib/utils";
import type { Conversation, ConversationStatus, Tag } from "@/types";
import { Search, ChevronDown, X, RefreshCw, UserCheck } from "lucide-react";
import { formatDistanceToNow } from "date-fns";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { Input } from "@/components/ui/input";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ScrollArea } from "@/components/ui/scroll-area";
import { ContactAvatar } from "@/components/ui/contact-avatar";
import { formatContactDisplayName } from "@/lib/contacts/format-contact";
import { useAuth } from "@/hooks/use-auth";

interface ConversationListProps {
  activeConversationId: string | null;
  onSelect: (conversation: Conversation) => void;
  conversations: Conversation[];
  onConversationsLoaded: (conversations: Conversation[]) => void;
  /**
   * Increment to force the fetch effect below to refire. The parent
   * bumps this on realtime reconnect / tab visibility → visible so the
   * list catches up on any events sent while the WS was disconnected
   * or the tab was throttled. Optional so existing callers keep working.
   */
  resyncToken?: number;
}

const STATUS_COLORS: Record<ConversationStatus, string> = {
  open: "bg-primary",
  pending: "bg-amber-500",
  closed: "bg-muted-foreground",
};



type InboxFilter = ConversationStatus | "all" | "unread";

export function ConversationList({
  activeConversationId,
  onSelect,
  conversations,
  onConversationsLoaded,
  resyncToken = 0,
}: ConversationListProps) {
  const t = useTranslations("Inbox.conversationList");
  const { accountId } = useAuth();
  
  const FILTER_OPTIONS: { label: string; value: InboxFilter }[] = useMemo(() => [
    { label: t("filterAll"), value: "all" },
    { label: t("filterUnread"), value: "unread" },
    { label: t("filterOpen"), value: "open" },
    { label: t("filterPending"), value: "pending" },
    { label: t("filterClosed"), value: "closed" },
  ], [t]);

  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<InboxFilter>("all");
  const [loading, setLoading] = useState(true);
  // Contact-based filters (issue #272). Tags use OR logic (a conversation
  // matches if its contact carries any selected tag), consistent with
  // Broadcast audience filtering. Company is an exact match on the field.
  const [tags, setTags] = useState<Tag[]>([]);
  const [selectedTagIds, setSelectedTagIds] = useState<string[]>([]);
  const [selectedCompany, setSelectedCompany] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [leadCaptureEnabled, setLeadCaptureEnabled] = useState(true);
  const [togglingLeadCapture, setTogglingLeadCapture] = useState(false);
  const hasAutoSyncedRef = useRef(false);

  useEffect(() => {
    fetch('/api/whatsapp/uazapi/capture-leads')
      .then((r) => r.json())
      .then((data) => {
        if (typeof data.enabled === 'boolean') {
          setLeadCaptureEnabled(data.enabled);
        }
      })
      .catch(() => {});
  }, []);

  const handleToggleLeadCapture = async () => {
    try {
      setTogglingLeadCapture(true);
      const next = !leadCaptureEnabled;
      setLeadCaptureEnabled(next);
      const res = await fetch('/api/whatsapp/uazapi/capture-leads', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'toggle', enabled: next }),
      });
      const data = await res.json();
      if (data.success) {
        toast.success(next ? 'Captura de Leads ATIVADA (Sim)' : 'Captura de Leads DESATIVADA (Não)');
      }
    } catch {
      toast.error('Erro ao alternar captura de leads');
    } finally {
      setTogglingLeadCapture(false);
    }
  };

  const handleSyncChats = async () => {
    try {
      setSyncing(true);
      const res = await fetch("/api/whatsapp/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ limit: 500 }),
      });
      const data = await res.json();
      if (res.ok && data.success) {
        toast.success(data.message || `${data.conversationsCount || data.synced || 0} conversas sincronizadas!`);
        // If lead capture is active, batch capture real names and leads
        if (leadCaptureEnabled) {
          fetch("/api/whatsapp/uazapi/capture-leads", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ action: "capture-all" }),
          }).catch(() => {});
        }
        // Refresh conversations list
        const apiRes = await fetch("/api/inbox/conversations").then((r) => r.json());
        if (apiRes.conversations) {
          onConversationsLoadedRef.current(apiRes.conversations);
        }
      } else {
        toast.error(data.error || "Falha ao sincronizar conversas.");
      }
    } catch {
      toast.error("Erro ao sincronizar conversas.");
    } finally {
      setSyncing(false);
    }
  };

  // Keep the latest callback in a ref so the fetch effect below can
  // have a stable, empty-dep identity. Previously the fetch useCallback
  // depended on `onConversationsLoaded`, which depends on the parent's
  // `deepLinkConvId` — so every URL change (including one the parent
  // triggered via router.replace after a click) caused a fresh
  // conversations fetch. That extra refetch was the trigger for the
  // deep-link auto-select running a second time and wiping the active
  // thread's messages.
  // Mutation lives in an effect (not render) per React 19's refs rule;
  // the fetch runs once on mount so it's fine to read the slightly
  // older value — the very next render updates the ref for any
  // subsequent async completion.
  const onConversationsLoadedRef = useRef(onConversationsLoaded);
  const existingConversationsRef = useRef<Conversation[]>(Array.isArray(conversations) ? conversations : []);
  useEffect(() => {
    onConversationsLoadedRef.current = onConversationsLoaded;
    existingConversationsRef.current = Array.isArray(conversations) ? conversations : [];
  });

  useEffect(() => {
    const supabase = createClient();
    let cancelled = false;

    (async () => {
      const currentCount = existingConversationsRef.current?.length ?? 0;
      const timestamp = new Date().toLocaleTimeString('pt-BR');
      console.log(`[TIMELINE] ${timestamp} SOURCE=ConversationList:fetchTrigger resyncToken=${resyncToken} currentCount=${currentCount}`);
      console.log(`[INBOX] load conversations trigger: resyncToken=${resyncToken}, currentCount=${currentCount}`);
      let list: any = null;

      // 1. Try Supabase browser client with strict account isolation
      try {
        let q = supabase
          .from("conversations")
          .select(CONVERSATION_SELECT);
        if (accountId) {
          q = q.eq("account_id", accountId);
        }
        const { data, error } = await q
          .order("last_message_at", { ascending: false, nullsFirst: false })
          .order("updated_at", { ascending: false });

        if (!error && data && data.length > 0) {
          list = data;
        } else if (error) {
          console.warn("[INBOX] Supabase client fetch warning:", error.message);
        }
      } catch (clientErr) {
        console.warn("[INBOX] Supabase client fetch threw:", clientErr);
      }

      if (cancelled) return;

      // 2. If client query returned 0 rows or errored, ALWAYS fallback to server API
      if (!list || list.length === 0) {
        try {
          const apiRes = await fetch("/api/inbox/conversations").then((r) => r.json());
          if (apiRes?.conversations && apiRes.conversations.length > 0) {
            list = apiRes.conversations;
          } else if (apiRes?.conversations) {
            list = apiRes.conversations;
          }
        } catch (apiErr) {
          console.error("[INBOX] API fallback error:", apiErr);
        }
      }

      if (cancelled) return;

      const normalizedList = normalizeConversations(list ?? []);
      const prevCount = existingConversationsRef.current?.length ?? 0;
      console.log(`[INBOX] conversation count fetched: ${normalizedList.length} (previous: ${prevCount})`);

      // 3. DEFENSIVE STATE PRESERVATION (ETAPA 7):
      // If the newly fetched list is empty, BUT we already have valid conversations in memory,
      // DO NOT wipe the list! Preserve existing state and avoid showing a false empty state.
      if (normalizedList.length === 0 && prevCount > 0) {
        console.warn(`[INBOX] Preserving ${prevCount} existing conversations — incoming fetch was unexpectedly empty.`);
        setLoading(false);
        return;
      }

      // Strictly ensure no foreign accounts can be passed to state
      const filteredList = accountId
        ? normalizedList.filter((c) => !c.account_id || c.account_id === accountId)
        : normalizedList;

      onConversationsLoadedRef.current(filteredList);
      setLoading(false);

      // 4. If user actually has 0 conversations on first load, trigger background sync
      if (normalizedList.length === 0 && prevCount === 0 && !hasAutoSyncedRef.current) {
        hasAutoSyncedRef.current = true;
        fetch('/api/whatsapp/sync', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ limit: 100 }),
        })
          .then((r) => r.json())
          .then(async (data) => {
            if (data?.success && !cancelled) {
              const res = await fetch('/api/inbox/conversations').then((r) => r.json());
              if (res.conversations && res.conversations.length > 0 && !cancelled) {
                console.log(`[INBOX] Auto-sync populated ${res.conversations.length} conversations`);
                onConversationsLoadedRef.current(res.conversations);
              }
            }
          })
          .catch(() => {});
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [resyncToken, accountId]);

  // Tag definitions for the filter picker — loaded once so labels/colours
  // stay stable regardless of which conversations happen to be loaded.
  useEffect(() => {
    const supabase = createClient();
    let cancelled = false;
    (async () => {
      let q = supabase.from("tags").select("*");
      if (accountId) q = q.eq("account_id", accountId);
      const { data } = await q.order("name");
      if (!cancelled && data) setTags(data as Tag[]);
    })();
    return () => {
      cancelled = true;
    };
  }, [accountId]);

  // Company options are derived from the loaded conversations — there's no
  // separate companies table, and only companies with a live conversation
  // are worth offering as an inbox filter.
  const companies = useMemo(() => {
    const set = new Set<string>();
    for (const c of conversations) {
      const co = c.contact?.company?.trim();
      if (co) set.add(co);
    }
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }, [conversations]);

  const tagsById = useMemo(() => {
    const m = new Map<string, Tag>();
    for (const t of tags) m.set(t.id, t);
    return m;
  }, [tags]);

  const filtered = useMemo(() => {
    let result = conversations;

    // STRICT MULTI-TENANT ISOLATION:
    if (accountId) {
      result = result.filter((c) => !c.account_id || c.account_id === accountId);
    }

    if (filter === "unread") {
      result = result.filter((c) => c.unread_count > 0);
    } else if (filter !== "all") {
      result = result.filter((c) => c.status === filter);
    }

    // Contact-based filters (tags via OR logic, exact company match).
    if (selectedTagIds.length > 0 || selectedCompany !== null) {
      result = result.filter((c) =>
        matchesContactFilters(c, {
          tagIds: selectedTagIds,
          company: selectedCompany,
        })
      );
    }

    if (search.trim()) {
      const q = search.toLowerCase();
      result = result.filter((c) => {
        const name = c.contact?.name?.toLowerCase() ?? "";
        const phone = c.contact?.phone?.toLowerCase() ?? "";
        const lastMsg = c.last_message_text?.toLowerCase() ?? "";
        return name.includes(q) || phone.includes(q) || lastMsg.includes(q);
      });
    }

    return result;
  }, [conversations, filter, search, selectedTagIds, selectedCompany, accountId]);

  const toggleTag = useCallback((id: string) => {
    setSelectedTagIds((prev) =>
      prev.includes(id) ? prev.filter((t) => t !== id) : [...prev, id]
    );
  }, []);

  const clearContactFilters = useCallback(() => {
    setSelectedTagIds([]);
    setSelectedCompany(null);
  }, []);

  const hasContactFilters = selectedTagIds.length > 0 || selectedCompany !== null;

  const handleSearchChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      setSearch(e.target.value);
    },
    []
  );

  const handleSelect = useCallback(
    (conv: Conversation) => {
      onSelect(conv);
    },
    [onSelect]
  );

  const activeFilter = FILTER_OPTIONS.find((o) => o.value === filter);

  return (
    // w-full on mobile so the list occupies the whole viewport when it's
    // the single pane showing; fixed 320px on desktop where it shares the
    // row with the thread + contact sidebar.
    <div className="flex h-full w-full flex-col border-r border-border bg-card lg:w-80">
      {/* Search + Filter */}
      <div className="space-y-2 border-b border-border p-3">
        {/* Quick Lead Capture Toggle & Sync */}
        <div className="flex items-center justify-between gap-1.5 pb-0.5">
          <div className="flex items-center gap-1 text-[11px] font-medium text-muted-foreground">
            <UserCheck className="h-3.5 w-3.5 text-emerald-500" />
            <span>Captura Leads:</span>
          </div>
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={handleToggleLeadCapture}
              disabled={togglingLeadCapture}
              title={leadCaptureEnabled ? "Captura automática de leads ativada (Sim). Clique para desativar." : "Captura desativada (Não). Clique para ativar."}
              className={cn(
                "inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-semibold transition-all cursor-pointer select-none",
                leadCaptureEnabled
                  ? "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border border-emerald-500/30 hover:bg-emerald-500/25"
                  : "bg-muted text-muted-foreground border border-border/60 hover:bg-muted/80"
              )}
            >
              <span className={cn(
                "h-1.5 w-1.5 rounded-full",
                leadCaptureEnabled ? "bg-emerald-500 animate-pulse" : "bg-muted-foreground/50"
              )} />
              {leadCaptureEnabled ? "Sim" : "Não"}
            </button>
            <button
              type="button"
              onClick={handleSyncChats}
              disabled={syncing}
              title="Sincronizar conversas e capturar nomes reais do WhatsApp"
              className="inline-flex items-center justify-center h-6 w-6 rounded text-muted-foreground hover:text-foreground hover:bg-muted transition-colors cursor-pointer"
            >
              <RefreshCw className={cn("h-3 w-3", syncing && "animate-spin text-primary")} />
            </button>
          </div>
        </div>

        <div className="relative">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={handleSearchChange}
            placeholder={t("searchPlaceholder")}
            className="border-border bg-muted pl-9 text-sm text-foreground placeholder-muted-foreground focus:border-primary/50"
          />
        </div>

        <div className="flex flex-wrap items-center gap-1">
          <DropdownMenu>
            <DropdownMenuTrigger className="inline-flex items-center justify-center h-7 gap-1 px-2 text-xs text-muted-foreground hover:text-foreground rounded-md hover:bg-muted">
                {activeFilter?.label ?? t("filterAll")}
                <ChevronDown className="h-3 w-3" />
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="start"
              className="border-border bg-popover"
            >
              {FILTER_OPTIONS.map((opt) => (
                <DropdownMenuItem
                  key={opt.value}
                  onClick={() => setFilter(opt.value)}
                  className={cn(
                    "text-sm",
                    filter === opt.value
                      ? "text-primary"
                      : "text-popover-foreground"
                  )}
                >
                  {opt.label}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>

          {tags.length > 0 && (
            <DropdownMenu>
              <DropdownMenuTrigger
                className={cn(
                  "inline-flex items-center justify-center h-7 gap-1 px-2 text-xs rounded-md hover:bg-muted",
                  selectedTagIds.length > 0
                    ? "text-primary"
                    : "text-muted-foreground hover:text-foreground"
                )}
              >
                {t("tags")}
                {selectedTagIds.length > 0 && (
                  <span className="flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-bold text-primary-foreground">
                    {selectedTagIds.length}
                  </span>
                )}
                <ChevronDown className="h-3 w-3" />
              </DropdownMenuTrigger>
              <DropdownMenuContent
                align="start"
                className="max-h-64 w-56 border-border bg-popover"
              >
                {tags.map((t) => (
                  <DropdownMenuCheckboxItem
                    key={t.id}
                    checked={selectedTagIds.includes(t.id)}
                    onCheckedChange={() => toggleTag(t.id)}
                    className="text-sm text-popover-foreground"
                  >
                    <span className="flex items-center gap-2">
                      <span
                        className="h-2 w-2 shrink-0 rounded-full"
                        style={{ backgroundColor: t.color }}
                      />
                      <span className="truncate">{t.name}</span>
                    </span>
                  </DropdownMenuCheckboxItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          )}

          {companies.length > 0 && (
            <DropdownMenu>
              <DropdownMenuTrigger
                className={cn(
                  "inline-flex max-w-40 items-center justify-center h-7 gap-1 px-2 text-xs rounded-md hover:bg-muted",
                  selectedCompany
                    ? "text-primary"
                    : "text-muted-foreground hover:text-foreground"
                )}
              >
                <span className="truncate">{selectedCompany ?? t("company")}</span>
                <ChevronDown className="h-3 w-3 shrink-0" />
              </DropdownMenuTrigger>
              <DropdownMenuContent
                align="start"
                className="max-h-64 w-56 border-border bg-popover"
              >
                <DropdownMenuItem
                  onClick={() => setSelectedCompany(null)}
                  className={cn(
                    "text-sm",
                    selectedCompany === null
                      ? "text-primary"
                      : "text-popover-foreground"
                  )}
                >
                  {t("allCompanies")}
                </DropdownMenuItem>
                {companies.map((co) => (
                  <DropdownMenuItem
                    key={co}
                    onClick={() => setSelectedCompany(co)}
                    className={cn(
                      "text-sm",
                      selectedCompany === co
                        ? "text-primary"
                        : "text-popover-foreground"
                    )}
                  >
                    <span className="truncate">{co}</span>
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          )}

          <button
            type="button"
            onClick={handleSyncChats}
            disabled={syncing}
            title="Sincronizar conversas do WhatsApp (UazAPI)"
            className="ml-auto inline-flex items-center justify-center h-7 gap-1 px-2 text-xs text-muted-foreground hover:text-foreground rounded-md hover:bg-muted disabled:opacity-50"
          >
            <RefreshCw className={cn("h-3 w-3", syncing && "animate-spin")} />
            <span className="hidden sm:inline">{syncing ? "Sincronizando..." : "Sincronizar"}</span>
          </button>
        </div>

        {hasContactFilters && (
          <div className="flex flex-wrap items-center gap-1">
            {selectedTagIds.map((id) => {
              const tag = tagsById.get(id);
              return (
                <button
                  key={id}
                  onClick={() => toggleTag(id)}
                  className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-[11px] text-foreground hover:bg-muted/70"
                >
                  <span
                    className="h-1.5 w-1.5 shrink-0 rounded-full"
                    style={{ backgroundColor: tag?.color ?? "var(--muted-foreground)" }}
                  />
                  <span className="max-w-24 truncate">{tag?.name ?? t("tags")}</span>
                  <X className="h-3 w-3" />
                </button>
              );
            })}
            {selectedCompany && (
              <button
                onClick={() => setSelectedCompany(null)}
                className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-[11px] text-foreground hover:bg-muted/70"
              >
                <span className="max-w-24 truncate">{selectedCompany}</span>
                <X className="h-3 w-3" />
              </button>
            )}
            <button
              onClick={clearContactFilters}
              className="px-1 text-[11px] text-muted-foreground hover:text-foreground"
            >
              {t("clearAll")}
            </button>
          </div>
        )}
      </div>

      {/* Conversation Items.
          `min-h-0` is load-bearing: a flex child defaults to
          min-height:auto, so without it this ScrollArea grows to fit
          every conversation instead of shrinking to the remaining
          space — the list then overflows and gets clipped by the
          parent's overflow-hidden with no scrollbar (issue #229). */}
      <ScrollArea className="min-h-0 flex-1">
        {loading ? (
          <div className="flex items-center justify-center py-12">
            <div className="h-5 w-5 animate-spin rounded-full border-2 border-primary border-t-transparent" />
          </div>
        ) : filtered.length === 0 ? (
          <div className="px-4 py-12 text-center">
            <p className="text-sm text-muted-foreground">{t("noConversations")}</p>
          </div>
        ) : (
          <div className="flex flex-col">
            {filtered.map((conv) => (
              <ConversationItem
                key={conv.id}
                conversation={conv}
                isActive={conv.id === activeConversationId}
                onSelect={handleSelect}
                t={t}
              />
            ))}
          </div>
        )}
      </ScrollArea>
    </div>
  );
}

interface ConversationItemProps {
  conversation: Conversation;
  isActive: boolean;
  onSelect: (conversation: Conversation) => void;
  t: ReturnType<typeof useTranslations>;
}

function ConversationItem({
  conversation,
  isActive,
  onSelect,
  t,
}: ConversationItemProps) {
  const contact = conversation.contact;
  const displayName = formatContactDisplayName(contact?.name, contact?.phone) || t("unknown");
  const initials = displayName.charAt(0).toUpperCase();

  const handleClick = useCallback(() => {
    onSelect(conversation);
  }, [onSelect, conversation]);

  let timeAgo = "";
  if (conversation.last_message_at) {
    try {
      const d = new Date(conversation.last_message_at);
      if (!isNaN(d.getTime())) {
        timeAgo = formatDistanceToNow(d, { addSuffix: false });
      }
    } catch {}
  }

  return (
    <button
      onClick={handleClick}
      className={cn(
        "flex w-full items-start gap-3 px-3 py-3 text-left transition-colors hover:bg-muted/50",
        isActive && "border-l-2 border-primary bg-muted/70"
      )}
    >
      {/* Avatar */}
      <ContactAvatar
        name={contact?.name}
        phone={contact?.phone}
        avatarUrl={contact?.avatar_url}
        size="md"
      />

      {/* Content */}
      <div className="min-w-0 flex-1">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-1.5 truncate min-w-0">
            <span className="truncate text-sm font-medium text-foreground">
              {displayName}
            </span>
            {conversation.ai_autoreply_disabled === true ? (
              <span
                className="inline-flex items-center px-1 py-0.5 rounded text-[9px] font-semibold border border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400 shrink-0"
                title="IA pausada nesta conversa (Atendimento humano)"
              >
                ⏸️ Humano
              </span>
            ) : conversation.assigned_agent_id ? (
              <span
                className="inline-flex items-center px-1 py-0.5 rounded text-[9px] font-semibold border border-muted bg-muted text-muted-foreground shrink-0"
                title="Atendente humano atribuído"
              >
                👤 Operador
              </span>
            ) : (
              <span
                className="inline-flex items-center px-1 py-0.5 rounded text-[9px] font-semibold border border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 shrink-0"
                title="IA Ativa (Respondendo automaticamente)"
              >
                🤖 IA
              </span>
            )}
          </div>
          <span className="shrink-0 text-[10px] text-muted-foreground">{timeAgo}</span>
        </div>
        <div className="mt-0.5 flex items-center justify-between gap-2">
          <p className="truncate text-xs text-muted-foreground">
            {conversation.last_message_text || t("noMessagesYet")}
          </p>
          <div className="flex shrink-0 items-center gap-1.5">
            {conversation.unread_count > 0 && (
              <span className="flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-bold text-primary-foreground">
                {conversation.unread_count}
              </span>
            )}
            <span
              className={cn(
                "h-2 w-2 rounded-full",
                STATUS_COLORS[conversation.status]
              )}
              title={conversation.status}
            />
          </div>
        </div>
      </div>
    </button>
  );
}
