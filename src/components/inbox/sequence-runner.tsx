"use client";

import { useEffect, useState, useRef } from "react";
import {
  Layers,
  X,
  Play,
  CheckCircle2,
  Clock,
  Loader2,
  AlertCircle,
  Radio,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import type { QuickReply, QuickReplySequenceStep, Message } from "@/types";
import {
  replaceQuickReplyVariables,
  type VariableContext,
} from "@/lib/inbox/quick-reply-variables";

export interface ActiveSequenceExecution {
  sequence: QuickReply;
  steps: QuickReplySequenceStep[];
  currentStepIndex: number;
  remainingDelaySeconds: number;
  isSending: boolean;
}

interface SequenceRunnerBannerProps {
  execution: ActiveSequenceExecution | null;
  onCancel: () => void;
}

export function SequenceRunnerBanner({
  execution,
  onCancel,
}: SequenceRunnerBannerProps) {
  if (!execution) return null;

  const totalSteps = execution.steps.length;
  const currentStep = execution.steps[execution.currentStepIndex];
  const progressPercent = Math.round(
    ((execution.currentStepIndex) / Math.max(1, totalSteps)) * 100
  );

  return (
    <div className="relative border-b border-orange-500/40 bg-gradient-to-r from-orange-500/15 via-amber-500/10 to-orange-500/15 px-4 py-2 text-xs flex flex-col sm:flex-row sm:items-center justify-between gap-2 shadow-xs z-20 animate-in fade-in slide-in-from-top-2">
      <div className="flex items-center gap-2.5 min-w-0">
        <div className="h-7 w-7 rounded-full bg-orange-500 text-white flex items-center justify-center shrink-0 animate-pulse">
          <Layers className="h-3.5 w-3.5" />
        </div>

        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="font-semibold text-orange-950 dark:text-orange-200 truncate">
              Executando Sequência: {execution.sequence.title}
            </span>
            <span className="px-1.5 py-0.2 rounded-full text-[10px] font-medium bg-orange-500/20 text-orange-700 dark:text-orange-300">
              Passo {execution.currentStepIndex + 1} de {totalSteps}
            </span>
          </div>

          <p className="text-[11px] text-muted-foreground truncate">
            {execution.remainingDelaySeconds > 0 ? (
              <span className="flex items-center gap-1 text-amber-700 dark:text-amber-300">
                <Clock className="h-3 w-3 inline" />
                Aguardando delay ({execution.remainingDelaySeconds}s) antes de enviar [{currentStep?.type?.toUpperCase()}]: {currentStep?.content || currentStep?.filename || "Mídia"}...
              </span>
            ) : execution.isSending ? (
              <span className="flex items-center gap-1 text-orange-600 dark:text-orange-400 font-medium">
                <Loader2 className="h-3 w-3 animate-spin inline" />
                Disparando passo {execution.currentStepIndex + 1} no WhatsApp...
              </span>
            ) : (
              <span>Próximo: [{currentStep?.type?.toUpperCase()}]</span>
            )}
          </p>
        </div>
      </div>

      <div className="flex items-center gap-2 self-end sm:self-center shrink-0">
        <div className="w-24 sm:w-32 hidden sm:block">
          <div className="h-2 w-full rounded-full bg-orange-500/20 overflow-hidden">
            <div
              className="h-full bg-orange-500 transition-all duration-300 rounded-full"
              style={{ width: `${progressPercent}%` }}
            />
          </div>
        </div>


        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={onCancel}
          className="h-6 px-2 text-[11px] font-medium border-red-500/40 text-red-600 hover:bg-red-500/10 gap-1"
        >
          <X className="h-3 w-3" />
          Cancelar Sequência
        </Button>
      </div>
    </div>
  );
}

/**
 * Controller hook for running sequences sequentially with delays.
 */
export function useSequenceRunner(params: {
  conversationId: string | null;
  contactPhone: string | null;
  contactContext: VariableContext;
  onNewMessage?: (msg: Message) => void;
}) {
  const { conversationId, contactPhone, contactContext, onNewMessage } = params;
  const [execution, setExecution] = useState<ActiveSequenceExecution | null>(null);
  const cancelRequestedRef = useRef(false);

  const startSequence = (sequence: QuickReply) => {
    const rawSteps = sequence.sequence_items || [];
    if (!rawSteps.length) {
      toast.error("Esta sequência não possui mensagens configuradas.");
      return;
    }
    if (!conversationId) {
      toast.error("Nenhuma conversa selecionada.");
      return;
    }

    // Sort by order ascending
    const sortedSteps = [...rawSteps].sort((a, b) => (a.order || 0) - (b.order || 0));

    cancelRequestedRef.current = false;
    setExecution({
      sequence,
      steps: sortedSteps,
      currentStepIndex: 0,
      remainingDelaySeconds: sortedSteps[0].delay_seconds || 0,
      isSending: false,
    });
  };

  const cancelSequence = () => {
    cancelRequestedRef.current = true;
    setExecution(null);
    toast.info("Execução da sequência cancelada.");

    // Clear presence
    if (conversationId || contactPhone) {
      void fetch("/api/whatsapp/presence", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          conversationId,
          phone: contactPhone,
          presence: "paused",
        }),
      }).catch(() => {});
    }
  };

  useEffect(() => {
    if (!execution || !conversationId) return;

    let timer: ReturnType<typeof setTimeout> | null = null;
    let countdownTimer: ReturnType<typeof setInterval> | null = null;

    const runCurrentStep = async () => {
      const step = execution.steps[execution.currentStepIndex];
      if (!step) {
        setExecution(null);
        toast.success(`Sequência "${execution.sequence.title}" concluída com sucesso!`);
        return;
      }

      // Step delay handling
      const delay = Math.max(0, step.delay_seconds || 0);

      if (delay > 0) {
        let count = delay;
        setExecution((prev) => (prev ? { ...prev, remainingDelaySeconds: count } : null));

        // Trigger live presence during delay: recording for audio, composing for text!
        if (step.type === "audio" && (conversationId || contactPhone)) {
          void fetch("/api/whatsapp/presence", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              conversationId,
              phone: contactPhone,
              presence: "recording",
              delayMs: delay * 1000,
            }),
          }).catch(() => {});
        } else if (step.type === "text" && (conversationId || contactPhone)) {
          void fetch("/api/whatsapp/presence", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              conversationId,
              phone: contactPhone,
              presence: "composing",
              delayMs: delay * 1000,
            }),
          }).catch(() => {});
        }

        countdownTimer = setInterval(() => {
          count -= 1;
          if (count <= 0) {
            if (countdownTimer) clearInterval(countdownTimer);
          }
          setExecution((prev) => (prev ? { ...prev, remainingDelaySeconds: Math.max(0, count) } : null));
        }, 1000);

        await new Promise((r) => {
          timer = setTimeout(r, delay * 1000);
        });
      }

      if (cancelRequestedRef.current) return;

      setExecution((prev) => (prev ? { ...prev, isSending: true, remainingDelaySeconds: 0 } : null));

      // Auto-detect effective type if step has media_url but was marked as text
      let effectiveType = step.type || "text";
      if (step.media_url) {
        if (effectiveType === "text" || !["image", "video", "audio", "document"].includes(effectiveType)) {
          const mType = (step.media_type || "").toLowerCase();
          const mUrl = (step.media_url || "").toLowerCase();
          if (mType.startsWith("image/") || /\.(jpe?g|png|webp|gif)(\?.*)?$/i.test(mUrl)) {
            effectiveType = "image";
          } else if (mType.startsWith("audio/") || /\.(ogg|mp3|wav|m4a|opus)(\?.*)?$/i.test(mUrl)) {
            effectiveType = "audio";
          } else if (mType.startsWith("video/") || /\.(mp4|3gpp|mov)(\?.*)?$/i.test(mUrl)) {
            effectiveType = "video";
          } else {
            effectiveType = "document";
          }
        }
      }

      let payload: Record<string, unknown> = {
        conversation_id: conversationId,
      };

      if (effectiveType === "text") {
        const textWithVars = replaceQuickReplyVariables(step.content || "", contactContext);
        if (!textWithVars.trim() && step.media_url) {
          // Fallback to image if content is empty but media_url exists
          effectiveType = "image";
          payload = {
            ...payload,
            message_type: "image",
            media_url: step.media_url,
            content_text: "",
            filename: step.filename || "imagem.jpg",
          };
        } else {
          payload = {
            ...payload,
            message_type: "text",
            content_text: textWithVars || " ",
          };
        }
      } else if (effectiveType === "audio") {
        payload = {
          ...payload,
          message_type: "audio",
          media_url: step.media_url,
          content_text: step.content || "[Áudio Gravado]",
        };
      } else if (["image", "video", "document"].includes(effectiveType)) {
        payload = {
          ...payload,
          message_type: effectiveType,
          media_url: step.media_url,
          content_text: step.content || "",
          filename: step.filename || (effectiveType === "image" ? "imagem.jpg" : undefined),
        };
      }

      try {
        const res = await fetch("/api/whatsapp/send", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });

        if (!res.ok) {
          const errData = await res.json().catch(() => ({}));
          throw new Error(errData.error || "Erro no envio do passo da sequência");
        }

        const data = await res.json();
        if (data.message_id && onNewMessage) {
          onNewMessage({
            id: data.message_id,
            conversation_id: conversationId,
            sender_type: "agent",
            sender_id: "",
            content_type: effectiveType === "text" ? "text" : (effectiveType as any),
            content_text: (payload.content_text as string) || "",
            media_url: (step.media_url as string) || null,
            status: "sent",
            created_at: new Date().toISOString(),
          } as Message);
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : "Falha na sequência";
        toast.error(`Passo ${execution.currentStepIndex + 1} falhou: ${msg}`);
      }

      if (cancelRequestedRef.current) return;

      // Advance to next step
      const nextIndex = execution.currentStepIndex + 1;
      if (nextIndex < execution.steps.length) {
        const nextStep = execution.steps[nextIndex];
        setExecution({
          ...execution,
          currentStepIndex: nextIndex,
          remainingDelaySeconds: nextStep.delay_seconds || 0,
          isSending: false,
        });
      } else {
        setExecution(null);
        toast.success(`Sequência "${execution.sequence.title}" concluída!`);
      }
    };

    void runCurrentStep();

    return () => {
      if (timer) clearTimeout(timer);
      if (countdownTimer) clearInterval(countdownTimer);
    };
  }, [execution?.currentStepIndex, execution?.sequence?.id]);

  return {
    execution,
    startSequence,
    cancelSequence,
  };
}
