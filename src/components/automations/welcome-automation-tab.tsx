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
  Mic,
  Image as ImageIcon,
  Video,
  FileText,
  ChevronRight,
  Pencil,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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

  // Editor modal state
  const [editingReply, setEditingReply] = useState<QuickReply | null>(null);
  const [editText, setEditText] = useState("");
  const [editSequenceSteps, setEditSequenceSteps] = useState<any[]>([]);
  const [savingEdit, setSavingEdit] = useState(false);
  const [isEditOpen, setIsEditOpen] = useState(false);

  const openEditReply = (reply: QuickReply) => {
    setEditingReply(reply);
    setEditText(reply.content_text || "");
    const seq = Array.isArray(reply.sequence_items)
      ? JSON.parse(JSON.stringify(reply.sequence_items))
      : [];
    setEditSequenceSteps(seq);
    setIsEditOpen(true);
  };

  const handleSaveEditedReply = async () => {
    if (!editingReply) return;
    setSavingEdit(true);
    try {
      const isSequence = editingReply.kind === "sequence" || editSequenceSteps.length > 0;
      const body: Record<string, any> = {
        title: editingReply.title,
        kind: editingReply.kind,
      };
      if (isSequence) {
        body.sequence_items = editSequenceSteps;
        body.content_text = editText || `[Sequência: ${editSequenceSteps.length} mensagens]`;
      } else {
        body.content_text = editText;
      }

      const res = await fetch(`/api/quick-replies/${editingReply.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || "Erro ao salvar alterações");
      }

      // Update local quickReplies list
      setQuickReplies((prev) =>
        prev.map((qr) =>
          qr.id === editingReply.id
            ? {
                ...qr,
                content_text: body.content_text,
                sequence_items: isSequence ? editSequenceSteps : qr.sequence_items,
              }
            : qr
        )
      );

      toast.success("Texto da automação atualizado com sucesso!");
      setIsEditOpen(false);
    } catch (error: any) {
      console.error("Erro ao salvar texto da resposta:", error);
      toast.error(error.message || "Erro ao atualizar resposta rápida");
    } finally {
      setSavingEdit(false);
    }
  };

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
          const list = Array.isArray(qrData.quick_replies)
            ? qrData.quick_replies
            : Array.isArray(qrData.data)
            ? qrData.data
            : [];
          setQuickReplies(list);
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

  // Group quick replies by kind
  const audios = quickReplies.filter((r) => r.kind === "audio");
  const images = quickReplies.filter((r) => r.kind === "image");
  const sequences = quickReplies.filter((r) => r.kind === "sequence");
  const texts = quickReplies.filter((r) => r.kind === "text");
  const otherMedia = quickReplies.filter(
    (r) => r.kind === "video" || r.kind === "document" || r.kind === "media"
  );

  const renderSelectOptions = (placeholder: string) => (
    <>
      <option value="">{placeholder}</option>
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
    </>
  );

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
                {renderSelectOptions("-- Selecione uma resposta salva da biblioteca --")}
              </select>
            </div>

            {selectedMainReply ? (
              <div className="rounded-lg border border-border/80 bg-muted/30 p-3.5 text-xs space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    {selectedMainReply.kind === "audio" ? (
                      <div className="h-7 w-7 rounded-full bg-purple-500/20 text-purple-600 flex items-center justify-center shrink-0">
                        <Mic className="h-4 w-4" />
                      </div>
                    ) : selectedMainReply.kind === "image" ? (
                      <div className="h-7 w-7 rounded-md bg-blue-500/20 text-blue-600 flex items-center justify-center shrink-0">
                        <ImageIcon className="h-4 w-4" />
                      </div>
                    ) : selectedMainReply.kind === "sequence" ? (
                      <div className="h-7 w-7 rounded-md bg-orange-500/20 text-orange-600 flex items-center justify-center shrink-0">
                        <Layers className="h-4 w-4" />
                      </div>
                    ) : (
                      <div className="h-7 w-7 rounded-md bg-amber-500/20 text-amber-600 flex items-center justify-center shrink-0">
                        <MessageSquare className="h-4 w-4" />
                      </div>
                    )}
                    <span className="font-semibold text-foreground text-sm">{selectedMainReply.title}</span>
                  </div>

                  <div className="flex items-center gap-1.5">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => openEditReply(selectedMainReply)}
                      className="h-6 px-2 gap-1 text-[11px] text-primary hover:text-primary hover:bg-primary/10 border-primary/30"
                    >
                      <Pencil className="h-3 w-3" />
                      Editar Texto
                    </Button>
                    {selectedMainReply.media_duration && (
                      <Badge variant="outline" className="text-[10px] font-mono">
                        {selectedMainReply.media_duration}s
                      </Badge>
                    )}
                    <Badge
                      variant="outline"
                      className={`text-[10px] uppercase font-bold ${
                        selectedMainReply.kind === "audio"
                          ? "bg-purple-500/15 text-purple-700 dark:text-purple-300 border-purple-500/40"
                          : selectedMainReply.kind === "image"
                          ? "bg-blue-500/15 text-blue-700 dark:text-blue-300 border-blue-500/40"
                          : selectedMainReply.kind === "sequence"
                          ? "bg-orange-500/15 text-orange-700 dark:text-orange-300 border-orange-500/40"
                          : "bg-amber-500/15 text-amber-700 dark:text-amber-300 border-amber-500/40"
                      }`}
                    >
                      {selectedMainReply.kind}
                    </Badge>
                  </div>
                </div>

                {selectedMainReply.content_text && selectedMainReply.kind !== "sequence" && (
                  <p className="text-foreground/90 whitespace-pre-line leading-relaxed font-sans bg-background/60 p-2.5 rounded border border-border/50">
                    {selectedMainReply.content_text}
                  </p>
                )}

                {selectedMainReply.media_url && selectedMainReply.kind !== "sequence" && (
                  <div className="text-[11px] text-muted-foreground flex items-center gap-1 font-mono truncate">
                    <span>Mídia:</span>
                    <span className="truncate text-foreground/80">{selectedMainReply.media_url}</span>
                  </div>
                )}

                {selectedMainReply.kind === "sequence" && (
                  <div className="pt-2 border-t border-border/60 space-y-2">
                    <div className="flex items-center justify-between">
                      <div className="text-[11px] font-semibold text-orange-700 dark:text-orange-300 flex items-center gap-1">
                        <Layers className="h-3.5 w-3.5" />
                        Passos da Sequência ({selectedMainReply.sequence_items?.length || 0} mensagens):
                      </div>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => openEditReply(selectedMainReply)}
                        className="h-6 px-2 text-[11px] text-orange-600 hover:text-orange-700 hover:bg-orange-500/10 gap-1 font-medium"
                      >
                        <Pencil className="h-3 w-3" />
                        Editar Textos da Sequência
                      </Button>
                    </div>
                    <div className="space-y-1.5">
                      {((selectedMainReply.sequence_items as any[]) || []).map((step, sIdx) => (
                        <div key={sIdx} className="rounded bg-background/70 p-2 border border-border/40 text-[11px] space-y-1">
                          <div className="flex items-center justify-between font-mono text-[10px] text-muted-foreground">
                            <span className="font-semibold text-foreground">
                              Passo {sIdx + 1}: {step.type === "image" ? "🖼️ Imagem (Tabela)" : step.type === "audio" ? "🎙️ Áudio" : step.type === "video" ? "🎥 Vídeo" : "💬 Mensagem de Texto"}
                            </span>
                            {step.delay_seconds ? <span>Espera: {step.delay_seconds}s</span> : null}
                          </div>
                          {step.content && (
                            <p className="whitespace-pre-line text-foreground/90 font-sans line-clamp-3 bg-muted/20 p-1.5 rounded">
                              {step.content}
                            </p>
                          )}
                          {step.media_url && (
                            <div className="truncate text-muted-foreground text-[10px]">
                              Mídia: <span className="font-mono text-foreground/80">{step.media_url}</span>
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            ) : (
              <div className="rounded-lg border border-dashed border-border p-4 text-center text-xs text-muted-foreground">
                Nenhuma resposta selecionada. Selecione uma resposta acima para enviar aos novos leads.
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
                            {renderSelectOptions("-- Selecione uma resposta salva --")}
                          </select>
                        </div>
                      </div>

                      {reply && (
                        <div className="p-2.5 rounded-lg bg-muted/40 border border-border/60 text-xs space-y-1">
                          <div className="flex items-center justify-between gap-1">
                            <div className="flex items-center gap-1.5 font-semibold text-foreground">
                              {reply.kind === "audio" && <Mic className="h-3.5 w-3.5 text-purple-600" />}
                              {reply.kind === "image" && <ImageIcon className="h-3.5 w-3.5 text-blue-600" />}
                              {reply.kind === "sequence" && <Layers className="h-3.5 w-3.5 text-orange-600" />}
                              {reply.kind === "text" && <MessageSquare className="h-3.5 w-3.5 text-amber-600" />}
                              <span>{reply.title}</span>
                            </div>
                            <div className="flex items-center gap-1">
                              <Button
                                type="button"
                                variant="ghost"
                                size="sm"
                                onClick={() => openEditReply(reply)}
                                className="h-6 px-1.5 gap-1 text-[10px] text-primary hover:bg-primary/10"
                              >
                                <Pencil className="h-3 w-3" />
                                Editar Texto
                              </Button>
                              {reply.media_duration && (
                                <Badge variant="outline" className="text-[9px] font-mono">
                                  {reply.media_duration}s
                                </Badge>
                              )}
                              <Badge variant="outline" className="text-[9px] uppercase font-bold">
                                {reply.kind}
                              </Badge>
                            </div>
                          </div>
                          <p className="text-[11px] text-muted-foreground truncate">
                            {reply.content_text || (reply.media_url ? "Mídia: " + reply.media_url : "Sem conteúdo")}
                          </p>
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

      {/* Modal / Dialog para edição direta do texto das automações */}
      <Dialog open={isEditOpen} onOpenChange={setIsEditOpen}>
        <DialogContent className="max-w-2xl max-h-[88vh] flex flex-col p-6">
          <DialogHeader className="pb-3 border-b border-border/60">
            <DialogTitle className="flex items-center gap-2 text-base text-foreground font-bold">
              <Pencil className="h-4 w-4 text-primary" />
              Editar Conteúdo da Automação: <span className="text-primary">{editingReply?.title}</span>
            </DialogTitle>
            <DialogDescription className="text-xs text-muted-foreground">
              Edite o texto que será disparado automaticamente para o lead no WhatsApp quando esta automação for ativada.
            </DialogDescription>
          </DialogHeader>

          <div className="flex-1 overflow-y-auto pr-1 space-y-4 py-2">
            {/* Se for sequência (como a tabela + texto de boas-vindas) */}
            {editingReply && (editingReply.kind === "sequence" || editSequenceSteps.length > 0) ? (
              <div className="space-y-4">
                <div className="text-xs font-semibold text-foreground flex items-center gap-1.5">
                  <Layers className="h-4 w-4 text-orange-500" />
                  Passos da Sequência ({editSequenceSteps.length} mensagens enviadas em ordem):
                </div>

                {editSequenceSteps.map((step, idx) => (
                  <div key={idx} className="rounded-xl border border-border bg-muted/20 p-4 space-y-3">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <span className="flex h-5 w-5 items-center justify-center rounded-full bg-orange-500/15 text-orange-600 font-bold text-xs">
                          {idx + 1}
                        </span>
                        <span className="text-xs font-semibold uppercase text-foreground">
                          Passo {idx + 1}: {step.type === "image" ? "🖼️ Imagem (Tabela de Preços/Planos)" : step.type === "audio" ? "🎙️ Áudio" : step.type === "video" ? "🎥 Vídeo" : "💬 Mensagem de Texto"}
                        </span>
                      </div>
                      <div className="flex items-center gap-2 text-xs">
                        <label className="text-[11px] text-muted-foreground">Aguardar:</label>
                        <div className="flex items-center gap-1">
                          <Input
                            type="number"
                            min={0}
                            value={step.delay_seconds ?? 0}
                            onChange={(e) => {
                              const val = parseInt(e.target.value) || 0;
                              setEditSequenceSteps((prev) =>
                                prev.map((s, i) => (i === idx ? { ...s, delay_seconds: val } : s))
                              );
                            }}
                            className="h-7 w-16 text-xs text-center"
                          />
                          <span className="text-[11px] text-muted-foreground">seg</span>
                        </div>
                      </div>
                    </div>

                    {step.media_url && (
                      <div className="space-y-1.5">
                        <label className="text-[11px] font-medium text-muted-foreground block">
                          URL da Mídia:
                        </label>
                        <Input
                          value={step.media_url || ""}
                          onChange={(e) => {
                            const val = e.target.value;
                            setEditSequenceSteps((prev) =>
                              prev.map((s, i) => (i === idx ? { ...s, media_url: val } : s))
                            );
                          }}
                          className="h-8 text-xs font-mono"
                          placeholder="https://..."
                        />
                        {step.type === "image" && step.media_url && (
                          <div className="relative h-28 w-44 rounded-lg overflow-hidden border border-border bg-background mt-1">
                            <img
                              src={step.media_url}
                              alt="Prévia da tabela"
                              className="h-full w-full object-cover"
                            />
                          </div>
                        )}
                      </div>
                    )}

                    <div className="space-y-1.5">
                      <div className="flex items-center justify-between">
                        <label className="text-[11px] font-medium text-foreground">
                          {step.type === "image" ? "Legenda da Imagem (opcional):" : "Texto da Mensagem enviada ao Lead:"}
                        </label>
                        <span className="text-[10px] text-muted-foreground font-mono">
                          {(step.content || "").length} caracteres
                        </span>
                      </div>

                      {/* Variáveis para inserir no passo */}
                      <div className="flex flex-wrap items-center gap-1 pb-1">
                        <span className="text-[10px] text-muted-foreground flex items-center gap-1 mr-1">
                          <Sparkles className="h-3 w-3 text-amber-500" /> Inserir:
                        </span>
                        {[
                          { label: "Primeiro Nome", tag: "{{primeiro_nome}}" },
                          { label: "Nome Completo", tag: "{{nome}}" },
                          { label: "Empresa", tag: "{{empresa}}" },
                          { label: "Atendente", tag: "{{atendente}}" },
                        ].map((v) => (
                          <button
                            key={v.tag}
                            type="button"
                            onClick={() => {
                              setEditSequenceSteps((prev) =>
                                prev.map((s, i) =>
                                  i === idx ? { ...s, content: (s.content || "") + " " + v.tag } : s
                                )
                              );
                            }}
                            className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-background border border-border/80 hover:border-primary hover:text-primary transition-colors cursor-pointer"
                          >
                            + {v.tag}
                          </button>
                        ))}
                      </div>

                      <Textarea
                        rows={step.type === "text" ? 7 : 2}
                        value={step.content || ""}
                        onChange={(e) => {
                          const val = e.target.value;
                          setEditSequenceSteps((prev) =>
                            prev.map((s, i) => (i === idx ? { ...s, content: val } : s))
                          );
                        }}
                        placeholder={
                          step.type === "image"
                            ? "Legenda opcional para a imagem..."
                            : "Digite o texto da mensagem que será enviada para o lead..."
                        }
                        className="text-xs font-sans leading-relaxed resize-y"
                      />
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <label className="text-xs font-medium text-foreground">
                    Texto da Mensagem Enviada:
                  </label>
                  <span className="text-[10px] text-muted-foreground font-mono">
                    {editText.length} caracteres
                  </span>
                </div>

                {/* Variáveis para inserir no texto simples */}
                <div className="flex flex-wrap items-center gap-1.5 pb-1">
                  <span className="text-[11px] text-muted-foreground flex items-center gap-1 mr-1">
                    <Sparkles className="h-3.5 w-3.5 text-amber-500" /> Inserir tag:
                  </span>
                  {[
                    { label: "Primeiro Nome", tag: "{{primeiro_nome}}" },
                    { label: "Nome Completo", tag: "{{nome}}" },
                    { label: "Empresa", tag: "{{empresa}}" },
                    { label: "Atendente", tag: "{{atendente}}" },
                  ].map((v) => (
                    <button
                      key={v.tag}
                      type="button"
                      onClick={() => setEditText((prev) => (prev ? prev + " " + v.tag : v.tag))}
                      className="text-[11px] font-mono px-2 py-0.5 rounded bg-background border border-border/80 hover:border-primary hover:text-primary transition-colors cursor-pointer"
                    >
                      + {v.tag}
                    </button>
                  ))}
                </div>

                <Textarea
                  rows={9}
                  value={editText}
                  onChange={(e) => setEditText(e.target.value)}
                  placeholder="Digite o texto da mensagem que será enviada para o lead..."
                  className="text-xs font-sans leading-relaxed resize-y"
                />
              </div>
            )}
          </div>

          <DialogFooter className="pt-3 border-t border-border/60 gap-2 sm:gap-0">
            <Button
              type="button"
              variant="outline"
              onClick={() => setIsEditOpen(false)}
              disabled={savingEdit}
            >
              Cancelar
            </Button>
            <Button
              type="button"
              onClick={handleSaveEditedReply}
              disabled={savingEdit}
              className="gap-1.5 bg-primary text-primary-foreground hover:bg-primary/90 font-medium"
            >
              <Save className="h-4 w-4" />
              {savingEdit ? "Salvando Alterações..." : "Salvar Alterações no Texto"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
