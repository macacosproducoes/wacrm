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

  // In-modal microphone recording
  const [isRecording, setIsRecording] = useState(false);
  const [recordSeconds, setRecordSeconds] = useState(0);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const recordTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const categories = useMemo(() => {
    const set = new Set<string>();
    audioReplies.forEach((item) => {
      if (item.category) set.add(item.category);
    });
    return Array.from(set);
  }, [audioReplies]);

  const filteredAudios = useMemo(() => {
    return audioReplies.filter((qr) => {
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
  }, [audioReplies, selectedCategory, search]);

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
          setAudioDuration(dur);
        };

        stream.getTracks().forEach((track) => track.stop());
      };

      mediaRecorder.start(200);
      setIsRecording(true);
      setRecordSeconds(0);

      recordTimerRef.current = setInterval(() => {
        setRecordSeconds((s) => s + 1);
      }, 1000);
    } catch (err) {
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

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const localUrl = URL.createObjectURL(file);
    setAudioBlob(file);
    setAudioUrl(localUrl);
    if (!newTitle) {
      setNewTitle(file.name.replace(/\.[^/.]+$/, ""));
    }

    const tempAudio = new Audio(localUrl);
    tempAudio.onloadedmetadata = () => {
      setAudioDuration(isFinite(tempAudio.duration) ? Math.round(tempAudio.duration) : 0);
    };
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

      const { publicUrl } = await uploadAccountMedia(CHAT_MEDIA_BUCKET, file);

      const res = await fetch("/api/quick-replies", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: newTitle.trim(),
          kind: "audio",
          shortcut: newShortcut ? newShortcut.replace(/^\//, "").trim() : null,
          category: newCategory.trim() || "Vendas",
          content_text: `🎙️ ${newTitle.trim()}`,
          media_url: publicUrl,
          media_type: file.type || "audio/ogg",
          media_duration: audioDuration || recordSeconds || 5,
        }),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || "Erro ao salvar áudio.");
      }

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

  const handleDelete = async (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (!confirm("Tem certeza que deseja excluir este áudio da biblioteca?")) return;

    try {
      const res = await fetch(`/api/quick-replies/${id}`, { method: "DELETE" });
      if (res.ok) {
        toast.success("Áudio removido!");
        onRefreshReplies?.();
      }
    } catch {
      toast.error("Erro ao excluir.");
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[85vh] flex flex-col p-0 gap-0 overflow-hidden border-border bg-card">
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
                accept="audio/*,.ogg,.mp3,.wav,.m4a"
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
                Upload Arquivo (.ogg / .mp3)
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
            filteredAudios.map((qr) => (
              <div
                key={qr.id}
                className="group relative flex flex-col sm:flex-row sm:items-center justify-between gap-3 p-3 rounded-lg border border-border/70 bg-card hover:border-purple-500/50 hover:bg-purple-500/5 transition-all shadow-xs"
              >
                <div className="flex-1 min-w-0 space-y-1">
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-semibold text-foreground truncate">
                      🎙️ {qr.title}
                    </span>
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

                  {qr.media_url && (
                    <div className="pt-1">
                      <QuickReplyAudioPlayer
                        url={qr.media_url}
                        duration={qr.media_duration || 0}
                      />
                    </div>
                  )}

                </div>

                {/* Send actions */}
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
                    onClick={(e) => handleDelete(qr.id, e)}
                    title="Excluir áudio"
                    className="p-1 rounded text-muted-foreground hover:text-red-500 hover:bg-red-500/10 transition-colors"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              </div>
            ))
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
