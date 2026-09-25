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
  Send,
  Camera,
  Hash,
  Clock,
  Database,
  Layers,
  Sparkles,
  Info,
  ShieldCheck,
  AlertTriangle,
} from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import { format } from "date-fns";
import { ptBR } from "date-fns/locale";
import type { Contact } from "@/types";
import { getInstagramDiagnosticInfo } from "@/lib/instagram-resolver/types";

export function InstagramBrandIcon({ className = "h-4 w-4" }: { className?: string }) {
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

interface InstagramDiagnosticModalProps {
  contact: Contact & {
    instagram_username?: string | null;
    instagram_url?: string | null;
    profile_image_url?: string | null;
    profile_image_source?: string | null;
    profile_image_updated_at?: string | null;
    profile_image_hash?: string | null;
    instagram_resolve_status?: string | null;
    instagram_last_error?: string | null;
    instagram_attempt_count?: number | null;
    instagram_last_attempt_at?: string | null;
  };
  onContactUpdated?: (updated: any) => void;
  triggerButton?: React.ReactNode;
}

export function InstagramDiagnosticModal({
  contact,
  onContactUpdated,
  triggerButton,
}: InstagramDiagnosticModalProps) {
  const [open, setOpen] = useState(false);
  const [isResolving, setIsResolving] = useState(false);
  const [isSendingOrder, setIsSendingOrder] = useState(false);
  const [orderQuantity, setOrderQuantity] = useState("5000");
  const [editingUsername, setEditingUsername] = useState(false);
  const [usernameInput, setUsernameInput] = useState(contact.instagram_username || "");
  const fileInputRef = useRef<HTMLInputElement>(null);

  const diag = getInstagramDiagnosticInfo(contact);
  const username = contact.instagram_username || "";
  const profileUrl =
    contact.instagram_url ||
    (username ? `https://www.instagram.com/${username.replace(/^@+/, "")}/` : null);

  // 1. Resolve Profile from Instagram
  const handleResolve = useCallback(
    async (force = true) => {
      setIsResolving(true);
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
            ? "Foto do Instagram obtida com sucesso!"
            : "Perfil consultado com sucesso."
        );
        onContactUpdated?.({
          ...contact,
          instagram_username: data.result?.instagramUsername || contact.instagram_username,
          instagram_url: data.result?.instagramUrl || contact.instagram_url,
          profile_image_url: data.result?.profileImageUrl,
          profile_image_source: data.result?.profileImageSource,
          instagram_resolve_status: data.result?.resolveStatus,
          profile_image_hash: data.result?.hash,
          profile_image_updated_at: data.result?.updatedAt,
          instagram_last_error: null,
        });
      } catch (err: any) {
        toast.error(err.message || "Erro ao consultar perfil.");
        onContactUpdated?.({
          ...contact,
          instagram_resolve_status: "FAILED",
          instagram_last_error: err.message,
        });
      } finally {
        setIsResolving(false);
      }
    },
    [contact, onContactUpdated]
  );

  // 2. Save new Instagram handle
  const handleSaveUsername = async () => {
    const clean = usernameInput.trim().replace(/^@+/, "");
    if (!clean) return;
    setIsResolving(true);
    try {
      const res = await fetch(`/api/contacts/${contact.id}/instagram`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: clean, action: "resolve", forceRefresh: true }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Falha ao atualizar @.");
      toast.success(`Instagram @${clean} salvo com sucesso!`);
      setEditingUsername(false);
      onContactUpdated?.({
        ...contact,
        instagram_username: clean,
        instagram_url: `https://www.instagram.com/${clean}/`,
        profile_image_url: data.result?.profileImageUrl,
        instagram_resolve_status: data.result?.resolveStatus,
      });
    } catch (err: any) {
      toast.error(err.message);
    } finally {
      setIsResolving(false);
    }
  };

  // 3. Manual Send Confirmation (Executes exact same backend pipeline)
  const handleSendConfirmation = async () => {
    if (!contact.phone) {
      toast.error("Contato não possui telefone WhatsApp cadastrado.");
      return;
    }
    if (!username) {
      toast.error("Informe o @ de Instagram antes de enviar.");
      return;
    }

    setIsSendingOrder(true);
    try {
      const res = await fetch(`/api/contacts/${contact.id}/instagram/send-confirmation`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          quantity: parseInt(orderQuantity, 10) || 5000,
          username,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || "Falha ao enviar confirmação.");
      }

      toast.success(
        data.delivery_success
          ? `✅ Pedido #${data.order_code} gerado e enviado ao WhatsApp!`
          : `Arte #${data.order_code} gerada com sucesso!`
      );
      setOpen(false);
    } catch (err: any) {
      toast.error(err.message || "Erro ao processar envio de confirmação.");
    } finally {
      setIsSendingOrder(false);
    }
  };

  // 4. Upload manual photo
  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setIsResolving(true);
    try {
      const formData = new FormData();
      formData.append("file", file);
      formData.append("action", "set_manual_photo");
      const res = await fetch(`/api/contacts/${contact.id}/instagram`, {
        method: "POST",
        body: formData,
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Falha ao enviar imagem.");
      toast.success("Foto do Instagram definida manualmente!");
      onContactUpdated?.({
        ...contact,
        profile_image_url: data.result?.profileImageUrl,
        profile_image_source: "MANUAL",
        instagram_resolve_status: "IMAGE_AVAILABLE",
      });
    } catch (err: any) {
      toast.error(err.message);
    } finally {
      setIsResolving(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  // 5. Remove photo
  const handleRemovePhoto = async () => {
    setIsResolving(true);
    try {
      const res = await fetch(`/api/contacts/${contact.id}/instagram`, {
        method: "DELETE",
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Falha ao remover imagem.");
      toast.success("Foto do Instagram removida.");
      onContactUpdated?.({
        ...contact,
        profile_image_url: null,
        instagram_resolve_status: "IMAGE_UNAVAILABLE",
      });
    } catch (err: any) {
      toast.error(err.message);
    } finally {
      setIsResolving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger
        render={
          (triggerButton as any) || (
            <Button
              variant="outline"
              size="sm"
              className="group relative flex w-full items-center justify-between overflow-hidden border-border/80 bg-linear-to-r from-pink-500/10 via-purple-500/10 to-amber-500/10 px-3 py-2 text-xs font-semibold transition-all hover:border-pink-500/40 hover:bg-linear-to-r hover:from-pink-500/20 hover:via-purple-500/20 hover:to-amber-500/20"
            />
          )
        }
      >
        <div className="flex items-center gap-2">
          <span className="flex h-5 w-5 items-center justify-center rounded-md bg-linear-to-tr from-amber-500 via-rose-500 to-purple-600 text-white shadow-xs">
            <InstagramBrandIcon className="h-3 w-3" />
          </span>
          <div className="flex flex-col text-left">
            <span className="text-[11px] font-bold text-foreground">Instagram</span>
            <span className="text-[10px] text-muted-foreground">
              {username ? `@${username.replace(/^@+/, "")}` : "Configurar perfil"}
            </span>
          </div>
        </div>

        <Badge
          variant={diag.badgeVariant === "success" ? "default" : diag.badgeVariant}
          className={`text-[9px] font-semibold uppercase px-1.5 py-0.2 ${
            diag.badgeVariant === "success"
              ? "bg-emerald-500/15 text-emerald-600 border-emerald-500/30"
              : diag.badgeVariant === "destructive"
              ? "bg-rose-500/15 text-rose-600 border-rose-500/30"
              : ""
          }`}
        >
          {diag.badgeLabel}
        </Badge>
      </DialogTrigger>

      <DialogContent className="sm:max-w-md border-border bg-card p-5 text-card-foreground shadow-2xl">
        <DialogHeader className="pb-3 border-b border-border">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2.5">
              <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-linear-to-tr from-amber-500 via-rose-500 to-purple-600 text-white shadow-md">
                <InstagramBrandIcon className="h-4 w-4" />
              </span>
              <div>
                <DialogTitle className="text-base font-bold flex items-center gap-1.5">
                  Diagnóstico do Instagram
                </DialogTitle>
                <p className="text-xs text-muted-foreground">
                  Foto e metadados dedicados exclusivamente ao Creative Engine
                </p>
              </div>
            </div>
            <Badge
              variant={diag.badgeVariant === "success" ? "default" : diag.badgeVariant}
              className={`text-[10px] font-bold ${
                diag.badgeVariant === "success"
                  ? "bg-emerald-500/15 text-emerald-600 border-emerald-500/30"
                  : diag.badgeVariant === "destructive"
                  ? "bg-rose-500/15 text-rose-600 border-rose-500/30"
                  : ""
              }`}
            >
              {diag.badgeLabel}
            </Badge>
          </div>
        </DialogHeader>

        {/* Profile Card & Photo Section */}
        <div className="mt-4 flex items-center gap-4 rounded-xl border border-border/80 bg-muted/40 p-3.5">
          <div className="relative h-16 w-16 shrink-0 overflow-hidden rounded-full border-2 border-primary/40 bg-slate-900 shadow-inner">
            {contact.profile_image_url ? (
              <img
                src={contact.profile_image_url}
                alt={username || "Instagram"}
                className="h-full w-full object-cover"
                onError={(e) => {
                  (e.target as HTMLElement).style.display = "none";
                }}
              />
            ) : (
              <div className="flex h-full w-full flex-col items-center justify-center text-slate-400">
                <InstagramBrandIcon className="h-6 w-6 opacity-60" />
              </div>
            )}
            <div className="absolute inset-0 ring-1 ring-black/10 rounded-full" />
          </div>

          <div className="flex-1 min-w-0">
            {editingUsername ? (
              <div className="flex items-center gap-1.5">
                <span className="text-xs font-bold text-muted-foreground">@</span>
                <input
                  type="text"
                  value={usernameInput}
                  onChange={(e) => setUsernameInput(e.target.value)}
                  placeholder="usuario_insta"
                  className="flex-1 rounded-md border border-primary/50 bg-background px-2 py-1 text-xs text-foreground outline-none"
                  autoFocus
                  onKeyDown={(e) => {
                    if (e.key === "Enter") handleSaveUsername();
                    if (e.key === "Escape") setEditingUsername(false);
                  }}
                />
                <Button
                  size="sm"
                  className="h-7 px-2 text-xs"
                  onClick={handleSaveUsername}
                  disabled={isResolving}
                >
                  Salvar
                </Button>
              </div>
            ) : (
              <div>
                <div className="flex items-center gap-2">
                  <h4 className="text-sm font-bold text-foreground truncate">
                    {username ? `@${username.replace(/^@+/, "")}` : "Sem perfil informado"}
                  </h4>
                  <button
                    onClick={() => {
                      setUsernameInput(username);
                      setEditingUsername(true);
                    }}
                    className="text-[10px] text-primary hover:underline"
                  >
                    Editar
                  </button>
                </div>

                {profileUrl ? (
                  <a
                    href={profileUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="mt-0.5 inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-primary transition-colors truncate"
                  >
                    <span className="truncate">{profileUrl.replace(/^https?:\/\//, "")}</span>
                    <ExternalLink className="h-2.5 w-2.5 shrink-0" />
                  </a>
                ) : (
                  <p className="text-xs text-muted-foreground">Informe o usuário do cliente</p>
                )}
              </div>
            )}

            <div className="mt-2 flex items-center gap-1.5 text-[11px] text-muted-foreground">
              <ShieldCheck className="h-3 w-3 text-emerald-500" />
              <span>Foto WhatsApp mantida intacta</span>
            </div>
          </div>
        </div>

        {/* Diagnostic Status Box */}
        {diag.state !== "IMAGE_AVAILABLE" && (
          <div
            className={`rounded-xl border p-3.5 text-xs ${
              diag.state === "INSTAGRAM_HTTP_429" || diag.state === "INSTAGRAM_BLOCKED"
                ? "border-amber-500/40 bg-amber-500/10 text-amber-900 dark:text-amber-200"
                : diag.state === "IMAGE_DOWNLOAD_FAILED" || diag.state === "INSTAGRAM_PROFILE_NOT_FOUND"
                ? "border-rose-500/40 bg-rose-500/10 text-rose-900 dark:text-rose-200"
                : "border-border bg-muted/30 text-foreground"
            }`}
          >
            <div className="flex items-start gap-2">
              <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
              <div className="flex-1">
                <p className="font-bold text-xs">{diag.title}</p>
                <p className="mt-1 text-[11px] leading-relaxed opacity-90">{diag.description}</p>
                {diag.technicalError && (
                  <div className="mt-2 rounded-md bg-black/20 px-2 py-1 font-mono text-[10px] text-foreground/80 break-all">
                    Código Técnico: {diag.technicalError}
                  </div>
                )}
              </div>
            </div>
          </div>
        )}

        {/* Detailed Diagnostics Table */}
        <div className="rounded-xl border border-border bg-muted/20 p-3 space-y-2 text-xs">
          <div className="flex items-center justify-between py-0.5 border-b border-border/50">
            <span className="flex items-center gap-1.5 text-muted-foreground">
              <Info className="h-3 w-3" /> Status do Perfil
            </span>
            <span className="font-semibold text-foreground">
              {username ? "Identificado" : "Pendente"}
            </span>
          </div>

          <div className="flex items-center justify-between py-0.5 border-b border-border/50">
            <span className="flex items-center gap-1.5 text-muted-foreground">
              <Layers className="h-3 w-3" /> Foto Instagram
            </span>
            <span className="font-semibold text-foreground">
              {contact.profile_image_url ? "✓ Disponível" : "⚠ Não disponível"}
            </span>
          </div>

          <div className="flex items-center justify-between py-0.5 border-b border-border/50">
            <span className="flex items-center gap-1.5 text-muted-foreground">
              <Database className="h-3 w-3" /> Armazenamento (Storage)
            </span>
            <span className="font-semibold text-foreground">
              {contact.profile_image_url ? "✓ Salvo no Supabase" : "Pendente"}
            </span>
          </div>

          <div className="flex items-center justify-between py-0.5 border-b border-border/50">
            <span className="flex items-center gap-1.5 text-muted-foreground">
              <Clock className="h-3 w-3" /> Última Atualização
            </span>
            <span className="font-mono text-[11px] text-foreground">
              {contact.profile_image_updated_at
                ? format(new Date(contact.profile_image_updated_at), "dd/MM/yyyy HH:mm:ss", {
                    locale: ptBR,
                  })
                : "Nunca"}
            </span>
          </div>

          {contact.profile_image_hash && (
            <div className="flex items-center justify-between py-0.5">
              <span className="flex items-center gap-1.5 text-muted-foreground">
                <Hash className="h-3 w-3" /> Hash SHA-256
              </span>
              <span className="font-mono text-[10px] text-muted-foreground">
                {contact.profile_image_hash.slice(0, 16)}...
              </span>
            </div>
          )}
        </div>

        {/* Action: Enviar Confirmação de Pedido */}
        <div className="rounded-xl border border-primary/30 bg-primary/5 p-3.5 space-y-3">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-xs font-bold text-foreground flex items-center gap-1.5">
                <Sparkles className="h-3.5 w-3.5 text-primary" />
                Disparar Template de Confirmação
              </p>
              <p className="text-[11px] text-muted-foreground">
                Executa o mesmo pipeline real: valida perfil, gera imagem 960x960 e entrega via WhatsApp.
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <div className="w-36">
              <label className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">
                Seguidores
              </label>
              <select
                value={orderQuantity}
                onChange={(e) => setOrderQuantity(e.target.value)}
                className="w-full rounded-md border border-border bg-background px-2 py-1.5 text-xs text-foreground outline-none font-medium"
              >
                <option value="500">500 seguidores</option>
                <option value="1000">1.000 seguidores</option>
                <option value="2000">2.000 seguidores</option>
                <option value="5000">5.000 seguidores</option>
                <option value="10000">10.000 seguidores</option>
                <option value="20000">20.000 seguidores</option>
                <option value="30000">30.000 seguidores</option>
                <option value="50000">50.000 seguidores</option>
                <option value="100000">100.000 seguidores</option>
              </select>
            </div>

            <Button
              className="flex-1 mt-3.5 h-8 gap-1.5 bg-primary text-primary-foreground font-bold hover:bg-primary/90 shadow-sm"
              onClick={handleSendConfirmation}
              disabled={isSendingOrder || !username || !contact.phone}
            >
              {isSendingOrder ? (
                <>
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  <span>Gerando & Enviando Arte...</span>
                </>
              ) : (
                <>
                  <Send className="h-3.5 w-3.5" />
                  <span>⚡ Gerar e Enviar Confirmação</span>
                </>
              )}
            </Button>
          </div>
        </div>

        {/* Secondary Maintenance Tools */}
        <div className="flex items-center justify-between gap-2 pt-2 border-t border-border">
          <Button
            variant="outline"
            size="sm"
            className="h-8 gap-1 text-xs"
            onClick={() => handleResolve(true)}
            disabled={isResolving || !username}
          >
            {isResolving ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <RefreshCw className="h-3 w-3" />
            )}
            <span>Buscar no Instagram</span>
          </Button>

          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={handleFileUpload}
          />

          <Button
            variant="ghost"
            size="sm"
            className="h-8 gap-1 text-xs text-muted-foreground hover:text-foreground border border-dashed border-border"
            onClick={() => fileInputRef.current?.click()}
            disabled={isResolving}
            title="Importar imagem do seu computador (caso o Instagram não tenha foto)"
          >
            <Upload className="h-3 w-3" />
            <span>Arquivo do PC</span>
          </Button>

          {contact.profile_image_url && (
            <Button
              variant="ghost"
              size="sm"
              className="h-8 gap-1 text-xs text-rose-500 hover:bg-rose-500/10 hover:text-rose-600"
              onClick={handleRemovePhoto}
              disabled={isResolving}
            >
              <Trash2 className="h-3 w-3" />
              <span>Remover Foto</span>
            </Button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
