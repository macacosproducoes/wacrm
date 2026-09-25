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
  GripVertical,
  Pencil,
  ChevronUp,
  ChevronDown,
  Trash2,
  Layers,
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
import {
  isAudioOrEncFile,
  cleanAudioTitle,
  computeAudioDuration,
  uploadAudioQuickReply,
} from "@/lib/audio/audio-file-normalizer";

interface QuickReplyPickerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onPick: (qr: QuickReply) => void;
  onSendAudio?: (qr: QuickReply, simulateRecording: boolean) => void;
  onSendTextDirect?: (text: string) => void;
  onSelectSequence?: (qr: QuickReply) => void;
  onEditReply?: (qr: QuickReply) => void;
  contactContext?: VariableContext;
}

type TabFilter = "all" | "audio" | "text" | "sequence" | "interactive";

export function QuickReplyPicker({
  open,
  onOpenChange,
  onPick,
  onSendAudio,
  onSendTextDirect,
  onSelectSequence,
  onEditReply,
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
  const [isDragging, setIsDragging] = useState(false);
  const [isDropping, setIsDropping] = useState(false);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const recordTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Drag and drop reordering state
  const [draggedAudioId, setDraggedAudioId] = useState<string | null>(null);
  const [dragOverAudioId, setDragOverAudioId] = useState<string | null>(null);

  // Audio rename state
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState("");
  const [savingRename, setSavingRename] = useState(false);

  const handleMoveAudio = async (fromId: string, toId: string) => {
    if (fromId === toId) return;
    const currentList = [...items];
    const fromIdx = currentList.findIndex((a) => a.id === fromId);
    const toIdx = currentList.findIndex((a) => a.id === toId);
    if (fromIdx === -1 || toIdx === -1) return;

    const [moved] = currentList.splice(fromIdx, 1);
    currentList.splice(toIdx, 0, moved);
    setItems(currentList);

    try {
      const orders = currentList.map((item, index) => ({ id: item.id, order_index: index }));
      await fetch("/api/quick-replies", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orders }),
      });
      toast.success("Ordem dos áudios atualizada com sucesso!");
    } catch {
      toast.error("Erro ao salvar ordem dos áudios.");
    }
  };

  const handleMoveStep = (id: string, direction: "up" | "down") => {
    const idx = items.findIndex((a) => a.id === id);
    if (idx === -1) return;
    const targetIdx = direction === "up" ? idx - 1 : idx + 1;
    if (targetIdx < 0 || targetIdx >= items.length) return;
    void handleMoveAudio(id, items[targetIdx].id);
  };

  const handleStartRename = (qr: QuickReply, e: React.MouseEvent) => {
    e.stopPropagation();
    setEditingId(qr.id);
    setEditingTitle(qr.title);
  };

  const handleSaveRename = async (id: string) => {
    const trimmed = editingTitle.trim();
    if (!trimmed) {
      toast.error("O título não pode ficar vazio.");
      return;
    }
    setSavingRename(true);
    try {
      const res = await fetch(`/api/quick-replies/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: trimmed }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || "Falha ao renomear áudio.");
      }
      setItems((prev) => prev.map((a) => (a.id === id ? { ...a, title: trimmed } : a)));
      setEditingId(null);
      toast.success(`Áudio renomeado para "${trimmed}"!`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Falha ao renomear.");
    } finally {
      setSavingRename(false);
    }
  };

  // Audio/item deletion state
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const handleConfirmDelete = async (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setDeletingId(id);
    try {
      const res = await fetch(`/api/quick-replies/${id}`, { method: "DELETE" });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || "Falha ao excluir áudio da base.");
      }
      setItems((prev) => prev.filter((a) => a.id !== id));
      setConfirmDeleteId(null);
      toast.success("Áudio excluído da base com sucesso!");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Erro ao excluir áudio.");
    } finally {
      setDeletingId(null);
    }
  };

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

  const listContainerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (listContainerRef.current) {
      listContainerRef.current.scrollTop = 0;
    }
  }, [open, currentTab, selectedCategory, search]);

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
      if (currentTab === "sequence" && qr.kind !== "sequence") return false;
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
  const sequenceCount = useMemo(() => items.filter((i) => i.kind === "sequence").length, [items]);
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

  const handleFileUpload = async (file: File) => {
    if (!file) return;
    setRecordedAudioBlob(file);
    const url = URL.createObjectURL(file);
    setRecordedAudioUrl(url);
    if (!newAudioTitle) {
      setNewAudioTitle(cleanAudioTitle(file.name));
    }

    const dur = await computeAudioDuration(file);
    setRecordedAudioDuration(dur);
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
          category: selectedCategory !== "all" ? selectedCategory : "Áudios",
        });
        toast.success(`🎙️ Áudio "${title}" salvo com sucesso no ZapPlus!`, { id: toastId });
      }
      setCurrentTab("audio");
      await fetchQuickReplies();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Erro ao salvar áudio arrastado.";
      toast.error(msg, { id: toastId });
    } finally {
      setIsDropping(false);
    }
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
      const file =
        recordedAudioBlob instanceof File
          ? recordedAudioBlob
          : new File([recordedAudioBlob], `audio-reply-${Date.now()}.ogg`, {
              type: recordedAudioBlob.type || "audio/ogg",
            });

      await uploadAudioQuickReply(file, {
        title: newAudioTitle.trim(),
        shortcut: newAudioShortcut.trim() || undefined,
        category: newAudioCategory.trim() || "Áudios",
      });

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
      <DialogContent
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        className="sm:max-w-2xl max-h-[min(82vh,680px)] flex flex-col p-0 gap-0 overflow-hidden bg-card border-border shadow-2xl relative"
      >
        {/* Drag & Drop Visual Overlay */}
        {(isDragging || isDropping) && (
          <div className="absolute inset-0 z-50 flex flex-col items-center justify-center bg-background/95 backdrop-blur-sm border-2 border-dashed border-emerald-500 rounded-lg p-6 text-center animate-in fade-in zoom-in-95 duration-150">
            <div className="h-16 w-16 rounded-full bg-emerald-500/20 text-emerald-600 dark:text-emerald-400 flex items-center justify-center mb-3 animate-bounce">
              {isDropping ? <Loader2 className="h-8 w-8 animate-spin" /> : <Upload className="h-8 w-8" />}
            </div>
            <h3 className="text-base font-bold text-foreground">
              {isDropping ? "Processando e Salvando Áudio..." : "Solte o Áudio para Salvar no ZapPlus"}
            </h3>
            <p className="text-xs text-muted-foreground mt-1 max-w-sm">
              Reconhece áudios <b>.enc</b>, <b>.ogg</b>, <b>.mp3</b> e salva automaticamente na sua conta!
            </p>
          </div>
        )}
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

          {/* Drag & Drop Hint Banner */}
          <div className="mt-2.5 px-3 py-1.5 rounded-lg bg-emerald-500/10 border border-emerald-500/20 flex items-center justify-between text-[11px] text-emerald-700 dark:text-emerald-300">
            <span className="flex items-center gap-1.5">
              <Sparkles className="h-3.5 w-3.5 text-emerald-500 shrink-0" />
              <span><b>Dica ZapPlus:</b> Arraste arquivos <b>.enc</b>, <b>.ogg</b> ou <b>.mp3</b> para dentro para salvar</span>
            </span>
            <Badge variant="outline" className="text-[10px] bg-emerald-500/15 border-emerald-500/30 text-emerald-700 dark:text-emerald-300">
              Auto-Save
            </Badge>
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
                onClick={() => setCurrentTab("sequence")}
                className={`flex items-center gap-1.5 px-3 py-1 rounded-lg font-medium transition-colors ${
                  currentTab === "sequence"
                    ? "bg-orange-600 text-white shadow-xs"
                    : "bg-muted/80 text-muted-foreground hover:bg-muted"
                }`}
              >
                <Layers className="h-3.5 w-3.5" />
                Sequências ({sequenceCount})
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
                  accept="audio/*,.ogg,.mp3,.wav,.m4a,.enc,.opus"
                  className="hidden"
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) void handleFileUpload(f);
                  }}
                />
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => fileInputRef.current?.click()}
                  className="h-8 text-xs text-muted-foreground hover:text-foreground"
                >
                  <Upload className="mr-1.5 h-3.5 w-3.5" />
                  Subir (.enc / .mp3 / .ogg)
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
        <div ref={listContainerRef} className="flex-1 min-h-[220px] max-h-[58vh] overflow-y-auto p-4 space-y-2.5">
          {loading && items.length === 0 ? (
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
            filteredItems.map((qr, index) => {
              const isAudio = qr.kind === "audio";
              const isSequence = qr.kind === "sequence";
              const isInteractive = qr.kind === "interactive";

              return (
                <div
                  key={qr.id}
                  draggable={editingId !== qr.id}
                  onDragStart={(e) => {
                    setDraggedAudioId(qr.id);
                    e.dataTransfer.setData("text/plain", qr.id);
                    e.dataTransfer.effectAllowed = "move";
                  }}
                  onDragOver={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    if (dragOverAudioId !== qr.id) setDragOverAudioId(qr.id);
                  }}
                  onDragLeave={(e) => {
                    e.stopPropagation();
                    if (dragOverAudioId === qr.id) setDragOverAudioId(null);
                  }}
                  onDrop={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    if (draggedAudioId && draggedAudioId !== qr.id) {
                      void handleMoveAudio(draggedAudioId, qr.id);
                    }
                    setDraggedAudioId(null);
                    setDragOverAudioId(null);
                  }}
                  onDragEnd={() => {
                    setDraggedAudioId(null);
                    setDragOverAudioId(null);
                  }}
                  className={`rounded-xl border p-3 transition-all ${
                    dragOverAudioId === qr.id
                      ? "border-emerald-500 bg-emerald-500/15 ring-2 ring-emerald-500/30 scale-[1.01]"
                      : isAudio
                      ? "border-emerald-500/30 bg-emerald-500/[0.02] hover:border-emerald-500/50 hover:bg-emerald-500/[0.05]"
                      : "border-border bg-card hover:border-border/80 hover:bg-muted/40"
                  }`}
                >
                  <div className="flex items-start justify-between gap-3">
                    {/* Drag Handle & Move Up/Down Controls */}
                    <div className="flex items-center gap-1 self-start sm:self-center shrink-0">
                      <div
                        className="cursor-grab active:cursor-grabbing p-1 rounded hover:bg-muted text-muted-foreground hover:text-foreground"
                        title="Arraste para reposicionar para cima ou para baixo"
                      >
                        <GripVertical className="h-4 w-4" />
                      </div>
                      <div className="flex flex-col -space-y-1">
                        <button
                          type="button"
                          disabled={index === 0}
                          onClick={() => handleMoveStep(qr.id, "up")}
                          title="Mover para cima"
                          className="p-0.5 rounded hover:bg-muted text-muted-foreground hover:text-foreground disabled:opacity-20 disabled:pointer-events-none transition-colors"
                        >
                          <ChevronUp className="h-3 w-3" />
                        </button>
                        <button
                          type="button"
                          disabled={index === filteredItems.length - 1}
                          onClick={() => handleMoveStep(qr.id, "down")}
                          title="Mover para baixo"
                          className="p-0.5 rounded hover:bg-muted text-muted-foreground hover:text-foreground disabled:opacity-20 disabled:pointer-events-none transition-colors"
                        >
                          <ChevronDown className="h-3 w-3" />
                        </button>
                      </div>
                    </div>

                    <div className="flex items-start gap-2.5 min-w-0 flex-1">
                      <div
                        className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${
                          isAudio
                            ? "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400"
                            : isSequence
                            ? "bg-orange-500/15 text-orange-600 dark:text-orange-400"
                            : isInteractive
                            ? "bg-purple-500/15 text-purple-600 dark:text-purple-400"
                            : "bg-primary/10 text-primary"
                        }`}
                      >
                        {isAudio ? (
                          <Mic className="h-4 w-4" />
                        ) : isSequence ? (
                          <Layers className="h-4 w-4" />
                        ) : isInteractive ? (
                          <Zap className="h-4 w-4" />
                        ) : (
                          <MessageSquare className="h-4 w-4" />
                        )}
                      </div>

                      <div className="min-w-0 flex-1">
                        {editingId === qr.id ? (
                          <div className="flex items-center gap-1.5" onClick={(e) => e.stopPropagation()}>
                            <Input
                              value={editingTitle}
                              onChange={(e) => setEditingTitle(e.target.value)}
                              onKeyDown={(e) => {
                                if (e.key === "Enter") void handleSaveRename(qr.id);
                                if (e.key === "Escape") setEditingId(null);
                              }}
                              autoFocus
                              placeholder="Nome do áudio..."
                              className="h-7 text-xs bg-background max-w-xs"
                            />
                            <Button
                              type="button"
                              size="sm"
                              disabled={savingRename || !editingTitle.trim()}
                              onClick={() => void handleSaveRename(qr.id)}
                              className="h-7 px-2 text-xs bg-emerald-600 hover:bg-emerald-700 text-white gap-1"
                              title="Salvar novo nome"
                            >
                              {savingRename ? <Loader2 className="h-3 w-3 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
                              Salvar
                            </Button>
                            <Button
                              type="button"
                              size="sm"
                              variant="ghost"
                              onClick={() => setEditingId(null)}
                              className="h-7 px-2 text-xs"
                              title="Cancelar"
                            >
                              <X className="h-3.5 w-3.5" />
                            </Button>
                          </div>
                        ) : (
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="font-semibold text-sm text-foreground truncate">
                              {qr.title}
                            </span>
                            <button
                              type="button"
                              onClick={(e) => {
                                if (onEditReply) {
                                  onOpenChange(false);
                                  onEditReply(qr);
                                } else {
                                  handleStartRename(qr, e);
                                }
                              }}
                              title="Editar resposta rápida / texto"
                              className="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-muted/80 transition-colors"
                            >
                              <Pencil className="h-3 w-3" />
                            </button>
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
                        )}

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
                        confirmDeleteId === qr.id ? (
                          <div
                            className="flex items-center gap-1.5 shrink-0 bg-red-500/10 border border-red-500/30 rounded-md px-2 py-1 animate-in fade-in"
                            onClick={(e) => e.stopPropagation()}
                          >
                            <span className="text-[11px] font-medium text-red-600 dark:text-red-400">
                              Excluir da base?
                            </span>
                            <Button
                              type="button"
                              size="sm"
                              variant="destructive"
                              disabled={deletingId === qr.id}
                              onClick={(e) => void handleConfirmDelete(qr.id, e)}
                              className="h-6 px-2 text-[11px] font-medium gap-1 bg-red-600 hover:bg-red-700 text-white shadow-none"
                            >
                              {deletingId === qr.id ? (
                                <Loader2 className="h-3 w-3 animate-spin" />
                              ) : (
                                <Trash2 className="h-3 w-3" />
                              )}
                              Sim
                            </Button>
                            <Button
                              type="button"
                              size="sm"
                              variant="ghost"
                              onClick={(e) => {
                                e.stopPropagation();
                                setConfirmDeleteId(null);
                              }}
                              className="h-6 px-1.5 text-[11px] text-muted-foreground hover:text-foreground"
                            >
                              <X className="h-3 w-3" />
                            </Button>
                          </div>
                        ) : (
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

                            {/* Edit audio reply */}
                            {onEditReply && (
                              <button
                                type="button"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  onOpenChange(false);
                                  onEditReply(qr);
                                }}
                                title="Editar configurações deste áudio"
                                className="p-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
                              >
                                <Pencil className="h-3.5 w-3.5" />
                              </button>
                            )}

                            {/* Delete audio from database button */}
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                setConfirmDeleteId(qr.id);
                              }}
                              title="Excluir este áudio da base"
                              className="p-1.5 rounded-md text-muted-foreground hover:text-red-500 hover:bg-red-500/10 transition-colors"
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </button>
                          </>
                        )
                      ) : isSequence ? (
                        confirmDeleteId === qr.id ? (
                          <div
                            className="flex items-center gap-1.5 shrink-0 bg-red-500/10 border border-red-500/30 rounded-md px-2 py-1 animate-in fade-in"
                            onClick={(e) => e.stopPropagation()}
                          >
                            <span className="text-[11px] font-medium text-red-600 dark:text-red-400">
                              Excluir da base?
                            </span>
                            <Button
                              type="button"
                              size="sm"
                              variant="destructive"
                              disabled={deletingId === qr.id}
                              onClick={(e) => void handleConfirmDelete(qr.id, e)}
                              className="h-6 px-2 text-[11px] font-medium gap-1 bg-red-600 hover:bg-red-700 text-white shadow-none"
                            >
                              {deletingId === qr.id ? (
                                <Loader2 className="h-3 w-3 animate-spin" />
                              ) : (
                                <Trash2 className="h-3 w-3" />
                              )}
                              Sim
                            </Button>
                            <Button
                              type="button"
                              size="sm"
                              variant="ghost"
                              onClick={(e) => {
                                e.stopPropagation();
                                setConfirmDeleteId(null);
                              }}
                              className="h-6 px-1.5 text-[11px] text-muted-foreground hover:text-foreground"
                            >
                              <X className="h-3 w-3" />
                            </Button>
                          </div>
                        ) : (
                          <>
                            <Button
                              size="sm"
                              onClick={() => {
                                onOpenChange(false);
                                onSelectSequence?.(qr);
                              }}
                              className="h-8 bg-orange-600 hover:bg-orange-700 text-white text-xs px-2.5 shadow-xs gap-1.5"
                              title="Disparar sequência de mensagens em ordem no WhatsApp"
                            >
                              <Layers className="h-3.5 w-3.5" />
                              Iniciar Sequência
                            </Button>

                            {onEditReply && (
                              <Button
                                size="sm"
                                variant="outline"
                                onClick={() => {
                                  onOpenChange(false);
                                  onEditReply(qr);
                                }}
                                className="h-8 text-xs px-2 border-border hover:bg-muted gap-1 text-muted-foreground hover:text-foreground"
                                title="Editar passos desta sequência"
                              >
                                <Pencil className="h-3.5 w-3.5" />
                                Editar
                              </Button>
                            )}

                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                setConfirmDeleteId(qr.id);
                              }}
                              title="Excluir esta sequência da base"
                              className="p-1.5 rounded-md text-muted-foreground hover:text-red-500 hover:bg-red-500/10 transition-colors"
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </button>
                          </>
                        )
                      ) : (
                        confirmDeleteId === qr.id ? (
                          <div
                            className="flex items-center gap-1.5 shrink-0 bg-red-500/10 border border-red-500/30 rounded-md px-2 py-1 animate-in fade-in"
                            onClick={(e) => e.stopPropagation()}
                          >
                            <span className="text-[11px] font-medium text-red-600 dark:text-red-400">
                              Excluir da base?
                            </span>
                            <Button
                              type="button"
                              size="sm"
                              variant="destructive"
                              disabled={deletingId === qr.id}
                              onClick={(e) => void handleConfirmDelete(qr.id, e)}
                              className="h-6 px-2 text-[11px] font-medium gap-1 bg-red-600 hover:bg-red-700 text-white shadow-none"
                            >
                              {deletingId === qr.id ? (
                                <Loader2 className="h-3 w-3 animate-spin" />
                              ) : (
                                <Trash2 className="h-3 w-3" />
                              )}
                              Sim
                            </Button>
                            <Button
                              type="button"
                              size="sm"
                              variant="ghost"
                              onClick={(e) => {
                                e.stopPropagation();
                                setConfirmDeleteId(null);
                              }}
                              className="h-6 px-1.5 text-[11px] text-muted-foreground hover:text-foreground"
                            >
                              <X className="h-3 w-3" />
                            </Button>
                          </div>
                        ) : (
                          <>
                            {onEditReply && (
                              <Button
                                size="sm"
                                variant="outline"
                                onClick={() => {
                                  onOpenChange(false);
                                  onEditReply(qr);
                                }}
                                className="h-8 text-xs px-2.5 border-border hover:bg-muted gap-1 text-muted-foreground hover:text-foreground"
                                title="Editar texto pronto completo, atalho ou categoria"
                              >
                                <Pencil className="h-3 w-3" />
                                Editar
                              </Button>
                            )}

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

                            {/* Delete text reply button */}
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                setConfirmDeleteId(qr.id);
                              }}
                              title="Excluir este texto da base"
                              className="p-1.5 rounded-md text-muted-foreground hover:text-red-500 hover:bg-red-500/10 transition-colors"
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </button>
                          </>
                        )
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

                  {/* Sequence Steps Flow Preview */}
                  {isSequence && qr.sequence_items && qr.sequence_items.length > 0 && (
                    <div className="mt-2.5 pt-2 border-t border-orange-500/15 flex items-center gap-1.5 flex-wrap">
                      {qr.sequence_items.map((step, sIdx) => (
                        <span
                          key={step.id || sIdx}
                          className="inline-flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-md bg-orange-500/10 border border-orange-500/20 text-orange-800 dark:text-orange-200"
                        >
                          <span className="font-bold">{sIdx + 1}º</span>
                          <span className="capitalize font-medium">{step.type}</span>
                          {step.delay_seconds ? (
                            <span className="text-muted-foreground font-mono">({step.delay_seconds}s)</span>
                          ) : null}
                        </span>
                      ))}
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
