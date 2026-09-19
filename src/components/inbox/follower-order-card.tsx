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
} from "lucide-react";
import { toast } from "sonner";

interface FollowerOrderCardProps {
  contact: Contact | null;
  onContactUpdated?: (updated: Contact) => void;
}

interface OrderData {
  has_order: boolean;
  job?: {
    id: string;
    order_code: string;
    username: string;
    quantity: number | string;
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

  // Real-time listener on creative_jobs and creative_deliveries
  useEffect(() => {
    if (!contact?.id || !accountId) return;

    const supabase = createClient();
    const channelName = `follower_order_${contact.id}_${Date.now()}`;

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
          console.log("[FollowerOrderCard] Realtime creative_jobs event received, re-fetching...");
          fetchOrderData(true);
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
          console.log("[FollowerOrderCard] Realtime creative_deliveries event received, re-fetching...");
          fetchOrderData(true);
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
          console.log("[FollowerOrderCard] Realtime contact update received, re-fetching...");
          if (payload.new && onContactUpdated) {
            onContactUpdated(payload.new as Contact);
          }
          fetchOrderData(true);
        }
      )
      .subscribe();

    activeChannelRef.current = channel;

    return () => {
      if (activeChannelRef.current) {
        supabase.removeChannel(activeChannelRef.current);
      }
    };
  }, [contact?.id, accountId, fetchOrderData, onContactUpdated]);

  const handleSend = async (forceResend = false) => {
    if (!contact?.id) return;
    setSending(true);

    try {
      const res = await fetch(`/api/contacts/${contact.id}/follower-order`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          job_id: data?.job?.id,
          force_resend: forceResend,
        }),
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

  const job = data?.job;
  const isSent = Boolean(data?.is_sent || job?.status === "SENT");
  const isSending = job?.status === "SENDING";
  const isProcessing = job?.status === "PROCESSING";
  const isFailed = job?.status === "FAILED";
  const hasImage = Boolean(job?.output_url);
  const deliveryError = data?.steps?.delivery_error || job?.error;

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
                onClick={() => handleSend(true)}
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
            <span>Instagram:</span>
            <span className="inline-flex items-center gap-1 font-medium text-foreground">
              <Camera className="h-3 w-3 text-pink-500" />
              @{job?.username || (contact as any)?.instagram_username}
            </span>
          </div>
          <div className="flex items-center justify-between text-muted-foreground">
            <span>Quantidade:</span>
            <span className="font-semibold text-foreground">
              {Number(job?.quantity || 5000).toLocaleString("pt-BR")} seguidores
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
            <span>Instagram identificado: @{job?.username}</span>
          </div>

          <div className="flex items-center gap-2 text-emerald-600 dark:text-emerald-400 font-medium">
            <CheckCircle2 className="h-3.5 w-3.5 shrink-0" />
            <span>Foto do Instagram obtida</span>
          </div>

          <div className="flex items-center gap-2 font-medium">
            {hasImage ? (
              <span className="flex items-center gap-2 text-emerald-600 dark:text-emerald-400">
                <CheckCircle2 className="h-3.5 w-3.5 shrink-0" />
                <span>Criativo gerado</span>
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

        {/* Action Button: Manual Send / Resend */}
        <div className="pt-1">
          {isSent ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setResendConfirmOpen(true)}
              disabled={sending}
              className="w-full gap-1.5 text-xs font-medium border-emerald-500/30 text-emerald-600 dark:text-emerald-400 hover:bg-emerald-500/10"
            >
              <RotateCw className="h-3.5 w-3.5" />
              <span>✓ Já enviado • Reenviar</span>
            </Button>
          ) : (
            <Button
              type="button"
              size="sm"
              onClick={() => handleSend(false)}
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
          )}

          {/* If failed, provide retry button */}
          {deliveryError && !isSent && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => handleSend(true)}
              disabled={sending}
              className="mt-1.5 w-full text-[11px] text-rose-500 hover:bg-rose-500/10 hover:text-rose-600"
            >
              <RotateCw className="mr-1 h-3 w-3" />
              Tentar enviar novamente
            </Button>
          )}
        </div>
      </div>

      {/* Confirmation Modal for Manual Resend (Requirement 19) */}
      <Dialog open={resendConfirmOpen} onOpenChange={setResendConfirmOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-base">
              <RotateCw className="h-4 w-4 text-amber-500" />
              Reenviar Confirmação de Pedido?
            </DialogTitle>
          </DialogHeader>

          <div className="space-y-3 py-2 text-xs text-muted-foreground">
            <p>
              Esta confirmação já foi enviada com sucesso para o WhatsApp de{" "}
              <strong className="text-foreground">{contact?.name || contact?.phone}</strong>.
            </p>
            <div className="rounded-md bg-muted p-2.5 text-foreground space-y-1">
              <div><strong>Pedido:</strong> #{job?.order_code}</div>
              <div><strong>Instagram:</strong> @{job?.username}</div>
              <div><strong>Quantidade:</strong> {Number(job?.quantity || 5000).toLocaleString("pt-BR")} seguidores</div>
            </div>
            <p>
              Deseja reenviar a mesma arte para o cliente agora? Uma nova entrega será registrada.
            </p>
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
              onClick={() => handleSend(true)}
              disabled={sending}
              className="gap-1.5 bg-primary"
            >
              {sending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />}
              Reenviar
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
                  handleSend(false);
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
