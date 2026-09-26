"use client";

import React, { useState, useEffect, useCallback, useRef } from "react";
import type { Contact } from "@/types";
import { createClient } from "@/lib/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  CheckCircle2,
  Clock,
  AlertCircle,
  Send,
  RotateCw,
  Sparkles,
  ExternalLink,
  Eye,
  Loader2,
  RefreshCw,
  Camera,
  SlidersHorizontal,
  Layers,
} from "lucide-react";
import { Input } from "@/components/ui/input";
import { toast } from "sonner";

interface FollowerOrderCardProps {
  contact: Contact | null;
  onContactUpdated?: (updated: Contact) => void;
}

interface OrderData {
  has_order: boolean;
  templates?: Array<{
    id: string;
    name: string;
    category?: string;
    status?: string;
  }>;
  job?: {
    id: string;
    order_code: string;
    username: string;
    quantity: number | string;
    template_id?: string;
    platform?: "instagram" | "tiktok";
    status: string;
    output_url: string | null;
    error: string | null;
    created_at: string;
    completed_at?: string;
    sent_at?: string;
  };
  deliveries?: Array<{
    id: string;
    provider_message_id: string | null;
    status: string;
    error: string | null;
    created_at: string;
    sent_at: string | null;
  }>;
  is_sent?: boolean;
  last_delivery?: {
    id: string;
    provider_message_id: string | null;
    status: string;
    error: string | null;
    created_at: string;
    sent_at: string | null;
  } | null;
  contact?: {
    id: string;
    name: string | null;
    phone: string | null;
    instagram_username: string | null;
    profile_image_url: string | null;
    instagram_resolve_status: string | null;
    instagram_last_error?: string | null;
  };
  steps?: {
    order_received: boolean;
    instagram_identified: boolean;
    instagram_photo_obtained: boolean;
    creative_generated: boolean;
    delivery_status: "IDLE" | "SENDING" | "SENT" | "FAILED";
    delivery_error: string | null;
  };
}

