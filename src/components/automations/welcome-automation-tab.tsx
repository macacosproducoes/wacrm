"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import {
  Zap,
  Clock,
  UserCheck,
  Plus,
  Trash2,
  Save,
  CheckCircle2,
  AlertCircle,
  HelpCircle,
  MessageSquare,
  Sparkles,
  ArrowDown,
  Info,
  Layers,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import type { QuickReply } from "@/types";

interface ChainedFollowUpItem {
  id: string;
  delay_value: number;
  delay_unit: "minutes" | "hours" | "days";
  response_id: string;
  cancel_on_client_reply: boolean;
  cancel_on_agent_reply: boolean;
}

interface WelcomeConfigData {
  id?: string;
  is_active: boolean;
  response_id: string | null;
  inactivity_window_days: number;
  send_if_human_active: boolean;
  follow_ups: ChainedFollowUpItem[];
}

export function WelcomeAutomationTab() {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [quickReplies, setQuickReplies] = useState<QuickReply[]>([]);
  const [config, setConfig] = useState<WelcomeConfigData>({
    is_active: false,
    response_id: null,
    inactivity_window_days: 14,
    send_if_human_active: false,
    follow_ups: [],
  });

  useEffect(() => {
    async function loadData() {
      setLoading(true);
      try {
        const [configRes, qrRes] = await Promise.all([
          fetch("/api/automations/welcome"),
          fetch("/api/quick-replies"),
        ]);

        if (configRes.ok) {
          const cData = await configRes.json();
          if (cData.config) {
            setConfig({
              id: cData.config.id,
              is_active: !!cData.config.is_active,
              response_id: cData.config.response_id || null,
              inactivity_window_days: cData.config.inactivity_window_days ?? 14,
              send_if_human_active: !!cData.config.send_if_human_active,
              follow_ups: Array.isArray(cData.config.follow_ups) ? cData.config.follow_ups : [],
            });
          }
        }

        if (qrRes.ok) {
          const qrData = await qrRes.json();
          setQuickReplies(Array.isArray(qrData.data) ? qrData.data : []);
        }
      } catch (err) {
        console.error("Failed to load welcome automation data", err);
        toast.error("Erro ao carregar dados da automação de boas-vindas");
      } finally {
        setLoading(false);
      }
    }
    loadData();
  }, []);

  async function handleSave() {
    setSaving(true);
    try {
      const res = await fetch("/api/automations/welcome", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(config),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || "Erro ao salvar");
      }

      toast.success("Automação de Boas-vindas salva com sucesso!");
    } catch (err: any) {
      toast.error(err.message || "Erro ao salvar configuração");
    } finally {
      setSaving(false);
    }
  }

  function addFollowUpStep() {
    const newStep: ChainedFollowUpItem = {
      id: crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).substring(2, 9),
      delay_value: 10,
      delay_unit: "minutes",
      response_id: quickReplies[0]?.id || "",
      cancel_on_client_reply: true,
      cancel_on_agent_reply: true,
    };
    setConfig((prev) => ({
      ...prev,
      follow_ups: [...prev.follow_ups, newStep],
    }));
  }

  function removeFollowUpStep(index: number) {
    setConfig((prev) => ({
      ...prev,
      follow_ups: prev.follow_ups.filter((_, i) => i !== index),
    }));
  }

  function updateFollowUpStep(index: number, patch: Partial<ChainedFollowUpItem>) {
    setConfig((prev) => {
      const updated = [...prev.follow_ups];
      updated[index] = { ...updated[index], ...patch };
      return { ...prev, follow_ups: updated };
    });
  }

  const selectedMainReply = quickReplies.find((qr) => qr.id === config.response_id);

  if (loading) {
    return (
      <div className="flex h-64 items-center justify-center">
        <div className="flex items-center gap-3 text-muted-foreground">
          <Clock className="h-5 w-5 animate-spin text-primary" />
          <span>Carregando automações e biblioteca de respostas...</span>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-8 max-w-4xl">
      {/* Header Banner */}
      <div className="rounded-2xl border border-border/80 bg-gradient-to-r from-card via-card/90 to-primary/5 p-6 shadow-sm">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div className="flex items-start gap-4">
            <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-amber-500/10 text-amber-500">
              <Sparkles className="h-6 w-6" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h2 className="text-xl font-bold text-foreground">Automação de Boas-vindas</h2>
                <Badge variant={config.is_active ? "default" : "secondary"}>
                  {config.is_active ? "Ativa" : "Pausada"}
                </Badge>
              </div>
              <p className="mt-1 text-sm text-muted-foreground">
                Dispara uma mensagem da sua Biblioteca Central quando um lead envia a primeira mensagem,
                com suporte a reentrada inteligente e sequência de follow-ups condicionais.
              </p>
            </div>
          </div>
          <div className="flex items-center gap-3 shrink-0">
            <Switch
              checked={config.is_active}
              onCheckedChange={(val) => setConfig((p) => ({ ...p, is_active: val }))}
              aria-label="Ativar automação de boas-vindas"
            />
            <Button
              onClick={handleSave}
              disabled={saving}
              className="bg-primary text-primary-foreground hover:bg-primary/90 gap-2 shadow-sm"
            >
              <Save className="h-4 w-4" />
              {saving ? "Salvando..." : "Salvar Configuração"}
            </Button>
          </div>
        </div>
      </div>

      {/* Regras e Mensagem Principal */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        {/* Coluna Esquerda: Configurações do Gatilho */}
        <div className="md:col-span-1 space-y-6">
          <div className="rounded-xl border border-border bg-card p-5 space-y-5">
            <h3 className="text-sm font-semibold text-foreground flex items-center gap-2">
              <Zap className="h-4 w-4 text-amber-500" />
              Gatilho de Entrada
            </h3>

            <div>
              <div className="text-xs font-medium text-muted-foreground mb-1">Tipo de Gatilho</div>
              <div className="rounded-lg border border-border/80 bg-muted/40 p-2.5 text-xs text-foreground font-medium">
                Primeira mensagem recebida do Lead
              </div>
              <p className="mt-1.5 text-[11px] text-muted-foreground">
                Detectado automaticamente pelo webhook UAZAPI quando uma nova conversa é iniciada.
              </p>
            </div>

            <div className="border-t border-border pt-4">
              <label className="text-xs font-medium text-foreground flex items-center justify-between">
                <span>Janela de Reentrada (dias)</span>
                <span className="font-mono text-xs text-primary font-bold">{config.inactivity_window_days}d</span>
              </label>
              <Input
                type="number"
                min={0}
                max={365}
                value={config.inactivity_window_days}
                onChange={(e) =>
                  setConfig((p) => ({ ...p, inactivity_window_days: parseInt(e.target.value) || 0 }))
                }
                className="mt-1.5 h-9 text-xs"
              />
              <p className="mt-1.5 text-[11px] text-muted-foreground leading-relaxed">
                {config.inactivity_window_days === 0 ? (
                  <span className="text-amber-500 font-medium">
                    0 dias: Dispara estritamente na 1ª mensagem da vida do contato.
                  </span>
                ) : (
                  <span>
                    Considera novamente nova conversa se o cliente ficar {config.inactivity_window_days} dias sem interagir.
                  </span>
                )}
              </p>
            </div>

            <div className="border-t border-border pt-4 space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-xs font-medium text-foreground">
                  Enviar mesmo com Atendente Ativo
                </span>
                <Switch
                  checked={config.send_if_human_active}
                  onCheckedChange={(val) => setConfig((p) => ({ ...p, send_if_human_active: val }))}
                />
              </div>
              <p className="text-[11px] text-muted-foreground leading-relaxed">
                {config.send_if_human_active
                  ? "A mensagem será enviada mesmo que um operador esteja com a conversa em HUMAN_ACTIVE."
                  : "Não dispara se um operador humano já tiver assumido o atendimento."}
              </p>
            </div>
          </div>

          <div className="rounded-xl border border-primary/20 bg-primary/5 p-4 text-xs text-muted-foreground space-y-2">
            <div className="font-semibold text-foreground flex items-center gap-1.5">
              <Info className="h-4 w-4 text-primary" />
              Variáveis Disponíveis
            </div>
            <p className="text-[11px] leading-relaxed">
              Você pode usar tags na sua resposta salva que serão substituídas no momento do envio:
            </p>
            <div className="flex flex-wrap gap-1.5 font-mono text-[10px]">
              <span className="px-1.5 py-0.5 rounded bg-card border border-border">{"{{nome}}"}</span>
              <span className="px-1.5 py-0.5 rounded bg-card border border-border">{"{{primeiro_nome}}"}</span>
              <span className="px-1.5 py-0.5 rounded bg-card border border-border">{"{{empresa}}"}</span>
              <span className="px-1.5 py-0.5 rounded bg-card border border-border">{"{{atendente}}"}</span>
            </div>
          </div>
        </div>

        {/* Coluna Direita: Seleção da Mensagem e Follow-ups */}
        <div className="md:col-span-2 space-y-6">
          {/* Mensagem Imediata */}
          <div className="rounded-xl border border-border bg-card p-5 space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold text-foreground flex items-center gap-2">
                <MessageSquare className="h-4 w-4 text-emerald-500" />
                Mensagem Imediata (Biblioteca Central)
              </h3>
              <Badge variant="outline" className="text-[11px] font-normal">
                Disparo Imediato
              </Badge>
            </div>

            <div>
              <label className="text-xs font-medium text-muted-foreground mb-1.5 block">
                Selecione uma resposta da Biblioteca de Respostas Rápidas:
              </label>
              <select
                value={config.response_id || ""}
                onChange={(e) => setConfig((p) => ({ ...p, response_id: e.target.value || null }))}
                className="w-full h-10 px-3 py-2 text-xs rounded-lg border border-border bg-background text-foreground focus:outline-none focus:ring-2 focus:ring-primary"
              >
                <option value="">-- Selecione uma resposta salva --</option>
                {quickReplies.map((qr) => (
                  <option key={qr.id} value={qr.id}>
                    [{qr.category || "Geral"}] {qr.title} ({qr.kind})
                  </option>
                ))}
              </select>
            </div>

            {selectedMainReply ? (
              <div className="rounded-lg border border-border/80 bg-muted/30 p-3 text-xs space-y-1.5">
                <div className="flex items-center justify-between text-muted-foreground">
                  <span className="font-semibold text-foreground">{selectedMainReply.title}</span>
                  <Badge variant="secondary" className="text-[10px]">
                    {selectedMainReply.kind.toUpperCase()}
                  </Badge>
                </div>
                <p className="text-foreground/90 whitespace-pre-line leading-relaxed font-sans">
                  {selectedMainReply.content_text || (selectedMainReply.media_url ? "Mídia anexada: " + selectedMainReply.media_url : "Sem conteúdo")}
                </p>
                {selectedMainReply.kind === "sequence" && (
                  <div className="text-[11px] text-primary flex items-center gap-1 mt-1">
                    <Layers className="h-3 w-3" />
                    Sequência com {selectedMainReply.sequence_items?.length || 0} passos
                  </div>
                )}
              </div>
            ) : (
              <div className="rounded-lg border border-dashed border-border p-4 text-center text-xs text-muted-foreground">
                Nenhuma resposta selecionada. Selecione uma resposta acima ou crie uma na Biblioteca Central.
              </div>
            )}
          </div>

          {/* Follow-ups Chained */}
          <div className="rounded-xl border border-border bg-card p-5 space-y-5">
            <div className="flex items-center justify-between">
              <div>
                <h3 className="text-sm font-semibold text-foreground flex items-center gap-2">
                  <Clock className="h-4 w-4 text-blue-500" />
                  Sequência de Follow-up Condicional
                </h3>
                <p className="text-xs text-muted-foreground mt-0.5">
                  Mensagens enviadas se o cliente não responder após a mensagem inicial.
                </p>
              </div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={addFollowUpStep}
                className="gap-1.5 text-xs h-8"
              >
                <Plus className="h-3.5 w-3.5" />
                Adicionar Etapa
              </Button>
            </div>

            {config.follow_ups.length === 0 ? (
              <div className="rounded-xl border border-dashed border-border/80 p-6 text-center text-xs text-muted-foreground">
                <p>Nenhum follow-up automático agendado.</p>
                <p className="mt-1 text-[11px]">
                  Clique em "+ Adicionar Etapa" para programar mensagens caso o lead não responda.
                </p>
              </div>
            ) : (
              <div className="space-y-4">
                {config.follow_ups.map((step, idx) => {
                  const reply = quickReplies.find((qr) => qr.id === step.response_id);
                  return (
                    <div
                      key={step.id || idx}
                      className="rounded-xl border border-border bg-background p-4 relative space-y-3"
                    >
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2">
                          <span className="flex h-5 w-5 items-center justify-center rounded-full bg-primary/10 text-primary text-xs font-bold">
                            {idx + 1}
                          </span>
                          <span className="text-xs font-semibold text-foreground">
                            Etapa {idx + 1} de Follow-up
                          </span>
                        </div>
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          onClick={() => removeFollowUpStep(idx)}
                          className="h-7 w-7 p-0 text-muted-foreground hover:text-red-500"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </div>

                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                        {/* Tempo de espera */}
                        <div>
                          <label className="text-[11px] font-medium text-muted-foreground block mb-1">
                            Aguardar após etapa anterior:
                          </label>
                          <div className="flex gap-2">
                            <Input
                              type="number"
                              min={1}
                              value={step.delay_value}
                              onChange={(e) =>
                                updateFollowUpStep(idx, { delay_value: parseInt(e.target.value) || 1 })
                              }
                              className="h-8 text-xs w-20"
                            />
                            <select
                              value={step.delay_unit}
                              onChange={(e) =>
                                updateFollowUpStep(idx, {
                                  delay_unit: e.target.value as "minutes" | "hours" | "days",
                                })
                              }
                              className="h-8 px-2 text-xs rounded-md border border-border bg-card text-foreground flex-1"
                            >
                              <option value="minutes">Minuto(s)</option>
                              <option value="hours">Hora(s)</option>
                              <option value="days">Dia(s)</option>
                            </select>
                          </div>
                        </div>

                        {/* Mensagem da Biblioteca */}
                        <div>
                          <label className="text-[11px] font-medium text-muted-foreground block mb-1">
                            Mensagem salva:
                          </label>
                          <select
                            value={step.response_id || ""}
                            onChange={(e) =>
                              updateFollowUpStep(idx, { response_id: e.target.value })
                            }
                            className="w-full h-8 px-2 text-xs rounded-md border border-border bg-card text-foreground"
                          >
                            <option value="">-- Selecione uma resposta --</option>
                            {quickReplies.map((qr) => (
                              <option key={qr.id} value={qr.id}>
                                [{qr.category || "Geral"}] {qr.title}
                              </option>
                            ))}
                          </select>
                        </div>
                      </div>

                      {reply && (
                        <div className="p-2 rounded bg-muted/40 border border-border/60 text-[11px] text-muted-foreground truncate">
                          Preview: &ldquo;{reply.content_text || reply.title}&rdquo;
                        </div>
                      )}

                      {/* Condições de parada */}
                      <div className="flex flex-wrap gap-4 pt-1 border-t border-border/40 text-xs">
                        <label className="flex items-center gap-2 cursor-pointer text-muted-foreground hover:text-foreground">
                          <input
                            type="checkbox"
                            checked={step.cancel_on_client_reply}
                            onChange={(e) =>
                              updateFollowUpStep(idx, { cancel_on_client_reply: e.target.checked })
                            }
                            className="rounded border-border text-primary focus:ring-primary h-3.5 w-3.5"
                          />
                          <span>Cancelar se cliente responder (silêncio)</span>
                        </label>

                        <label className="flex items-center gap-2 cursor-pointer text-muted-foreground hover:text-foreground">
                          <input
                            type="checkbox"
                            checked={step.cancel_on_agent_reply}
                            onChange={(e) =>
                              updateFollowUpStep(idx, { cancel_on_agent_reply: e.target.checked })
                            }
                            className="rounded border-border text-primary focus:ring-primary h-3.5 w-3.5"
                          />
                          <span>Cancelar se atendente responder</span>
                        </label>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
