"use client";

import { useState, useMemo, useEffect, useRef } from "react";
import {
  MessageSquare,
  Zap,
  Mic,
  Plus,
  Star,
  Sparkles,
  Layers,
  Image as ImageIcon,
  FileText,
  Video,
  Play,
  Clock,
  Check,
  ChevronRight,
  Filter,
  X,
  Send,
  Folder,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type { QuickReply, QuickReplyKind } from "@/types";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import {
  replaceQuickReplyVariables,
  type VariableContext,
} from "@/lib/inbox/quick-reply-variables";
import type { QuickReplyCategory } from "@/lib/inbox/categories";

interface QuickReplyTopBarProps {
  quickReplies: QuickReply[];
  loading?: boolean;
  contactContext: VariableContext;
  onSelectText: (text: string) => void;
  onDirectSendText?: (text: string) => void;
  onSelectAudio: (qr: QuickReply, simulateRecording: boolean) => void;
  onSelectMedia: (qr: QuickReply) => void;
  onSelectSequence: (qr: QuickReply) => void;
  onOpenAudioLibrary: () => void;
  onOpenCreateReply: (defaultKind?: QuickReplyKind) => void;
  onToggleFavorite?: (id: string, currentFav: boolean) => void;
}

type FilterType = "all" | "favorite" | "text" | "audio" | "sequence" | "media";

const KIND_COLORS: Record<string, { bg: string; text: string; border: string; label: string; icon: string; dot: string }> = {
  text: {
    bg: "bg-amber-500/10 hover:bg-amber-500/20",
    text: "text-amber-600 dark:text-amber-400",
    border: "border-amber-500/30",
    label: "Texto",
    icon: "🟨",
    dot: "bg-amber-500",
  },
  audio: {
    bg: "bg-purple-500/10 hover:bg-purple-500/20",
    text: "text-purple-600 dark:text-purple-400",
    border: "border-purple-500/30",
    label: "Áudio",
    icon: "🟪",
    dot: "bg-purple-500",
  },
  sequence: {
    bg: "bg-orange-500/10 hover:bg-orange-500/20",
    text: "text-orange-600 dark:text-orange-400",
    border: "border-orange-500/30",
    label: "Sequência",
    icon: "🟧",
    dot: "bg-orange-500",
  },
  image: {
    bg: "bg-blue-500/10 hover:bg-blue-500/20",
    text: "text-blue-600 dark:text-blue-400",
    border: "border-blue-500/30",
    label: "Imagem",
    icon: "🟦",
    dot: "bg-blue-500",
  },
  video: {
    bg: "bg-cyan-500/10 hover:bg-cyan-500/20",
    text: "text-cyan-600 dark:text-cyan-400",
    border: "border-cyan-500/30",
    label: "Vídeo",
    icon: "🟩",
    dot: "bg-cyan-500",
  },
  document: {
    bg: "bg-red-500/10 hover:bg-red-500/20",
    text: "text-red-600 dark:text-red-400",
    border: "border-red-500/30",
    label: "Documento",
    icon: "🟥",
    dot: "bg-red-500",
  },
  interactive: {
    bg: "bg-emerald-500/10 hover:bg-emerald-500/20",
    text: "text-emerald-600 dark:text-emerald-400",
    border: "border-emerald-500/30",
    label: "Interativo",
    icon: "⚡",
    dot: "bg-emerald-500",
  },
};

interface PendingSend {
  qr: QuickReply;
  substitutedText?: string;
  secondsLeft: number;
}

export function QuickReplyTopBar({
  quickReplies,
  loading = false,
  contactContext,
  onSelectText,
  onDirectSendText,
  onSelectAudio,
  onSelectMedia,
  onSelectSequence,
  onOpenAudioLibrary,
  onOpenCreateReply,
  onToggleFavorite,
}: QuickReplyTopBarProps) {
  const [filter, setFilter] = useState<FilterType>("all");
  const [selectedCategory, setSelectedCategory] = useState<string>("all");
  const [categories, setCategories] = useState<QuickReplyCategory[]>([]);

  // 3-second instant send state
  const [pendingSend, setPendingSend] = useState<PendingSend | null>(null);
  const countdownTimerRef = useRef<NodeJS.Timeout | null>(null);
  const intervalRef = useRef<NodeJS.Timeout | null>(null);

  // Load categories
  useEffect(() => {
    async function loadCategories() {
      try {
        const res = await fetch("/api/quick-replies/categories");
        const data = await res.json();
        if (data.categories) {
          setCategories(data.categories);
        }
      } catch (err) {
        console.warn("[QuickReplyTopBar] Could not load categories:", err);
      }
    }
    loadCategories();
  }, []);

  // Cleanup timers on unmount
  useEffect(() => {
    return () => {
      if (countdownTimerRef.current) clearTimeout(countdownTimerRef.current);
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, []);

  const filteredItems = useMemo(() => {
    return quickReplies.filter((item) => {
      if (item.is_active === false) return false;
      if (selectedCategory !== "all") {
        if (item.category !== selectedCategory && item.category_id !== selectedCategory) {
          return false;
        }
      }
      if (filter === "favorite") return Boolean(item.is_favorite);
      if (filter === "text") return item.kind === "text";
      if (filter === "audio") return item.kind === "audio";
      if (filter === "sequence") return item.kind === "sequence";
      if (filter === "media") return ["image", "video", "document", "media"].includes(item.kind);
      return true;
    });
  }, [quickReplies, filter, selectedCategory]);

  const favoritesCount = useMemo(() => {
    return quickReplies.filter((i) => i.is_favorite && i.is_active !== false).length;
  }, [quickReplies]);

  // Execute actual send after 3 seconds
  const executeDispatch = (qr: QuickReply, textToSend?: string) => {
    // Record usage count
    void fetch(`/api/quick-replies/${qr.id}/use`, { method: "POST" }).catch(() => {});

    if (qr.kind === "text") {
      if (onDirectSendText && textToSend) {
        onDirectSendText(textToSend);
      } else if (textToSend) {
        onSelectText(textToSend);
      }
    } else if (qr.kind === "audio") {
      onSelectAudio(qr, false);
    } else if (qr.kind === "sequence") {
      onSelectSequence(qr);
    } else if (["image", "video", "document", "media"].includes(qr.kind)) {
      onSelectMedia(qr);
    }
  };

  const cancelPendingSend = () => {
    if (countdownTimerRef.current) clearTimeout(countdownTimerRef.current);
    if (intervalRef.current) clearInterval(intervalRef.current);
    setPendingSend(null);
    toast.info("Envio cancelado.");
  };

  const handleCardClick = (qr: QuickReply, isShiftPressed: boolean) => {
    const rawText = qr.content_text || "";
    const substituted = replaceQuickReplyVariables(rawText, contactContext);

    // If SHIFT is pressed: Place into composer for manual editing
    if (isShiftPressed) {
      if (qr.kind === "text") {
        onSelectText(substituted);
        toast.info("Texto inserido no campo para edição antes de enviar.");
      } else if (["image", "video", "document", "media"].includes(qr.kind)) {
        onSelectMedia(qr);
      } else {
        toast.info("Esta resposta pronta foi selecionada.");
      }
      return;
    }

    // NORMAL CLICK: 3-Second Instant Send with CANCEL option!
    if (countdownTimerRef.current) clearTimeout(countdownTimerRef.current);
    if (intervalRef.current) clearInterval(intervalRef.current);

    setPendingSend({
      qr,
      substitutedText: substituted,
      secondsLeft: 3,
    });

    // Tick every 1 second
    let currentSeconds = 3;
    intervalRef.current = setInterval(() => {
      currentSeconds -= 1;
      if (currentSeconds > 0) {
        setPendingSend((prev) => (prev ? { ...prev, secondsLeft: currentSeconds } : null));
      }
    }, 1000);

    // Dispatch after 3 seconds
    countdownTimerRef.current = setTimeout(() => {
      if (intervalRef.current) clearInterval(intervalRef.current);
      setPendingSend(null);
      executeDispatch(qr, substituted);
    }, 3000);
  };

  return (
    <TooltipProvider delay={200}>
      <div className="relative border-t border-border/60 bg-card/85 dark:bg-card/65 backdrop-blur-md transition-opacity duration-200 z-10 select-none shadow-2xs">
        {/* Active 3-Second Instant Send Countdown Banner */}
        {pendingSend && (
          <div className="flex items-center justify-between gap-3 border-b border-amber-500/40 bg-amber-500/15 px-3 py-2 text-xs font-medium text-amber-900 dark:text-amber-200 animate-in fade-in slide-in-from-top-1 duration-200">
            <div className="flex items-center gap-2 min-w-0">
              <span className="flex h-2.5 w-2.5 relative">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-amber-400 opacity-75" />
                <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-amber-500" />
              </span>
              <span className="truncate">
                Enviando <strong>&quot;{pendingSend.qr.title}&quot;</strong> em{" "}
                <span className="font-mono text-sm font-bold text-amber-600 dark:text-amber-400">
                  {pendingSend.secondsLeft}s
                </span>
                ...
              </span>
            </div>

            <div className="flex items-center gap-2 shrink-0">
              <span className="hidden sm:inline text-[11px] opacity-70">
                (Shift+Clique edita antes)
              </span>
              <Button
                type="button"
                size="sm"
                variant="destructive"
                className="h-6 px-2.5 text-xs font-semibold gap-1 bg-red-600 hover:bg-red-700 text-white shadow-sm"
                onClick={cancelPendingSend}
              >
                <X className="h-3.5 w-3.5" />
                <span>Cancelar</span>
              </Button>
            </div>
          </div>
        )}

        {/* Categories & Filter Bar */}
        <div className="flex items-center justify-between gap-1.5 px-3 py-1.5 overflow-hidden">
          <div className="flex items-center gap-1 shrink-0 overflow-x-auto no-scrollbar">
            {/* Kind Filters */}
            <button
              type="button"
              onClick={() => setFilter("all")}
              className={cn(
                "px-2 py-0.5 rounded text-[11px] font-medium transition-colors cursor-pointer shrink-0",
                filter === "all"
                  ? "bg-primary text-primary-foreground font-semibold shadow-2xs"
                  : "text-muted-foreground hover:bg-muted hover:text-foreground"
              )}
            >
              Todos
            </button>

            {favoritesCount > 0 && (
              <button
                type="button"
                onClick={() => setFilter("favorite")}
                className={cn(
                  "inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-medium transition-colors cursor-pointer shrink-0",
                  filter === "favorite"
                    ? "bg-amber-500 text-white font-semibold shadow-2xs"
                    : "text-muted-foreground hover:bg-muted hover:text-foreground"
                )}
              >
                <Star className="h-3 w-3 fill-current text-amber-400" />
                <span>Favoritos ({favoritesCount})</span>
              </button>
            )}

            <button
              type="button"
              onClick={() => setFilter("text")}
              className={cn(
                "inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[11px] font-medium transition-colors cursor-pointer shrink-0",
                filter === "text"
                  ? "bg-amber-500/20 text-amber-700 dark:text-amber-300 font-semibold border border-amber-500/40"
                  : "text-muted-foreground hover:bg-muted"
              )}
            >
              <span>🟨 Texto</span>
            </button>

            <button
              type="button"
              onClick={() => setFilter("audio")}
              className={cn(
                "inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[11px] font-medium transition-colors cursor-pointer shrink-0",
                filter === "audio"
                  ? "bg-purple-500/20 text-purple-700 dark:text-purple-300 font-semibold border border-purple-500/40"
                  : "text-muted-foreground hover:bg-muted"
              )}
            >
              <span>🟪 Áudio</span>
            </button>

            <button
              type="button"
              onClick={() => setFilter("sequence")}
              className={cn(
                "inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[11px] font-medium transition-colors cursor-pointer shrink-0",
                filter === "sequence"
                  ? "bg-orange-500/20 text-orange-700 dark:text-orange-300 font-semibold border border-orange-500/40"
                  : "text-muted-foreground hover:bg-muted"
              )}
            >
              <span>🟧 Sequência</span>
            </button>

            <button
              type="button"
              onClick={() => setFilter("media")}
              className={cn(
                "inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[11px] font-medium transition-colors cursor-pointer shrink-0",
                filter === "media"
                  ? "bg-blue-500/20 text-blue-700 dark:text-blue-300 font-semibold border border-blue-500/40"
                  : "text-muted-foreground hover:bg-muted"
              )}
            >
              <span>🟦 Mídia</span>
            </button>

            {/* Category Dropdown/Selector */}
            {categories.length > 0 && (
              <div className="ml-1 flex items-center gap-1 border-l border-border/70 pl-2">
                <span className="text-[10px] uppercase tracking-wider text-muted-foreground">Cat:</span>
                <select
                  value={selectedCategory}
                  onChange={(e) => setSelectedCategory(e.target.value)}
                  className="rounded border border-border bg-background px-1.5 py-0.5 text-[11px] font-medium text-foreground outline-none cursor-pointer focus:ring-1 focus:ring-primary"
                >
                  <option value="all">Todas as Categorias</option>
                  {categories.map((cat) => (
                    <option key={cat.id} value={cat.name}>
                      {cat.name}
                    </option>
                  ))}
                </select>
              </div>
            )}
          </div>

          {/* Quick Actions (Audio Library & New Quick Reply) */}
          <div className="flex items-center gap-1 shrink-0">
            <Tooltip>
              <TooltipTrigger
                type="button"
                onClick={onOpenAudioLibrary}
                className="inline-flex items-center gap-1 rounded px-2 py-0.5 text-[11px] font-medium text-purple-600 dark:text-purple-400 hover:bg-purple-500/15 border border-purple-500/20 cursor-pointer"
              >
                <Mic className="h-3 w-3" />
                <span className="hidden sm:inline">Biblioteca de Áudios</span>
              </TooltipTrigger>
              <TooltipContent side="top">
                Ouvir e gerenciar áudios gravados
              </TooltipContent>
            </Tooltip>

            <Tooltip>
              <TooltipTrigger
                type="button"
                onClick={() => onOpenCreateReply()}
                className="inline-flex items-center gap-1 rounded bg-primary/10 hover:bg-primary/20 text-primary px-2 py-0.5 text-[11px] font-medium border border-primary/20 cursor-pointer"
              >
                <Plus className="h-3 w-3" />
                <span className="hidden sm:inline">Nova Resposta</span>
              </TooltipTrigger>
              <TooltipContent side="top">
                Cadastrar texto, áudio, mídia ou sequência
              </TooltipContent>
            </Tooltip>
          </div>
        </div>

        {/* Scrollable Quick Reply Badges */}
        <div className="flex items-center gap-1.5 px-3 pb-2 overflow-x-auto no-scrollbar scroll-smooth">
          {loading ? (
            <div className="flex items-center gap-2 py-1 text-xs text-muted-foreground">
              <div className="h-3 w-3 animate-spin rounded-full border border-primary border-t-transparent" />
              <span>Carregando respostas...</span>
            </div>
          ) : filteredItems.length === 0 ? (
            <div className="py-1 text-xs text-muted-foreground">
              Nenhuma resposta rápida encontrada nesta categoria.
            </div>
          ) : (
            filteredItems.map((item) => {
              const kindCfg = KIND_COLORS[item.kind] || KIND_COLORS.text;
              const isFav = Boolean(item.is_favorite);

              return (
                <div
                  key={item.id}
                  onClick={(e) => handleCardClick(item, e.shiftKey)}
                  className={cn(
                    "group relative flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs font-medium cursor-pointer transition-all duration-150 shrink-0 select-none shadow-2xs",
                    kindCfg.bg,
                    kindCfg.border,
                    kindCfg.text,
                    "hover:scale-[1.02] active:scale-[0.98]"
                  )}
                  title={`Clique: Envia em 3s | Shift+Clique: Insere no texto`}
                >
                  {/* Color dot indicator */}
                  <span className={cn("h-2 w-2 rounded-full shrink-0", kindCfg.dot)} />

                  {/* Title & snippet */}
                  <span className="truncate max-w-[150px] sm:max-w-[200px] font-semibold">
                    {item.title}
                  </span>

                  {/* Audio duration tag if applicable */}
                  {item.kind === "audio" && item.media_duration && (
                    <span className="text-[10px] opacity-75 font-mono">
                      {Math.floor(Number(item.media_duration))}s
                    </span>
                  )}

                  {/* Favorite star */}
                  {isFav && (
                    <Star className="h-3 w-3 fill-amber-400 text-amber-400 shrink-0 ml-0.5" />
                  )}
                </div>
              );
            })
          )}
        </div>
      </div>
    </TooltipProvider>
  );
}
