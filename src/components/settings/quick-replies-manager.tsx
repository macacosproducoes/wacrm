"use client";

import { useCallback, useEffect, useState, useRef, useMemo } from "react";
import {
  Loader2,
  MessageSquare,
  Pencil,
  Plus,
  Trash2,
  Zap,
  Mic,
  Square,
  Upload,
  Sparkles,
  Volume2,
  Copy,
  Star,
  Layers,
  Image as ImageIcon,
  FileText,
  Video,
  Play,
  Check,
} from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { SettingsPanelHead } from "./settings-panel-head";
import {
  InteractiveBuilder,
  blankButtonsPayload,
} from "@/components/interactive/interactive-builder";
import {
  interactivePayloadPreviewText,
  type InteractiveMessagePayload,
} from "@/lib/whatsapp/interactive";
import type { QuickReply, QuickReplyKind, QuickReplySequenceStep } from "@/types";
import { QuickReplyAudioPlayer } from "@/components/inbox/quick-reply-audio-player";
import { uploadAccountMedia } from "@/lib/storage/upload-media";
import { CHAT_MEDIA_BUCKET } from "@/components/inbox/message-composer";
import { getDefaultColorForKind } from "@/lib/inbox/quick-reply-colors";
import {
  isAudioOrEncFile,
  cleanAudioTitle,
  uploadAudioQuickReply,
} from "@/lib/audio/audio-file-normalizer";

interface DraftState {
  id?: string;
  title: string;
  kind: QuickReplyKind;
  shortcut: string;
  category: string;
  color?: string;
  content_text: string;
  media_url?: string;
  media_duration?: number;
  media_type?: string;
  is_favorite?: boolean;
  order_index?: number;
  scope?: "team" | "personal";
  sequence_items?: QuickReplySequenceStep[];
  interactive_payload: InteractiveMessagePayload;
}

function emptyDraft(): DraftState {
  return {
    title: "",
    kind: "text",
    shortcut: "",
    category: "Geral",
    color: "#EAB308",
    content_text: "",
    is_favorite: false,
    order_index: 0,
    scope: "team",
    sequence_items: [
      { id: "1", order: 1, type: "text", content: "Olá {{primeiro_nome}}, tudo bem?", delay_seconds: 0 },
      { id: "2", order: 2, type: "text", content: "Como posso te ajudar hoje?", delay_seconds: 3 },
    ],
    interactive_payload: blankButtonsPayload(),
  };
}

const CATEGORIES = [
  "Boas-vindas",
  "Apresentação",
  "Qualificação",
  "Vendas",
  "Preço",
  "Produtos",
  "Serviços",
  "Pagamento",
  "Objeções",
  "Follow-up",
  "Pós-venda",
  "Suporte",
  "Documentos",
  "Agendamento",
  "Reativação",
  "Outros",
  "Geral",
];

