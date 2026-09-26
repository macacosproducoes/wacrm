"use client";

import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Clock, Calendar, Check, Loader2, Sparkles, Mic, Image as ImageIcon, Layers, MessageSquare } from "lucide-react";
import { toast } from "sonner";
import type { QuickReply } from "@/types";

interface ManualFollowUpModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  conversationId: string;
  contactId?: string | null;
  quickReplies: QuickReply[];
  onScheduled: () => void;
}

export function ManualFollowUpModal({
  open,
  onOpenChange,
  conversationId,
  contactId,
  quickReplies,
  onScheduled,
}: ManualFollowUpModalProps) {
  const [selectedReplyId, setSelectedReplyId] = useState<string>("");
  const [scheduleType, setScheduleType] = useState<"1m" | "5m" | "15m" | "30m" | "1h" | "2h" | "today18" | "tomorrow9" | "custom">("1m");
  const [customDateTime, setCustomDateTime] = useState<string>("");
  const [cancelOnClientReply, setCancelOnClientReply] = useState(true);
  const [cancelOnAgentReply, setCancelOnAgentReply] = useState(true);
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Compute scheduled date
  const computeScheduledTime = (): Date => {
    const now = new Date();
    if (scheduleType === "1m") {
      return new Date(now.getTime() + 60 * 1000);
    }
    if (scheduleType === "5m") {
      return new Date(now.getTime() + 5 * 60 * 1000);
    }
    if (scheduleType === "15m") {
      return new Date(now.getTime() + 15 * 60 * 1000);
    }
    if (scheduleType === "30m") {
      return new Date(now.getTime() + 30 * 60 * 1000);
    }
    if (scheduleType === "1h") {
      return new Date(now.getTime() + 60 * 60 * 1000);
    }
    if (scheduleType === "2h") {
      return new Date(now.getTime() + 2 * 60 * 60 * 1000);
    }
    if (scheduleType === "today18") {
      const target = new Date();
      target.setHours(18, 0, 0, 0);
      if (target.getTime() <= now.getTime()) {
        target.setDate(target.getDate() + 1);
      }
      return target;
    }
    if (scheduleType === "tomorrow9") {
      const target = new Date();
      target.setDate(target.getDate() + 1);
      target.setHours(9, 0, 0, 0);
      return target;
    }
    if (scheduleType === "custom" && customDateTime) {
      return new Date(customDateTime);
    }
    return new Date(now.getTime() + 60 * 1000);
  };

  const handleSchedule = async () => {
    if (!selectedReplyId) {
      toast.error("Por favor, selecione uma resposta salva da biblioteca.");
      return;
    }

    const scheduledDate = computeScheduledTime();
    if (isNaN(scheduledDate.getTime()) || scheduledDate.getTime() <= Date.now()) {
      toast.error("O horário do follow-up deve ser no futuro.");
      return;
    }

    setIsSubmitting(true);
    try {
      const res = await fetch("/api/follow-ups", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          conversationId,
          contactId,
          responseId: selectedReplyId,
          scheduledAt: scheduledDate.toISOString(),
          cancelOnClientReply,
          cancelOnAgentReply,
        }),
      });

      const data = await res.json();
      if (!res.ok || data.error) {
        toast.error(data.error || "Erro ao agendar follow-up.");
        return;
      }

      toast.success(
        `✓ Follow-up agendado com sucesso para ${scheduledDate.toLocaleDateString("pt-BR")} às ${scheduledDate.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })}!`
      );
      onOpenChange(false);
      onScheduled();
    } catch (err) {
      console.error("Schedule follow-up error:", err);
      toast.error("Falha ao agendar follow-up.");
    } finally {
      setIsSubmitting(false);
    }
  };

  const availableReplies = quickReplies.filter((q) => q.is_active !== false);
  const audios = availableReplies.filter((r) => r.kind === "audio");
  const images = availableReplies.filter((r) => r.kind === "image");
  const sequences = availableReplies.filter((r) => r.kind === "sequence");
  const texts = availableReplies.filter((r) => r.kind === "text");
  const otherMedia = availableReplies.filter(
    (r) => r.kind === "video" || r.kind === "document" || r.kind === "media"
  );

  const selectedReply = availableReplies.find((r) => r.id === selectedReplyId);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-base font-semibold text-foreground">
            <Clock className="h-5 w-5 text-amber-500" />
            Agendar Follow-up Condicional
          </DialogTitle>
          <DialogDescription className="text-xs text-muted-foreground">
            Programe o envio de uma mensagem automática da biblioteca para este contato. O envio será cancelado automaticamente caso o cliente ou o atendente responda antes.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          {/* Response Selector */}
          <div>
            <label className="text-xs font-semibold text-foreground">
              Mensagem da Biblioteca:
            </label>
            <select
              value={selectedReplyId}
              onChange={(e) => setSelectedReplyId(e.target.value)}
              className="mt-1 w-full rounded-md border border-border bg-background px-3 py-2 text-xs text-foreground outline-none focus:ring-1 focus:ring-primary"
            >
              <option value="">-- Selecione uma resposta salva --</option>
              {audios.length > 0 && (
                <optgroup label="🎙️ Áudios Cadastrados">
                  {audios.map((a) => (
                    <option key={a.id} value={a.id}>
                      🎙️ {a.title} {a.media_duration ? `(${a.media_duration}s)` : ""}
                    </option>
                  ))}
                </optgroup>
              )}
              {images.length > 0 && (
                <optgroup label="🖼️ Imagens Cadastradas">
                  {images.map((img) => (
                    <option key={img.id} value={img.id}>
                      🖼️ {img.title}
                    </option>
                  ))}
                </optgroup>
              )}
              {sequences.length > 0 && (
                <optgroup label="🟧 Sequências Cadastradas">
                  {sequences.map((s) => (
                    <option key={s.id} value={s.id}>
                      🟧 {s.title} ({s.sequence_items?.length || 0} passos)
                    </option>
                  ))}
                </optgroup>
              )}
              {texts.length > 0 && (
                <optgroup label="💬 Mensagens de Texto Cadastradas">
                  {texts.map((t) => (
                    <option key={t.id} value={t.id}>
                      💬 {t.title}
                    </option>
                  ))}
                </optgroup>
              )}
              {otherMedia.length > 0 && (
                <optgroup label="📁 Outras Mídias Cadastradas">
                  {otherMedia.map((m) => (
                    <option key={m.id} value={m.id}>
                      📁 {m.title} ({m.kind})
                    </option>
                  ))}
                </optgroup>
              )}
            </select>

            {selectedReply && (
              <div className="mt-2 p-2 rounded-md bg-muted/40 border border-border/60 text-xs flex items-center justify-between gap-2">
                <span className="truncate text-muted-foreground">
                  {selectedReply.content_text || selectedReply.title}
                </span>
                <Badge variant="outline" className="text-[10px] uppercase font-bold shrink-0">
                  {selectedReply.kind}
                </Badge>
              </div>
            )}
          </div>

          {/* Schedule Presets */}
          <div>
            <label className="text-xs font-semibold text-foreground">
              Quando enviar:
            </label>
            <div className="mt-2 grid grid-cols-2 sm:grid-cols-4 gap-2">
              <button
                type="button"
                onClick={() => setScheduleType("1m")}
                className={`rounded-md border p-2 text-center text-xs font-medium transition-all ${
                  scheduleType === "1m"
                    ? "border-amber-500 bg-amber-500/10 text-amber-600 dark:text-amber-400 font-semibold shadow-xs"
                    : "border-border text-muted-foreground hover:bg-muted"
                }`}
              >
                ⚡ 1 min (Agora)
              </button>

              <button
                type="button"
                onClick={() => setScheduleType("5m")}
                className={`rounded-md border p-2 text-center text-xs font-medium transition-all ${
                  scheduleType === "5m"
                    ? "border-primary bg-primary/10 text-primary font-semibold shadow-xs"
                    : "border-border text-muted-foreground hover:bg-muted"
                }`}
              >
                Em 5 min
              </button>

              <button
                type="button"
                onClick={() => setScheduleType("15m")}
                className={`rounded-md border p-2 text-center text-xs font-medium transition-all ${
                  scheduleType === "15m"
                    ? "border-primary bg-primary/10 text-primary font-semibold shadow-xs"
                    : "border-border text-muted-foreground hover:bg-muted"
                }`}
              >
                Em 15 min
              </button>

              <button
                type="button"
                onClick={() => setScheduleType("30m")}
                className={`rounded-md border p-2 text-center text-xs font-medium transition-all ${
                  scheduleType === "30m"
                    ? "border-primary bg-primary/10 text-primary font-semibold shadow-xs"
                    : "border-border text-muted-foreground hover:bg-muted"
                }`}
              >
                Em 30 min
              </button>

              <button
                type="button"
                onClick={() => setScheduleType("1h")}
                className={`rounded-md border p-2 text-center text-xs font-medium transition-all ${
                  scheduleType === "1h"
                    ? "border-primary bg-primary/10 text-primary font-semibold shadow-xs"
                    : "border-border text-muted-foreground hover:bg-muted"
                }`}
              >
                Em 1 hora
              </button>

              <button
                type="button"
                onClick={() => setScheduleType("2h")}
                className={`rounded-md border p-2 text-center text-xs font-medium transition-all ${
                  scheduleType === "2h"
                    ? "border-primary bg-primary/10 text-primary font-semibold shadow-xs"
                    : "border-border text-muted-foreground hover:bg-muted"
                }`}
              >
                Em 2 horas
              </button>

              <button
                type="button"
                onClick={() => setScheduleType("today18")}
                className={`rounded-md border p-2 text-center text-xs font-medium transition-all ${
                  scheduleType === "today18"
                    ? "border-primary bg-primary/10 text-primary font-semibold shadow-xs"
                    : "border-border text-muted-foreground hover:bg-muted"
                }`}
              >
                Hoje 18:00
              </button>

              <button
                type="button"
                onClick={() => setScheduleType("tomorrow9")}
                className={`rounded-md border p-2 text-center text-xs font-medium transition-all ${
                  scheduleType === "tomorrow9"
                    ? "border-primary bg-primary/10 text-primary font-semibold shadow-xs"
                    : "border-border text-muted-foreground hover:bg-muted"
                }`}
              >
                Amanhã 09:00
              </button>
            </div>

            {/* Custom DateTime Option */}
            <div className="mt-2">
              <button
                type="button"
                onClick={() => setScheduleType("custom")}
                className={`text-xs font-medium underline-offset-2 ${
                  scheduleType === "custom"
                    ? "text-primary font-semibold underline"
                    : "text-muted-foreground hover:underline"
                }`}
              >
                Ou escolher data e hora personalizada...
              </button>

              {scheduleType === "custom" && (
                <div className="mt-2">
                  <input
                    type="datetime-local"
                    value={customDateTime}
                    onChange={(e) => setCustomDateTime(e.target.value)}
                    className="rounded-md border border-border bg-background px-3 py-1.5 text-xs text-foreground outline-none focus:ring-1 focus:ring-primary"
                  />
                </div>
              )}
            </div>
          </div>

          {/* Stop Conditions Checkboxes */}
          <div className="rounded-lg border border-border/80 bg-muted/40 p-3 space-y-2">
            <p className="text-[11px] font-semibold text-foreground uppercase tracking-wider">
              Condições de Cancelamento Automático:
            </p>

            <label className="flex items-center gap-2 cursor-pointer text-xs text-foreground">
              <input
                type="checkbox"
                checked={cancelOnClientReply}
                onChange={(e) => setCancelOnClientReply(e.target.checked)}
                className="rounded border-border text-primary focus:ring-primary h-4 w-4"
              />
              <span>Cancelar envio se o cliente responder antes (Recomendado)</span>
            </label>

            <label className="flex items-center gap-2 cursor-pointer text-xs text-foreground">
              <input
                type="checkbox"
                checked={cancelOnAgentReply}
                onChange={(e) => setCancelOnAgentReply(e.target.checked)}
                className="rounded border-border text-primary focus:ring-primary h-4 w-4"
              />
              <span>Cancelar envio se um atendente enviar mensagem antes</span>
            </label>
          </div>
        </div>

        <DialogFooter className="gap-2 sm:gap-0">
          <Button
            variant="outline"
            size="sm"
            onClick={() => onOpenChange(false)}
            disabled={isSubmitting}
          >
            Cancelar
          </Button>
          <Button
            size="sm"
            onClick={handleSchedule}
            disabled={isSubmitting || !selectedReplyId}
            className="gap-1.5 bg-amber-600 hover:bg-amber-700 text-white font-semibold"
          >
            {isSubmitting ? (
              <>
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                <span>Agendando...</span>
              </>
            ) : (
              <>
                <Check className="h-3.5 w-3.5" />
                <span>Agendar Follow-up</span>
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
