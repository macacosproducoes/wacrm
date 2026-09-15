"use client";

import { useState, useEffect, useCallback } from "react";
import { Clock, X, ChevronDown, ChevronUp, AlertCircle, CheckCircle2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import type { FollowUpRow } from "@/lib/automations/follow-up-engine";

interface FollowUpsBannerProps {
  conversationId: string;
  refreshTrigger?: number;
}

export function FollowUpsBanner({
  conversationId,
  refreshTrigger = 0,
}: FollowUpsBannerProps) {
  const [followUps, setFollowUps] = useState<FollowUpRow[]>([]);
  const [isExpanded, setIsExpanded] = useState(true);
  const [loading, setLoading] = useState(false);

  const loadFollowUps = useCallback(async () => {
    if (!conversationId) return;
    try {
      setLoading(true);
      const res = await fetch(`/api/follow-ups?conversationId=${conversationId}`);
      const data = await res.json();
      if (data.follow_ups) {
        // Filter only scheduled or pending
        const active = (data.follow_ups as FollowUpRow[]).filter(
          (f) => f.status === "scheduled" || f.status === "pending"
        );
        setFollowUps(active);
      }
    } catch (err) {
      console.warn("[FollowUpsBanner] Error loading follow-ups:", err);
    } finally {
      setLoading(false);
    }
  }, [conversationId]);

  useEffect(() => {
    loadFollowUps();
  }, [loadFollowUps, refreshTrigger]);

  const handleCancelFollowUp = async (id: string) => {
    try {
      const res = await fetch(`/api/follow-ups/${id}`, { method: "DELETE" });
      if (res.ok) {
        toast.success("Follow-up cancelado com sucesso.");
        setFollowUps((prev) => prev.filter((f) => f.id !== id));
      } else {
        toast.error("Erro ao cancelar follow-up.");
      }
    } catch {
      toast.error("Falha na comunicação com o servidor.");
    }
  };

  if (followUps.length === 0) {
    return null;
  }

  return (
    <div className="border-b border-amber-500/30 bg-amber-500/10 px-3 py-1.5 text-xs text-foreground transition-all">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Clock className="h-3.5 w-3.5 text-amber-500 shrink-0" />
          <span className="font-semibold text-amber-700 dark:text-amber-300">
            📅 {followUps.length} Follow-up{followUps.length > 1 ? "s" : ""} Agendado{followUps.length > 1 ? "s" : ""}
          </span>
        </div>

        <button
          type="button"
          onClick={() => setIsExpanded(!isExpanded)}
          className="text-muted-foreground hover:text-foreground p-0.5 rounded"
        >
          {isExpanded ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
        </button>
      </div>

      {isExpanded && (
        <div className="mt-1.5 space-y-1">
          {followUps.map((f) => {
            const date = new Date(f.scheduled_at);
            const dateStr = date.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" });
            const timeStr = date.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });

            return (
              <div
                key={f.id}
                className="flex items-center justify-between gap-2 rounded bg-background/70 px-2 py-1 text-[11px] border border-amber-500/20 shadow-2xs"
              >
                <div className="flex items-center gap-2 min-w-0">
                  <span className="truncate font-medium text-foreground">
                    &quot;{f.quick_reply?.title || "Mensagem de Follow-up"}&quot;
                  </span>
                  <span className="text-muted-foreground font-mono shrink-0">
                    ⏱️ {dateStr} às {timeStr}
                  </span>
                  {f.source === "welcome_automation" ? (
                    <Badge variant="outline" className="text-[9px] px-1 py-0 border-emerald-500/40 text-emerald-600 dark:text-emerald-400">
                      Boas-vindas
                    </Badge>
                  ) : (
                    <Badge variant="outline" className="text-[9px] px-1 py-0 text-muted-foreground">
                      Manual
                    </Badge>
                  )}
                </div>

                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => handleCancelFollowUp(f.id)}
                  className="h-5 px-1.5 text-[10px] text-red-500 hover:bg-red-500/10 hover:text-red-600 gap-1 shrink-0"
                >
                  <X className="h-3 w-3" />
                  <span>Cancelar</span>
                </Button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