export function FollowerOrderCard({ contact, onContactUpdated }: FollowerOrderCardProps) {
  const { accountId } = useAuth();
  const [data, setData] = useState<OrderData | null>(null);
  const [loading, setLoading] = useState(false);
  const [sending, setSending] = useState(false);
  const [resendConfirmOpen, setResendConfirmOpen] = useState(false);
  const [lightboxOpen, setLightboxOpen] = useState(false);
  const activeChannelRef = useRef<any>(null);

  // Customization state for resend / editing
  const [customUsername, setCustomUsername] = useState("");
  const [customQuantity, setCustomQuantity] = useState(5000);
  const [isVerified, setIsVerified] = useState(false);
  const [customTemplateId, setCustomTemplateId] = useState("");
  const [customPlatform, setCustomPlatform] = useState<"instagram" | "tiktok">("instagram");
  const [forceRegenerate, setForceRegenerate] = useState(false);

  const fetchOrderData = useCallback(async (silent = false) => {
    if (!contact?.id) return;
    if (!silent) setLoading(true);

    try {
      const res = await fetch(`/api/contacts/${contact.id}/follower-order`);
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      const json: OrderData = await res.json();
      setData(json);
    } catch (err) {
      console.warn("[FollowerOrderCard] Error fetching order data:", err);
    } finally {
      if (!silent) setLoading(false);
    }
  }, [contact?.id]);

  // Initial fetch on contact change
  useEffect(() => {
    if (contact?.id) {
      fetchOrderData();
    } else {
      setData(null);
    }
  }, [contact?.id, fetchOrderData]);

  // Sync state with fetched data
  useEffect(() => {
    if (data?.job) {
      const jobIsVerif = Boolean(
        (data.job as any).is_verified ||
        String(data.job.quantity).toUpperCase().includes("VERIFICAD")
      );
      setCustomUsername(data.job.username || data.contact?.instagram_username || "");
      setCustomQuantity(jobIsVerif ? 1 : (Number(data.job.quantity) || 5000));
      setIsVerified(jobIsVerif);
      setCustomTemplateId(data.job.template_id || data.templates?.[0]?.id || "");
      setCustomPlatform((data.job.platform as any) || "instagram");
    } else if (data?.contact) {
      setCustomUsername(data.contact.instagram_username || "");
      setCustomQuantity(5000);
      setIsVerified(false);
      setCustomTemplateId(data.templates?.[0]?.id || "");
      setCustomPlatform("instagram");
    }
  }, [data]);

  const fetchOrderDataRef = useRef(fetchOrderData);
  fetchOrderDataRef.current = fetchOrderData;

  const onContactUpdatedRef = useRef(onContactUpdated);
  onContactUpdatedRef.current = onContactUpdated;

  // Real-time listener on creative_jobs and creative_deliveries
  useEffect(() => {
    if (!contact?.id || !accountId) return;

    const supabase = createClient();
    const channelName = `follower_order_${contact.id}`;

    const channel = supabase
      .channel(channelName)
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "creative_jobs",
          filter: `account_id=eq.${accountId}`,
        },
        () => {
          fetchOrderDataRef.current?.(true);
        }
      )
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "creative_deliveries",
          filter: `account_id=eq.${accountId}`,
        },
        () => {
          fetchOrderDataRef.current?.(true);
        }
      )
      .on(
        "postgres_changes",
        {
          event: "UPDATE",
          schema: "public",
          table: "contacts",
          filter: `id=eq.${contact.id}`,
        },
        (payload) => {
          if (payload.new && onContactUpdatedRef.current) {
            onContactUpdatedRef.current(payload.new as Contact);
          }
          fetchOrderDataRef.current?.(true);
        }
      )
      .subscribe();

    activeChannelRef.current = channel;

    return () => {
      if (channel) {
        supabase.removeChannel(channel);
      }
    };
  }, [contact?.id, accountId]);

  const job = data?.job;
  const isSent = Boolean(data?.is_sent || job?.status === "SENT");
  const isSending = job?.status === "SENDING";
  const isProcessing = job?.status === "PROCESSING";
  const isFailed = job?.status === "FAILED";
  const hasImage = Boolean(job?.output_url);
  const deliveryError = data?.steps?.delivery_error || job?.error;

  const currentIsVerified = Boolean(
    (job as any)?.is_verified ||
    String(job?.quantity).toUpperCase().includes("VERIFICAD")
  );

  const isModified = Boolean(
    (customUsername.trim().replace(/^@+/, "").toLowerCase() !==
      (job?.username || "").trim().replace(/^@+/, "").toLowerCase()) ||
    (isVerified !== currentIsVerified) ||
    (!isVerified && Number(customQuantity) !== Number(job?.quantity || 5000)) ||
    (customTemplateId && job?.template_id && customTemplateId !== job?.template_id) ||
    (customPlatform !== (job?.platform || "instagram")) ||
    forceRegenerate
  );

  const handleSend = async (options?: {
    forceResend?: boolean;
    useCustomParams?: boolean;
  }) => {
    if (!contact?.id) return;
    setSending(true);

    const forceResend = options?.forceResend ?? false;
    const useCustomParams = options?.useCustomParams ?? false;

    const payload: Record<string, any> = {
      job_id: data?.job?.id,
      force_resend: forceResend,
    };

    if (useCustomParams) {
      payload.username = customUsername.trim().replace(/^@+/, "");
      payload.quantity = isVerified ? "VERIFICADO" : Number(customQuantity);
      payload.is_verified = isVerified;
      payload.template_id = customTemplateId || undefined;
      payload.platform = customPlatform;
      payload.regenerate = isModified || forceRegenerate;
    }

    try {
      const res = await fetch(`/api/contacts/${contact.id}/follower-order`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      const result = await res.json();

      if (result.already_sent && !forceResend) {
        setResendConfirmOpen(true);
        return;
      }

      if (!res.ok || result.error) {
        toast.error(result.error || "Falha no envio da confirmação pelo WhatsApp.");
        fetchOrderData(true);
        return;
      }

      toast.success(result.message || "Confirmação enviada com sucesso!");
      setResendConfirmOpen(false);
      setForceRegenerate(false);
      fetchOrderData(true);
    } catch (err) {
      console.error("[FollowerOrderCard] Send error:", err);
      toast.error("Erro ao comunicar com o servidor para envio.");
    } finally {
      setSending(false);
    }
  };

  // If no order exists and contact has no @instagram, don't show card
  if (!loading && (!data || !data.has_order || !data.job)) {
    return null;
  }

  return (
    <>
      <div className="rounded-xl border border-border bg-card p-3.5 shadow-sm space-y-3">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-1.5">
            <Sparkles className="h-4 w-4 text-primary" />
            <span className="text-xs font-bold uppercase tracking-wider text-foreground">
              Confirmação do Pedido
            </span>
          </div>

          {/* Status Badge */}
          {isSent ? (
            <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/10 px-2 py-0.5 text-[11px] font-semibold text-emerald-600 dark:text-emerald-400">
              <CheckCircle2 className="h-3 w-3" />
              Enviado
            </span>
          ) : isSending ? (
            <span className="inline-flex items-center gap-1 rounded-full bg-amber-500/10 px-2 py-0.5 text-[11px] font-semibold text-amber-600 dark:text-amber-400">
              <Clock className="h-3 w-3 animate-pulse" />
              Enviando...
            </span>
          ) : isProcessing ? (
            <span className="inline-flex items-center gap-1 rounded-full bg-indigo-500/10 px-2 py-0.5 text-[11px] font-semibold text-indigo-600 dark:text-indigo-400">
              <Loader2 className="h-3 w-3 animate-spin" />
              Gerando arte
            </span>
          ) : isFailed ? (
            <span className="inline-flex items-center gap-1 rounded-full bg-rose-500/10 px-2 py-0.5 text-[11px] font-semibold text-rose-600 dark:text-rose-400">
              <AlertCircle className="h-3 w-3" />
              Falhou
            </span>
          ) : hasImage ? (
            <span className="inline-flex items-center gap-1 rounded-full bg-sky-500/10 px-2 py-0.5 text-[11px] font-semibold text-sky-600 dark:text-sky-400">
              <CheckCircle2 className="h-3 w-3" />
              Criativo gerado
            </span>
          ) : null}
        </div>

        {/* Generated Template Visual Preview */}
        <div className="relative overflow-hidden rounded-lg border border-border bg-muted/30">
          {hasImage ? (
            <div className="group relative aspect-square w-full">
              {/* EXACT rendered template image from Creative Engine Storage */}
              <img
                src={job!.output_url!}
                alt={`Confirmação de Pedido ${job!.order_code}`}
                className="h-full w-full object-cover transition-transform duration-200 group-hover:scale-[1.02] cursor-pointer"
                onClick={() => setLightboxOpen(true)}
              />
              <div
                onClick={() => setLightboxOpen(true)}
                className="absolute inset-0 flex items-center justify-center bg-black/40 opacity-0 transition-opacity group-hover:opacity-100 cursor-pointer"
              >
                <span className="inline-flex items-center gap-1.5 rounded-md bg-background/90 px-2.5 py-1 text-xs font-medium text-foreground shadow-sm">
                  <Eye className="h-3.5 w-3.5" />
                  Visualizar Arte
                </span>
              </div>
            </div>
          ) : isProcessing ? (
            <div className="flex aspect-square w-full flex-col items-center justify-center gap-2 p-4 text-center">
              <Loader2 className="h-7 w-7 animate-spin text-primary" />
              <p className="text-xs font-medium text-foreground">Gerando confirmação...</p>
              <p className="text-[10px] text-muted-foreground">Renderizando template 960x960 no Creative Engine</p>
            </div>
          ) : isFailed ? (
            <div className="flex aspect-square w-full flex-col items-center justify-center gap-2 p-4 text-center">
              <AlertCircle className="h-7 w-7 text-rose-500" />
              <p className="text-xs font-semibold text-rose-600 dark:text-rose-400">Falha ao gerar arte</p>
              <p className="line-clamp-3 text-[10px] text-muted-foreground">{job?.error || "Erro durante o render"}</p>
              <Button
                size="sm"
                variant="outline"
                className="mt-2 h-7 text-xs"
                onClick={() => handleSend({ forceResend: true, useCustomParams: true })}
                disabled={sending}
              >
                <RefreshCw className="mr-1 h-3 w-3" />
                Tentar novamente
              </Button>
            </div>
          ) : (
            <div className="flex aspect-square w-full items-center justify-center p-4 text-center text-xs text-muted-foreground">
              Aguardando processamento do criativo...
            </div>
          )}
        </div>

        {/* Order Details */}
        <div className="space-y-1.5 text-xs">
          <div className="flex items-center justify-between text-muted-foreground">
            <span>Pedido:</span>
            <span className="font-mono font-semibold text-foreground">
              #{job?.order_code || "PENDENTE"}
            </span>
          </div>
          <div className="flex items-center justify-between text-muted-foreground">
            <span className="flex items-center gap-1">
              <Layers className="h-3 w-3" />
              Template:
            </span>
            <span
              className="font-medium text-foreground truncate max-w-[170px]"
              title={data?.templates?.find((t) => t.id === job?.template_id)?.name || "Padrão"}
            >
              {data?.templates?.find((t) => t.id === job?.template_id)?.name || "Template Padrão"}
            </span>
          </div>
          <div className="flex items-center justify-between text-muted-foreground">
            <span>Perfil:</span>
            <span className="inline-flex items-center gap-1 font-medium text-foreground">
              <Camera className="h-3 w-3 text-pink-500" />
              @{job?.username || (contact as any)?.instagram_username}
            </span>
          </div>
          <div className="flex items-center justify-between text-muted-foreground">
            <span>{currentIsVerified ? "Serviço:" : "Quantidade:"}</span>
            <span className="font-semibold text-foreground flex items-center gap-1">
              {currentIsVerified ? (
                <span className="inline-flex items-center gap-1 text-sky-500 font-bold">
                  ✓ Selo Verificado
                </span>
              ) : (
                `${Number(job?.quantity || 5000).toLocaleString("pt-BR")} seguidores`
              )}
            </span>
          </div>
        </div>

        {/* Realtime Status Checklist */}
        <div className="rounded-lg bg-muted/50 p-2.5 space-y-1 text-[11px]">
          <div className="flex items-center gap-2 text-emerald-600 dark:text-emerald-400 font-medium">
            <CheckCircle2 className="h-3.5 w-3.5 shrink-0" />
            <span>Pedido recebido</span>
          </div>

          <div className="flex items-center gap-2 text-emerald-600 dark:text-emerald-400 font-medium">
            <CheckCircle2 className="h-3.5 w-3.5 shrink-0" />
            <span>Perfil identificado: @{job?.username || (contact as any)?.instagram_username}</span>
          </div>

          <div className="flex items-center gap-2 text-emerald-600 dark:text-emerald-400 font-medium">
            <CheckCircle2 className="h-3.5 w-3.5 shrink-0" />
            <span>Foto de perfil obtida</span>
          </div>

          <div className="flex items-center gap-2 font-medium">
            {hasImage ? (
              <span className="flex items-center gap-2 text-emerald-600 dark:text-emerald-400">
                <CheckCircle2 className="h-3.5 w-3.5 shrink-0" />
                <span>Criativo 960x960 gerado</span>
              </span>
            ) : isProcessing ? (
              <span className="flex items-center gap-2 text-amber-600 dark:text-amber-400">
                <Loader2 className="h-3.5 w-3.5 animate-spin shrink-0" />
                <span>Gerando arte...</span>
              </span>
            ) : (
              <span className="flex items-center gap-2 text-rose-500">
                <AlertCircle className="h-3.5 w-3.5 shrink-0" />
                <span>Criativo: Falhou</span>
              </span>
            )}
          </div>

          {/* Delivery Step */}
          <div className="flex items-center gap-2 font-medium">
            {isSent ? (
              <span className="flex items-center gap-2 text-emerald-600 dark:text-emerald-400">
                <CheckCircle2 className="h-3.5 w-3.5 shrink-0" />
                <span>Enviado para o WhatsApp</span>
              </span>
            ) : isSending ? (
              <span className="flex items-center gap-2 text-amber-600 dark:text-amber-400">
                <Clock className="h-3.5 w-3.5 animate-pulse shrink-0" />
                <span>Enviando pelo WhatsApp...</span>
              </span>
            ) : deliveryError ? (
              <div className="space-y-0.5 text-rose-600 dark:text-rose-400">
                <div className="flex items-center gap-2">
                  <AlertCircle className="h-3.5 w-3.5 shrink-0" />
                  <span>Envio WhatsApp: Falhou</span>
                </div>
                <p className="pl-5 text-[10px] text-muted-foreground line-clamp-2">
                  Motivo: {deliveryError}
                </p>
              </div>
            ) : (
              <span className="flex items-center gap-2 text-muted-foreground">
                <Clock className="h-3.5 w-3.5 shrink-0" />
                <span>Aguardando envio</span>
              </span>
            )}
          </div>
        </div>

        {/* Action Buttons: Manual Send / Resend / Customize */}
        <div className="space-y-1.5 pt-1">
          {isSent ? (
            <div className="space-y-1.5">
              <div className="grid grid-cols-2 gap-1.5">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => handleSend({ forceResend: true, useCustomParams: false })}
                  disabled={sending}
                  className="w-full gap-1 text-[11px] font-medium border-emerald-500/30 text-emerald-600 dark:text-emerald-400 hover:bg-emerald-500/10 h-8"
                >
                  <RotateCw className="h-3 w-3" />
                  <span>Reenviar Arte</span>
                </Button>
                <Button
                  type="button"
                  variant="default"
                  size="sm"
                  onClick={() => setResendConfirmOpen(true)}
                  disabled={sending}
                  className="w-full gap-1 text-[11px] font-medium bg-primary hover:bg-primary/90 text-primary-foreground h-8"
                >
                  <SlidersHorizontal className="h-3 w-3" />
                  <span>Alterar / Reenviar</span>
                </Button>
              </div>
            </div>
          ) : (
            <div className="space-y-1.5">
              <Button
                type="button"
                size="sm"
                onClick={() => handleSend({ forceResend: false, useCustomParams: false })}
                disabled={sending || isProcessing}
                className="w-full gap-2 text-xs font-semibold bg-primary hover:bg-primary/90 text-primary-foreground shadow"
              >
                {sending ? (
                  <>
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    <span>Enviando pelo WhatsApp...</span>
                  </>
                ) : (
                  <>
                    <Send className="h-3.5 w-3.5" />
                    <span>⚡ GERAR E ENVIAR CONFIRMAÇÃO</span>
                  </>
                )}
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => setResendConfirmOpen(true)}
                disabled={sending || isProcessing}
                className="w-full gap-1.5 text-[11px] text-muted-foreground hover:text-foreground h-7"
              >
                <SlidersHorizontal className="h-3 w-3" />
                <span>Personalizar template, @ ou quantidade</span>
              </Button>
            </div>
          )}

          {/* If failed, provide retry button */}
          {deliveryError && !isSent && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => handleSend({ forceResend: true, useCustomParams: false })}
              disabled={sending}
              className="mt-1 w-full text-[11px] text-rose-500 hover:bg-rose-500/10 hover:text-rose-600"
            >
              <RotateCw className="mr-1 h-3 w-3" />
              Tentar enviar novamente
            </Button>
          )}
        </div>
      </div>

      {/* Confirmation & Customization Modal (Template, @, Followers Quantity) */}
      <Dialog open={resendConfirmOpen} onOpenChange={setResendConfirmOpen}>
        <DialogContent className="sm:max-w-md max-h-[92vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-base font-semibold">
              <SlidersHorizontal className="h-4 w-4 text-primary" />
              Personalizar e Reenviar Confirmação
            </DialogTitle>
          </DialogHeader>

          <div className="space-y-4 py-2 text-xs">
            {/* Template Selector */}
            <div className="space-y-1.5">
              <label className="font-semibold text-foreground flex items-center justify-between">
                <span className="flex items-center gap-1.5">
                  <Layers className="h-3.5 w-3.5 text-primary" />
                  Template da Arte
                </span>
                <span className="text-[10px] font-normal text-muted-foreground">
                  {data?.templates?.length || 0} disponíveis
                </span>
              </label>
              <select
                value={customTemplateId}
                onChange={(e) => setCustomTemplateId(e.target.value)}
                className="w-full h-9 rounded-md border border-input bg-background px-3 py-1 text-xs text-foreground shadow-sm focus:outline-none focus:ring-1 focus:ring-ring"
              >
                {(data?.templates || []).map((tpl) => (
                  <option key={tpl.id} value={tpl.id}>
                    {tpl.name} {tpl.category ? `(${tpl.category})` : ""}
                  </option>
                ))}
              </select>
            </div>

            {/* Platform & Username (@) */}
            <div className="space-y-1.5">
              <label className="font-semibold text-foreground flex items-center justify-between">
                <span>Plataforma & Perfil</span>
                <span className="text-[10px] font-normal text-muted-foreground">
                  Foto será buscada automaticamente
                </span>
              </label>

              <div className="grid grid-cols-2 gap-1.5 pb-1">
                <button
                  type="button"
                  onClick={() => setCustomPlatform("instagram")}
                  className={`flex items-center justify-center gap-1.5 h-8 rounded-md border text-xs font-medium transition-colors ${
                    customPlatform === "instagram"
                      ? "border-pink-500 bg-pink-500/10 text-pink-600 dark:text-pink-400 font-semibold"
                      : "border-border bg-background hover:bg-muted text-muted-foreground"
                  }`}
                >
                  <Camera className="h-3.5 w-3.5" />
                  Instagram
                </button>
                <button
                  type="button"
                  onClick={() => setCustomPlatform("tiktok")}
                  className={`flex items-center justify-center gap-1.5 h-8 rounded-md border text-xs font-medium transition-colors ${
                    customPlatform === "tiktok"
                      ? "border-sky-500 bg-sky-500/10 text-sky-600 dark:text-sky-400 font-semibold"
                      : "border-border bg-background hover:bg-muted text-muted-foreground"
                  }`}
                >
                  <span>🎵</span>
                  TikTok
                </button>
              </div>

              <div className="relative">
                <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground font-semibold">
                  @
                </span>
                <Input
                  type="text"
                  placeholder="nomedeusuario"
                  value={customUsername.replace(/^@+/, "")}
                  onChange={(e) => setCustomUsername(e.target.value.replace(/^@+/, ""))}
                  className="pl-7 h-9 text-xs font-medium"
                />
              </div>
            </div>

            {/* Followers Quantity or Verified Badge with Quick Pills */}
            <div className="space-y-1.5">
              <label className="font-semibold text-foreground flex items-center justify-between">
                <span>{isVerified ? "Serviço Selecionado" : "Quantidade de Seguidores"}</span>
                <span className="font-mono text-primary font-bold">
                  {isVerified ? "✓ Selo Verificado Oficial" : `${Number(customQuantity || 0).toLocaleString("pt-BR")} seguidores`}
                </span>
              </label>

              {/* Quick Pills */}
              <div className="flex flex-wrap gap-1.5 pb-1">
                {[500, 1000, 2000, 5000, 10000, 20000, 30000, 50000, 100000].map((qty) => (
                  <button
                    key={qty}
                    type="button"
                    onClick={() => {
                      setCustomQuantity(qty);
                      setIsVerified(false);
                    }}
                    className={`px-2 py-1 rounded text-[11px] font-medium transition-colors border ${
                      !isVerified && Number(customQuantity) === qty
                        ? "bg-primary text-primary-foreground border-primary"
                        : "bg-muted/50 hover:bg-muted border-border text-foreground"
                    }`}
                  >
                    {qty >= 1000 ? `${qty / 1000}k` : qty}
                  </button>
                ))}

                {/* VERIFICADO Pill */}
                <button
                  type="button"
                  onClick={() => setIsVerified((prev) => !prev)}
                  className={`px-2.5 py-1 rounded text-[11px] font-semibold transition-colors border flex items-center gap-1 ${
                    isVerified
                      ? "bg-sky-500 text-white border-sky-400 shadow-sm"
                      : "bg-sky-500/10 text-sky-600 dark:text-sky-400 hover:bg-sky-500/20 border-sky-500/30"
                  }`}
                >
                  <span>✓ VERIFICADO</span>
                </button>
              </div>

              {isVerified ? (
                <div className="rounded-md border border-sky-500/30 bg-sky-500/10 p-2.5 text-xs text-sky-700 dark:text-sky-300 flex items-center gap-2">
                  <span className="text-base font-bold">✓</span>
                  <span>
                    <strong>Modo Selo Verificado Ativo:</strong> O criativo 960x960 será gerado com o selo azul oficial de verificação sobre o perfil.
                  </span>
                </div>
              ) : (
                <Input
                  type="number"
                  min={1}
                  step={50}
                  placeholder="5000"
                  value={customQuantity || ""}
                  onChange={(e) => setCustomQuantity(Number(e.target.value))}
                  className="h-9 text-xs"
                />
              )}
            </div>

            {/* Notice / Status description */}
            <div className="rounded-lg border border-border bg-muted/40 p-2.5 space-y-1">
              <div className="flex items-center gap-1.5 font-medium text-foreground">
                <Sparkles className="h-3.5 w-3.5 text-primary" />
                <span>
                  {isModified
                    ? "✨ Parâmetros alterados — Uma nova arte 960x960 será gerada"
                    : "ℹ️ Parâmetros idênticos à arte atual"}
                </span>
              </div>
              <p className="text-[11px] text-muted-foreground leading-relaxed">
                {isModified
                  ? "O Creative Engine resolverá a foto do perfil atualizada, renderizará o template selecionado com a nova quantidade e enviará a imagem pelo WhatsApp."
                  : "A arte já gerada será reenviada diretamente para o WhatsApp do cliente."}
              </p>
            </div>
          </div>

          <DialogFooter className="gap-2 sm:gap-0">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setResendConfirmOpen(false)}
              disabled={sending}
            >
              Cancelar
            </Button>
            <Button
              size="sm"
              onClick={() => handleSend({ forceResend: true, useCustomParams: true })}
              disabled={sending || !customUsername.trim() || !customQuantity}
              className="gap-1.5 bg-primary"
            >
              {sending ? (
                <>
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  <span>Enviando...</span>
                </>
              ) : (
                <>
                  <Send className="h-3.5 w-3.5" />
                  <span>{isModified ? "⚡ Gerar Nova Arte e Reenviar" : "Reenviar Confirmação"}</span>
                </>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Lightbox / High-Res View of Exact Rendered Template */}
      <Dialog open={lightboxOpen} onOpenChange={setLightboxOpen}>
        <DialogContent className="sm:max-w-xl p-3">
          <DialogHeader className="p-2">
            <DialogTitle className="text-sm font-semibold flex items-center justify-between">
              <span>Arte Final • #{job?.order_code}</span>
              {job?.output_url && (
                <a
                  href={job.output_url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-xs text-muted-foreground hover:text-foreground inline-flex items-center gap-1"
                >
                  <ExternalLink className="h-3.5 w-3.5" />
                  Abrir original
                </a>
              )}
            </DialogTitle>
          </DialogHeader>

          {job?.output_url && (
            <div className="relative aspect-square w-full overflow-hidden rounded-lg bg-black">
              <img
                src={job.output_url}
                alt="Arte Final 960x960"
                className="h-full w-full object-contain"
              />
            </div>
          )}

          <div className="p-2 flex items-center justify-between text-xs text-muted-foreground">
            <span>Dimensões: 960x960 PNG</span>
            <Button
              size="sm"
              variant="default"
              onClick={() => {
                setLightboxOpen(false);
                if (isSent) {
                  setResendConfirmOpen(true);
                } else {
                  handleSend({ forceResend: false, useCustomParams: false });
                }
              }}
              className="gap-1.5 h-8 text-xs"
            >
              <Send className="h-3.5 w-3.5" />
              {isSent ? "Reenviar Imagem" : "Enviar Imagem"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
