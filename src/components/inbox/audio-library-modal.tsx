"use client";

import { useState, useMemo, useRef, useEffect } from "react";
import {
  Mic,
  Search,
  Upload,
  Play,
  Square,
  Trash2,
  Send,
  Volume2,
  Sparkles,
  Radio,
  Clock,
  Plus,
  X,
  Loader2,
  GripVertical,
  Pencil,
  Check,
  ChevronUp,
  ChevronDown,
} from "lucide-react";
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
import type { QuickReply } from "@/types";
import { QuickReplyAudioPlayer } from "./quick-reply-audio-player";
import { uploadAccountMedia } from "@/lib/storage/upload-media";
import { CHAT_MEDIA_BUCKET } from "./message-composer";
import {
  isAudioOrEncFile,
  cleanAudioTitle,
  computeAudioDuration,
  uploadAudioQuickReply,
} from "@/lib/audio/audio-file-normalizer";

interface AudioLibraryModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  audioReplies: QuickReply[];
  onSendAudio: (qr: QuickReply, simulateRecording: boolean) => void;
  onRefreshReplies?: () => void;
}

export function AudioLibraryModal({
  open,
  onOpenChange,
  audioReplies,
  onSendAudio,
  onRefreshReplies,
}: AudioLibraryModalProps) {
  const [search, setSearch] = useState("");
  const [selectedCategory, setSelectedCategory] = useState<string>("all");

  // New audio creation drawer / inline state
  const [showAddForm, setShowAddForm] = useState(false);
  const [newTitle, setNewTitle] = useState("");
  const [newShortcut, setNewShortcut] = useState("");
  const [newCategory, setNewCategory] = useState("Vendas");
  const [uploading, setUploading] = useState(false);
  const [audioBlob, setAudioBlob] = useState<Blob | null>(null);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [audioDuration, setAudioDuration] = useState<number>(0);
  const [isDragging, setIsDragging] = useState(false);
  const [isDropping, setIsDropping] = useState(false);

  // In-modal microphone recording
  const [isRecording, setIsRecording] = useState(false);
  const [recordSeconds, setRecordSeconds] = useState(0);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const recordTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Local copy of audios for instant drag-and-drop reordering and renaming
  const [localAudios, setLocalAudios] = useState<QuickReply[]>(Array.isArray(audioReplies) ? audioReplies : []);
  useEffect(() => {
    setLocalAudios(Array.isArray(audioReplies) ? audioReplies : []);
  }, [audioReplies]);

  // Drag and drop reordering state
  const [draggedAudioId, setDraggedAudioId] = useState<string | null>(null);
  const [dragOverAudioId, setDragOverAudioId] = useState<string | null>(null);

  // Audio rename state
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState("");
  const [savingRename, setSavingRename] = useState(false);

  // Audio deletion state
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const categories = useMemo(() => {
    const set = new Set<string>();
    const audios = Array.isArray(localAudios) ? localAudios : [];
    audios.forEach((item) => {
      if (item.category) set.add(item.category);
    });
    return Array.from(set);
  }, [localAudios]);

  const filteredAudios = useMemo(() => {
    const audios = Array.isArray(localAudios) ? localAudios : [];
    return audios.filter((qr) => {
      if (qr.kind !== "audio") return false;
      if (selectedCategory !== "all" && qr.category !== selectedCategory) return false;
      if (search.trim()) {
        const q = search.toLowerCase();
        const matchTitle = (qr.title || "").toLowerCase().includes(q);
        const matchShortcut = (qr.shortcut || "").toLowerCase().includes(q);
        const matchCategory = (qr.category || "").toLowerCase().includes(q);
        return matchTitle || matchShortcut || matchCategory;
      }
      return true;
    });
  }, [localAudios, selectedCategory, search]);

  const handleMoveAudio = async (fromId: string, toId: string) => {
    if (fromId === toId) return;
    const currentList = [...localAudios];
    const fromIdx = currentList.findIndex((a) => a.id === fromId);
    const toIdx = currentList.findIndex((a) => a.id === toId);
    if (fromIdx === -1 || toIdx === -1) return;

    const [moved] = currentList.splice(fromIdx, 1);
    currentList.splice(toIdx, 0, moved);
    setLocalAudios(currentList);

    try {
      const orders = currentList.map((item, index) => ({ id: item.id, order_index: index }));
      await fetch("/api/quick-replies", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orders }),
      });
      onRefreshReplies?.();
      toast.success("Ordem dos áudios atualizada com sucesso!");
    } catch {
      toast.error("Erro ao salvar ordem dos áudios.");
    }
  };

  const handleMoveStep = (id: string, direction: "up" | "down") => {
    const idx = localAudios.findIndex((a) => a.id === id);
    if (idx === -1) return;
    const targetIdx = direction === "up" ? idx - 1 : idx + 1;
    if (targetIdx < 0 || targetIdx >= localAudios.length) return;
    void handleMoveAudio(id, localAudios[targetIdx].id);
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
      setLocalAudios((prev) => prev.map((a) => (a.id === id ? { ...a, title: trimmed } : a)));
      setEditingId(null);
      onRefreshReplies?.();
      toast.success(`Áudio renomeado para "${trimmed}"!`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Falha ao renomear.");
    } finally {
      setSavingRename(false);
    }
  };

  const listContainerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (listContainerRef.current) {
      listContainerRef.current.scrollTop = 0;
    }
  }, [open, selectedCategory, search]);

  const resetForm = () => {
    setNewTitle("");
    setNewShortcut("");
    setNewCategory("Vendas");
    setAudioBlob(null);
    setAudioUrl(null);
    setAudioDuration(0);
    setIsRecording(false);
    setRecordSeconds(0);
    if (recordTimerRef.current) {
      clearInterval(recordTimerRef.current);
      recordTimerRef.current = null;
    }
  };

  const startRecording = async () => {
    if (!navigator.mediaDevices?.getUserMedia) {
      toast.error("Gravação de microfone não suportada neste navegador.");
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

      mediaRecorder.onstop = () => {
        const blob = new Blob(audioChunksRef.current, { type: "audio/ogg" });
        const localUrl = URL.createObjectURL(blob);
        setAudioBlob(blob);
        setAudioUrl(localUrl);

        const tempAudio = new Audio(localUrl);
        tempAudio.onloadedmetadata = () => {
          const dur = isFinite(tempAudio.duration) ? Math.round(tempAudio.duration) : recordSeconds;
          setAudioDuration(dur || recordSeconds || 5);
        };

        stream.getTracks().forEach((track) => track.stop());
      };

      mediaRecorder.start(200);
      setIsRecording(true);
      setRecordSeconds(0);

      recordTimerRef.current = setInterval(() => {
        setRecordSeconds((s) => s + 1);
      }, 1000);
    } catch {
      toast.error("Permissão de microfone negada.");
    }
  };

  const stopRecording = () => {
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

    const localUrl = URL.createObjectURL(file);
    setAudioBlob(file);
    setAudioUrl(localUrl);
    if (!newTitle) {
      setNewTitle(cleanAudioTitle(file.name));
    }

    const dur = await computeAudioDuration(file);
    setAudioDuration(dur);
  };

  const handleDragOver = (e: React.DragEvent) => {
    // If dragging an internal audio card to reorder, ignore the file dropzone overlay!
    if (draggedAudioId) return;
    if (!e.dataTransfer.types.includes("Files")) return;
    e.preventDefault();
    e.stopPropagation();
    if (!isDragging) setIsDragging(true);
  };

  const handleDragLeave = (e: React.DragEvent) => {
    if (draggedAudioId) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.currentTarget.contains(e.relatedTarget as Node)) return;
    setIsDragging(false);
  };

  const handleDrop = async (e: React.DragEvent) => {
    // If dragging an internal audio card, ignore parent dropzone
    if (draggedAudioId) return;
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
        toast.success(`🎙️ Áudio "${title}" salvo com sucesso!`, { id: toastId });
      }
      onRefreshReplies?.();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Erro ao salvar áudio arrastado.";
      toast.error(msg, { id: toastId });
    } finally {
      setIsDropping(false);
    }
  };

  const handleSaveNewAudio = async () => {
    if (!newTitle.trim()) {
      toast.error("Defina um título para o áudio.");
      return;
    }
    if (!audioBlob) {
      toast.error("Grave ou faça upload de um áudio antes de salvar.");
      return;
    }

    setUploading(true);
    try {
      const file =
        audioBlob instanceof File
          ? audioBlob
          : new File([audioBlob], `voice-audio-${Date.now()}.ogg`, { type: "audio/ogg" });

      await uploadAudioQuickReply(file, {
        title: newTitle.trim(),
        shortcut: newShortcut ? newShortcut.replace(/^\//, "").trim() : undefined,
        category: newCategory.trim() || "Vendas",
      });

      toast.success("Áudio gravado e adicionado à biblioteca com sucesso!");
      setShowAddForm(false);
      resetForm();
      onRefreshReplies?.();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Erro no upload";
      toast.error(msg);
    } finally {
      setUploading(false);
    }
  };

  const handleConfirmDelete = async (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setDeletingId(id);
    try {
      const res = await fetch(`/api/quick-replies/${id}`, { method: "DELETE" });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || "Falha ao excluir áudio da base.");
      }
      setLocalAudios((prev) => prev.filter((a) => a.id !== id));
      setConfirmDeleteId(null);
      toast.success("Áudio excluído da base com sucesso!");
      onRefreshReplies?.();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Erro ao excluir áudio.");
    } finally {
      setDeletingId(null);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        className="max-w-2xl max-h-[min(82vh,680px)] flex flex-col p-0 gap-0 overflow-hidden border-border bg-card relative"
      >
        {/* Drag & Drop Visual Overlay */}
        {(isDragging || isDropping) && (
          <div className="absolute inset-0 z-50 flex flex-col items-center justify-center bg-background/95 backdrop-blur-sm border-2 border-dashed border-purple-500 rounded-lg p-6 text-center animate-in fade-in zoom-in-95 duration-150">
            <div className="h-16 w-16 rounded-full bg-purple-500/20 text-purple-600 dark:text-purple-400 flex items-center justify-center mb-3 animate-bounce">
              {isDropping ? <Loader2 className="h-8 w-8 animate-spin" /> : <Upload className="h-8 w-8" />}
            </div>
            <h3 className="text-base font-bold text-foreground">
              {isDropping ? "Processando e Salvando Áudio..." : "Solte o Áudio para Salvar no ZapPlus"}
            </h3>
            <p className="text-xs text-muted-foreground mt-1 max-w-sm">
              Reconhece áudios <b>.enc</b>, <b>.ogg</b>, <b>.mp3</b> e salva automaticamente com duração calculada!
            </p>
          </div>
        )}

        {/* Header */}
        <DialogHeader className="px-5 py-3.5 border-b border-border/70 flex flex-row items-center justify-between shrink-0">
          <div className="flex items-center gap-2">
            <div className="h-8 w-8 rounded-full bg-purple-500/15 text-purple-600 dark:text-purple-400 flex items-center justify-center">
              <Mic className="h-4 w-4" />
            </div>
            <div>
              <DialogTitle className="text-base font-semibold text-foreground">
                Biblioteca de Áudios Gravados (PTT)
              </DialogTitle>
              <p className="text-xs text-muted-foreground">
                Envie notas de voz oficiais no WhatsApp com simulação realista de gravação.
              </p>
            </div>
          </div>

          <Button
            type="button"
            size="sm"
            onClick={() => {
              setShowAddForm(!showAddForm);
              if (showAddForm) resetForm();
            }}
            className="gap-1 bg-purple-600 hover:bg-purple-700 text-white text-xs h-8"
          >
            {showAddForm ? (
              <>
                <X className="h-3.5 w-3.5" />
                Fechar
              </>
            ) : (
              <>
                <Plus className="h-3.5 w-3.5" />
                Novo Áudio
              </>
            )}
          </Button>
        </DialogHeader>

        {/* Drag Drop Hint Bar */}
        <div className="px-5 py-1.5 bg-purple-500/10 border-b border-purple-500/20 flex items-center justify-between text-[11px] text-purple-700 dark:text-purple-300 shrink-0">
          <span className="flex items-center gap-1.5">
            <Sparkles className="h-3.5 w-3.5 text-purple-500 shrink-0" />
            <span><b>Dica ZapPlus:</b> Arraste arquivos <b>.enc</b>, <b>.ogg</b> ou <b>.mp3</b> para salvar imediatamente</span>
          </span>
          <Badge variant="outline" className="text-[10px] bg-purple-500/15 border-purple-500/30 text-purple-700 dark:text-purple-300">
            Arrastar e Soltar
          </Badge>
        </div>

        {/* Add Audio Form Drawer */}
        {showAddForm && (
          <div className="px-5 py-4 border-b border-purple-500/30 bg-purple-500/5 space-y-3 shrink-0">
            <h4 className="text-xs font-semibold text-purple-700 dark:text-purple-300 flex items-center gap-1.5">
              <Mic className="h-3.5 w-3.5" />
              Gravar ou Enviar Novo Áudio para a Biblioteca
            </h4>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
              <div className="sm:col-span-2">
                <Input
                  placeholder="Nome do áudio (ex: Apresentação da Solução)"
                  value={newTitle}
                  onChange={(e) => setNewTitle(e.target.value)}
                  className="h-8 text-xs bg-background"
                />
              </div>
              <div>
                <Input
                  placeholder="/atalho (ex: intro)"
                  value={newShortcut}
                  onChange={(e) => setNewShortcut(e.target.value)}
                  className="h-8 text-xs bg-background font-mono"
                />
              </div>
            </div>

            {/* Recorder controls */}
            <div className="flex flex-wrap items-center gap-2">
              {!isRecording ? (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={startRecording}
                  className="h-8 gap-1.5 text-xs border-purple-500/40 text-purple-600 hover:bg-purple-500/10"
                >
                  <Mic className="h-3.5 w-3.5" />
                  Gravar Microfone
                </Button>
              ) : (
                <Button
                  type="button"
                  variant="destructive"
                  size="sm"
                  onClick={stopRecording}
                  className="h-8 gap-1.5 text-xs animate-pulse"
                >
                  <Square className="h-3.5 w-3.5" />
                  Parar ({recordSeconds}s)
                </Button>
              )}

              <input
                ref={fileInputRef}
                type="file"
                accept="audio/*,.ogg,.mp3,.wav,.m4a,.enc,.opus"
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
                Upload (.enc / .ogg / .mp3)
              </Button>

              {audioUrl && (
                <div className="flex items-center gap-2 text-xs text-muted-foreground pl-2">
                  <Badge variant="outline" className="bg-emerald-500/10 text-emerald-600 border-emerald-500/30">
                    Áudio pronto: {audioDuration}s
                  </Badge>
                  <audio src={audioUrl} controls className="h-7 w-48" />
                </div>
              )}
            </div>

            <div className="flex justify-end gap-2 pt-1">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => {
                  setShowAddForm(false);
                  resetForm();
                }}
                className="h-7 text-xs"
              >
                Cancelar
              </Button>
              <Button
                type="button"
                size="sm"
                disabled={uploading || !audioBlob || !newTitle.trim()}
                onClick={handleSaveNewAudio}
                className="h-7 text-xs bg-purple-600 hover:bg-purple-700 text-white gap-1"
              >
                {uploading ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
                Salvar na Biblioteca
              </Button>
            </div>
          </div>
        )}

        {/* Search & Categories Filter */}
        <div className="px-5 py-2.5 border-b border-border/70 flex flex-col sm:flex-row items-center gap-2 bg-muted/20 shrink-0">
          <div className="relative flex-1 w-full">
            <Search className="absolute left-2.5 top-2 h-3.5 w-3.5 text-muted-foreground" />
            <Input
              placeholder="Pesquisar áudio por título ou /atalho..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="h-7.5 pl-8 text-xs bg-background"
            />
          </div>

          <div className="flex items-center gap-1 overflow-x-auto no-scrollbar w-full sm:w-auto">
            <button
              type="button"
              onClick={() => setSelectedCategory("all")}
              className={`h-6 px-2 text-[11px] rounded-md font-medium whitespace-nowrap transition-colors ${
                selectedCategory === "all"
                  ? "bg-purple-600 text-white"
                  : "bg-muted text-muted-foreground hover:bg-muted/80"
              }`}
            >
              Todas
            </button>
            {categories.map((cat) => (
              <button
                key={cat}
                type="button"
                onClick={() => setSelectedCategory(cat)}
                className={`h-6 px-2 text-[11px] rounded-md font-medium whitespace-nowrap transition-colors ${
                  selectedCategory === cat
                    ? "bg-purple-600 text-white"
                    : "bg-muted text-muted-foreground hover:bg-muted/80"
                }`}
              >
                {cat}
              </button>
            ))}
          </div>
        </div>

        {/* Audio List */}
        <div ref={listContainerRef} className="flex-1 overflow-y-auto p-4 space-y-2.5">
          {filteredAudios.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 text-muted-foreground text-center">
              <div className="h-12 w-12 rounded-full bg-muted/60 flex items-center justify-center mb-2">
                <Mic className="h-6 w-6 text-muted-foreground/60" />
              </div>
              <p className="text-sm font-medium">Nenhum áudio encontrado</p>
              <p className="text-xs text-muted-foreground/75 mt-1">
                Grave ou envie um áudio usando o botão "+ Novo Áudio" acima.
              </p>
            </div>
          ) : (
            filteredAudios.map((qr, index) => (
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
                className={`group relative flex flex-col sm:flex-row sm:items-center justify-between gap-3 p-3 rounded-lg border transition-all shadow-xs ${
                  dragOverAudioId === qr.id
                    ? "border-purple-500 bg-purple-500/15 ring-2 ring-purple-500/30 scale-[1.01]"
                    : "border-border/70 bg-card hover:border-purple-500/50 hover:bg-purple-500/5"
                }`}
              >
                {/* Drag Handle & Move Up/Down Reorder Controls */}
                <div className="flex items-center gap-1 self-start sm:self-center shrink-0">
                  <div
                    className="cursor-grab active:cursor-grabbing p-1 rounded hover:bg-muted text-muted-foreground hover:text-foreground"
                    title="Arraste para reposicionar este áudio para cima ou para baixo"
                  >
                    <GripVertical className="h-4 w-4" />
                  </div>
                  <div className="flex flex-col -space-y-1">
                    <button
                      type="button"
                      disabled={index === 0}
                      onClick={() => handleMoveStep(qr.id, "up")}
                      title="Mover áudio para cima"
                      className="p-0.5 rounded hover:bg-muted text-muted-foreground hover:text-foreground disabled:opacity-20 disabled:pointer-events-none transition-colors"
                    >
                      <ChevronUp className="h-3 w-3" />
                    </button>
                    <button
                      type="button"
                      disabled={index === filteredAudios.length - 1}
                      onClick={() => handleMoveStep(qr.id, "down")}
                      title="Mover áudio para baixo"
                      className="p-0.5 rounded hover:bg-muted text-muted-foreground hover:text-foreground disabled:opacity-20 disabled:pointer-events-none transition-colors"
                    >
                      <ChevronDown className="h-3 w-3" />
                    </button>
                  </div>
                </div>

                <div className="flex-1 min-w-0 space-y-1">
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
                    <div className="flex items-center gap-1.5 flex-wrap">
                      <span className="text-xs font-semibold text-foreground truncate">
                        🎙️ {qr.title}
                      </span>
                      <button
                        type="button"
                        onClick={(e) => handleStartRename(qr, e)}
                        title="Renomear este áudio"
                        className="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-muted/80 transition-colors"
                      >
                        <Pencil className="h-3 w-3" />
                      </button>
                      {qr.shortcut && (
                        <Badge variant="outline" className="text-[10px] font-mono px-1.5 py-0">
                          /{qr.shortcut}
                        </Badge>
                      )}
                      {qr.category && (
                        <span className="text-[10px] text-muted-foreground font-medium px-1.5 py-0.5 rounded bg-muted">
                          {qr.category}
                        </span>
                      )}
                    </div>
                  )}

                  {qr.media_url && (
                    <div className="pt-1">
                      <QuickReplyAudioPlayer
                        url={qr.media_url}
                        duration={qr.media_duration || 0}
                      />
                    </div>
                  )}
                </div>

                {/* Send actions & Delete */}
                {confirmDeleteId === qr.id ? (
                  <div
                    className="flex items-center gap-1.5 shrink-0 bg-red-500/10 border border-red-500/30 rounded-md px-2 py-1 self-end sm:self-center animate-in fade-in"
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
                      Sim, excluir
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
                      Cancelar
                    </Button>
                  </div>
                ) : (
                  <div className="flex items-center gap-1.5 shrink-0 self-end sm:self-center">
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      title="Simula status 'Gravando áudio...' no WhatsApp do cliente antes de entregar a nota de voz"
                      onClick={() => {
                        onSendAudio(qr, true);
                        onOpenChange(false);
                      }}
                      className="h-7 px-2.5 text-[11px] font-medium border-purple-500/30 text-purple-600 dark:text-purple-300 hover:bg-purple-500/10 gap-1"
                    >
                      <Radio className="h-3 w-3 text-purple-500" />
                      Simular & Enviar
                    </Button>

                    <Button
                      type="button"
                      size="sm"
                      title="Envia imediatamente como mensagem de voz oficial"
                      onClick={() => {
                        onSendAudio(qr, false);
                        onOpenChange(false);
                      }}
                      className="h-7 px-2.5 text-[11px] font-medium bg-purple-600 hover:bg-purple-700 text-white gap-1"
                    >
                      <Send className="h-3 w-3" />
                      Enviar Direto
                    </Button>

                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        setConfirmDeleteId(qr.id);
                      }}
                      title="Excluir este áudio da base"
                      className="p-1.5 rounded-md text-muted-foreground hover:text-red-500 hover:bg-red-500/10 transition-colors"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </div>
                )}
              </div>
            ))
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
