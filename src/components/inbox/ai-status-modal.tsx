"use client";

import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { CheckCircle2, AlertTriangle, PauseCircle, XCircle, Info, Bot, Sparkles, Clock, RefreshCw } from "lucide-react";
import { cn } from "@/lib/utils";
import type { AiTraceData, AiExecutionStep } from "@/lib/ai/trace";

interface AiStatusModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  trace: AiTraceData | null;
  aiDisabled?: boolean;
  assignedAgentName?: string | null;
  onForceReply?: () => void;
  onToggleAi?: () => void;
  isToggling?: boolean;
}

export function AiStatusModal({
  open,
  onOpenChange,
  trace,
  aiDisabled,
  assignedAgentName,
  onForceReply,
  onToggleAi,
  isToggling,
}: AiStatusModalProps) {
  const isSkipped = trace?.status === "skipped" || aiDisabled;
  const isHandedOff = trace?.status === "handed_off";
  const isReplied = trace?.status === "replied" && !aiDisabled;
  const isError = trace?.status === "error";

  const statusTitle = isReplied
    ? "IA Respondeu Automaticamente"
    : isSkipped
    ? "IA Não Responderá Esta Mensagem"
    : isHandedOff
    ? "Transferência Solicitada (Handoff)"
    : isError
    ? "Erro na Execução da IA"
    : "IA em Monitoramento";

  const statusColor = isReplied
    ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
    : isSkipped
    ? "border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400"
    : isHandedOff
    ? "border-orange-500/30 bg-orange-500/10 text-orange-600 dark:text-orange-400"
    : isError
    ? "border-red-500/30 bg-red-500/10 text-red-600 dark:text-red-400"
    : "border-primary/30 bg-primary/10 text-primary";

  // Fallback default steps if none recorded yet
  const displaySteps: AiExecutionStep[] =
    trace?.steps && trace.steps.length > 0
      ? trace.steps
      : [
          {
            name: "1. Webhook & Inbound",
            status: "success",
            detail: "Mensagem recebida e autenticada no WhatsApp",
            timestamp: new Date().toISOString(),
          },
          {
            name: "2. Verificação de Ativação",
            status: aiDisabled ? "skipped" : "success",
            detail: aiDisabled
              ? "A IA está desativada para esta conversa"
              : "IA ativa na conversa",
            timestamp: new Date().toISOString(),
          },
          {
            name: "3. Atendente Humano",
            status: assignedAgentName ? "skipped" : "success",
            detail: assignedAgentName
              ? `Atendente ${assignedAgentName} responsável pela conversa`
              : "Nenhum atendente humano bloqueando",
            timestamp: new Date().toISOString(),
          },
        ];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md sm:max-w-lg max-h-[85vh] overflow-y-auto">
        <DialogHeader className="pb-2 border-b">
          <DialogTitle className="flex items-center gap-2 text-base font-semibold">
            <Bot className="h-5 w-5 text-primary" />
            Passos Detalhados da IA
          </DialogTitle>
          <DialogDescription className="text-xs">
            Acompanhe o diagnóstico e o fluxo de decisão do Agent IA para esta conversa.
          </DialogDescription>
        </DialogHeader>

        {/* Status Highlight Banner */}
        <div className={cn("p-3 rounded-lg border flex items-start gap-2.5 my-2", statusColor)}>
          {isReplied ? (
            <CheckCircle2 className="h-5 w-5 shrink-0 mt-0.5" />
          ) : isSkipped ? (
            <PauseCircle className="h-5 w-5 shrink-0 mt-0.5" />
          ) : isHandedOff ? (
            <AlertTriangle className="h-5 w-5 shrink-0 mt-0.5" />
          ) : isError ? (
            <XCircle className="h-5 w-5 shrink-0 mt-0.5" />
          ) : (
            <Sparkles className="h-5 w-5 shrink-0 mt-0.5" />
          )}
          <div className="flex-1 min-w-0">
            <h4 className="text-xs font-bold uppercase tracking-wider">{statusTitle}</h4>
            <p className="text-xs mt-0.5 font-medium leading-relaxed">
              {trace?.reason || (aiDisabled ? "IA pausada nesta conversa pelo operador" : "Aguardando próxima mensagem")}
            </p>
            {trace?.updatedAt && (
              <p className="text-[10px] opacity-75 mt-1 flex items-center gap-1">
                <Clock className="h-3 w-3" />
                {new Date(trace.updatedAt).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
                {trace.model && ` • Modelo: ${trace.model}`}
              </p>
            )}
          </div>
        </div>

        {/* Stepper Timeline */}
        <div className="mt-2 space-y-3">
          <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
            Linha do Tempo de Decisão:
          </h4>

          <div className="relative pl-6 space-y-4 before:absolute before:left-2.5 before:top-2 before:bottom-2 before:w-0.5 before:bg-border">
            {displaySteps.map((step, idx) => {
              const isStepSuccess = step.status === "success";
              const isStepSkipped = step.status === "skipped";
              const isStepWarning = step.status === "warning";
              const isStepError = step.status === "error";

              return (
                <div key={idx} className="relative group">
                  {/* Step Dot Icon */}
                  <span
                    className={cn(
                      "absolute -left-6 top-0.5 flex h-5 w-5 items-center justify-center rounded-full text-[10px] ring-4 ring-card",
                      isStepSuccess && "bg-emerald-500 text-white",
                      isStepSkipped && "bg-amber-500 text-white",
                      isStepWarning && "bg-orange-500 text-white",
                      isStepError && "bg-red-500 text-white",
                      !isStepSuccess && !isStepSkipped && !isStepWarning && !isStepError && "bg-muted text-muted-foreground"
                    )}
                  >
                    {isStepSuccess ? (
                      <CheckCircle2 className="h-3 w-3" />
                    ) : isStepSkipped ? (
                      <PauseCircle className="h-3 w-3" />
                    ) : isStepWarning ? (
                      <AlertTriangle className="h-3 w-3" />
                    ) : isStepError ? (
                      <XCircle className="h-3 w-3" />
                    ) : (
                      <Info className="h-3 w-3" />
                    )}
                  </span>

                  {/* Step Details */}
                  <div className="rounded-md border border-border/70 bg-card p-2.5 shadow-sm transition-all hover:border-border">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-xs font-semibold text-foreground">{step.name}</span>
                      <span
                        className={cn(
                          "text-[9px] px-1.5 py-0.5 rounded font-bold uppercase tracking-wider",
                          isStepSuccess && "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
                          isStepSkipped && "bg-amber-500/10 text-amber-600 dark:text-amber-400",
                          isStepWarning && "bg-orange-500/10 text-orange-600 dark:text-orange-400",
                          isStepError && "bg-red-500/10 text-red-600 dark:text-red-400"
                        )}
                      >
                        {step.status}
                      </span>
                    </div>
                    <p className="text-xs text-muted-foreground mt-1 leading-relaxed">{step.detail}</p>
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* Quick Actions in Modal */}
        <div className="mt-4 pt-3 border-t flex items-center justify-end gap-2">
          {onToggleAi && (
            <button
              type="button"
              onClick={onToggleAi}
              disabled={isToggling}
              className={cn(
                "inline-flex items-center gap-1.5 h-8 px-3 rounded-md text-xs font-medium border transition-colors cursor-pointer disabled:opacity-60",
                aiDisabled
                  ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 hover:bg-emerald-500/20"
                  : "border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-400 hover:bg-amber-500/20"
              )}
            >
              <RefreshCw className={cn("h-3.5 w-3.5", isToggling && "animate-spin")} />
              {aiDisabled ? "Ativar IA nesta conversa" : "Pausar IA nesta conversa"}
            </button>
          )}
          <button
            type="button"
            onClick={() => onOpenChange(false)}
            className="h-8 px-3 rounded-md text-xs font-medium border border-border bg-card text-foreground hover:bg-muted transition-colors cursor-pointer"
          >
            Fechar
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
