"use client";

import { useState } from "react";
import {
  Layers,
  Plus,
  Trash2,
  ChevronUp,
  ChevronDown,
  Mic,
  Image as ImageIcon,
  MessageSquare,
  FileText,
  Video,
  Clock,
  ArrowDown,
  Sparkles,
  Check,
  Music,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import type { QuickReply, QuickReplySequenceStep } from "@/types";

interface SequenceStepBuilderProps {
  steps: QuickReplySequenceStep[];
  onChange: (steps: QuickReplySequenceStep[]) => void;
  availableReplies: QuickReply[];
}

export function SequenceStepBuilder({
  steps,
  onChange,
  availableReplies,
}: SequenceStepBuilderProps) {
  // Filter out sequence quick replies to prevent circular sequences
  const selectableReplies = availableReplies.filter(
    (r) => r.kind !== "sequence" && r.kind !== "interactive"
  );

  const audios = selectableReplies.filter((r) => r.kind === "audio");
  const images = selectableReplies.filter((r) => r.kind === "image");
  const texts = selectableReplies.filter((r) => r.kind === "text");
  const otherMedia = selectableReplies.filter(
    (r) => r.kind === "video" || r.kind === "document" || r.kind === "media"
  );

  const resolveStepType = (reply: QuickReply): QuickReplySequenceStep["type"] => {
    if (reply.kind === "audio" || reply.media_type?.startsWith("audio/") || /\.(ogg|mp3|wav|m4a|opus)(\?.*)?$/i.test(reply.media_url || "")) {
      return "audio";
    }
    if (reply.kind === "image" || reply.media_type?.startsWith("image/") || /\.(jpe?g|png|webp|gif)(\?.*)?$/i.test(reply.media_url || "")) {
      return "image";
    }
    if (reply.kind === "video" || reply.media_type?.startsWith("video/") || /\.(mp4|3gpp|mov)(\?.*)?$/i.test(reply.media_url || "")) {
      return "video";
    }
    if (reply.kind === "document" || reply.media_type?.startsWith("application/")) {
      return "document";
    }
    return (reply.kind as any) || "text";
  };

  const handleAddStep = (replyId?: string) => {
    let newStep: QuickReplySequenceStep;

    if (replyId) {
      const selected = selectableReplies.find((r) => r.id === replyId);
      if (selected) {
        newStep = {
          id: String(Date.now()),
          order: steps.length + 1,
          type: resolveStepType(selected),
          content: selected.content_text || selected.title,
          media_url: selected.media_url,
          media_type: selected.media_type,
          media_duration: selected.media_duration,
          delay_seconds: steps.length === 0 ? 0 : 3,
        };
      } else {
        newStep = {
          id: String(Date.now()),
          order: steps.length + 1,
          type: "text",
          content: "",
          delay_seconds: steps.length === 0 ? 0 : 3,
        };
      }
    } else {
      newStep = {
        id: String(Date.now()),
        order: steps.length + 1,
        type: "text",
        content: "",
        delay_seconds: steps.length === 0 ? 0 : 3,
      };
    }

    onChange([...steps, newStep]);
  };

  const handleSelectReplyForStep = (stepIndex: number, replyId: string) => {
    const selected = selectableReplies.find((r) => r.id === replyId);
    if (!selected) return;

    const next = [...steps];
    next[stepIndex] = {
      ...next[stepIndex],
      type: resolveStepType(selected),
      content: selected.content_text || selected.title,
      media_url: selected.media_url,
      media_type: selected.media_type,
      media_duration: selected.media_duration,
    };
    onChange(next);
  };

  const handleRemoveStep = (index: number) => {
    const next = steps.filter((_, i) => i !== index).map((s, i) => ({ ...s, order: i + 1 }));
    onChange(next);
  };

  const handleMoveStep = (index: number, direction: "up" | "down") => {
    const targetIndex = direction === "up" ? index - 1 : index + 1;
    if (targetIndex < 0 || targetIndex >= steps.length) return;

    const next = [...steps];
    const [moved] = next.splice(index, 1);
    next.splice(targetIndex, 0, moved);

    // Reassign order
    const reordered = next.map((s, i) => ({ ...s, order: i + 1 }));
    onChange(reordered);
  };

  const getKindIcon = (type: string) => {
    switch (type) {
      case "audio":
        return <Mic className="h-4 w-4 text-purple-600 dark:text-purple-400" />;
      case "image":
        return <ImageIcon className="h-4 w-4 text-blue-600 dark:text-blue-400" />;
      case "video":
        return <Video className="h-4 w-4 text-cyan-600 dark:text-cyan-400" />;
      case "document":
        return <FileText className="h-4 w-4 text-rose-600 dark:text-rose-400" />;
      default:
        return <MessageSquare className="h-4 w-4 text-amber-600 dark:text-amber-400" />;
    }
  };

  const getKindBadgeClass = (type: string) => {
    switch (type) {
      case "audio":
        return "bg-purple-500/15 text-purple-700 dark:text-purple-300 border-purple-500/30";
      case "image":
        return "bg-blue-500/15 text-blue-700 dark:text-blue-300 border-blue-500/30";
      case "video":
        return "bg-cyan-500/15 text-cyan-700 dark:text-cyan-300 border-cyan-500/30";
      case "document":
        return "bg-rose-500/15 text-rose-700 dark:text-rose-300 border-rose-500/30";
      default:
        return "bg-amber-500/15 text-amber-700 dark:text-amber-300 border-amber-500/30";
    }
  };

  return (
    <div className="space-y-3.5 p-3.5 rounded-lg border border-orange-500/30 bg-orange-500/5">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
        <div>
          <label className="text-xs font-bold text-orange-900 dark:text-orange-200 flex items-center gap-1.5">
            <Layers className="h-4 w-4 text-orange-600" />
            Etapas da Sequência (Ordem de Disparo)
          </label>
          <p className="text-[11px] text-muted-foreground">
            Configure as respostas cadastradas para serem enviadas em ordem cronológica no WhatsApp.
          </p>
        </div>

        <div className="flex items-center gap-1.5 self-start sm:self-center shrink-0">
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => handleAddStep()}
            className="h-7 text-xs gap-1 border-orange-500/40 text-orange-700 dark:text-orange-300 hover:bg-orange-500/10 font-medium"
          >
            <Plus className="h-3.5 w-3.5" />
            Adicionar Etapa
          </Button>
        </div>
      </div>

      {steps.length === 0 ? (
        <div className="p-5 border-2 border-dashed border-orange-500/30 rounded-lg text-center bg-background/50 space-y-2">
          <p className="text-xs text-muted-foreground">
            Nenhuma etapa adicionada. Selecione abaixo para começar:
          </p>
          <div className="flex flex-wrap items-center justify-center gap-2 pt-1">
            {audios.length > 0 && (
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => handleAddStep(audios[0].id)}
                className="h-7 text-xs gap-1 border-purple-500/30 text-purple-600 hover:bg-purple-500/10"
              >
                <Mic className="h-3.5 w-3.5" />
                Adicionar Áudio Cadastrado
              </Button>
            )}
            {images.length > 0 && (
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => handleAddStep(images[0].id)}
                className="h-7 text-xs gap-1 border-blue-500/30 text-blue-600 hover:bg-blue-500/10"
              >
                <ImageIcon className="h-3.5 w-3.5" />
                Adicionar Imagem Cadastrada
              </Button>
            )}
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => handleAddStep()}
              className="h-7 text-xs gap-1"
            >
              <Plus className="h-3.5 w-3.5" />
              Adicionar Mensagem de Texto
            </Button>
          </div>
        </div>
      ) : (
        <div className="space-y-2.5 max-h-96 overflow-y-auto pr-1">
          {steps.map((step, idx) => {
            const isFirst = idx === 0;
            const isLast = idx === steps.length - 1;

            return (
              <div key={step.id || idx} className="relative flex flex-col gap-1">
                {/* Arrow connector between steps showing delay flow */}
                {!isFirst && (
                  <div className="flex items-center justify-center gap-1.5 py-0.5 text-[10px] font-mono text-muted-foreground">
                    <ArrowDown className="h-3 w-3 text-orange-500 animate-bounce" />
                    <span className="bg-muted px-2 py-0.5 rounded-full border border-border">
                      aguarda {step.delay_seconds || 0}s de intervalo antes do próximo
                    </span>
                  </div>
                )}

                <div className="p-3 rounded-lg border border-border bg-card shadow-xs flex flex-col gap-2.5 transition-all hover:border-orange-500/40">
                  {/* Step Header: Order Badge + Move Controls + Delete */}
                  <div className="flex items-center justify-between gap-2 border-b border-border/50 pb-2">
                    <div className="flex items-center gap-2 flex-wrap">
                      <Badge
                        variant="outline"
                        className={`text-[11px] font-bold px-2 py-0.5 ${
                          isFirst
                            ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 border-emerald-500/40"
                            : "bg-orange-500/15 text-orange-700 dark:text-orange-300 border-orange-500/40"
                        }`}
                      >
                        {isFirst ? "1º a ser enviado" : `${idx + 1}º a ser enviado`}
                      </Badge>

                      <div
                        className={`flex items-center gap-1 text-xs font-semibold px-2 py-0.5 rounded border ${getKindBadgeClass(
                          step.type
                        )}`}
                      >
                        {getKindIcon(step.type)}
                        <span className="capitalize">{step.type}</span>
                      </div>
                    </div>

                    <div className="flex items-center gap-1">
                      {/* Move Up/Down Controls */}
                      <Button
                        type="button"
                        size="icon"
                        variant="ghost"
                        disabled={isFirst}
                        onClick={() => handleMoveStep(idx, "up")}
                        title="Enviar este passo antes (subir ordem)"
                        className="h-6 w-6 text-muted-foreground hover:text-foreground disabled:opacity-20"
                      >
                        <ChevronUp className="h-3.5 w-3.5" />
                      </Button>

                      <Button
                        type="button"
                        size="icon"
                        variant="ghost"
                        disabled={isLast}
                        onClick={() => handleMoveStep(idx, "down")}
                        title="Enviar este passo depois (descer ordem)"
                        className="h-6 w-6 text-muted-foreground hover:text-foreground disabled:opacity-20"
                      >
                        <ChevronDown className="h-3.5 w-3.5" />
                      </Button>

                      {steps.length > 1 && (
                        <Button
                          type="button"
                          size="icon"
                          variant="ghost"
                          onClick={() => handleRemoveStep(idx)}
                          title="Remover esta etapa"
                          className="h-6 w-6 text-muted-foreground hover:text-destructive hover:bg-destructive/10"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      )}
                    </div>
                  </div>

                  {/* Step Selector: Choose from registered quick replies */}
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                    <div className="space-y-1">
                      <label className="text-[11px] font-semibold text-foreground">
                        Origem da Resposta:
                      </label>
                      <select
                        onChange={(e) => {
                          const val = e.target.value;
                          if (val === "custom-text") {
                            const next = [...steps];
                            next[idx] = { ...next[idx], type: "text", media_url: null };
                            onChange(next);
                          } else if (val) {
                            handleSelectReplyForStep(idx, val);
                          }
                        }}
                        className="w-full h-8 text-xs rounded-md border border-input bg-background px-2 text-foreground truncate"
                        defaultValue=""
                      >
                        <option value="" disabled>
                          -- Selecionar dentre as respostas cadastradas --
                        </option>

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

                        <optgroup label="✏️ Personalizado">
                          <option value="custom-text">✏️ Digitar Novo Texto Personalizado</option>
                        </optgroup>
                      </select>
                    </div>

                    {/* Delay configuration */}
                    <div className="space-y-1">
                      <div className="flex items-center justify-between">
                        <label className="text-[11px] font-semibold text-foreground flex items-center gap-1">
                          <Clock className="h-3 w-3 text-muted-foreground" />
                          Intervalo (Delay):
                        </label>
                        <span className="text-[10px] text-muted-foreground font-mono">
                          {step.delay_seconds || 0} segundos
                        </span>
                      </div>
                      <div className="flex items-center gap-2">
                        <input
                          type="range"
                          min={0}
                          max={30}
                          step={1}
                          value={step.delay_seconds || 0}
                          onChange={(e) => {
                            const next = [...steps];
                            next[idx] = { ...next[idx], delay_seconds: Number(e.target.value) };
                            onChange(next);
                          }}
                          className="w-full accent-orange-500 cursor-pointer h-2"
                        />
                        <input
                          type="number"
                          min={0}
                          max={120}
                          value={step.delay_seconds || 0}
                          onChange={(e) => {
                            const next = [...steps];
                            next[idx] = { ...next[idx], delay_seconds: Number(e.target.value) || 0 };
                            onChange(next);
                          }}
                          className="w-12 h-7 text-xs text-center border rounded bg-background"
                        />
                      </div>
                    </div>
                  </div>

                  {/* Content Preview / Editor based on Step Type */}
                  <div className="pt-1">
                    {step.type === "text" ? (
                      <Input
                        placeholder="Conteúdo do texto (pode usar {{primeiro_nome}}, {{nome}}, etc.)..."
                        value={step.content || ""}
                        onChange={(e) => {
                          const next = [...steps];
                          next[idx] = { ...next[idx], content: e.target.value };
                          onChange(next);
                        }}
                        className="h-8 text-xs bg-background"
                      />
                    ) : (
                      <div className="flex items-center gap-2 p-2 rounded-md bg-muted/40 border border-border/60 text-xs">
                        {step.type === "audio" ? (
                          <div className="h-8 w-8 rounded-full bg-purple-500/20 text-purple-600 flex items-center justify-center shrink-0">
                            <Mic className="h-4 w-4" />
                          </div>
                        ) : (
                          <div className="h-8 w-8 rounded-md bg-blue-500/20 text-blue-600 flex items-center justify-center shrink-0">
                            <ImageIcon className="h-4 w-4" />
                          </div>
                        )}

                        <div className="min-w-0 flex-1">
                          <p className="font-semibold text-foreground truncate">
                            {step.content || (step.type === "audio" ? "Áudio Selecionado" : "Mídia Selecionada")}
                          </p>
                          <p className="text-[10px] text-muted-foreground truncate font-mono">
                            {step.media_url ? step.media_url : "Sem URL configurada"}
                          </p>
                        </div>

                        {step.media_duration && (
                          <Badge variant="outline" className="text-[10px] font-mono shrink-0">
                            {step.media_duration}s
                          </Badge>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      <div className="pt-1 flex items-center justify-between text-[11px] text-muted-foreground border-t border-orange-500/20">
        <span>Total: {steps.length} {steps.length === 1 ? "mensagem" : "mensagens"} na sequência</span>
        <span className="text-orange-700 dark:text-orange-300 font-medium">
          ✓ Enviadas juntas em ordem no WhatsApp
        </span>
      </div>
    </div>
  );
}
