"use client";

import { useState, useMemo, useEffect, useRef } from "react";
import {
  ImageIcon,
  Search,
  Upload,
  Send,
  Sparkles,
  Clock,
  X,
  Loader2,
  Check,
  ExternalLink,
  Copy,
  Maximize2,
  Plus,
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

export interface StoredPhoto {
  id: string;
  name: string;
  path: string;
  url: string;
  size?: number;
  created_at: string;
  title?: string;
}

interface PhotoLibraryModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSendPhoto: (url: string, caption?: string) => void;
}

export function PhotoLibraryModal({
  open,
  onOpenChange,
  onSendPhoto,
}: PhotoLibraryModalProps) {
  const [photos, setPhotos] = useState<StoredPhoto[]>([]);
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState("");
  const [selectedPhoto, setSelectedPhoto] = useState<StoredPhoto | null>(null);
  const [caption, setCaption] = useState("");
  const [previewZoomUrl, setPreviewZoomUrl] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Fetch photos on open
  useEffect(() => {
    if (!open) {
      setSelectedPhoto(null);
      setCaption("");
      setPreviewZoomUrl(null);
      return;
    }

    let cancelled = false;
    async function loadPhotos() {
      setLoading(true);
      try {
        const res = await fetch("/api/inbox/media/photos");
        const data = await res.json();
        if (!cancelled && data.photos) {
          setPhotos(data.photos);
        }
      } catch (err) {
        console.error("Failed to load photos:", err);
        if (!cancelled) toast.error("Falha ao carregar galeria de fotos.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void loadPhotos();

    return () => {
      cancelled = true;
    };
  }, [open]);

  // Handle direct file upload to storage
  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setUploading(true);
    const formData = new FormData();
    formData.append("file", file);
    formData.append("title", file.name);

    try {
      const res = await fetch("/api/inbox/media/photos", {
        method: "POST",
        body: formData,
      });
      const data = await res.json();

      if (!res.ok || !data.success) {
        toast.error(data.error || "Erro no upload da foto.");
        return;
      }

      toast.success("Foto cadastrada com sucesso na galeria!");
      const newPhoto: StoredPhoto = {
        id: data.path || Date.now().toString(),
        name: data.name || file.name,
        path: data.path,
        url: data.url,
        size: file.size,
        created_at: new Date().toISOString(),
      };
      setPhotos((prev) => [newPhoto, ...prev]);
      setSelectedPhoto(newPhoto);
    } catch (err) {
      console.error("Error uploading photo:", err);
      toast.error("Erro na conexão durante upload da foto.");
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  const filteredPhotos = useMemo(() => {
    if (!search.trim()) return photos;
    const term = search.toLowerCase();
    return photos.filter((p) =>
      p.name.toLowerCase().includes(term) ||
      (p.title && p.title.toLowerCase().includes(term))
    );
  }, [photos, search]);

  const handleSendCurrent = (photoToSend: StoredPhoto) => {
    onSendPhoto(photoToSend.url, caption.trim() || undefined);
    toast.success(`Foto enviada no chat!`);
    onOpenChange(false);
  };

  const copyUrl = (url: string, e: React.MouseEvent) => {
    e.stopPropagation();
    navigator.clipboard.writeText(url);
    toast.success("Link da foto copiado!");
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl sm:max-w-4xl max-h-[88vh] flex flex-col p-4 sm:p-6 overflow-hidden">
        <DialogHeader className="pb-3 border-b border-border/60">
          <div className="flex items-center justify-between gap-3 pr-6">
            <div className="flex items-center gap-2.5">
              <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-blue-500/10 text-blue-600 dark:text-blue-400">
                <ImageIcon className="h-5 w-5" />
              </div>
              <div>
                <DialogTitle className="text-base font-bold text-foreground flex items-center gap-2">
                  Galeria de Fotos Cadastradas
                  <Badge variant="outline" className="text-[11px] font-normal border-blue-500/30 text-blue-600 dark:text-blue-400 bg-blue-500/5">
                    {photos.length} fotos
                  </Badge>
                </DialogTitle>
                <p className="text-xs text-muted-foreground mt-0.5">
                  Fotos salvas no Supabase Storage. Clique para enviar como imagem direta no chat do WhatsApp.
                </p>
              </div>
            </div>

            {/* Upload Button */}
            <div className="flex items-center gap-2 shrink-0">
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                onChange={handleFileUpload}
                className="hidden"
              />
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={uploading}
                onClick={() => fileInputRef.current?.click()}
                className="h-8 gap-1.5 text-xs border-blue-500/30 text-blue-600 dark:text-blue-400 hover:bg-blue-500/10 cursor-pointer"
              >
                {uploading ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Upload className="h-3.5 w-3.5" />
                )}
                <span>Cadastrar Nova Foto</span>
              </Button>
            </div>
          </div>
        </DialogHeader>

        {/* Search Bar */}
        <div className="pt-3 pb-2 flex items-center gap-2">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Buscar foto por nome ou código..."
              className="pl-9 h-8 text-xs bg-muted/40"
            />
          </div>
        </div>

        {/* Photos Grid Container */}
        <div className="flex-1 overflow-y-auto min-h-[280px] max-h-[50vh] pr-1 py-1">
          {loading ? (
            <div className="flex flex-col items-center justify-center py-20 gap-3 text-muted-foreground">
              <Loader2 className="h-6 w-6 animate-spin text-blue-500" />
              <p className="text-xs">Carregando fotos do Supabase...</p>
            </div>
          ) : filteredPhotos.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 gap-2 text-center text-muted-foreground">
              <ImageIcon className="h-10 w-10 stroke-1 opacity-40 text-blue-500" />
              <p className="text-sm font-medium text-foreground">Nenhuma foto encontrada</p>
              <p className="text-xs max-w-sm">
                {search ? "Nenhum resultado para a busca." : "Faça upload de fotos para visualizar e enviar com 1 clique no WhatsApp."}
              </p>
              <Button
                type="button"
                size="sm"
                onClick={() => fileInputRef.current?.click()}
                className="mt-2 h-8 text-xs gap-1.5 bg-blue-600 hover:bg-blue-700 text-white"
              >
                <Plus className="h-3.5 w-3.5" />
                Enviar Primeira Foto
              </Button>
            </div>
          ) : (
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3">
              {filteredPhotos.map((photo) => {
                const isSelected = selectedPhoto?.url === photo.url;
                return (
                  <div
                    key={photo.url}
                    onClick={() => setSelectedPhoto(photo)}
                    className={`group relative flex flex-col rounded-xl border overflow-hidden cursor-pointer transition-all duration-150 bg-card hover:shadow-md ${
                      isSelected
                        ? "border-blue-500 ring-2 ring-blue-500/30 shadow-md"
                        : "border-border/70 hover:border-blue-400/60"
                    }`}
                  >
                    {/* Image Thumbnail */}
                    <div className="relative w-full aspect-square bg-muted/50 overflow-hidden flex items-center justify-center">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={photo.url}
                        alt={photo.name}
                        loading="lazy"
                        className="w-full h-full object-cover transition-transform duration-200 group-hover:scale-105"
                      />

                      {/* Hover action overlay */}
                      <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center gap-1.5 p-2">
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            setPreviewZoomUrl(photo.url);
                          }}
                          title="Ampliar Foto"
                          className="p-1.5 rounded-full bg-white/90 text-gray-800 hover:bg-white hover:scale-110 transition-all shadow"
                        >
                          <Maximize2 className="h-3.5 w-3.5" />
                        </button>

                        <button
                          type="button"
                          onClick={(e) => copyUrl(photo.url, e)}
                          title="Copiar Link"
                          className="p-1.5 rounded-full bg-white/90 text-gray-800 hover:bg-white hover:scale-110 transition-all shadow"
                        >
                          <Copy className="h-3.5 w-3.5" />
                        </button>

                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            handleSendCurrent(photo);
                          }}
                          title="Enviar Imediatamente"
                          className="px-2.5 py-1 rounded-full bg-blue-600 text-white font-semibold text-[11px] hover:bg-blue-700 hover:scale-105 transition-all shadow flex items-center gap-1"
                        >
                          <Send className="h-3 w-3" />
                          <span>Enviar</span>
                        </button>
                      </div>

                      {/* Selected check badge */}
                      {isSelected && (
                        <div className="absolute top-1.5 right-1.5 flex h-5 w-5 items-center justify-center rounded-full bg-blue-600 text-white shadow">
                          <Check className="h-3 w-3 stroke-[3]" />
                        </div>
                      )}
                    </div>

                    {/* Metadata Footer */}
                    <div className="p-2 flex flex-col gap-0.5 border-t border-border/40 bg-card">
                      <span className="text-[11px] font-semibold text-foreground truncate" title={photo.name}>
                        {photo.name}
                      </span>
                      <div className="flex items-center justify-between text-[10px] text-muted-foreground">
                        <span>{photo.created_at ? new Date(photo.created_at).toLocaleDateString("pt-BR") : "Cadastrada"}</span>
                        {photo.size && <span>{(photo.size / 1024).toFixed(0)} KB</span>}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Selected Photo Action Bar */}
        {selectedPhoto && (
          <div className="mt-3 pt-3 border-t border-border/60 flex flex-col sm:flex-row items-center justify-between gap-3 bg-muted/20 -mx-4 -mb-4 sm:-mx-6 sm:-mb-6 p-4">
            <div className="flex items-center gap-3 w-full sm:w-auto">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={selectedPhoto.url}
                alt={selectedPhoto.name}
                className="h-10 w-10 rounded-md object-cover border border-border shrink-0"
              />
              <div className="flex-1 min-w-0">
                <p className="text-xs font-semibold text-foreground truncate max-w-xs sm:max-w-md">
                  {selectedPhoto.name}
                </p>
                <input
                  type="text"
                  value={caption}
                  onChange={(e) => setCaption(e.target.value)}
                  placeholder="Legenda para a foto (opcional)..."
                  className="mt-0.5 h-7 w-full sm:w-80 rounded-md border border-input bg-background px-2 text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-blue-500"
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      handleSendCurrent(selectedPhoto);
                    }
                  }}
                />
              </div>
            </div>

            <div className="flex items-center gap-2 w-full sm:w-auto justify-end">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setSelectedPhoto(null)}
                className="h-8 text-xs"
              >
                Cancelar
              </Button>

              <Button
                type="button"
                size="sm"
                onClick={() => handleSendCurrent(selectedPhoto)}
                className="h-8 gap-1.5 text-xs bg-blue-600 hover:bg-blue-700 text-white font-semibold cursor-pointer shadow-sm"
              >
                <Send className="h-3.5 w-3.5" />
                <span>Enviar Foto no Chat</span>
              </Button>
            </div>
          </div>
        )}
      </DialogContent>

      {/* Lightbox / Zoom Dialog */}
      {previewZoomUrl && (
        <Dialog open={Boolean(previewZoomUrl)} onOpenChange={() => setPreviewZoomUrl(null)}>
          <DialogContent className="max-w-4xl p-2 bg-black/90 border-neutral-800 flex flex-col items-center justify-center">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={previewZoomUrl}
              alt="Ampliação"
              className="max-h-[80vh] max-w-full rounded-md object-contain"
            />
            <div className="mt-2 flex items-center gap-2">
              <Button
                type="button"
                size="sm"
                onClick={() => {
                  const target = photos.find((p) => p.url === previewZoomUrl);
                  if (target) handleSendCurrent(target);
                  setPreviewZoomUrl(null);
                }}
                className="gap-1.5 text-xs bg-blue-600 hover:bg-blue-700 text-white"
              >
                <Send className="h-3.5 w-3.5" />
                <span>Enviar Esta Foto</span>
              </Button>
            </div>
          </DialogContent>
        </Dialog>
      )}
    </Dialog>
  );
}