export function QuickRepliesManager() {
  const [items, setItems] = useState<QuickReply[]>([]);
  const [loading, setLoading] = useState(true);
  const [draft, setDraft] = useState<DraftState | null>(null);
  const [saving, setSaving] = useState(false);
  const [tabFilter, setTabFilter] = useState<
    "all" | "favorite" | "text" | "audio" | "sequence" | "media" | "interactive"
  >("all");
  const [isDragging, setIsDragging] = useState(false);
  const [isDropping, setIsDropping] = useState(false);

  // Mic recorder state for audio quick reply editing
  const [isRecording, setIsRecording] = useState(false);
  const [recordSeconds, setRecordSeconds] = useState(0);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/quick-replies", { cache: "no-store" });
      const data = await res.json().catch(() => ({}));
      if (res.ok) setItems((data.quick_replies as QuickReply[]) ?? []);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const openCreate = () => setDraft(emptyDraft());

  const openEdit = (qr: QuickReply) =>
    setDraft({
      id: qr.id,
      title: qr.title,
      kind: qr.kind,
      shortcut: qr.shortcut ?? "",
      category: qr.category ?? (qr.kind === "audio" ? "Áudios" : "Geral"),
      color: qr.color ?? getDefaultColorForKind(qr.kind),
      content_text: qr.content_text ?? "",
      media_url: qr.media_url ?? undefined,
      media_duration: qr.media_duration ?? undefined,
      media_type: qr.media_type ?? undefined,
      is_favorite: qr.is_favorite ?? false,
      order_index: qr.order_index ?? 0,
      scope: qr.scope ?? "team",
      sequence_items: qr.sequence_items ?? [
        { id: "1", order: 1, type: "text", content: "Olá {{primeiro_nome}}!", delay_seconds: 0 },
      ],
      interactive_payload: qr.interactive_payload ?? blankButtonsPayload(),
    });

  // Handle duplication
  const handleDuplicate = async (qr: QuickReply) => {
    try {
      const res = await fetch(`/api/quick-replies/${qr.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "duplicate" }),
      });
      if (!res.ok) {
        throw new Error("Falha ao duplicar resposta");
      }
      toast.success(`Cópia criada para "${qr.title}"`);
      await load();
    } catch {
      toast.error("Não foi possível duplicar a resposta rápida.");
    }
  };

  // Toggle favorite
  const handleToggleFavorite = async (qr: QuickReply) => {
    const nextFav = !qr.is_favorite;
    try {
      const res = await fetch(`/api/quick-replies/${qr.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ is_favorite: nextFav }),
      });
      if (res.ok) {
        toast.success(nextFav ? "Adicionado aos favoritos ⭐" : "Removido dos favoritos");
        await load();
      }
    } catch {
      toast.error("Erro ao alterar favorito.");
    }
  };

  // Handle in-dialog microphone recording
  const startMicRecording = async () => {
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
        const url = URL.createObjectURL(blob);
        const tempAudio = new Audio(url);
        tempAudio.onloadedmetadata = () => {
          const duration = isFinite(tempAudio.duration) ? Math.round(tempAudio.duration) : recordSeconds;
          setDraft((d) => (d ? { ...d, media_url: url, media_duration: duration, media_type: "audio/ogg" } : d));
        };

        // Upload blob to storage
        try {
          const file = new File([blob], `voice-qr-${Date.now()}.ogg`, { type: "audio/ogg" });
          const { publicUrl } = await uploadAccountMedia(CHAT_MEDIA_BUCKET, file);
          setDraft((d) => (d ? { ...d, media_url: publicUrl, media_type: "audio/ogg" } : d));
          toast.success("Áudio gravado com sucesso!");
        } catch {
          toast.error("Falha ao salvar arquivo de áudio gravado.");
        }

        stream.getTracks().forEach((track) => track.stop());
      };

      mediaRecorder.start(250);
      setIsRecording(true);
      setRecordSeconds(0);
      timerRef.current = setInterval(() => setRecordSeconds((s) => s + 1), 1000);
    } catch {
      toast.error("Microfone não disponível ou permissão negada.");
    }
  };

  const stopMicRecording = () => {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== "inactive") {
      mediaRecorderRef.current.stop();
    }
    setIsRecording(false);
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (!isDragging) setIsDragging(true);
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.currentTarget.contains(e.relatedTarget as Node)) return;
    setIsDragging(false);
  };

  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);

    const files = Array.from(e.dataTransfer.files).filter(isAudioOrEncFile);
    if (files.length === 0) {
      toast.error("Por favor arraste um arquivo de áudio ou .enc válido.");
      return;
    }

    setIsDropping(true);
    const toastId = toast.loading(`Salvando ${files.length} áudio(s) no ZapPlus...`);
    try {
      for (const file of files) {
        const title = cleanAudioTitle(file.name);
        await uploadAudioQuickReply(file, {
          title,
          category: "Áudios",
        });
        toast.success(`🎙️ Áudio "${title}" salvo com sucesso!`, { id: toastId });
      }
      setTabFilter("audio");
      await load();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Erro ao salvar áudio arrastado.";
      toast.error(msg, { id: toastId });
    } finally {
      setIsDropping(false);
    }
  };

  const handleFileUpload = async (file: File) => {
    if (!file) return;
    try {
      if (draft?.kind === "audio" || isAudioOrEncFile(file)) {
        const qr = await uploadAudioQuickReply(file, {
          title: draft?.title || cleanAudioTitle(file.name),
          category: draft?.category || "Áudios",
        });
        setDraft((d) =>
          d
            ? {
                ...d,
                title: d.title || qr.title,
                media_url: qr.media_url ?? undefined,
                media_type: qr.media_type ?? undefined,
                media_duration: qr.media_duration ?? undefined,
              }
            : d
        );
        toast.success("Áudio processado e armazenado com sucesso!");
        await load();
        return;
      }
      const { publicUrl } = await uploadAccountMedia(CHAT_MEDIA_BUCKET, file);
      setDraft((d) =>
        d
          ? {
              ...d,
              media_url: publicUrl,
              media_type: file.type || "application/octet-stream",
              media_duration: 5,
            }
          : d
      );
      toast.success("Arquivo carregado com sucesso!");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Falha no upload.");
    }
  };

  const save = useCallback(async () => {
    if (!draft) return;
    if (!draft.title.trim()) {
      toast.error("Dê um nome para a resposta rápida.");
      return;
    }

    if (draft.kind === "text" && !draft.content_text.trim()) {
      toast.error("O texto da resposta não pode ficar vazio.");
      return;
    }

    if (["audio", "image", "video", "document"].includes(draft.kind) && !draft.media_url) {
      toast.error("Grave ou envie um arquivo antes de salvar.");
      return;
    }

    let payload: Record<string, unknown> = {
      title: draft.title.trim(),
      kind: draft.kind,
      shortcut: draft.shortcut.trim() ? draft.shortcut.replace(/^\//, "").trim() : null,
      category: draft.category.trim() || "Geral",
      color: draft.color || getDefaultColorForKind(draft.kind),
      is_favorite: draft.is_favorite ?? false,
      scope: draft.scope || "team",
      order_index: draft.order_index || 0,
    };

    if (draft.kind === "interactive") {
      payload.interactive_payload = draft.interactive_payload;
    } else if (draft.kind === "audio") {
      payload = {
        ...payload,
        media_url: draft.media_url,
        media_duration: draft.media_duration || 5,
        media_type: draft.media_type || "audio/ogg",
        content_text: draft.content_text || `🎙️ ${draft.title}`,
      };
    } else if (["image", "video", "document"].includes(draft.kind)) {
      payload = {
        ...payload,
        media_url: draft.media_url,
        media_type: draft.media_type,
        content_text: draft.content_text || "",
      };
    } else if (draft.kind === "sequence") {
      payload = {
        ...payload,
        sequence_items: draft.sequence_items || [],
        content_text: `[Sequência: ${draft.sequence_items?.length || 0} mensagens]`,
      };
    } else {
      payload.content_text = draft.content_text;
    }

    setSaving(true);
    try {
      const res = await fetch(
        draft.id ? `/api/quick-replies/${draft.id}` : "/api/quick-replies",
        {
          method: draft.id ? "PATCH" : "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        }
      );
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(data.error ?? "Não foi possível salvar a resposta rápida.");
        return;
      }
      toast.success(draft.id ? "Resposta rápida atualizada." : "Resposta rápida criada.");
      setDraft(null);
      await load();
    } catch {
      toast.error("Não foi possível salvar a resposta rápida.");
    } finally {
      setSaving(false);
    }
  }, [draft, load]);

  const remove = useCallback(
    async (id: string) => {
      if (!window.confirm("Excluir esta resposta rápida?")) return;
      const res = await fetch(`/api/quick-replies/${id}`, { method: "DELETE" });
      if (!res.ok) {
        toast.error("Não foi possível excluir a resposta rápida.");
        return;
      }
      toast.success("Resposta rápida excluída.");
      await load();
    },
    [load]
  );

  const filteredItems = useMemo(() => {
    return items.filter((i) => {
      if (tabFilter === "favorite") return Boolean(i.is_favorite);
      if (tabFilter === "audio") return i.kind === "audio";
      if (tabFilter === "text") return i.kind === "text";
      if (tabFilter === "sequence") return i.kind === "sequence";
      if (tabFilter === "media") return ["image", "video", "document", "media"].includes(i.kind);
      if (tabFilter === "interactive") return i.kind === "interactive";
      return true;
    });
  }, [items, tabFilter]);

  return (
    <div
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      className="space-y-6 relative"
    >
      {/* Drag & Drop Visual Overlay */}
      {(isDragging || isDropping) && (
        <div className="absolute inset-0 z-50 flex flex-col items-center justify-center bg-background/95 backdrop-blur-sm border-2 border-dashed border-purple-500 rounded-xl p-8 text-center animate-in fade-in zoom-in-95 duration-150">
          <div className="h-16 w-16 rounded-full bg-purple-500/20 text-purple-600 dark:text-purple-400 flex items-center justify-center mb-3 animate-bounce">
            {isDropping ? <Loader2 className="h-8 w-8 animate-spin" /> : <Upload className="h-8 w-8" />}
          </div>
          <h3 className="text-base font-bold text-foreground">
            {isDropping ? "Processando e Salvando Áudio..." : "Solte o Áudio para Salvar no ZapPlus"}
          </h3>
          <p className="text-xs text-muted-foreground mt-1 max-w-sm">
            Reconhece arquivos <b>.enc</b>, <b>.ogg</b>, <b>.mp3</b> e salva automaticamente com duração calculada!
          </p>
        </div>
      )}

      <SettingsPanelHead
        title="Central de Respostas Rápidas & Atalhos (ZapPlus)"
        description="Gerencie atalhos de textos, áudios com simulação de gravação, mídias e sequências automáticas com delays para a equipe do Inbox. Arraste áudios (.enc / .ogg) diretamente para esta tela para salvar instantaneamente."
        action={
          <Button onClick={openCreate} className="bg-primary text-primary-foreground gap-1.5 shadow-xs">
            <Plus className="h-4 w-4" />
            Nova Resposta / Atalho
          </Button>
        }
      />

      {/* Filter tabs */}
      <div className="flex flex-wrap items-center gap-1.5 border-b border-border pb-3">
        <button
          type="button"
          onClick={() => setTabFilter("all")}
          className={`px-3 py-1 rounded-lg text-xs font-medium transition-colors ${
            tabFilter === "all" ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground hover:text-foreground"
          }`}
        >
          Todas ({items.length})
        </button>

        <button
          type="button"
          onClick={() => setTabFilter("favorite")}
          className={`flex items-center gap-1 px-3 py-1 rounded-lg text-xs font-medium transition-colors ${
            tabFilter === "favorite" ? "bg-amber-500 text-white" : "bg-muted text-muted-foreground hover:text-foreground"
          }`}
        >
          <Star className="h-3.5 w-3.5 fill-current" />
          Favoritos ({items.filter((i) => i.is_favorite).length})
        </button>

        <button
          type="button"
          onClick={() => setTabFilter("text")}
          className={`flex items-center gap-1 px-3 py-1 rounded-lg text-xs font-medium transition-colors ${
            tabFilter === "text" ? "bg-amber-500 text-white" : "bg-muted text-muted-foreground hover:text-foreground"
          }`}
        >
          🟨 Textos ({items.filter((i) => i.kind === "text").length})
        </button>

        <button
          type="button"
          onClick={() => setTabFilter("audio")}
          className={`flex items-center gap-1 px-3 py-1 rounded-lg text-xs font-medium transition-colors ${
            tabFilter === "audio" ? "bg-purple-600 text-white" : "bg-muted text-muted-foreground hover:text-foreground"
          }`}
        >
          🟪 Áudios ({items.filter((i) => i.kind === "audio").length})
        </button>

        <button
          type="button"
          onClick={() => setTabFilter("sequence")}
          className={`flex items-center gap-1 px-3 py-1 rounded-lg text-xs font-medium transition-colors ${
            tabFilter === "sequence" ? "bg-orange-500 text-white" : "bg-muted text-muted-foreground hover:text-foreground"
          }`}
        >
          🟧 Sequências ({items.filter((i) => i.kind === "sequence").length})
        </button>

        <button
          type="button"
          onClick={() => setTabFilter("media")}
          className={`flex items-center gap-1 px-3 py-1 rounded-lg text-xs font-medium transition-colors ${
            tabFilter === "media" ? "bg-blue-600 text-white" : "bg-muted text-muted-foreground hover:text-foreground"
          }`}
        >
          🟦 Mídias ({items.filter((i) => ["image", "video", "document", "media"].includes(i.kind)).length})
        </button>

        <button
          type="button"
          onClick={() => setTabFilter("interactive")}
          className={`flex items-center gap-1 px-3 py-1 rounded-lg text-xs font-medium transition-colors ${
            tabFilter === "interactive" ? "bg-emerald-600 text-white" : "bg-muted text-muted-foreground hover:text-foreground"
          }`}
        >
          ⚡ Interativos ({items.filter((i) => i.kind === "interactive").length})
        </button>
      </div>

      {loading ? (
        <div className="flex justify-center py-12">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      ) : filteredItems.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border py-12 text-center text-sm text-muted-foreground">
          Nenhuma resposta rápida cadastrada neste filtro.
        </div>
      ) : (
        <ul className="flex flex-col gap-2.5">
          {filteredItems.map((qr) => {
            const isAudio = qr.kind === "audio";
            const isSequence = qr.kind === "sequence";
            const isText = qr.kind === "text";

            return (
              <li
                key={qr.id}
                className="rounded-xl border border-border/80 bg-card p-3.5 transition-all hover:border-primary/40 shadow-xs"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="flex items-start gap-3 min-w-0 flex-1">
                    <div
                      className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-base shadow-2xs"
                      style={{ backgroundColor: `${qr.color || "#EAB308"}20` }}
                    >
                      {isAudio ? "🟪" : isSequence ? "🟧" : qr.kind === "image" ? "🟦" : qr.kind === "document" ? "🟥" : qr.kind === "video" ? "🟩" : "🟨"}
                    </div>

                    <div className="min-w-0 flex-1 space-y-1">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-semibold text-sm text-foreground truncate">
                          {qr.title}
                        </span>

                        {qr.shortcut && (
                          <Badge variant="outline" className="font-mono text-[10px] px-1.5 py-0">
                            /{qr.shortcut}
                          </Badge>
                        )}

                        {qr.category && (
                          <span className="text-[10px] text-muted-foreground font-medium px-1.5 py-0.5 rounded bg-muted">
                            {qr.category}
                          </span>
                        )}

                        {qr.scope === "personal" && (
                          <span className="text-[10px] text-amber-600 dark:text-amber-400 font-medium px-1.5 py-0.5 rounded bg-amber-500/10">
                            👤 Pessoal
                          </span>
                        )}

                        {(qr.usage_count ?? 0) > 0 && (
                          <span className="text-[10px] text-muted-foreground font-medium px-1.5 py-0.5 rounded bg-muted/80">
                            🔥 {qr.usage_count} {qr.usage_count === 1 ? "uso" : "usos"}
                          </span>
                        )}

                        {qr.is_favorite && (
                          <Star className="h-3.5 w-3.5 fill-amber-400 text-amber-500" />
                        )}
                      </div>

                      {isText && qr.content_text && (
                        <p className="text-xs text-muted-foreground line-clamp-2 whitespace-pre-wrap">
                          {qr.content_text}
                        </p>
                      )}

                      {isAudio && qr.media_url && (
                        <div className="pt-1 max-w-sm">
                          <QuickReplyAudioPlayer
                            url={qr.media_url}
                            duration={qr.media_duration || 0}
                          />
                        </div>
                      )}


                      {isSequence && qr.sequence_items?.length ? (
                        <div className="text-xs text-muted-foreground pt-0.5 space-y-0.5">
                          <span className="font-medium text-foreground">
                            {qr.sequence_items.length} mensagens na sequência:
                          </span>{" "}
                          {qr.sequence_items.map((s, idx) => (
                            <span key={s.id || idx} className="text-[11px] inline-block mr-2 text-muted-foreground">
                              {idx + 1}. [{s.type}] ({s.delay_seconds}s)
                            </span>
                          ))}
                        </div>
                      ) : null}
                    </div>
                  </div>

                  {/* Actions */}
                  <div className="flex items-center gap-1 shrink-0">
                    <button
                      type="button"
                      onClick={() => handleToggleFavorite(qr)}
                      title={qr.is_favorite ? "Desfavoritar" : "Favoritar"}
                      className="p-1.5 rounded-md hover:bg-muted text-muted-foreground hover:text-amber-500 transition-colors"
                    >
                      <Star className={`h-4 w-4 ${qr.is_favorite ? "fill-amber-400 text-amber-500" : ""}`} />
                    </button>

                    <button
                      type="button"
                      onClick={() => handleDuplicate(qr)}
                      title="Duplicar resposta (criar variação)"
                      className="p-1.5 rounded-md hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
                    >
                      <Copy className="h-4 w-4" />
                    </button>

                    <button
                      type="button"
                      onClick={() => openEdit(qr)}
                      title="Editar"
                      className="p-1.5 rounded-md hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
                    >
                      <Pencil className="h-4 w-4" />
                    </button>

                    <button
                      type="button"
                      onClick={() => remove(qr.id)}
                      title="Excluir"
                      className="p-1.5 rounded-md hover:bg-red-500/10 text-muted-foreground hover:text-red-500 transition-colors"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {/* Edit / Create Dialog */}
      {draft && (
        <Dialog open={true} onOpenChange={(open) => !open && setDraft(null)}>
          <DialogContent className="max-w-2xl max-h-[min(82vh,680px)] flex flex-col p-0 gap-0 overflow-hidden border-border bg-card">
            <DialogHeader className="px-6 py-4 border-b border-border/70 flex flex-row items-center justify-between">
              <DialogTitle className="text-base font-semibold text-foreground">
                {draft.id ? "Editar Resposta Rápida / Atalho" : "Nova Resposta Rápida / Atalho"}
              </DialogTitle>
              <button
                type="button"
                onClick={() => setDraft({ ...draft, is_favorite: !draft.is_favorite })}
                className="p-1 rounded hover:bg-muted"
                title="Favoritar"
              >
                <Star className={`h-4 w-4 ${draft.is_favorite ? "fill-amber-400 text-amber-500" : "text-muted-foreground"}`} />
              </button>
            </DialogHeader>

            <div className="flex-1 overflow-y-auto p-6 space-y-4">
              {/* Kind selection */}
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
                      onClick={() => setDraft({ ...draft, kind: t.id as QuickReplyKind })}
                      className={`flex flex-col items-center justify-center p-2 rounded-lg border text-xs font-medium transition-all ${
                        draft.kind === t.id
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
                    placeholder="Ex: Apresentação da Solução"
                    value={draft.title}
                    onChange={(e) => setDraft({ ...draft, title: e.target.value })}
                    className="h-8 text-xs bg-background"
                  />
                </div>
                <div className="space-y-1">
                  <label className="text-xs font-semibold text-foreground">Atalho (/)</label>
                  <Input
                    placeholder="intro, preco"
                    value={draft.shortcut}
                    onChange={(e) => setDraft({ ...draft, shortcut: e.target.value })}
                    className="h-8 text-xs font-mono bg-background"
                  />
                </div>
              </div>

              {/* Category & Scope */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div className="space-y-1">
                  <label className="text-xs font-semibold text-foreground">Categoria</label>
                  <select
                    value={draft.category}
                    onChange={(e) => setDraft({ ...draft, category: e.target.value })}
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
                    value={draft.scope}
                    onChange={(e) => setDraft({ ...draft, scope: e.target.value as "team" | "personal" })}
                    className="w-full h-8 text-xs rounded-md border border-input bg-background px-2.5 text-foreground"
                  >
                    <option value="team">👥 Compartilhada com a Equipe</option>
                    <option value="personal">👤 Somente Pessoal</option>
                  </select>
                </div>
              </div>

              {/* Kind specific inputs */}
              {draft.kind === "text" && (
                <div className="space-y-1.5">
                  <div className="flex items-center justify-between">
                    <label className="text-xs font-semibold text-foreground">Texto da Mensagem</label>
                    <div className="flex items-center gap-1 text-[10px] text-muted-foreground">
                      <span className="font-semibold text-primary">Variáveis:</span>
                      {["{{primeiro_nome}}", "{{nome}}", "{{empresa}}", "{{atendente}}"].map((v) => (
                        <button
                          key={v}
                          type="button"
                          onClick={() => setDraft({ ...draft, content_text: `${draft.content_text} ${v}` })}
                          className="px-1 py-0.5 rounded bg-muted hover:bg-muted/80 font-mono text-[9px]"
                        >
                          {v}
                        </button>
                      ))}
                    </div>
                  </div>
                  <Textarea
                    rows={4}
                    placeholder="Olá {{primeiro_nome}}, tudo bem? Segue a proposta..."
                    value={draft.content_text}
                    onChange={(e) => setDraft({ ...draft, content_text: e.target.value })}
                    className="text-xs bg-background resize-y"
                  />
                </div>
              )}

              {draft.kind === "audio" && (
                <div className="space-y-2 p-3.5 rounded-lg border border-purple-500/30 bg-purple-500/5">
                  <label className="text-xs font-semibold text-purple-700 dark:text-purple-300">
                    Gravação de Áudio PTT
                  </label>

                  <div className="flex flex-wrap items-center gap-2">
                    {!isRecording ? (
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={startMicRecording}
                        className="h-8 text-xs text-purple-600 border-purple-500/40 hover:bg-purple-500/10 gap-1.5"
                      >
                        <Mic className="h-3.5 w-3.5" />
                        Gravar Microfone
                      </Button>
                    ) : (
                      <Button
                        type="button"
                        variant="destructive"
                        size="sm"
                        onClick={stopMicRecording}
                        className="h-8 text-xs animate-pulse gap-1.5"
                      >
                        <Square className="h-3.5 w-3.5" />
                        Parar ({recordSeconds}s)
                      </Button>
                    )}

                    <input
                      ref={fileInputRef}
                      type="file"
                      accept="audio/*,.ogg,.mp3,.wav,.m4a,.enc,.opus"
                      onChange={(e) => {
                        const file = e.target.files?.[0];
                        if (file) void handleFileUpload(file);
                      }}
                      className="hidden"
                    />

                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => fileInputRef.current?.click()}
                      className="h-8 text-xs gap-1.5"
                    >
                      <Upload className="h-3.5 w-3.5" />
                      Upload (.enc / .ogg / .mp3)
                    </Button>

                    {draft.media_url && (
                      <span className="text-xs text-emerald-600 font-medium pl-2">
                        ✓ Áudio armazenado ({draft.media_duration || 0}s)
                      </span>
                    )}
                  </div>
                </div>
              )}

              {["image", "video", "document"].includes(draft.kind) && (
                <div className="space-y-2 p-3.5 rounded-lg border border-border bg-muted/20">
                  <label className="text-xs font-semibold text-foreground capitalize">
                    Arquivo de {draft.kind}
                  </label>

                  <div className="flex items-center gap-2">
                    <input
                      ref={fileInputRef}
                      type="file"
                      accept={
                        draft.kind === "image"
                          ? "image/*"
                          : draft.kind === "video"
                          ? "video/*"
                          : ".pdf,.doc,.docx,.xls,.xlsx,.txt"
                      }
                      onChange={(e) => {
                        const file = e.target.files?.[0];
                        if (file) void handleFileUpload(file);
                      }}
                      className="hidden"
                    />

                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => fileInputRef.current?.click()}
                      className="h-8 text-xs gap-1.5"
                    >
                      <Upload className="h-3.5 w-3.5" />
                      Selecionar Arquivo
                    </Button>

                    {draft.media_url && (
                      <span className="text-xs text-emerald-600 font-medium">
                        ✓ Mídia pronta para envio
                      </span>
                    )}
                  </div>

                  <div className="space-y-1 pt-1">
                    <label className="text-xs text-muted-foreground">Legenda</label>
                    <Input
                      placeholder="Texto que acompanha a mídia..."
                      value={draft.content_text}
                      onChange={(e) => setDraft({ ...draft, content_text: e.target.value })}
                      className="h-8 text-xs bg-background"
                    />
                  </div>
                </div>
              )}

              {draft.kind === "sequence" && (
                <div className="space-y-3 p-3.5 rounded-lg border border-orange-500/30 bg-orange-500/5">
                  <div className="flex items-center justify-between">
                    <label className="text-xs font-semibold text-orange-800 dark:text-orange-200">
                      Etapas da Sequência
                    </label>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={() => {
                        const next = [
                          ...(draft.sequence_items || []),
                          {
                            id: String(Date.now()),
                            order: (draft.sequence_items?.length || 0) + 1,
                            type: "text" as const,
                            content: "",
                            delay_seconds: 2,
                          },
                        ];
                        setDraft({ ...draft, sequence_items: next });
                      }}
                      className="h-6 text-[11px] gap-1 border-orange-500/40 text-orange-700 dark:text-orange-300"
                    >
                      <Plus className="h-3 w-3" />
                      Adicionar Etapa
                    </Button>
                  </div>

                  <div className="space-y-2 max-h-56 overflow-y-auto pr-1">
                    {(draft.sequence_items || []).map((step, idx) => (
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
                              const next = [...(draft.sequence_items || [])];
                              next[idx] = { ...next[idx], type: val };
                              setDraft({ ...draft, sequence_items: next });
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
                                const next = [...(draft.sequence_items || [])];
                                next[idx] = { ...next[idx], delay_seconds: val };
                                setDraft({ ...draft, sequence_items: next });
                              }}
                              className="w-12 h-6 text-[11px] rounded border px-1 bg-background text-foreground text-center"
                            />
                            <span>s</span>
                          </div>

                          {(draft.sequence_items?.length || 0) > 1 && (
                            <button
                              type="button"
                              onClick={() => {
                                const next = (draft.sequence_items || []).filter((_, i) => i !== idx);
                                setDraft({ ...draft, sequence_items: next });
                              }}
                              className="text-muted-foreground hover:text-red-500 p-0.5"
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </button>
                          )}
                        </div>

                        <Input
                          placeholder={step.type === "text" ? "Texto da mensagem..." : "URL do arquivo/mídia..."}
                          value={step.content || step.media_url || ""}
                          onChange={(e) => {
                            const next = [...(draft.sequence_items || [])];
                            if (step.type === "text") {
                              next[idx] = { ...next[idx], content: e.target.value };
                            } else {
                              next[idx] = { ...next[idx], media_url: e.target.value };
                            }
                            setDraft({ ...draft, sequence_items: next });
                          }}
                          className="h-7 text-xs bg-background"
                        />
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>

            <DialogFooter className="px-6 py-3 border-t border-border/70 bg-muted/20 flex flex-row items-center justify-end gap-2">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => setDraft(null)}
                className="h-8 text-xs"
              >
                Cancelar
              </Button>
              <Button
                type="button"
                size="sm"
                disabled={saving || !draft.title.trim()}
                onClick={save}
                className="h-8 text-xs bg-primary text-primary-foreground gap-1"
              >
                {saving ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
                Salvar Alterações
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}
