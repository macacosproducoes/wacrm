"use client";

import { useState, useEffect, useCallback } from "react";
import { Sparkles, Hand, Undo2, Loader2, Info, PauseCircle, User } from "lucide-react";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import { useAuth } from "@/hooks/use-auth";
import { parseAiTrace, type AiTraceData } from "@/lib/ai/trace";
import { AiStatusModal } from "./ai-status-modal";

interface AiAccountStatus {
  autoReplyOn: boolean;
}
const statusCache = new Map<string, AiAccountStatus>();

async function fetchAiAccountStatus(accountId: string): Promise<AiAccountStatus> {
  const cached = statusCache.get(accountId);
  if (cached) return cached;
  try {
    const res = await fetch("/api/ai/config", { cache: "no-store" });
    if (!res.ok) return { autoReplyOn: false };
    const j = await res.json();
    const status = {
      autoReplyOn: !!(j?.configured && j?.is_active && j?.auto_reply_enabled),
    };
    statusCache.set(accountId, status);
    return status;
  } catch {
    return { autoReplyOn: false };
  }
}

interface AiThreadBannerProps {
  conversationId: string;
  /** `conversations.ai_autoreply_disabled` — bot paused on this thread. */
  disabled: boolean;
  /** `conversations.ai_handoff_summary` — note or structured trace the bot left. */
  handoffSummary?: string | null;
  /** Current assignee; when a human owns the thread the bot won't run. */
  assignedAgentId?: string | null;
  assignedAgentName?: string | null;
  /** The acting agent — "Take over" assigns the thread to them. */
  currentUserId?: string | null;
  onChange?: (patch: {
    ai_autoreply_disabled: boolean;
    assigned_agent_id?: string | null;
  }) => void;
}

