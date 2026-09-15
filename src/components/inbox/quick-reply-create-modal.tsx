"use client";

import { useState, useRef } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import {
  Mic,
  Upload,
  Square,
  Plus,
  Trash2,
  Sparkles,
  Loader2,
  Star,
} from "lucide-react";
import { toast } from "sonner";
import type { QuickReplyKind, QuickReplySequenceStep } from "@/types";
import { uploadAccountMedia } from "@/lib/storage/upload-media";
import { getDefaultColorForKind } from "@/lib/inbox/quick-reply-colors";
import { CHAT_MEDIA_BUCKET } from "./message-composer";

interface QuickReplyCreateModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  defaultKind?: QuickReplyKind;
  onCreated: () => void;
}

const CATEGORIES = [
  "Geral",
  "Saudação",
  "Vendas",
  "Preço",
  "Pagamento",
  "Produtos",
  "Objeções",
  "Follow-up",
  "Pós-venda",
  "Suporte",
  "Qualificação",
  "Apresentação",
  "Documentos",
];

export function QuickReplyCreateModal({
  open,
  onOpenChange,
  defaultKind = "text",
  onCreated,
}: QuickReplyCreateModalProps) {
  const [kind, setKind] = useState<QuickReplyKind>(defaultKind);
  const [title, setTitle] = useState("");
  const [shortcut, setShortcut] = useState("");
  const [category, setCategory] = useState("Vendas");
  const [contentText, setContentText] = useState("");
  const [mediaUrl, setMediaUrl] = useState("");
  const [mediaDuration, setMediaDuration] = useState<number>(0);
  const [isFavorite, setIsFavorite] = useState(false);
  const [scope, setScope] = useState<"team" | "personal">("team");
  const [uploading, setUploading] = useState(false);

  // Sequence items state
  const [sequenceItems, setSequenceItems] = useState<QuickReplySequenceStep[]>([
    { id: "1", order: 1, type: "text", content: "Olá {{primeiro_nome}}, tudo bem?", delay_seconds: 0 },
    { id: "2", order: 2, type: "text", content: "Como posso te ajudar hoje?", delay_seconds: 3 },
  ]);

  // Audio recording
  const [isRecording, setIsRecording] = useState(false);
  const [recordSeconds, setRecordSeconds] = useState(0);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const recordTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const reset = () => {
    setTitle("");
    setShortcut("");
    setCategory("Vendas");
    setContentText("");
    setMediaUrl("");
    setMediaDuration(0);
    setIsFavorite(false);
    setScope("team");
    setKind("text");
  };

  const handleStartRecording = async () => {
    if (!navigator.mediaDevices?.getUserMedia) {
      toast.error("Gravação não suportada neste navegador.");
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mediaRecorder = new MediaRecorder(stream);
      mediaRecorderRef.current = mediaRecorder;
      audioChunksRef.current = [];

      mediaRecorder.ondataavailable = (e) => {
        if (e.data.size > 0) audioChunksRef.current.push(e.data);
      };

      mediaRecorder.onstop = async () => {
        const blob = new Blob(audioChunksRef.current, { type: "audio/ogg" });
        const localUrl = URL.createObjectURL(blob);
        const tempAudio = new Audio(localUrl);
        tempAudio.onloadedmetadata = () => {
          setMediaDuration(isFinite(tempAudio.duration) ? Math.round(tempAudio.duration) : recordSeconds);
        };

        // Upload to storage
        try {
          const file = new File([blob], `voice-${Date.now()}.ogg`, { type: "audio/ogg" });
          const { publicUrl } = await uploadAccountMedia(CHAT_MEDIA_BUCKET, file);
          setMediaUrl(publicUrl);
          toast.success("Áudio gravado e armazenado!");
        } catch {
          toast.error("Falha ao enviar áudio.");
        }

        stream.getTracks().forEach((track) => track.stop());
      };

      mediaRecorder.start(200);
      setIsRecording(true);
      setRecordSeconds(0);
      recordTimerRef.current = setInterval(() => setRecordSeconds((s) => s + 1), 1000);
    } catch {
      toast.error("Permissão de microfone negada.");
    }
  };

  const handleStopRecording = () => {
    if (mediaRecorderRef.current && isRecording) {
      mediaRecorderRef.current.stop();
      setIsRecording(false);
      if (recordTimerRef.current) {
        clearInterval(recordTimerRef.current);
        recordTimerRef.current = null;
      }
    }
  };

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setUploading(true);
    try {
      const { publicUrl } = await uploadAccountMedia(CHAT_MEDIA_BUCKET, file);
      setMediaUrl(publicUrl);
      if (!title) {
        setTitle(file.name.replace(/\.[^/.]+$/, ""));
      }
      toast.success("Arquivo enviado com sucesso!");
    } catch {
      toast.error("Erro no upload do arquivo.");
    } finally {
      setUploading(false);
    }
  };

  const handleAddSequenceStep = () => {
    const nextOrder = sequenceItems.length + 1;
    setSequenceItems([
      ...sequenceItems,
      {
        id: String(Date.now()),
        order: nextOrder,
        type: "text",
        content: "",
        delay_seconds: 2,
      },
    ]);
  };

  const handleRemoveSequenceStep = (index: number) => {
    setSequenceItems(sequenceItems.filter((_, i) => i !== index));
  };

  const handleSave = async () => {
    if (!title.trim()) {
      toast.error("Defina um título para a resposta rápida.");
      return;
    }

    if (kind === "text" && !contentText.trim()) {
      toast.error("O texto da resposta não pode ficar vazio.");
      return;
    }

    if (["audio", "image", "video", "document"].includes(kind) && !mediaUrl) {
      toast.error("Faça o upload da mídia antes de salvar.");
      return;
    }

    if (kind === "sequence" && sequenceItems.length === 0) {
      toast.error("Adicione pelo menos uma mensagem na sequência.");
      return;
    }

    setUploading(true);
    try {
      const res = await fetch("/api/quick-replies", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: title.trim(),
          kind,
          shortcut: shortcut ? shortcut.replace(/^\//, "").trim() : null,
          category,
          color: getDefaultColorForKind(kind),
          content_text: contentText.trim(),
          media_url: mediaUrl || null,
          media_duration: mediaDuration || null,
          is_favorite: isFavorite,
          scope,
          sequence_items: kind === "sequence" ? sequenceItems : null,
        }),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || "Falha ao criar resposta rápida.");
      }

      toast.success("Resposta rápida criada com sucesso!");
      reset();
      onOpenChange(false);
      onCreated();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Erro desconhecido";
      toast.error(msg);
    } finally {
      setUploading(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl max-h-[90vh] flex flex-col p-0 gap-0 overflow-hidden border-border bg-card">
        <DialogHeader className="px-5 py-3.5 border-b border-border/70 flex flex-row items-center justify-between">
          <DialogTitle className="text-base font-semibold text-foreground flex items-center gap-2">
            <span>✨</span>
            <span>Nova Resposta Rápida / Atalho</span>
          </DialogTitle>
          <button
            type="button"
            onClick={() => setIsFavorite(!isFavorite)}
            title={isFavorite ? "Remover dos favoritos" : "Marcar como favorito"}
            className="p-1 rounded hover:bg-muted text-muted-foreground"
          >
            <Star className={`h-4 w-4 ${isFavorite ? "fill-amber-400 text-amber-500" : ""}`} />
          </button>
        </DialogHeader>

        <div className="flex-1 overflow-y-auto p-5 space-y-4">
          {/* Type selector */}
          <div className="space-y-1.5">
            <label className="text-xs font-semibold text-foreground">Tipo de Resposta</label>
            <div className="grid grid-cols-3 sm:grid-cols-6 gap-1.5">
              {[
                { id: "text", label: "Texto", icon: "🟨" },
                { id: "audio", label: "Áudio", icon: "🟪" },
                { id: "sequence", label: "Sequência", icon: "🟧" },
                { id: "image", label: "Imagem", icon: "🟦" },
                { id: "video", label: "Vídeo", icon: "🟩" },
                { id: "document", label: "Documento", icon: "🟥" },
              ].map((t) => (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => setKind(t.id as QuickReplyKind)}
                  className={`flex flex-col items-center justify-center p-2 rounded-lg border text-xs font-medium transition-all ${
                    kind === t.id
                      ? "border-primary bg-primary/10 text-primary shadow-xs"
                      : "border-border/60 hover:bg-muted/50 text-muted-foreground"
                  }`}
                >
                  <span className="text-base mb-0.5">{t.icon}</span>
                  <span>{t.label}</span>
                </button>
              ))}
            </div>
          </div>

          {/* Title & Shortcut */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div className="sm:col-span-2 space-y-1">
              <label className="text-xs font-semibold text-foreground">Título</label>
              <Input
                placeholder="Ex: Saudação Inicial, Preço Plano Pro"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                className="h-8 text-xs bg-background"
              />
            </div>
            <div className="space-y-1">
              <label className="text-xs font-semibold text-foreground">Atalho (/)</label>
              <Input
                placeholder="preco, ola"
                value={shortcut}
                onChange={(e) => setShortcut(e.target.value)}
                className="h-8 text-xs font-mono bg-background"
              />
            </div>
          </div>

          {/* Category & Scope */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="space-y-1">
              <label className="text-xs font-semibold text-foreground">Categoria</label>
              <select
                value={category}
                onChange={(e) => setCategory(e.target.value)}
                className="w-full h-8 text-xs rounded-md border border-input bg-background px-2.5 text-foreground"
              >
                {CATEGORIES.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            </div>

            <div className="space-y-1">
              <label className="text-xs font-semibold text-foreground">Disponibilidade</label>
              <select
                value={scope}
                onChange={(e) => setScope(e.target.value as "team" | "personal")}
                className="w-full h-8 text-xs rounded-md border border-input bg-background px-2.5 text-foreground"
              >
                <option value="team">👥 Compartilhada com a Equipe</option>
                <option value="personal">👤 Somente Pessoal</option>
              </select>
            </div>
          </div>

          {/* Specific content based on kind */}
          {kind === "text" && (
            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <label className="text-xs font-semibold text-foreground">Conteúdo da Mensagem</label>
                <div className="flex items-center gap-1 text-[10px] text-muted-foreground">
                  <span className="font-semibold text-primary">Variáveis:</span>
                  {["{{primeiro_nome}}", "{{nome}}", "{{empresa}}", "{{atendente}}"].map((v) => (
                    <button
                      key={v}
                      type="button"
                      onClick={() => setContentText((t) => `${t} ${v}`)}
                      className="px-1 py-0.5 rounded bg-muted hover:bg-muted/80 font-mono text-[9px]"
                    >
                      {v}
                    </button>
                  ))}
                </div>
              </div>
              <Textarea
                rows={4}
                placeholder="Olá {{primeiro_nome}}, tudo bem? Aqui é o {{atendente}}..."
                value={contentText}
                onChange={(e) => setContentText(e.target.value)}
                className="text-xs bg-background resize-y"
              />
            </div>
          )}

          {kind === "audio" && (
            <div className="space-y-2 p-3 rounded-lg border border-purple-500/30 bg-purple-500/5">
              <label className="text-xs font-semibold text-purple-700 dark:text-purple-300">
                Gravação de Voz ou Arquivo de Áudio (PTT)
              </label>

              <div className="flex flex-wrap items-center gap-2">
                {!isRecording ? (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={handleStartRecording}
                    className="h-8 gap-1.5 text-xs text-purple-600 border-purple-500/40 hover:bg-purple-500/10"
                  >
                    <Mic className="h-3.5 w-3.5" />
                    Gravar Microfone
                  </Button>
                ) : (
                  <Button
                    type="button"
                    variant="destructive"
                    size="sm"
                    onClick={handleStopRecording}
                    className="h-8 gap-1.5 text-xs animate-pulse"
                  >
                    <Square className="h-3.5 w-3.5" />
                    Parar ({recordSeconds}s)
                  </Button>
                )}

                <input
                  ref={fileInputRef}
                  type="file"
                  accept="audio/*,.ogg,.mp3,.wav"
                  onChange={handleFileUpload}
                  className="hidden"
                />

                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => fileInputRef.current?.click()}
                  className="h-8 gap-1.5 text-xs"
                >
                  <Upload className="h-3.5 w-3.5" />
                  Upload Arquivo
                </Button>

                {mediaUrl && (
                  <Badge variant="outline" className="bg-emerald-500/10 text-emerald-600 border-emerald-500/30 text-xs">
                    ✓ Áudio salvo ({mediaDuration}s)
                  </Badge>
                )}
              </div>
            </div>
          )}

          {["image", "video", "document"].includes(kind) && (
            <div className="space-y-2 p-3 rounded-lg border border-border bg-muted/20">
              <label className="text-xs font-semibold text-foreground capitalize">
                Arquivo de {kind}
              </label>

              <div className="flex items-center gap-2">
                <input
                  ref={fileInputRef}
                  type="file"
                  accept={
                    kind === "image"
                      ? "image/*"
                      : kind === "video"
                      ? "video/*"
                      : ".pdf,.doc,.docx,.xls,.xlsx,.txt"
                  }
                  onChange={handleFileUpload}
                  className="hidden"
                />
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => fileInputRef.current?.click()}
                  className="h-8 gap-1.5 text-xs"
                >
                  <Upload className="h-3.5 w-3.5" />
                  Selecionar Arquivo
                </Button>

                {mediaUrl && (
                  <span className="text-xs text-emerald-600 font-medium truncate max-w-xs">
                    ✓ Arquivo pronto para envio
                  </span>
                )}
              </div>

              <div className="space-y-1 pt-1">
                <label className="text-xs text-muted-foreground">Legenda (opcional)</label>
                <Input
                  placeholder="Legenda que acompanha o arquivo..."
                  value={contentText}
                  onChange={(e) => setContentText(e.target.value)}
                  className="h-8 text-xs bg-background"
                />
              </div>
            </div>
          )}

          {kind === "sequence" && (
            <div className="space-y-3 p-3 rounded-lg border border-orange-500/30 bg-orange-500/5">
              <div className="flex items-center justify-between">
                <label className="text-xs font-semibold text-orange-800 dark:text-orange-200">
                  Etapas da Sequência
                </label>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={handleAddSequenceStep}
                  className="h-6 text-[11px] gap-1 border-orange-500/40 text-orange-700 dark:text-orange-300"
                >
                  <Plus className="h-3 w-3" />
                  Adicionar Passo
                </Button>
              </div>

              <div className="space-y-2 max-h-56 overflow-y-auto pr-1">
                {sequenceItems.map((step, idx) => (
                  <div
                    key={step.id || idx}
                    className="p-2.5 rounded-md border border-border/80 bg-background flex flex-col gap-2 shadow-2xs"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-[11px] font-semibold text-foreground">
                        {idx + 1}. Tipo:
                      </span>
                      <select
                        value={step.type}
                        onChange={(e) => {
                          const val = e.target.value as any;
                          const next = [...sequenceItems];
                          next[idx] = { ...next[idx], type: val };
                          setSequenceItems(next);
                        }}
                        className="h-6 text-[11px] rounded border px-1 bg-background text-foreground"
                      >
                        <option value="text">Texto</option>
                        <option value="audio">Áudio</option>
                        <option value="image">Imagem</option>
                        <option value="video">Vídeo</option>
                        <option value="document">Documento</option>
                      </select>

                      <div className="flex items-center gap-1 text-[11px] text-muted-foreground ml-auto">
                        <span>Delay:</span>
                        <input
                          type="number"
                          min={0}
                          max={120}
                          value={step.delay_seconds}
                          onChange={(e) => {
                            const val = Number(e.target.value) || 0;
                            const next = [...sequenceItems];
                            next[idx] = { ...next[idx], delay_seconds: val };
                            setSequenceItems(next);
                          }}
                          className="w-12 h-6 text-[11px] rounded border px-1 bg-background text-foreground text-center"
                        />
                        <span>s</span>
                      </div>

                      {sequenceItems.length > 1 && (
                        <button
                          type="button"
                          onClick={() => handleRemoveSequenceStep(idx)}
                          className="text-muted-foreground hover:text-red-500 p-0.5"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      )}
                    </div>

                    <Input
                      placeholder={step.type === "text" ? "Texto da mensagem..." : "URL da mídia..."}
                      value={step.content || step.media_url || ""}
                      onChange={(e) => {
                        const next = [...sequenceItems];
                        if (step.type === "text") {
                          next[idx] = { ...next[idx], content: e.target.value };
                        } else {
                          next[idx] = { ...next[idx], media_url: e.target.value };
                        }
                        setSequenceItems(next);
                      }}
                      className="h-7 text-xs bg-background"
                    />
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        <DialogFooter className="px-5 py-3 border-t border-border/70 bg-muted/20 flex flex-row items-center justify-end gap-2">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => onOpenChange(false)}
            className="h-8 text-xs"
          >
            Cancelar
          </Button>
          <Button
            type="button"
            size="sm"
            disabled={uploading || !title.trim()}
            onClick={handleSave}
            className="h-8 text-xs bg-primary text-primary-foreground gap-1"
          >
            {uploading ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
            Salvar Resposta
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
