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
  Pencil,
  Trash2,
  GripVertical,
  Loader2,
} from "lucide-react";
import { Input } from "@/components/ui/input";
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

interface QuickReplyTopBarProps {
  quickReplies: QuickReply[];
  loading?: boolean;
  contactContext?: VariableContext;
  onSelectText: (text: string) => void;
  onDirectSendText?: (text: string) => void;
  onSelectAudio: (qr: QuickReply, simulateRecording: boolean) => void;
  onSelectMedia: (qr: QuickReply) => void;
  onSelectSequence: (qr: QuickReply) => void;
  onOpenAudioLibrary: () => void;
  onOpenCreateReply: (defaultKind: QuickReplyKind, itemToEdit?: QuickReply) => void;
  onToggleFavorite?: (qr: QuickReply) => void;
  onRefreshReplies?: () => void;
}

interface QuickReplyCategory {
  id: string;
  name: string;
  count: number;
}

type FilterType = "all" | "favorite" | "text" | "audio" | "sequence" | "media";

const KIND_COLORS: Record<
  string,
  { bg: string; text: string; border: string; label: string; icon: string; dot: string }
> = {
  text: {
    bg: "bg-amber-500/10 hover:bg-amber-500/20",
    text: "text-amber-700 dark:text-amber-400",
    border: "border-amber-500/30",
    label: "Texto",
    icon: "🟨",
    dot: "bg-amber-500",
  },
  audio: {
    bg: "bg-purple-500/10 hover:bg-purple-500/20",
    text: "text-purple-700 dark:text-purple-300",
    border: "border-purple-500/30",
    label: "Áudio",
    icon: "🎙️",
    dot: "bg-purple-500",
  },
  sequence: {
    bg: "bg-orange-500/10 hover:bg-orange-500/20",
    text: "text-orange-700 dark:text-orange-400",
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
    bg: "bg-emerald-500/10 hover:bg-emerald-500/20",
    text: "text-emerald-600 dark:text-emerald-400",
    border: "border-emerald-500/30",
    label: "Vídeo",
    icon: "🟩",
    dot: "bg-emerald-500",
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
  onRefreshReplies,
}: QuickReplyTopBarProps) {
  const [filter, setFilter] = useState<FilterType>("all");
  const [selectedCategory, setSelectedCategory] = useState<string>("all");
  const [categories, setCategories] = useState<QuickReplyCategory[]>([]);
  const [localItems, setLocalItems] = useState<QuickReply[]>(Array.isArray(quickReplies) ? quickReplies : []);

  // Drag and drop reordering state
  const [draggedId, setDraggedId] = useState<string | null>(null);
  const [dragOverId, setDragOverId] = useState<string | null>(null);

  // Audio / Item rename state
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState("");
  const [savingRename, setSavingRename] = useState(false);

  // Delete confirmation state
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  // Active 3-second instant send countdown state
  const [pendingSend, setPendingSend] = useState<PendingSend | null>(null);
  const countdownTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Sync quickReplies prop
  const scrollContainerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setLocalItems(Array.isArray(quickReplies) ? quickReplies : []);
  }, [quickReplies]);

  useEffect(() => {
    if (scrollContainerRef.current) {
      scrollContainerRef.current.scrollLeft = 0;
    }
  }, [filter, selectedCategory]);

  const loadItems = async () => {
    try {
      const res = await fetch("/api/quick-replies");
      if (res.ok) {
        const data = await res.json();
        setLocalItems(data.data || data.quick_replies || []);
      }
    } catch {
      // ignore
    }
  };

  const handleMoveItem = async (fromId: string, toId: string) => {
    if (fromId === toId) return;
    const currentList = [...localItems];
    const fromIdx = currentList.findIndex((a) => a.id === fromId);
    const toIdx = currentList.findIndex((a) => a.id === toId);
    if (fromIdx === -1 || toIdx === -1) return;

    const [moved] = currentList.splice(fromIdx, 1);
    currentList.splice(toIdx, 0, moved);
    setLocalItems(currentList);

    try {
      const orders = currentList.map((item, index) => ({ id: item.id, order_index: index }));
      await fetch("/api/quick-replies", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orders }),
      });
      onRefreshReplies?.();
      toast.success("Ordem dos áudios/respostas atualizada com sucesso!");
    } catch {
      toast.error("Erro ao salvar ordem.");
    }
  };

  const handleStartRename = (item: QuickReply, e: React.MouseEvent) => {
    e.stopPropagation();
    setEditingId(item.id);
    setEditingTitle(item.title);
  };

  const handleSaveRename = async (id: string) => {
    const trimmed = editingTitle.trim();
    if (!trimmed) {
      toast.error("O título não pode ficar vazio.");
      return;
    }
    setSavingRename(true);
    try {
      const res = await fetch(`/api/quick-replies/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: trimmed }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || "Falha ao renomear áudio.");
      }
      setLocalItems((prev) => prev.map((a) => (a.id === id ? { ...a, title: trimmed } : a)));
      setEditingId(null);
      onRefreshReplies?.();
      toast.success(`Áudio renomeado para "${trimmed}"!`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Falha ao renomear.");
    } finally {
      setSavingRename(false);
    }
  };

  const handleConfirmDelete = async (item: QuickReply, e: React.MouseEvent) => {
    e.stopPropagation();
    if (pendingSend?.qr.id === item.id) {
      cancelPendingSend();
    }
    setDeletingId(item.id);
    try {
      const res = await fetch(`/api/quick-replies/${item.id}`, { method: "DELETE" });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || "Falha ao excluir.");
      }
      setLocalItems((prev) => prev.filter((a) => a.id !== item.id));
      setConfirmDeleteId(null);
      toast.success(`"${item.title}" foi excluído com sucesso!`);
      onRefreshReplies?.();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Erro ao excluir áudio.");
    } finally {
      setDeletingId(null);
    }
  };

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
    const items = Array.isArray(localItems) ? localItems : [];
    return items.filter((item) => {
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
  }, [localItems, filter, selectedCategory]);

  const favoritesCount = useMemo(() => {
    const items = Array.isArray(localItems) ? localItems : [];
    return items.filter((i) => i.is_favorite && i.is_active !== false).length;
  }, [localItems]);

  // Execute actual send after 3 seconds - humanized audio simulation enabled by default!
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
      // 🎙️ Humanized Audio sending: simulate "Gravando áudio..." before delivery
      onSelectAudio(qr, true);
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
    // Do not trigger send if user is renaming or confirming delete
    if (editingId === qr.id || confirmDeleteId === qr.id) return;

    const rawText = qr.content_text || "";
    const substituted = replaceQuickReplyVariables(rawText, contactContext || {});

    // If SHIFT is pressed: Place into composer for manual editing
    if (isShiftPressed) {
      if (qr.kind === "text") {
        onSelectText(substituted);
        toast.info("Texto inserido no campo para edição.");
      } else if (qr.kind === "audio") {
        onSelectAudio(qr, false);
      } else if (qr.kind === "sequence") {
        onSelectSequence(qr);
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
                onClick={() => onOpenCreateReply("text")}
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
        <div ref={scrollContainerRef} className="flex items-center gap-1.5 px-3 pb-2 overflow-x-auto no-scrollbar scroll-smooth">
          {loading && quickReplies.length === 0 ? (
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
              const isAudio = item.kind === "audio";
              const isEditing = editingId === item.id;
              const isConfirmingDelete = confirmDeleteId === item.id;

              if (isEditing) {
                return (
                  <div
                    key={item.id}
                    onClick={(e) => e.stopPropagation()}
                    className="flex items-center gap-1 px-2 py-1 rounded-md border border-purple-500 bg-background shadow-xs shrink-0"
                  >
                    <Input
                      value={editingTitle}
                      onChange={(e) => setEditingTitle(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") void handleSaveRename(item.id);
                        if (e.key === "Escape") setEditingId(null);
                      }}
                      autoFocus
                      className="h-6 w-36 px-1.5 text-xs bg-background"
                      placeholder="Novo nome..."
                    />
                    <button
                      type="button"
                      disabled={savingRename || !editingTitle.trim()}
                      onClick={() => void handleSaveRename(item.id)}
                      className="p-1 rounded bg-emerald-600 text-white hover:bg-emerald-700"
                      title="Salvar novo nome"
                    >
                      {savingRename ? (
                        <Loader2 className="h-3 w-3 animate-spin" />
                      ) : (
                        <Check className="h-3 w-3" />
                      )}
                    </button>
                    <button
                      type="button"
                      onClick={() => setEditingId(null)}
                      className="p-1 rounded hover:bg-muted text-muted-foreground"
                      title="Cancelar"
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </div>
                );
              }

              if (isConfirmingDelete) {
                return (
                  <div
                    key={item.id}
                    onClick={(e) => e.stopPropagation()}
                    className="flex items-center gap-1.5 px-2 py-1 rounded-md border border-red-500/40 bg-red-500/10 text-xs text-red-600 dark:text-red-400 shadow-xs shrink-0 animate-in fade-in"
                  >
                    <span className="text-[11px] font-medium">Excluir da base?</span>
                    <button
                      type="button"
                      disabled={deletingId === item.id}
                      onClick={(e) => void handleConfirmDelete(item, e)}
                      className="px-1.5 py-0.5 rounded bg-red-600 hover:bg-red-700 text-white text-[10px] font-bold"
                    >
                      {deletingId === item.id ? (
                        <Loader2 className="h-2.5 w-2.5 animate-spin" />
                      ) : (
                        "Sim"
                      )}
                    </button>
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        setConfirmDeleteId(null);
                      }}
                      className="px-1 py-0.5 text-[10px] text-muted-foreground hover:text-foreground"
                    >
                      Não
                    </button>
                  </div>
                );
              }

              return (
                <div
                  key={item.id}
                  draggable={true}
                  onDragStart={(e) => {
                    setDraggedId(item.id);
                    e.dataTransfer.setData("text/plain", item.id);
                    e.dataTransfer.effectAllowed = "move";
                  }}
                  onDragOver={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    if (dragOverId !== item.id) setDragOverId(item.id);
                  }}
                  onDragLeave={(e) => {
                    e.stopPropagation();
                    if (dragOverId === item.id) setDragOverId(null);
                  }}
                  onDrop={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    if (draggedId && draggedId !== item.id) {
                      void handleMoveItem(draggedId, item.id);
                    }
                    setDraggedId(null);
                    setDragOverId(null);
                  }}
                  onDragEnd={() => {
                    setDraggedId(null);
                    setDragOverId(null);
                  }}
                  onClick={(e) => handleCardClick(item, e.shiftKey)}
                  className={cn(
                    "group relative flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs font-medium cursor-pointer transition-all duration-150 shrink-0 select-none shadow-2xs",
                    kindCfg.bg,
                    kindCfg.border,
                    kindCfg.text,
                    dragOverId === item.id
                      ? "border-purple-500 ring-2 ring-purple-500/50 bg-purple-500/20 scale-105"
                      : "hover:scale-[1.02] active:scale-[0.98]"
                  )}
                  title={`Arraste para mudar de lugar | Clique: Envia em 3s (${isAudio ? "com 'Gravando áudio...'" : "direto"})`}
                >
                  {/* Drag Handle */}
                  <div
                    className="cursor-grab active:cursor-grabbing opacity-50 group-hover:opacity-100 hover:text-foreground transition-opacity"
                    title="Arraste para mover de lugar"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <GripVertical className="h-3 w-3" />
                  </div>

                  {/* Color dot indicator */}
                  <span className={cn("h-2 w-2 rounded-full shrink-0", kindCfg.dot)} />

                  {/* Title */}
                  <span className="truncate max-w-[140px] sm:max-w-[180px] font-semibold">
                    {item.title}
                  </span>

                  {/* Audio duration tag if applicable */}
                  {isAudio && item.media_duration && (
                    <span className="text-[10px] opacity-75 font-mono">
                      {Math.floor(Number(item.media_duration))}s
                    </span>
                  )}

                  {/* Favorite star */}
                  {isFav && (
                    <Star className="h-3 w-3 fill-amber-400 text-amber-400 shrink-0 ml-0.5" />
                  )}

                  {/* Action buttons: Renomear e Excluir */}
                  <div className="flex items-center gap-0.5 ml-1 opacity-70 group-hover:opacity-100 transition-opacity">
                    <button
                      type="button"
                      title="Editar resposta rápida / texto pronto"
                      onClick={(e) => {
                        e.stopPropagation();
                        onOpenCreateReply(item.kind, item);
                      }}
                      className="p-1 rounded hover:bg-foreground/15 text-foreground/75 hover:text-foreground transition-colors"
                    >
                      <Pencil className="h-3 w-3" />
                    </button>
                    <button
                      type="button"
                      title="Excluir áudio/resposta"
                      onClick={(e) => {
                        e.stopPropagation();
                        setConfirmDeleteId(item.id);
                      }}
                      className="p-1 rounded hover:bg-red-500/20 text-muted-foreground hover:text-red-500 transition-colors"
                    >
                      <Trash2 className="h-3 w-3" />
                    </button>
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>
    </TooltipProvider>
  );
}
