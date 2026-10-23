"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import {
  CheckCircle2,
  AlertCircle,
  Clock,
  Mic,
  ShieldCheck,
  RefreshCw,
  Zap,
  Play,
  RotateCcw,
  Sparkles,
  ArrowRight,
  ExternalLink,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";

interface AudioItem {
  id: string;
  name: string;
  url: string;
  duration?: number;
}

interface FirstPaymentConfigData {
  id?: string;
  name: string;
  trigger_name: string;
  action_name: string;
  is_active: boolean;
  audio_id: string;
  audio_name: string;
  audio_url: string;
  execution_count?: number;
  last_executed_at?: string | null;
}

interface FirstPaymentLogItem {
  id: string;
  contact_id: string;
  lead_name: string;
  lead_phone: string;
  payment_id: string;
  amount: number;
  confirmed_at: string;
  attempted_at: string;
  status: "enviado" | "falhou" | "pendente";
  whatsapp_message_id: string | null;
  error_message: string | null;
  audio_name: string;
  created_at: string;
}

export function FirstPaymentAutomationTab() {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [retryingId, setRetryingId] = useState<string | null>(null);
  const [retryingAll, setRetryingAll] = useState(false);
  const [audios, setAudios] = useState<AudioItem[]>([]);
  const [logs, setLogs] = useState<FirstPaymentLogItem[]>([]);
  const [config, setConfig] = useState<FirstPaymentConfigData>({
    name: "Primeiro pagamento confirmado",
    trigger_name: "Primeiro pagamento aprovado",
    action_name: "Enviar áudio pelo WhatsApp",
    is_active: true,
    audio_id: "2fc16835-ab2a-4bf2-a0a5-3f70c9af402a",
    audio_name: "PEDIDO CONFIRMADO",
    audio_url: "https://ouitkocrqzflsmvuuckg.supabase.co/storage/v1/object/public/chat-media/account-512ca9fc-083c-4f59-ab46-7a065a370e77/WhatsApp_Ptt_2025-11-16_at_23.28.43.ogg",
  });

  const loadData = async () => {
    try {
      const res = await fetch("/api/automations/first-payment");
      if (!res.ok) throw new Error("Erro ao carregar dados da automação");
      const data = await res.json();
      if (data.config) {
        setConfig((prev) => ({
          ...prev,
          ...data.config,
        }));
      }
      if (Array.isArray(data.audios)) {
        setAudios(data.audios);
      }
      if (Array.isArray(data.logs)) {
        setLogs(data.logs);
      }
    } catch (err: any) {
      console.error("Falha ao carregar configuração:", err);
      toast.error(err.message || "Erro de conexão ao carregar configurações.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadData();
  }, []);

  const handleSave = async (updatedActive?: boolean) => {
    setSaving(true);
    try {
      const isActiveValue = updatedActive !== undefined ? updatedActive : config.is_active;
      const res = await fetch("/api/automations/first-payment", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          is_active: isActiveValue,
          audio_id: config.audio_id,
        }),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || "Falha ao salvar configuração");
      }

      const data = await res.json();
      if (data.config) {
        setConfig((prev) => ({
          ...prev,
          ...data.config,
        }));
      }
      toast.success("Configuração da automação atualizada com sucesso!");
    } catch (err: any) {
      toast.error(err.message || "Erro ao salvar alterações");
    } finally {
      setSaving(false);
    }
  };

  const handleToggle = (checked: boolean) => {
    setConfig((prev) => ({ ...prev, is_active: checked }));
    handleSave(checked);
  };

  const handleAudioChange = (selectedId: string) => {
    const found = audios.find((a) => a.id === selectedId);
    if (found) {
      setConfig((prev) => ({
        ...prev,
        audio_id: found.id,
        audio_name: found.name,
        audio_url: found.url,
      }));
    }
  };

  const handleRetry = async (log: FirstPaymentLogItem) => {
    setRetryingId(log.id);
    try {
      const res = await fetch("/api/automations/first-payment", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          payment_id: log.payment_id,
          contact_id: log.contact_id,
          log_id: log.id,
        }),
      });

      const data = await res.json();
      if (data.result?.dispatched) {
        toast.success("Áudio reenviado com sucesso pelo WhatsApp!");
        await loadData();
      } else {
        toast.error(data.result?.error || "Falha ao reenviar áudio.");
      }
    } catch (err: any) {
      toast.error(err.message || "Erro ao disparar retry.");
    } finally {
      setRetryingId(null);
    }
  };

  const handleRetryAll = async () => {
    setRetryingAll(true);
    try {
      const res = await fetch("/api/automations/first-payment", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          retry_all: true,
        }),
      });

      const data = await res.json();
      if (res.ok) {
        const count = data.results?.filter((r: any) => r.dispatched)?.length ?? data.count ?? 0;
        toast.success(`Reenvio concluído! ${count} áudios reenviados pelo WhatsApp com sucesso.`);
        await loadData();
      } else {
        toast.error(data.error || "Erro ao reenviar áudios com falha.");
      }
    } catch (err: any) {
      toast.error(err.message || "Erro ao executar reenvio em massa.");
    } finally {
      setRetryingAll(false);
    }
  };

  if (loading) {
    return (
      <div className="flex min-h-[320px] items-center justify-center">
        <RefreshCw className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const failedCount = logs.filter((l) => l.status === "falhou").length;

  return (
    <div className="space-y-6">
      {/* Top Automation Card */}
      <div className="rounded-xl border border-border/60 bg-card p-6 shadow-sm">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-emerald-500/10 text-emerald-500">
                <Zap className="h-4 w-4" />
              </span>
              <h2 className="text-base font-semibold text-foreground">
                Confirmação do Primeiro Pagamento
              </h2>
              <Badge
                variant="outline"
                className={
                  config.is_active
                    ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
                    : "border-muted-foreground/30 text-muted-foreground"
                }
              >
                {config.is_active ? "Automação Ativa" : "Pausada"}
              </Badge>
            </div>
            <p className="text-xs text-muted-foreground">
              Dispara automaticamente um áudio pelo ZapPlus quando o lead tem seu 1º pagamento Pix confirmado.
            </p>
          </div>

          <div className="flex items-center gap-3">
            <span className="text-xs font-medium text-muted-foreground">
              {config.is_active ? "Ativado" : "Desativado"}
            </span>
            <Switch
              checked={config.is_active}
              onCheckedChange={handleToggle}
              disabled={saving}
            />
          </div>
        </div>

        {/* Workflow Diagram */}
        <div className="mt-6 flex flex-wrap items-center gap-2 rounded-lg border border-border/40 bg-muted/20 p-3 text-xs text-muted-foreground">
          <span className="flex items-center gap-1 font-medium text-foreground">
            <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" />
            1. Pix Aprovado
          </span>
          <ArrowRight className="h-3.5 w-3.5 text-muted-foreground/50" />
          <span className="font-medium text-foreground">2. Checa Histórico do Lead</span>
          <ArrowRight className="h-3.5 w-3.5 text-muted-foreground/50" />
          <span className="flex items-center gap-1 font-medium text-primary">
            <Mic className="h-3.5 w-3.5" />
            3. Dispara Áudio no ZapPlus
          </span>
        </div>

        {/* Audio Configuration Section */}
        <div className="mt-6 space-y-4 border-t border-border/50 pt-5">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Áudio da Resposta Rápida (ZapPlus)
          </h3>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <div className="space-y-1.5 sm:col-span-2">
              <label className="text-xs font-medium text-foreground">
                Selecione o áudio configurado no CRM / ZapPlus
              </label>
              <select
                value={config.audio_id}
                onChange={(e) => handleAudioChange(e.target.value)}
                className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground focus:border-primary focus:outline-none"
              >
                {audios.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name} ({a.duration ? `${a.duration}s` : "Áudio"})
                  </option>
                ))}
              </select>
            </div>

            <div className="flex items-end">
              <Button
                onClick={() => handleSave()}
                disabled={saving}
                className="w-full gap-2 rounded-lg"
              >
                {saving ? (
                  <RefreshCw className="h-4 w-4 animate-spin" />
                ) : (
                  <CheckCircle2 className="h-4 w-4" />
                )}
                Salvar Alterações
              </Button>
            </div>
          </div>

          {/* Active Audio Card Preview */}
          <div className="flex items-center justify-between rounded-lg border border-emerald-500/20 bg-emerald-500/5 p-4">
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-full bg-emerald-500/20 text-emerald-500">
                <Mic className="h-5 w-5" />
              </div>
              <div>
                <div className="text-sm font-medium text-foreground">{config.audio_name}</div>
                <div className="text-xs text-muted-foreground">
                  Duração: ~11s • Formato: WhatsApp PTT (.ogg opus nativo)
                </div>
              </div>
            </div>

            {config.audio_url && (
              <a
                href={config.audio_url}
                target="_blank"
                rel="noreferrer"
                className="flex items-center gap-1.5 rounded-lg border border-border bg-background px-3 py-1.5 text-xs font-medium text-foreground hover:bg-muted"
              >
                <Play className="h-3.5 w-3.5 text-primary" />
                Ouvir Áudio
                <ExternalLink className="h-3 w-3 text-muted-foreground" />
              </a>
            )}
          </div>
        </div>
      </div>

      {/* Rules & Safeguards Info Card */}
      <div className="rounded-xl border border-blue-500/20 bg-blue-500/5 p-5">
        <div className="flex items-center gap-2 text-sm font-medium text-blue-600 dark:text-blue-400">
          <ShieldCheck className="h-5 w-5" />
          Salvaguardas & Regras Ativas do Motor
        </div>
        <div className="mt-3 grid grid-cols-1 gap-2 text-xs text-muted-foreground md:grid-cols-2">
          <div className="flex items-start gap-2">
            <span className="font-semibold text-foreground">1. Somente 1º Pagamento:</span>
            <span>Verifica o histórico completo de pagamentos do lead antes de enviar.</span>
          </div>
          <div className="flex items-start gap-2">
            <span className="font-semibold text-foreground">2. Pix Confirmado:</span>
            <span>Ignora pagamentos pendentes, cancelados, recusados ou expirados.</span>
          </div>
          <div className="flex items-start gap-2">
            <span className="font-semibold text-foreground">3. Anti-Duplicidade:</span>
            <span>Idempotência segura caso a API Pix reenvie o mesmo webhook.</span>
          </div>
          <div className="flex items-start gap-2">
            <span className="font-semibold text-foreground">4. Concorrência Ativa:</span>
            <span>Mutex em memória e banco garantem apenas 1 envio em pagamentos simultâneos.</span>
          </div>
        </div>
      </div>

      {/* Execution Logs Table */}
      <div className="rounded-xl border border-border/60 bg-card p-6 shadow-sm">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between border-b border-border/50 pb-4">
          <div className="space-y-0.5">
            <h3 className="text-sm font-semibold text-foreground">Registro de Disparos & Auditoria</h3>
            <p className="text-xs text-muted-foreground">
              Histórico de envios de áudio para primeiros pagamentos aprovados.
            </p>
          </div>
          <div className="flex items-center gap-2">
            {failedCount > 0 && (
              <Button
                variant="outline"
                size="sm"
                onClick={handleRetryAll}
                disabled={retryingAll}
                className="gap-1.5 text-xs text-rose-600 dark:text-rose-400 border-rose-500/30 hover:bg-rose-500/10"
              >
                <RotateCcw className={`h-3.5 w-3.5 ${retryingAll ? "animate-spin" : ""}`} />
                Reenviar Todos com Falha ({failedCount})
              </Button>
            )}
            <Button
              variant="outline"
              size="sm"
              onClick={loadData}
              className="gap-1.5 text-xs"
            >
              <RefreshCw className="h-3.5 w-3.5" />
              Atualizar
            </Button>
          </div>
        </div>

        <div className="mt-4 overflow-x-auto">
          {logs.length === 0 ? (
            <div className="py-8 text-center text-xs text-muted-foreground">
              Nenhum disparo registrado ainda. Os registros aparecerão automaticamente quando o primeiro Pix for aprovado.
            </div>
          ) : (
            <table className="w-full text-left text-xs">
              <thead>
                <tr className="border-b border-border/40 text-muted-foreground">
                  <th className="pb-2 font-medium">Lead</th>
                  <th className="pb-2 font-medium">ID Pagamento</th>
                  <th className="pb-2 font-medium">Áudio</th>
                  <th className="pb-2 font-medium">Data/Hora</th>
                  <th className="pb-2 font-medium">Status</th>
                  <th className="pb-2 font-medium">Msg WhatsApp</th>
                  <th className="pb-2 text-right font-medium">Ações</th>
                </tr>
              </thead>
              <tbody className="divide-y border-border/20">
                {logs.map((log) => (
                  <tr key={log.id} className="hover:bg-muted/30">
                    <td className="py-2.5 font-medium text-foreground">
                      <div>{log.lead_name}</div>
                      <div className="text-[11px] text-muted-foreground">{log.lead_phone}</div>
                    </td>
                    <td className="py-2.5 font-mono text-[11px] text-muted-foreground">
                      {log.payment_id.slice(0, 14)}...
                    </td>
                    <td className="py-2.5 text-foreground">{log.audio_name}</td>
                    <td className="py-2.5 text-muted-foreground">
                      {new Date(log.created_at).toLocaleString("pt-BR")}
                    </td>
                    <td className="py-2.5">
                      {log.status === "enviado" ? (
                        <Badge variant="outline" className="border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400">
                          Enviado
                        </Badge>
                      ) : log.status === "falhou" ? (
                        <Badge
                          variant="outline"
                          title={log.error_message || undefined}
                          className="border-rose-500/30 bg-rose-500/10 text-rose-600 dark:text-rose-400"
                        >
                          Falhou
                        </Badge>
                      ) : (
                        <Badge variant="outline" className="border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400">
                          Pendente
                        </Badge>
                      )}
                    </td>
                    <td className="py-2.5 font-mono text-[11px] text-muted-foreground">
                      {log.whatsapp_message_id ? log.whatsapp_message_id.slice(0, 16) : "-"}
                    </td>
                    <td className="py-2.5 text-right">
                      {log.status === "falhou" && (
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={retryingId === log.id || retryingAll}
                          onClick={() => handleRetry(log)}
                          className="h-7 gap-1 px-2 text-[11px] text-primary"
                        >
                          <RotateCcw className={`h-3 w-3 ${retryingId === log.id ? "animate-spin" : ""}`} />
                          Reenviar
                        </Button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}