export function AiThreadBanner({
  conversationId,
  disabled,
  handoffSummary,
  assignedAgentId,
  assignedAgentName,
  currentUserId,
  onChange,
}: AiThreadBannerProps) {
  const { accountId } = useAuth();
  const [autoReplyOn, setAutoReplyOn] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);

  // Optimistic local mirror of the pause flag
  const [paused, setPaused] = useState(disabled);
  useEffect(() => setPaused(disabled), [conversationId, disabled]);

  // Parse structured trace from handoffSummary
  const trace: AiTraceData | null = parseAiTrace(handoffSummary);

  useEffect(() => {
    if (!accountId) return;
    let alive = true;
    fetchAiAccountStatus(accountId).then((s) => alive && setAutoReplyOn(s.autoReplyOn));
    return () => {
      alive = false;
    };
  }, [accountId]);

  const toggle = useCallback(
    async (nextPaused: boolean) => {
      setBusy(true);
      try {
        const res = await fetch(`/api/ai/autoreply/${conversationId}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ paused: nextPaused, assign_to_me: nextPaused }),
        });
        if (!res.ok) {
          const j = await res.json().catch(() => ({}));
          toast.error(j?.error ?? "Erro ao atualizar status da IA");
          return;
        }
        setPaused(nextPaused);
        onChange?.({
          ai_autoreply_disabled: nextPaused,
          ...(nextPaused
            ? currentUserId
              ? { assigned_agent_id: currentUserId }
              : {}
            : { assigned_agent_id: null }),
        });
        toast.success(nextPaused ? "Atendimento humano assumido (IA em pausa)" : "IA Reativada com sucesso!");
      } catch {
        toast.error("Erro de conexão");
      } finally {
        setBusy(false);
      }
    },
    [conversationId, currentUserId, onChange],
  );

  // Account has no auto-reply configured → nothing to show
  if (!autoReplyOn) return null;

  // Case 1: Explicitly paused by operator or toggle
  if (paused) {
    const reasonText = trace?.reason || "IA pausada nesta conversa pelo operador";
    return (
      <>
        <Banner tone="amber">
          <div className="flex min-w-0 flex-1 items-center gap-2">
            <PauseCircle className="h-4 w-4 flex-shrink-0 text-amber-500" />
            <div className="min-w-0 flex-1">
              <span className="font-semibold text-amber-900 dark:text-amber-200">
                ⏸️ IA Não Responderá:
              </span>{" "}
              <span className="text-amber-800 dark:text-amber-300 truncate" title={reasonText}>
                {reasonText}
              </span>
            </div>
          </div>
          <div className="flex items-center gap-1.5 flex-shrink-0">
            <BannerButton onClick={() => setModalOpen(true)} icon={Info}>
              Ver Passos da IA
            </BannerButton>
            <BannerButton onClick={() => toggle(false)} busy={busy} icon={Undo2}>
              Reativar IA
            </BannerButton>
          </div>
        </Banner>
        <AiStatusModal
          open={modalOpen}
          onOpenChange={setModalOpen}
          trace={trace}
          aiDisabled={true}
          assignedAgentName={assignedAgentName}
          onToggleAi={() => toggle(false)}
          isToggling={busy}
        />
      </>
    );
  }

  // Case 2: Assigned to a human operator (AI stands down to avoid collision)
  if (assignedAgentId) {
    const agentLabel = assignedAgentName ? `por ${assignedAgentName}` : "por um operador";
    return (
      <>
        <Banner tone="muted">
          <div className="flex min-w-0 flex-1 items-center gap-2">
            <User className="h-4 w-4 flex-shrink-0 text-muted-foreground" />
            <div className="min-w-0 flex-1">
              <span className="font-semibold text-foreground">
                👤 Atendimento Humano Ativo:
              </span>{" "}
              <span className="text-muted-foreground truncate">
                A IA não responderá automaticamente enquanto a conversa estiver atribuída {agentLabel}.
              </span>
            </div>
          </div>
          <div className="flex items-center gap-1.5 flex-shrink-0">
            <BannerButton onClick={() => setModalOpen(true)} icon={Info}>
              Ver Passos da IA
            </BannerButton>
            <BannerButton onClick={() => toggle(false)} busy={busy} icon={Sparkles}>
              Ativar IA nesta Conversa
            </BannerButton>
          </div>
        </Banner>
        <AiStatusModal
          open={modalOpen}
          onOpenChange={setModalOpen}
          trace={trace}
          aiDisabled={false}
          assignedAgentName={assignedAgentName}
          onToggleAi={() => toggle(false)}
          isToggling={busy}
        />
      </>
    );
  }

  // Case 3: AI skipped the last turn (e.g. emoji, rate-limit, or veto)
  if (trace && trace.status === "skipped") {
    return (
      <>
        <Banner tone="amber">
          <div className="flex min-w-0 flex-1 items-center gap-2">
            <PauseCircle className="h-4 w-4 flex-shrink-0 text-amber-500" />
            <div className="min-w-0 flex-1">
              <span className="font-semibold text-amber-900 dark:text-amber-200">
                ⏸️ IA Não Respondeu a Última Mensagem:
              </span>{" "}
              <span className="text-amber-800 dark:text-amber-300 truncate" title={trace.reason}>
                {trace.reason}
              </span>
            </div>
          </div>
          <div className="flex items-center gap-1.5 flex-shrink-0">
            <BannerButton onClick={() => setModalOpen(true)} icon={Info}>
              Ver Passos da IA
            </BannerButton>
            <BannerButton onClick={() => toggle(true)} busy={busy} icon={Hand}>
              Assumir Atendimento
            </BannerButton>
          </div>
        </Banner>
        <AiStatusModal
          open={modalOpen}
          onOpenChange={setModalOpen}
          trace={trace}
          aiDisabled={false}
          assignedAgentName={assignedAgentName}
          onToggleAi={() => toggle(true)}
          isToggling={busy}
        />
      </>
    );
  }

  // Case 4: AI active & answering automatically
  return (
    <>
      <Banner tone="primary">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <Sparkles className="h-3.5 w-3.5 flex-shrink-0 text-emerald-500" />
          <div className="min-w-0 flex-1">
            <span className="font-medium text-emerald-900 dark:text-emerald-200">
              🤖 IA Ativa:
            </span>{" "}
            <span className="text-emerald-800 dark:text-emerald-300 truncate">
              {trace?.status === "replied"
                ? "Monitorando e respondendo automaticamente aos clientes."
                : "A IA está ativa e pronta para responder a próxima mensagem."}
            </span>
          </div>
        </div>
        <div className="flex items-center gap-1.5 flex-shrink-0">
          <BannerButton onClick={() => setModalOpen(true)} icon={Info}>
            Ver Passos da IA
          </BannerButton>
          <BannerButton onClick={() => toggle(true)} busy={busy} icon={Hand}>
            Assumir
          </BannerButton>
        </div>
      </Banner>
      <AiStatusModal
        open={modalOpen}
        onOpenChange={setModalOpen}
        trace={trace}
        aiDisabled={false}
        assignedAgentName={assignedAgentName}
        onToggleAi={() => toggle(true)}
        isToggling={busy}
      />
    </>
  );
}

function Banner({
  tone,
  children,
}: {
  tone: "primary" | "muted" | "amber";
  children: React.ReactNode;
}) {
  return (
    <div
      className={cn(
        "flex items-center gap-3 border-b px-3 py-2 text-xs sm:px-4 transition-colors",
        tone === "primary"
          ? "border-emerald-500/20 bg-emerald-500/5 text-emerald-950 dark:text-emerald-200"
          : tone === "amber"
          ? "border-amber-500/30 bg-amber-500/10 text-amber-950 dark:text-amber-200"
          : "border-border bg-muted/40 text-foreground",
      )}
    >
      {children}
    </div>
  );
}

function BannerButton({
  onClick,
  busy,
  icon: Icon,
  children,
}: {
  onClick: () => void;
  busy?: boolean;
  icon: any;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={busy}
      className="inline-flex flex-shrink-0 items-center gap-1 rounded-md border border-border bg-card px-2 py-0.5 text-xs font-medium text-foreground transition-colors hover:bg-muted disabled:opacity-60 cursor-pointer"
    >
      {busy ? (
        <Loader2 className="h-3 w-3 animate-spin" />
      ) : (
        <Icon className="h-3 w-3" />
      )}
      {children}
    </button>
  );
}
