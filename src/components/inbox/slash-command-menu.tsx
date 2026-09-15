"use client";

import { useEffect, useState, useRef, useMemo } from "react";
import { Mic, MessageSquare, Zap, Sparkles } from "lucide-react";
import type { QuickReply } from "@/types";
import { cn } from "@/lib/utils";
import { replaceQuickReplyVariables, type VariableContext } from "@/lib/inbox/quick-reply-variables";

interface SlashCommandMenuProps {
  open: boolean;
  filterText: string;
  items: QuickReply[];
  context: VariableContext;
  onSelectText: (text: string) => void;
  onSelectAudio: (qr: QuickReply) => void;
  onClose: () => void;
}

export function SlashCommandMenu({
  open,
  filterText,
  items,
  context,
  onSelectText,
  onSelectAudio,
  onClose,
}: SlashCommandMenuProps) {
  const [selectedIndex, setSelectedIndex] = useState(0);
  const listRef = useRef<HTMLUListElement>(null);

  const cleanFilter = useMemo(
    () => filterText.replace(/^\//, "").toLowerCase().trim(),
    [filterText]
  );

  const filteredItems = useMemo(() => {
    if (!cleanFilter) return items.slice(0, 8);
    return items
      .filter((qr) => {
        const titleMatch = (qr.title || "").toLowerCase().includes(cleanFilter);
        const shortcutMatch = (qr.shortcut || "").toLowerCase().includes(cleanFilter);
        const contentMatch = (qr.content_text || "").toLowerCase().includes(cleanFilter);
        const categoryMatch = (qr.category || "").toLowerCase().includes(cleanFilter);
        return titleMatch || shortcutMatch || contentMatch || categoryMatch;
      })
      .slice(0, 8);
  }, [items, cleanFilter]);

  useEffect(() => {
    setSelectedIndex(0);
  }, [cleanFilter]);

  // Handle keyboard navigation
  useEffect(() => {
    if (!open) return;

    const onKeyDown = (e: globalThis.KeyboardEvent) => {
      if (filteredItems.length === 0) return;

      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSelectedIndex((prev) => (prev + 1) % filteredItems.length);
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setSelectedIndex((prev) => (prev - 1 + filteredItems.length) % filteredItems.length);
      } else if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        const selected = filteredItems[selectedIndex];
        if (selected) {
          handlePick(selected);
        }
      } else if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };

    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [open, filteredItems, selectedIndex]);

  const handlePick = (qr: QuickReply) => {
    if (qr.kind === "audio") {
      onSelectAudio(qr);
    } else {
      const rawText = qr.content_text || qr.title;
      const interpolated = replaceQuickReplyVariables(rawText, context);
      onSelectText(interpolated);
    }
  };

  if (!open || filteredItems.length === 0) return null;

  return (
    <div className="absolute bottom-full left-0 mb-2 w-80 max-w-[95vw] rounded-xl border border-border/80 bg-popover/95 p-1.5 shadow-xl backdrop-blur-md z-50 animate-in fade-in zoom-in-95 duration-150">
      <div className="flex items-center justify-between px-2.5 py-1 text-[10px] font-semibold text-muted-foreground uppercase tracking-wider border-b border-border/50 pb-1 mb-1">
        <span className="flex items-center gap-1">
          <Sparkles className="h-3 w-3 text-amber-500" />
          Respostas Rápidas ({filteredItems.length})
        </span>
        <span className="font-mono text-[9px]">Tab / Enter ↵</span>
      </div>

      <ul ref={listRef} className="max-h-60 overflow-y-auto space-y-0.5">
        {filteredItems.map((qr, index) => {
          const isSelected = index === selectedIndex;
          const isAudio = qr.kind === "audio";

          return (
            <li key={qr.id}>
              <button
                type="button"
                onClick={() => handlePick(qr)}
                onMouseEnter={() => setSelectedIndex(index)}
                className={cn(
                  "flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-xs transition-colors cursor-pointer",
                  isSelected
                    ? "bg-primary text-primary-foreground font-medium"
                    : "hover:bg-muted text-foreground"
                )}
              >
                <div
                  className={cn(
                    "flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-xs",
                    isAudio
                      ? isSelected
                        ? "bg-emerald-400 text-emerald-950 font-bold"
                        : "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400"
                      : isSelected
                      ? "bg-primary-foreground/20 text-primary-foreground"
                      : "bg-muted text-muted-foreground"
                  )}
                >
                  {isAudio ? <Mic className="h-3.5 w-3.5" /> : qr.kind === "interactive" ? <Zap className="h-3.5 w-3.5" /> : <MessageSquare className="h-3.5 w-3.5" />}
                </div>

                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-1.5">
                    <span className="truncate font-semibold">{qr.title}</span>
                    {qr.shortcut && (
                      <span
                        className={cn(
                          "rounded px-1 text-[10px] font-mono",
                          isSelected
                            ? "bg-primary-foreground/20 text-primary-foreground"
                            : "bg-muted text-muted-foreground"
                        )}
                      >
                        /{qr.shortcut}
                      </span>
                    )}
                  </div>
                  <p
                    className={cn(
                      "truncate text-[11px] opacity-80 mt-0.5",
                      isSelected ? "text-primary-foreground/90" : "text-muted-foreground"
                    )}
                  >
                    {isAudio
                      ? `Áudio Gravado (${qr.media_duration || 0}s)`
                      : qr.content_text}
                  </p>
                </div>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
