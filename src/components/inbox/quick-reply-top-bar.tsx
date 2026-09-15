"use client";

import { useState, useMemo } from "react";
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
} from "lucide-react";
import { cn } from "@/lib/utils";
import type { QuickReply, QuickReplyKind, QuickReplySequenceStep } from "@/types";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  replaceQuickReplyVariables,
  type VariableContext,
} from "@/lib/inbox/quick-reply-variables";

interface QuickReplyTopBarProps {
  quickReplies: QuickReply[];
  loading?: boolean;
  contactContext: VariableContext;
  onSelectText: (text: string) => void;
  onSelectAudio: (qr: QuickReply, simulateRecording: boolean) => void;
  onSelectMedia: (qr: QuickReply) => void;
  onSelectSequence: (qr: QuickReply) => void;
  onOpenAudioLibrary: () => void;
  onOpenCreateReply: (defaultKind?: QuickReplyKind) => void;
  onToggleFavorite?: (id: string, currentFav: boolean) => void;
}

type FilterType = "all" | "favorite" | "text" | "audio" | "sequence" | "media";

const KIND_COLORS: Record<string, { bg: string; text: string; border: string; label: string; icon: string }> = {
  text: {
    bg: "bg-amber-500/10 hover:bg-amber-500/20",
    text: "text-amber-600 dark:text-amber-400",
    border: "border-amber-500/30",
    label: "Texto",
    icon: "🟨",
  },
  audio: {
    bg: "bg-purple-500/10 hover:bg-purple-500/20",
    text: "text-purple-600 dark:text-purple-400",
    border: "border-purple-500/30",
    label: "Áudio",
    icon: "🟪",
  },
  sequence: {
    bg: "bg-orange-500/10 hover:bg-orange-500/20",
    text: "text-orange-600 dark:text-orange-400",
    border: "border-orange-500/30",
    label: "Sequência",
    icon: "🟧",
  },
  image: {
    bg: "bg-blue-500/10 hover:bg-blue-500/20",
    text: "text-blue-600 dark:text-blue-400",
    border: "border-blue-500/30",
    label: "Imagem",
    icon: "🟦",
  },
  video: {
    bg: "bg-cyan-500/10 hover:bg-cyan-500/20",
    text: "text-cyan-600 dark:text-cyan-400",
    border: "border-cyan-500/30",
    label: "Vídeo",
    icon: "🟩",
  },
  document: {
    bg: "bg-red-500/10 hover:bg-red-500/20",
    text: "text-red-600 dark:text-red-400",
    border: "border-red-500/30",
    label: "Documento",
    icon: "🟥",
  },
  interactive: {
    bg: "bg-emerald-500/10 hover:bg-emerald-500/20",
    text: "text-emerald-600 dark:text-emerald-400",
    border: "border-emerald-500/30",
    label: "Interativo",
    icon: "⚡",
  },
};

