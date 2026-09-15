"use client";

import { useEffect, useState, useMemo, useRef, useCallback } from "react";
import {
  Loader2,
  MessageSquare,
  Zap,
  Mic,
  Search,
  Plus,
  Play,
  Square,
  Upload,
  Check,
  Tag,
  Volume2,
  Sparkles,
  Send,
  X,
  FileAudio,
} from "lucide-react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";

import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import type { QuickReply, QuickReplyKind } from "@/types";
import { interactivePayloadPreviewText } from "@/lib/whatsapp/interactive";
import { QuickReplyAudioPlayer } from "./quick-reply-audio-player";
import { replaceQuickReplyVariables, type VariableContext } from "@/lib/inbox/quick-reply-variables";
import { uploadAccountMedia, deleteAccountMedia } from "@/lib/storage/upload-media";
import { CHAT_MEDIA_BUCKET } from "./message-composer";

interface QuickReplyPickerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onPick: (qr: QuickReply) => void;
  onSendAudio?: (qr: QuickReply, simulateRecording: boolean) => void;
  onSendTextDirect?: (text: string) => void;
  contactContext?: VariableContext;
}

type TabFilter = "all" | "audio" | "text" | "interactive";

export function QuickReplyPicker({
  open,
  onOpenChange,
  onPick,
  onSendAudio,
  onSendTextDirect,
  contactContext = {},
}: QuickReplyPickerProps) {
  const t = useTranslations("Inbox.composer");
  const [items, setItems] = useState<QuickReply[]>([]);
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState("");
  const [currentTab, setCurrentTab] = useState<TabFilter>("all");
  const [selectedCategory, setSelectedCategory] = useState<string>("all");

  // New audio creation drawer / inline form
  const [showAddAudio, setShowAddAudio] = useState(false);
  const [newAudioTitle, setNewAudioTitle] = useState("");
  const [newAudioShortcut, setNewAudioShortcut] = useState("");
  const [newAudioCategory, setNewAudioCategory] = useState("Vendas");
  const [uploadingAudio, setUploadingAudio] = useState(false);
  const [recordedAudioBlob, setRecordedAudioBlob] = useState<Blob | null>(null);
  const [recordedAudioUrl, setRecordedAudioUrl] = useState<string | null>(null);
  const [recordedAudioDuration, setRecordedAudioDuration] = useState<number>(0);

  // In-picker recording state
  const [isRecording, setIsRecording] = useState(false);
  const [recordSeconds, setRecordSeconds] = useState(0);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const recordTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const fetchQuickReplies = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/quick-replies", { cache: "no-store" });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        setItems((data.quick_replies as QuickReply[]) ?? []);
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!open) {
      setShowAddAudio(false);
      resetAudioForm();
      return;
    }
    void fetchQuickReplies();
  }, [open, fetchQuickReplies]);

  // Extract unique categories
  const categories = useMemo(() => {
    const set = new Set<string>();
    items.forEach((item) => {
      if (item.category) set.add(item.category);
    });
    return Array.from(set);
  }, [items]);

  // Filtered items
  const filteredItems = useMemo(() => {
    return items.filter((qr) => {
      // Tab filter
      if (currentTab === "audio" && qr.kind !== "audio") return false;
      if (currentTab === "text" && qr.kind !== "text") return false;
      if (currentTab === "interactive" && qr.kind !== "interactive") return false;

      // Category filter
      if (selectedCategory !== "all" && qr.category !== selectedCategory) {
        return false;
      }

      // Search query
      if (search.trim()) {
        const q = search.toLowerCase();
        const matchTitle = (qr.title || "").toLowerCase().includes(q);
        const matchShortcut = (qr.shortcut || "").toLowerCase().includes(q);
        const matchContent = (qr.content_text || "").toLowerCase().includes(q);
        const matchCat = (qr.category || "").toLowerCase().includes(q);
        return matchTitle || matchShortcut || matchContent || matchCat;
      }

      return true;
    });
  }, [items, currentTab, selectedCategory, search]);

  // Counts for tabs
  const audioCount = useMemo(() => items.filter((i) => i.kind === "audio").length, [items]);
  const textCount = useMemo(() => items.filter((i) => i.kind === "text").length, [items]);
  const interactiveCount = useMemo(() => items.filter((i) => i.kind === "interactive").length, [items]);

  // Handle in-picker mic recording
  const startMicRecording = async () => {
    if (!navigator.mediaDevices?.getUserMedia) {
      toast.error("Gravação de áudio não suportada neste navegador.");
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mediaRecorder = new MediaRecorder(stream);
      mediaRecorderRef.current = mediaRecorder;
      audioChunksRef.current = [];

      mediaRecorder.ondataavailable = (e) => {
        if (e.data.size > 0) {
          audioChunksRef.current.push(e.data);
        }
      };

      mediaRecorder.onstop = () => {
        const mimeType = mediaRecorder.mimeType || "audio/ogg";
        const blob = new Blob(audioChunksRef.current, { type: mimeType });
        setRecordedAudioBlob(blob);
        const url = URL.createObjectURL(blob);
        setRecordedAudioUrl(url);

        // Get duration
        const tempAudio = new Audio(url);
        tempAudio.onloadedmetadata = () => {
          if (tempAudio.duration && isFinite(tempAudio.duration)) {
            setRecordedAudioDuration(Math.round(tempAudio.duration));
          }
        };

        // Stop all tracks to turn off mic indicator
        stream.getTracks().forEach((track) => track.stop());
      };

      mediaRecorder.start(250);
      setIsRecording(true);
      setRecordSeconds(0);
      recordTimerRef.current = setInterval(() => {
        setRecordSeconds((s) => s + 1);
      }, 1000);
    } catch {
      toast.error("Permissão de microfone negada.");
    }
  };

  const stopMicRecording = () => {
    if (recordTimerRef.current) {
      clearInterval(recordTimerRef.current);
      recordTimerRef.current = null;
    }
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== "inactive") {
      mediaRecorderRef.current.stop();
    }
    setIsRecording(false);
  };

  const handleFileUpload = (file: File) => {
    if (!file) return;
    setRecordedAudioBlob(file);
    const url = URL.createObjectURL(file);
    setRecordedAudioUrl(url);
    if (!newAudioTitle) {
      setNewAudioTitle(file.name.replace(/\.[^.]+$/, ""));
    }

    const tempAudio = new Audio(url);
    tempAudio.onloadedmetadata = () => {
      if (tempAudio.duration && isFinite(tempAudio.duration)) {
        setRecordedAudioDuration(Math.round(tempAudio.duration));
      }
    };
  };

  const resetAudioForm = () => {
    setNewAudioTitle("");
    setNewAudioShortcut("");
    setNewAudioCategory("Vendas");
    setRecordedAudioBlob(null);
    if (recordedAudioUrl) {
      URL.revokeObjectURL(recordedAudioUrl);
      setRecordedAudioUrl(null);
    }
    setRecordedAudioDuration(0);
    setIsRecording(false);
    if (recordTimerRef.current) {
      clearInterval(recordTimerRef.current);
      recordTimerRef.current = null;
    }
  };

  const handleSaveNewAudio = async () => {
    if (!newAudioTitle.trim()) {
      toast.error("Dê um nome para este áudio.");
      return;
    }
    if (!recordedAudioBlob) {
      toast.error("Grave um áudio ou faça upload de um arquivo de áudio.");
      return;
    }

    setUploadingAudio(true);
    try {
      const ext = recordedAudioBlob.type.includes("mp3") ? "mp3" : "ogg";
      const file = new File(
        [recordedAudioBlob],
        `audio-reply-${Date.now()}.${ext}`,
        { type: recordedAudioBlob.type || "audio/ogg" }
      );

      const { publicUrl } = await uploadAccountMedia(CHAT_MEDIA_BUCKET, file);

      const res = await fetch("/api/quick-replies", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: newAudioTitle.trim(),
          kind: "audio",
          shortcut: newAudioShortcut.trim() || null,
          category: newAudioCategory.trim() || "Áudios",
          media_url: publicUrl,
          media_type: file.type,
          media_duration: recordedAudioDuration || recordSeconds || 5,
          content_text: `🎙️ ${newAudioTitle.trim()}`,
        }),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || "Erro ao salvar áudio.");
      }

      toast.success("Áudio gravado e armazenado com sucesso no ZapPlus!");
      resetAudioForm();
      setShowAddAudio(false);
      await fetchQuickReplies();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Falha ao salvar áudio.");
    } finally {
      setUploadingAudio(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl max-h-[88vh] flex flex-col p-0 gap-0 overflow-hidden bg-card border-border shadow-2xl">
        {/* Header with ZapPlus Branding */}
        <DialogHeader className="p-4 pb-3 border-b border-border bg-muted/40">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2.5">
              <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-to-tr from-emerald-600 to-teal-500 text-white shadow-sm">
                <Zap className="h-5 w-5 fill-current" />
              </div>
              <div>
                <DialogTitle className="text-base font-bold text-foreground flex items-center gap-2">
                  Respostas Rápidas
                  <Badge variant="outline" className="bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/20 text-[10px] font-mono">
                    ZapPlus
                  </Badge>
                </DialogTitle>
                <p className="text-xs text-muted-foreground">
                  Áudios pré-gravados com simulação de gravação e respostas instantâneas
                </p>
              </div>
            </div>

            <Button
              size="sm"
              variant={showAddAudio ? "outline" : "default"}
              onClick={() => setShowAddAudio(!showAddAudio)}
              className={showAddAudio ? "border-border" : "bg-emerald-600 hover:bg-emerald-700 text-white"}
            >
              {showAddAudio ? (
                <>
                  <X className="mr-1.5 h-3.5 w-3.5" />
                  Fechar
                </>
              ) : (
                <>
                  <Plus className="mr-1.5 h-3.5 w-3.5" />
                  Novo Áudio
                </>
              )}
            </Button>
          </div>

          {/* Search bar & Tabs */}
          <div className="mt-3 flex flex-col gap-2.5">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Pesquisar por título, /atalho ou texto..."
                className="pl-9 h-9 bg-background text-xs border-border/80"
              />
              {search && (
                <button
                  type="button"
                  onClick={() => setSearch("")}
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              )}
            </div>

            {/* Filter Tabs */}
            <div className="flex items-center gap-1.5 overflow-x-auto pb-1 scrollbar-none text-xs">
              <button
                type="button"
                onClick={() => setCurrentTab("all")}
                className={`px-3 py-1 rounded-lg font-medium transition-colors ${
                  currentTab === "all"
                    ? "bg-primary text-primary-foreground shadow-xs"
                    : "bg-muted/80 text-muted-foreground hover:bg-muted"
                }`}
              >
                Todos ({items.length})
              </button>
              <button
                type="button"
                onClick={() => setCurrentTab("audio")}
                className={`flex items-center gap-1.5 px-3 py-1 rounded-lg font-medium transition-colors ${
                  currentTab === "audio"
                    ? "bg-emerald-600 text-white shadow-xs"
                    : "bg-muted/80 text-muted-foreground hover:bg-muted"
                }`}
              >
                <Mic className="h-3.5 w-3.5" />
                Áudios ({audioCount})
              </button>
              <button
                type="button"
                onClick={() => setCurrentTab("text")}
                className={`flex items-center gap-1.5 px-3 py-1 rounded-lg font-medium transition-colors ${
                  currentTab === "text"
                    ? "bg-primary text-primary-foreground shadow-xs"
                    : "bg-muted/80 text-muted-foreground hover:bg-muted"
                }`}
              >
                <MessageSquare className="h-3.5 w-3.5" />
                Textos ({textCount})
              </button>
              <button
                type="button"
                onClick={() => setCurrentTab("interactive")}
                className={`flex items-center gap-1.5 px-3 py-1 rounded-lg font-medium transition-colors ${
                  currentTab === "interactive"
                    ? "bg-primary text-primary-foreground shadow-xs"
                    : "bg-muted/80 text-muted-foreground hover:bg-muted"
                }`}
              >
                <Zap className="h-3.5 w-3.5" />
                Interativos ({interactiveCount})
              </button>

              {/* Category pills */}
              {categories.length > 0 && (
                <>
                  <div className="h-4 w-px bg-border mx-1" />
                  <button
                    type="button"
                    onClick={() => setSelectedCategory("all")}
                    className={`px-2 py-0.5 rounded text-[11px] font-medium transition-colors ${
                      selectedCategory === "all"
                        ? "bg-secondary text-secondary-foreground"
                        : "text-muted-foreground hover:bg-muted"
                    }`}
                  >
                    Todas Categorias
                  </button>
                  {categories.map((cat) => (
                    <button
                      key={cat}
                      type="button"
                      onClick={() => setSelectedCategory(cat)}
                      className={`px-2 py-0.5 rounded text-[11px] font-medium transition-colors ${
                        selectedCategory === cat
                          ? "bg-secondary text-secondary-foreground font-semibold"
                          : "text-muted-foreground hover:bg-muted"
                      }`}
                    >
                      {cat}
                    </button>
                  ))}
                </>
              )}
            </div>
          </div>
        </DialogHeader>

        {/* Inline Audio Recorder / Upload Drawer */}
        {showAddAudio && (
          <div className="p-4 border-b border-border bg-emerald-500/5 space-y-3 animate-in slide-in-from-top-2 duration-150">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold text-emerald-600 dark:text-emerald-400 flex items-center gap-1.5">
                <Mic className="h-4 w-4" />
                Armazenar Novo Áudio no Sistema
              </span>
              <span className="text-[11px] text-muted-foreground">
                Será enviado como mensagem de voz nativa (PTT)
              </span>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5">
              <div className="sm:col-span-1">
                <label className="text-[11px] font-medium text-muted-foreground block mb-1">
                  Nome do Áudio *
                </label>
                <Input
                  value={newAudioTitle}
                  onChange={(e) => setNewAudioTitle(e.target.value)}
                  placeholder="ex: Apresentação da Empresa"
                  className="h-8 text-xs bg-background"
                />
              </div>
              <div className="sm:col-span-1">
                <label className="text-[11px] font-medium text-muted-foreground block mb-1">
                  Atalho (/comando)
                </label>
                <Input
                  value={newAudioShortcut}
                  onChange={(e) => setNewAudioShortcut(e.target.value.replace(/^\//, ""))}
                  placeholder="ex: audio1 ou boas-vindas"
                  className="h-8 text-xs bg-background font-mono"
                />
              </div>
              <div className="sm:col-span-1">
                <label className="text-[11px] font-medium text-muted-foreground block mb-1">
                  Categoria
                </label>
                <Input
                  value={newAudioCategory}
                  onChange={(e) => setNewAudioCategory(e.target.value)}
                  placeholder="ex: Vendas, Suporte..."
                  className="h-8 text-xs bg-background"
                />
              </div>
            </div>

            {/* Audio Recording or Upload Controls */}
            <div className="rounded-xl border border-emerald-500/20 bg-card p-3 flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                {isRecording ? (
                  <div className="flex items-center gap-2.5">
                    <span className="flex h-3 w-3 relative">
                      <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-red-400 opacity-75" />
                      <span className="relative inline-flex rounded-full h-3 w-3 bg-red-500" />
                    </span>
                    <span className="text-xs font-mono font-medium text-red-500">
                      Gravando: {Math.floor(recordSeconds / 60)}:{(recordSeconds % 60).toString().padStart(2, "0")}
                    </span>
                    <Button
                      size="sm"
                      variant="destructive"
                      onClick={stopMicRecording}
                      className="h-7 text-xs px-2.5"
                    >
                      <Square className="mr-1 h-3 w-3" />
                      Parar Gravação
                    </Button>
                  </div>
                ) : (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={startMicRecording}
                    className="h-8 text-xs border-emerald-500/30 text-emerald-600 hover:bg-emerald-500/10 dark:text-emerald-400"
                  >
                    <Mic className="mr-1.5 h-3.5 w-3.5" />
                    Gravar no Microfone
                  </Button>
                )}

                <span className="text-xs text-muted-foreground">ou</span>

                <input
                  ref={fileInputRef}
                  type="file"
                  accept="audio/*"
                  className="hidden"
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) handleFileUpload(f);
                  }}
                />
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => fileInputRef.current?.click()}
                  className="h-8 text-xs text-muted-foreground hover:text-foreground"
                >
                  <Upload className="mr-1.5 h-3.5 w-3.5" />
                  Subir Arquivo (.mp3/.ogg)
                </Button>
              </div>

              {recordedAudioUrl && (
                <div className="flex-1 min-w-[240px] max-w-sm">
                  <QuickReplyAudioPlayer
                    url={recordedAudioUrl}
                    duration={recordedAudioDuration || recordSeconds}
                    className="py-1"
                  />
                </div>
              )}

              <div className="flex items-center gap-2 ml-auto">
                <Button
                  size="sm"
                  disabled={uploadingAudio || !recordedAudioBlob || !newAudioTitle.trim()}
                  onClick={handleSaveNewAudio}
                  className="h-8 text-xs bg-emerald-600 hover:bg-emerald-700 text-white font-medium"
                >
                  {uploadingAudio ? (
                    <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Check className="mr-1.5 h-3.5 w-3.5" />
                  )}
                  Salvar Áudio
                </Button>
              </div>
            </div>
          </div>
        )}

        {/* Content list */}
        <div className="flex-1 min-h-[300px] max-h-[58vh] overflow-y-auto p-4 space-y-2.5">
          {loading ? (
            <div className="flex flex-col items-center justify-center py-16 text-muted-foreground gap-2">
              <Loader2 className="h-6 w-6 animate-spin text-emerald-500" />
              <span className="text-xs">Carregando respostas rápidas...</span>
            </div>
          ) : filteredItems.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 text-center text-muted-foreground">
              <FileAudio className="h-10 w-10 text-muted-foreground/40 mb-2" />
              <p className="text-sm font-medium text-foreground">
                Nenhuma resposta rápida encontrada
              </p>
              <p className="text-xs text-muted-foreground mt-1 max-w-sm">
                {search
                  ? "Tente buscar por outros termos ou verifique a categoria selecionada."
                  : "Comece adicionando novos áudios ou mensagens pré-programadas para acelerar seus atendimentos."}
              </p>
              {!showAddAudio && (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => setShowAddAudio(true)}
                  className="mt-4 border-emerald-500/30 text-emerald-600 dark:text-emerald-400"
                >
                  <Plus className="mr-1.5 h-3.5 w-3.5" />
                  Cadastrar Primeiro Áudio
                </Button>
              )}
            </div>
          ) : (
            filteredItems.map((qr) => {
              const isAudio = qr.kind === "audio";
              const isInteractive = qr.kind === "interactive";

              return (
                <div
                  key={qr.id}
                  className={`rounded-xl border p-3 transition-all ${
                    isAudio
                      ? "border-emerald-500/30 bg-emerald-500/[0.02] hover:border-emerald-500/50 hover:bg-emerald-500/[0.05]"
                      : "border-border bg-card hover:border-border/80 hover:bg-muted/40"
                  }`}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex items-start gap-2.5 min-w-0 flex-1">
                      <div
                        className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${
                          isAudio
                            ? "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400"
                            : isInteractive
                            ? "bg-purple-500/15 text-purple-600 dark:text-purple-400"
                            : "bg-primary/10 text-primary"
                        }`}
                      >
                        {isAudio ? (
                          <Mic className="h-4 w-4" />
                        ) : isInteractive ? (
                          <Zap className="h-4 w-4" />
                        ) : (
                          <MessageSquare className="h-4 w-4" />
                        )}
                      </div>

                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="font-semibold text-sm text-foreground truncate">
                            {qr.title}
                          </span>
                          {qr.shortcut && (
                            <Badge variant="secondary" className="font-mono text-[10px] px-1.5 py-0 h-4">
                              /{qr.shortcut}
                            </Badge>
                          )}
                          {qr.category && (
                            <Badge variant="outline" className="text-[10px] px-1.5 py-0 h-4 text-muted-foreground">
                              {qr.category}
                            </Badge>
                          )}
                          {isAudio && qr.media_duration && (
                            <span className="text-[11px] text-emerald-600 dark:text-emerald-400 font-mono">
                              {Math.floor(qr.media_duration / 60)}:{(qr.media_duration % 60).toString().padStart(2, "0")}
                            </span>
                          )}
                        </div>

                        {/* Text Preview with variable replacement */}
                        {!isAudio && (
                          <p className="mt-1 text-xs text-muted-foreground line-clamp-2 leading-relaxed">
                            {isInteractive && qr.interactive_payload
                              ? interactivePayloadPreviewText(qr.interactive_payload)
                              : replaceQuickReplyVariables(qr.content_text || "", contactContext)}
                          </p>
                        )}
                      </div>
                    </div>

                    {/* Action buttons */}
                    <div className="flex items-center gap-1.5 shrink-0">
                      {isAudio ? (
                        <>
                          {/* Send with recording presence simulation */}
                          <Button
                            size="sm"
                            onClick={() => {
                              onOpenChange(false);
                              onSendAudio?.(qr, true);
                            }}
                            className="h-8 bg-emerald-600 hover:bg-emerald-700 text-white text-xs px-2.5 shadow-xs"
                            title="Simula 'Gravando áudio...' no WhatsApp do cliente antes de enviar como nota de voz"
                          >
                            <Mic className="mr-1.5 h-3.5 w-3.5 animate-pulse" />
                            🎙️ Gravar & Enviar
                          </Button>

                          {/* Send immediately */}
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => {
                              onOpenChange(false);
                              onSendAudio?.(qr, false);
                            }}
                            className="h-8 text-xs px-2 border-emerald-500/30 text-emerald-600 hover:bg-emerald-500/10 dark:text-emerald-400"
                            title="Envia como nota de voz sem esperar tempo de gravação"
                          >
                            <Send className="h-3.5 w-3.5" />
                          </Button>
                        </>
                      ) : (
                        <>
                          {/* Pick / Insert in textarea */}
                          <Button
                            size="sm"
                            variant="secondary"
                            onClick={() => {
                              onOpenChange(false);
                              onPick(qr);
                            }}
                            className="h-8 text-xs px-3"
                          >
                            Inserir
                          </Button>

                          {/* Direct send for text */}
                          {!isInteractive && onSendTextDirect && (
                            <Button
                              size="sm"
                              onClick={() => {
                                onOpenChange(false);
                                const textToSend = replaceQuickReplyVariables(
                                  qr.content_text || qr.title,
                                  contactContext
                                );
                                onSendTextDirect(textToSend);
                              }}
                              className="h-8 text-xs px-2.5 bg-primary"
                              title="Enviar imediatamente para o contato"
                            >
                              <Send className="h-3.5 w-3.5 mr-1" />
                              Enviar
                            </Button>
                          )}
                        </>
                      )}
                    </div>
                  </div>

                  {/* Audio Waveform Player */}
                  {isAudio && qr.media_url && (
                    <div className="mt-2.5 pt-2 border-t border-emerald-500/15">
                      <QuickReplyAudioPlayer
                        url={qr.media_url}
                        duration={qr.media_duration}
                      />
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
