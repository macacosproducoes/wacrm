"use client";

import { useState, useRef, useCallback } from "react";
import {
  RefreshCw,
  Upload,
  Trash2,
  ExternalLink,
  CheckCircle2,
  AlertCircle,
  Loader2,
  Camera,
  X,
  Pencil,
  Check,
  Send,
  Sparkles,
} from "lucide-react";

function InstagramIcon({ className = "h-3 w-3" }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      <rect width="20" height="20" x="2" y="2" rx="5" ry="5" />
      <path d="M16 11.37A4 4 0 1 1 12.63 8 4 4 0 0 1 16 11.37z" />
      <line x1="17.5" x2="17.51" y1="6.5" y2="6.5" />
    </svg>
  );
}
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import { format } from "date-fns";
import type { Contact } from "@/types";

interface InstagramProfileCardProps {
  contact: Contact & {
    instagram_username?: string | null;
    instagram_url?: string | null;
    profile_image_url?: string | null;
    profile_image_source?: string | null;
    profile_image_updated_at?: string | null;
    instagram_resolve_status?: string | null;
    instagram_last_error?: string | null;
    instagram_attempt_count?: number | null;
    instagram_last_attempt_at?: string | null;
  };
  onContactUpdated?: (updated: any) => void;
}

export function InstagramProfileCard({
  contact,
  onContactUpdated,
}: InstagramProfileCardProps) {
  const [loading, setLoading] = useState(false);
  const [editingUsername, setEditingUsername] = useState(false);
  const [usernameInput, setUsernameInput] = useState(
    contact.instagram_username || ""
  );
  const [isSendingTemplate, setIsSendingTemplate] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleSendTemplate = async () => {
    const handle = (contact.instagram_username || usernameInput || "").trim().replace(/^@+/, "");
    if (!handle) {
      toast.error("Informe o @ do Instagram antes de gerar.");
      return;
    }
    setIsSendingTemplate(true);
    try {
      const res = await fetch(`/api/contacts/${contact.id}/follower-order`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          username: handle,
          quantity: 5000,
        }),
      });
      const data = await res.json();
      if (!res.ok || data.error) {
        throw new Error(data.error || "Falha ao gerar e enviar confirmação.");
      }
      toast.success(data.message || "✅ Confirmação gerada e enviada ao WhatsApp!");
      if (data.profile_image_url && onContactUpdated) {
        onContactUpdated({
          ...contact,
          profile_image_url: data.profile_image_url,
          instagram_resolve_status: "IMAGE_AVAILABLE",
        });
      }
    } catch (err: any) {
      toast.error(err.message || "Erro ao gerar confirmação.");
    } finally {
      setIsSendingTemplate(false);
    }
  };

  const status = contact.instagram_resolve_status || "NOT_REQUESTED";
  const profileImage = contact.profile_image_url || null;
  const source = contact.profile_image_source || "INSTAGRAM_PROVIDER";
  const updatedAt = contact.profile_image_updated_at;
  const username = contact.instagram_username;
  const profileUrl =
    contact.instagram_url ||
    (username ? `https://www.instagram.com/${username}/` : null);

  const handleResolve = useCallback(
    async (force = true) => {
      setLoading(true);
      try {
        const res = await fetch(`/api/contacts/${contact.id}/instagram`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "resolve", forceRefresh: force }),
        });
        const data = await res.json();
        if (!res.ok) {
          throw new Error(data.error || "Falha ao resolver perfil.");
        }
        toast.success(
          data.result?.profileImageUrl
            ? "Foto do perfil atualizada com sucesso!"
            : "Perfil consultado com sucesso."
        );
        onContactUpdated?.({
          ...contact,
          instagram_username: data.result.instagramUsername,
          instagram_url: data.result.instagramUrl,
          profile_image_url: data.result.profileImageUrl,
          profile_image_source: data.result.profileImageSource,
          instagram_resolve_status: data.result.resolveStatus,
          profile_image_updated_at: data.result.updatedAt,
        });
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Erro na resolução.");
      } finally {
        setLoading(false);
      }
    },
    [contact, onContactUpdated]
  );

  const handleSaveUsername = useCallback(async () => {
    const trimmed = usernameInput.trim().replace(/^@/, "");
    setLoading(true);
    try {
      const res = await fetch(`/api/contacts/${contact.id}/instagram`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "resolve",
          username: trimmed || null,
          forceRefresh: true,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || "Falha ao atualizar Instagram.");
      }
      setEditingUsername(false);
      toast.success("Instagram atualizado!");
      onContactUpdated?.({
        ...contact,
        instagram_username: data.result.instagramUsername,
        instagram_url: data.result.instagramUrl,
        profile_image_url: data.result.profileImageUrl,
        profile_image_source: data.result.profileImageSource,
        instagram_resolve_status: data.result.resolveStatus,
        profile_image_updated_at: data.result.updatedAt,
      });
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Erro ao salvar Instagram."
      );
    } finally {
      setLoading(false);
    }
  }, [contact, usernameInput, onContactUpdated]);

  const handleUploadPhoto = useCallback(
    async (file: File) => {
      setLoading(true);
      const toastId = toast.loading("Salvando foto manual...");
      try {
        const formData = new FormData();
        formData.append("action", "set_manual_photo");
        formData.append("file", file);

        const res = await fetch(`/api/contacts/${contact.id}/instagram`, {
          method: "POST",
          body: formData,
        });
        const data = await res.json();
        if (!res.ok) {
          throw new Error(data.error || "Erro ao salvar foto.");
        }
        toast.success("Foto manual configurada com sucesso!", { id: toastId });
        onContactUpdated?.({
          ...contact,
          profile_image_url: data.result.profileImageUrl,
          profile_image_source: "MANUAL",
          instagram_resolve_status: "IMAGE_AVAILABLE",
          profile_image_updated_at: data.result.updatedAt,
        });
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Falha no upload.", {
          id: toastId,
        });
      } finally {
        setLoading(false);
      }
    },
    [contact, onContactUpdated]
  );

  const handleRemovePhoto = useCallback(async () => {
    if (!window.confirm("Deseja remover a foto deste perfil?")) return;
    setLoading(true);
    try {
      const res = await fetch(`/api/contacts/${contact.id}/instagram`, {
        method: "DELETE",
      });
      if (!res.ok) throw new Error("Erro ao remover foto.");
      toast.success("Foto removida.");
      onContactUpdated?.({
        ...contact,
        profile_image_url: null,
        profile_image_source: "INSTAGRAM_PROVIDER",
        instagram_resolve_status: "MANUAL_REQUIRED",
      });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Falha ao remover.");
    } finally {
      setLoading(false);
    }
  }, [contact, onContactUpdated]);

  return (
    <div className="rounded-xl border border-border bg-card p-3 shadow-xs">
      {/* Header */}
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 text-xs font-semibold text-foreground">
          <div className="flex h-5 w-5 items-center justify-center rounded-md bg-gradient-to-tr from-amber-500 via-pink-500 to-purple-600 text-white shadow-xs">
            <InstagramIcon className="h-3 w-3" />
          </div>
          <span>Instagram</span>
        </div>

        {/* Status Badge */}
        {status === "IMAGE_AVAILABLE" && (
          <Badge
            variant="outline"
            className="border-emerald-500/30 bg-emerald-500/10 text-[10px] text-emerald-600 dark:text-emerald-400 gap-1 px-1.5 py-0"
          >
            <CheckCircle2 className="h-2.5 w-2.5" />
            Foto Encontrada
          </Badge>
        )}
        {(status === "IMAGE_UNAVAILABLE" || status === "MANUAL_REQUIRED") && (
          <Badge
            variant="outline"
            className="border-amber-500/30 bg-amber-500/10 text-[10px] text-amber-600 dark:text-amber-400 gap-1 px-1.5 py-0"
          >
            <AlertCircle className="h-2.5 w-2.5" />
            Sem Foto
          </Badge>
        )}
        {status === "FAILED" && (
          <Badge
            variant="outline"
            className="border-destructive/30 bg-destructive/10 text-[10px] text-destructive gap-1 px-1.5 py-0"
          >
            <AlertCircle className="h-2.5 w-2.5" />
            Falha
          </Badge>
        )}
      </div>

      {/* Username row */}
      <div className="mt-2.5">
        {editingUsername ? (
          <div className="flex items-center gap-1">
            <span className="text-xs text-muted-foreground font-mono">@</span>
            <input
              type="text"
              value={usernameInput}
              onChange={(e) => setUsernameInput(e.target.value)}
              placeholder="usuario"
              autoFocus
              className="flex-1 rounded border border-primary/50 bg-background px-2 py-0.5 text-xs font-medium outline-none"
              onKeyDown={(e) => {
                if (e.key === "Enter") handleSaveUsername();
                if (e.key === "Escape") setEditingUsername(false);
              }}
            />
            <Button
              size="sm"
              variant="ghost"
              className="h-6 w-6 p-0 text-emerald-600 hover:bg-emerald-50"
              onClick={handleSaveUsername}
              disabled={loading}
            >
              <Check className="h-3 w-3" />
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="h-6 w-6 p-0 text-muted-foreground"
              onClick={() => setEditingUsername(false)}
            >
              <X className="h-3 w-3" />
            </Button>
          </div>
        ) : (
          <div className="flex items-center justify-between">
            {username ? (
              <a
                href={profileUrl || `https://instagram.com/${username}`}
                target="_blank"
                rel="noreferrer"
                className="group flex items-center gap-1 text-xs font-semibold text-primary hover:underline"
              >
                <span>@{username}</span>
                <ExternalLink className="h-2.5 w-2.5 opacity-60 group-hover:opacity-100" />
              </a>
            ) : (
              <span className="text-xs text-muted-foreground italic">
                Nenhum Instagram informado
              </span>
            )}
            <Button
              size="sm"
              variant="ghost"
              className="h-6 px-1.5 text-[11px] text-muted-foreground hover:text-foreground"
              onClick={() => {
                setUsernameInput(username || "");
                setEditingUsername(true);
              }}
              title="Editar Instagram"
            >
              <Pencil className="h-2.5 w-2.5 mr-1" />
              {username ? "Alterar" : "Adicionar"}
            </Button>
          </div>
        )}
      </div>

      {/* Photo Preview & Metadata */}
      {profileImage && (
        <div className="mt-3 flex items-center gap-3 rounded-lg bg-muted/50 p-2 border border-border/50">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={profileImage}
            alt={username || "Instagram Avatar"}
            className="h-12 w-12 rounded-full object-cover border border-border shrink-0 shadow-xs"
          />
          <div className="min-w-0 flex-1 text-[11px]">
            <div className="flex items-center gap-1.5">
              <span className="text-muted-foreground">Origem:</span>
              <span className="font-medium text-foreground">
                {source === "MANUAL" ? "Manual" : "Instagram Provider"}
              </span>
            </div>
            {updatedAt && (
              <div className="text-[10px] text-muted-foreground">
                Atualizado: {format(new Date(updatedAt), "dd/MM HH:mm")}
              </div>
            )}
          </div>
          <Button
            size="sm"
            variant="ghost"
            onClick={handleRemovePhoto}
            disabled={loading}
            className="h-7 w-7 p-0 text-muted-foreground hover:text-destructive hover:bg-destructive/10"
            title="Remover Foto"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        </div>
      )}

      {/* Error display if any */}
      {contact.instagram_last_error && status === "FAILED" && (
        <div className="mt-2 rounded-md bg-destructive/10 p-2 text-[11px] text-destructive">
          {contact.instagram_last_error}
        </div>
      )}

      {/* Action Buttons */}
      <div className="mt-3 space-y-1.5">
        <Button
          size="sm"
          onClick={handleSendTemplate}
          disabled={isSendingTemplate || loading || !username}
          className="w-full h-8 text-xs font-semibold gap-1.5 bg-primary hover:bg-primary/90 text-primary-foreground shadow-xs"
        >
          {isSendingTemplate ? (
            <>
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              <span>Gerando e Enviando Arte...</span>
            </>
          ) : (
            <>
              <Send className="h-3.5 w-3.5" />
              <span>Gerar e Enviar Confirmação</span>
            </>
          )}
        </Button>

        <div className="flex items-center gap-1.5">
          <Button
            size="sm"
            variant="outline"
            onClick={() => handleResolve(true)}
            disabled={loading || isSendingTemplate || !username}
            className="h-7 flex-1 text-[11px] gap-1 px-2"
            title="Consultar novamente o Instagram Provider"
          >
            {loading ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <RefreshCw className="h-3 w-3" />
            )}
            <span>Atualizar Foto</span>
          </Button>

          <Button
            size="sm"
            variant="outline"
            onClick={() => fileInputRef.current?.click()}
            disabled={loading || isSendingTemplate}
            className="h-7 flex-1 text-[11px] gap-1 px-2 text-muted-foreground hover:text-foreground"
            title="Fazer upload de foto do computador"
          >
            <Upload className="h-3 w-3" />
            <span>Upload Manual</span>
          </Button>

          <input
            ref={fileInputRef}
            type="file"
            accept="image/png,image/jpeg,image/webp"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void handleUploadPhoto(file);
              e.target.value = "";
            }}
          />
        </div>
      </div>
    </div>
  );
}