function formatAudioTime(seconds?: number | null): string {
  if (!seconds || seconds <= 0) return "0:00";
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

export function QuickReplyTopBar({
  quickReplies,
  loading = false,
  contactContext,
  onSelectText,
  onSelectAudio,
  onSelectMedia,
  onSelectSequence,
  onOpenAudioLibrary,
  onOpenCreateReply,
  onToggleFavorite,
}: QuickReplyTopBarProps) {
  const [filter, setFilter] = useState<FilterType>("all");

  const filteredItems = useMemo(() => {
    return quickReplies.filter((item) => {
      if (item.is_active === false) return false;
      if (filter === "favorite") return Boolean(item.is_favorite);
      if (filter === "text") return item.kind === "text";
      if (filter === "audio") return item.kind === "audio";
      if (filter === "sequence") return item.kind === "sequence";
      if (filter === "media") return ["image", "video", "document", "media"].includes(item.kind);
      return true;
    });
  }, [quickReplies, filter]);

  const favoritesCount = useMemo(() => {
    return quickReplies.filter((i) => i.is_favorite && i.is_active !== false).length;
  }, [quickReplies]);

  const handleCardClick = (qr: QuickReply) => {
    if (qr.kind === "text") {
      const rawText = qr.content_text || "";
      const substituted = replaceQuickReplyVariables(rawText, contactContext);
      onSelectText(substituted);
    } else if (qr.kind === "audio") {
      onSelectAudio(qr, true);
    } else if (qr.kind === "sequence") {
      onSelectSequence(qr);
    } else if (["image", "video", "document", "media"].includes(qr.kind)) {
      onSelectMedia(qr);
    }
  };

  return (
    <TooltipProvider delay={200}>
      <div className="relative border-b border-border/70 bg-card/75 backdrop-blur-md opacity-85 hover:opacity-100 transition-opacity duration-200 z-10 select-none">
        <div className="flex items-center justify-between gap-1.5 px-3 py-1.5 overflow-hidden">
          {/* Action pills & category toggles */}
          <div className="flex items-center gap-1 shrink-0">
            {/* Audio library shortcut */}
            <button
              type="button"
              onClick={onOpenAudioLibrary}
              title="Biblioteca de Áudios Gravados (PTT)"
              className="inline-flex items-center gap-1 h-6 px-2 text-[11px] font-medium rounded-full bg-purple-500/15 text-purple-600 dark:text-purple-300 hover:bg-purple-500/25 border border-purple-500/30 transition-colors shadow-xs"
            >
              <Mic className="h-3 w-3" />
              <span>🎙️ Áudios</span>
            </button>

            {/* Favorite chip */}
            <button
              type="button"
              onClick={() => setFilter(filter === "favorite" ? "all" : "favorite")}
              className={cn(
                "inline-flex items-center gap-1 h-6 px-2 text-[11px] font-medium rounded-full border transition-colors",
                filter === "favorite"
                  ? "bg-amber-500 text-white border-amber-600 shadow-xs"
                  : "bg-muted/60 text-muted-foreground hover:bg-muted border-border/50"
              )}
            >
              <Star className={cn("h-3 w-3", filter === "favorite" ? "fill-white" : "fill-amber-400 text-amber-500")} />
              <span>Favoritos</span>
              {favoritesCount > 0 && (
                <span className="ml-0.5 text-[9px] opacity-80">({favoritesCount})</span>
              )}
            </button>

            {/* Filter pills */}
            <div className="hidden sm:flex items-center gap-1 pl-1 border-l border-border/40">
              <button
                type="button"
                onClick={() => setFilter("all")}
                className={cn(
                  "h-5 px-1.5 text-[10px] rounded font-medium transition-colors",
                  filter === "all" ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted"
                )}
              >
                Todos
              </button>
              <button
                type="button"
                onClick={() => setFilter("text")}
                className={cn(
                  "h-5 px-1.5 text-[10px] rounded font-medium transition-colors",
                  filter === "text" ? "bg-amber-500 text-white" : "text-muted-foreground hover:bg-muted"
                )}
              >
                🟨 Textos
              </button>
              <button
                type="button"
                onClick={() => setFilter("audio")}
                className={cn(
                  "h-5 px-1.5 text-[10px] rounded font-medium transition-colors",
                  filter === "audio" ? "bg-purple-500 text-white" : "text-muted-foreground hover:bg-muted"
                )}
              >
                🟪 Áudios
              </button>
              <button
                type="button"
                onClick={() => setFilter("sequence")}
                className={cn(
                  "h-5 px-1.5 text-[10px] rounded font-medium transition-colors",
                  filter === "sequence" ? "bg-orange-500 text-white" : "text-muted-foreground hover:bg-muted"
                )}
              >
                🟧 Sequências
              </button>
            </div>
          </div>

          {/* Quick Reply Items — Horizontal Scrollable Area */}
          <div className="flex-1 flex items-center gap-1.5 overflow-x-auto no-scrollbar scroll-smooth px-1.5">
            {filteredItems.length === 0 ? (
              <span className="text-[11px] text-muted-foreground italic px-2">
                {loading ? "Carregando respostas..." : "Nenhuma resposta rápida encontrada neste filtro."}
              </span>
            ) : (
              filteredItems.map((qr) => {
                const conf = KIND_COLORS[qr.kind] || KIND_COLORS.text;
                const previewText = qr.content_text
                  ? replaceQuickReplyVariables(qr.content_text, contactContext)
                  : qr.title;

                return (
                  <Tooltip key={qr.id}>
                    <TooltipTrigger
                      type="button"
                      onClick={() => handleCardClick(qr)}
                      className={cn(
                        "inline-flex items-center gap-1.5 h-6 px-2 rounded-md border text-[11px] font-medium whitespace-nowrap transition-all shadow-2xs hover:scale-[1.02] active:scale-[0.98]",
                        conf.bg,
                        conf.border,
                        conf.text
                      )}
                    >
                      <span className="text-[10px] leading-none">{conf.icon}</span>
                      <span className="truncate max-w-[120px] font-medium">{qr.title}</span>
                      {qr.shortcut && (
                        <span className="text-[9px] px-1 rounded bg-black/10 dark:bg-white/10 opacity-75 font-mono">
                          /{qr.shortcut}
                        </span>
                      )}
                      {qr.kind === "audio" && qr.media_duration ? (
                        <span className="text-[9px] opacity-75">
                          {formatAudioTime(qr.media_duration)}
                        </span>
                      ) : null}
                      {qr.kind === "sequence" && qr.sequence_items?.length ? (
                        <span className="text-[9px] px-1 rounded bg-orange-500/20 text-orange-600 dark:text-orange-300">
                          {qr.sequence_items.length} etapas
                        </span>
                      ) : null}
                    </TooltipTrigger>
                    <TooltipContent side="bottom" align="start" className="max-w-xs text-xs p-2 space-y-1">
                      <div className="flex items-center justify-between gap-2 border-b border-border/50 pb-1">
                        <span className="font-semibold text-foreground flex items-center gap-1">
                          <span>{conf.icon}</span>
                          <span>{qr.title}</span>
                        </span>
                        {qr.shortcut && (
                          <Badge variant="outline" className="text-[9px] py-0 px-1 font-mono">
                            /{qr.shortcut}
                          </Badge>
                        )}
                      </div>

                      {qr.kind === "text" && (
                        <p className="text-muted-foreground line-clamp-3 text-[11px] whitespace-pre-wrap">
                          {previewText}
                        </p>
                      )}

                      {qr.kind === "audio" && (
                        <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
                          <Play className="h-3 w-3 text-purple-500" />
                          <span>Áudio gravado • Duração: {formatAudioTime(qr.media_duration)}</span>
                        </div>
                      )}

                      {qr.kind === "sequence" && (
                        <div className="text-[11px] text-muted-foreground space-y-0.5">
                          <p className="font-medium text-foreground">Fluxo de {qr.sequence_items?.length || 0} mensagens:</p>
                          {(qr.sequence_items || []).slice(0, 3).map((s, idx) => (
                            <p key={s.id || idx} className="truncate text-[10px]">
                              {idx + 1}. [{s.type.toUpperCase()}] {s.content || s.filename || "Mídia"} (+{s.delay_seconds}s)
                            </p>
                          ))}
                          {(qr.sequence_items?.length || 0) > 3 && (
                            <p className="text-[9px] italic opacity-80">+ {(qr.sequence_items?.length || 0) - 3} mais...</p>
                          )}
                        </div>
                      )}

                      {["image", "video", "document"].includes(qr.kind) && (
                        <p className="text-muted-foreground text-[11px]">
                          Arquivo de {conf.label} pronto para envio.
                        </p>
                      )}

                      <div className="pt-1 text-[9px] text-primary/80 flex items-center gap-1">
                        <span>💡</span>
                        <span>
                          {qr.kind === "text"
                            ? "Clique para inserir no campo de mensagem e revisar antes de enviar"
                            : qr.kind === "audio"
                            ? "Clique para simular gravação e enviar como nota de voz"
                            : qr.kind === "sequence"
                            ? "Clique para iniciar a execução sequencial"
                            : "Clique para enviar"}
                        </span>
                      </div>
                    </TooltipContent>
                  </Tooltip>
                );
              })
            )}
          </div>

          {/* "+ Criar resposta" Button */}
          <div className="shrink-0 pl-1">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => onOpenCreateReply()}
              className="h-6 px-2 text-[11px] gap-1 border-dashed border-border hover:border-primary/50 text-muted-foreground hover:text-foreground shadow-2xs"
            >
              <Plus className="h-3 w-3" />
              <span className="hidden sm:inline">Criar resposta</span>
              <span className="sm:hidden">Novo</span>
            </Button>
          </div>
        </div>
      </div>
    </TooltipProvider>
  );
}
