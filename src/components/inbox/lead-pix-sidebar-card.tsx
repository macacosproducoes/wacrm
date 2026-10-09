"use client";

import React, { useState, useEffect, useRef, useCallback } from "react";
import type { Contact } from "@/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  QrCode,
  Zap,
  Copy,
  Check,
  Send,
  Loader2,
  RefreshCw,
  CheckCircle2,
  Clock,
  Sparkles,
  ChevronDown,
  ChevronUp,
} from "lucide-react";
import { toast } from "sonner";

interface LeadPixSidebarCardProps {
  contact: Contact | null;
  conversationId?: string | null;
  onContactUpdated?: (updated: Contact) => void;
}

const PRESET_AMOUNTS = [10, 20, 25, 50, 100, 200];

export function LeadPixSidebarCard({
  contact,
  conversationId,
}: LeadPixSidebarCardProps) {
  const [amount, setAmount] = useState<number | string>(25);
  const [serviceName, setServiceName] = useState("Recarga SMM");
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [loading, setLoading] = useState(false);
  const [sendingToChat, setSendingToChat] = useState(false);
  const [copied, setCopied] = useState(false);

  // Result state
  const [pixResult, setPixResult] = useState<{
    code: string;
    qrcode_base64?: string;
    external_id: string;
    amount: number;
    status: "pending" | "paid";
  } | null>(null);

  const pollingRef = useRef<NodeJS.Timeout | null>(null);

  const numAmount = Number(amount) || 0;

  // Poll status when PIX is generated and pending
  const checkStatus = useCallback(async (externalId: string) => {
    try {
      const res = await fetch(`/api/smm/status?external_id=${encodeURIComponent(externalId)}`);
      if (!res.ok) return;
      const data = await res.json();
      if (data?.data?.status === "paid") {
        setPixResult((prev) => (prev ? { ...prev, status: "paid" } : null));
        toast.success("🎉 PIX Compensado! Pagamento recebido com sucesso!");
        if (pollingRef.current) {
          clearInterval(pollingRef.current);
          pollingRef.current = null;
        }
      }
    } catch {
      // ignore transient poll errors
    }
  }, []);

  useEffect(() => {
    if (pixResult?.external_id && pixResult.status === "pending") {
      pollingRef.current = setInterval(() => {
        checkStatus(pixResult.external_id);
      }, 3000);
    }
    return () => {
      if (pollingRef.current) {
        clearInterval(pollingRef.current);
        pollingRef.current = null;
      }
    };
  }, [pixResult?.external_id, pixResult?.status, checkStatus]);

  const handleGenerate = async (targetAmount?: number) => {
    const val = targetAmount ?? numAmount;
    if (val < 6) {
      toast.error("O valor mínimo para gerar a chave é R$ 6,00.");
      return;
    }

    setLoading(true);
    if (pollingRef.current) {
      clearInterval(pollingRef.current);
      pollingRef.current = null;
    }

    try {
      const res = await fetch("/api/smm/pay", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          amount: val,
          service_name: serviceName,
          name: contact?.name || "Cliente Lead",
          phone: contact?.phone,
        }),
      });

      const data = await res.json();

      if (!res.ok || data.error) {
        throw new Error(
          data.detail
            ? `${data.error}: ${data.detail}`
            : data.error || "Erro ao comunicar com a API PIX"
        );
      }

      const pixData = data.data?.pix;
      if (!pixData?.code) {
        throw new Error("A API não retornou o código Copia e Cola.");
      }

      setPixResult({
        code: pixData.code,
        qrcode_base64: pixData.qrcode_base64,
        external_id: data.external_id,
        amount: val,
        status: "pending",
      });

      toast.success(`✅ PIX de R$ ${val.toFixed(2).replace(".", ",")} gerado com sucesso!`);
    } catch (err: any) {
      console.error("[LeadPixSidebarCard] Error:", err);
      toast.error(err.message || "Erro ao gerar PIX.");
    } finally {
      setLoading(false);
    }
  };

  const handleCopy = async () => {
    if (!pixResult?.code) return;
    try {
      await navigator.clipboard.writeText(pixResult.code);
      setCopied(true);
      toast.success("📋 Código Copia e Cola copiado com sucesso!");
      setTimeout(() => setCopied(false), 2500);
    } catch {
      toast.error("Não foi possível copiar automaticamente.");
    }
  };

  const handleSendToChat = async () => {
    if (!pixResult?.code) return;
    if (!conversationId) {
      toast.error("Abra uma conversa ativa com o lead para enviar no chat.");
      return;
    }

    setSendingToChat(true);
    try {
      const res = await fetch("/api/whatsapp/send-pix", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          conversationId,
          pixKey: pixResult.code,
          pixKeyType: "COPIA_E_COLA",
          amount: pixResult.amount,
          merchantName: "SMM Painel",
          text: `Segue a chave PIX Copia e Cola no valor de R$ ${pixResult.amount.toFixed(2).replace(".", ",")}:`,
          followUpEnabled: true,
          followUpType: "text",
          followUpContent: "Assim que realizar o pagamento, confirme por aqui para liberarmos imediatamente!",
          followUpDelaySeconds: 4,
        }),
      });

      const data = await res.json();
      if (!res.ok || data.error) {
        // Fallback to text send if native button is not supported by provider
        const fallbackRes = await fetch("/api/whatsapp/send", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            conversationId,
            content: `🔑 *Chave PIX Copia e Cola (R$ ${pixResult.amount.toFixed(2).replace(".", ",")})*:

${pixResult.code}

_Copie o código acima e pague no seu aplicativo do banco._`,
          }),
        });
        const fallbackData = await fallbackRes.json();
        if (!fallbackRes.ok || fallbackData.error) {
          throw new Error(data.error || fallbackData.error || "Falha ao enviar no chat");
        }
      }

      toast.success("🚀 Chave PIX enviada diretamente no WhatsApp do lead!");
    } catch (err: any) {
      console.error("[LeadPixSidebarCard:SendToChat] Error:", err);
      toast.error(err.message || "Erro ao enviar chave no WhatsApp.");
    } finally {
      setSendingToChat(false);
    }
  };

  const handleReset = () => {
    if (pollingRef.current) {
      clearInterval(pollingRef.current);
      pollingRef.current = null;
    }
    setPixResult(null);
  };

  return (
    <div className="mt-4 rounded-xl border border-cyan-500/30 bg-gradient-to-b from-cyan-950/40 via-background to-blue-950/20 p-3.5 shadow-md transition-all">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-cyan-500/20 text-cyan-400 border border-cyan-500/30 shadow-sm">
            <Zap className="h-4 w-4 fill-cyan-400" />
          </div>
          <div>
            <h4 className="text-xs font-bold tracking-tight text-foreground">
              Chave PIX / Cobrança
            </h4>
            <p className="text-[10px] text-muted-foreground">
              Gerar QR Code & Copia e Cola
            </p>
          </div>
        </div>
        <Badge
          variant="outline"
          className="border-cyan-500/40 bg-cyan-500/10 px-2 py-0.5 text-[9px] font-semibold text-cyan-300 uppercase tracking-wider"
        >
          BuckPay API
        </Badge>
      </div>

      {!pixResult ? (
        /* State 1: Amount Selector & Generator */
        <div className="mt-3 space-y-2.5">
          <div>
            <Label className="text-[11px] font-medium text-muted-foreground">
              Selecione o Valor:
            </Label>
            {/* Quick Presets */}
            <div className="mt-1.5 grid grid-cols-3 gap-1.5">
              {PRESET_AMOUNTS.map((p) => {
                const isSelected = numAmount === p;
                return (
                  <button
                    key={p}
                    type="button"
                    onClick={() => {
                      setAmount(p);
                    }}
                    className={`rounded-lg border px-2 py-1.5 text-xs font-semibold transition-all ${
                      isSelected
                        ? "border-cyan-400 bg-cyan-500/20 text-cyan-300 shadow-sm shadow-cyan-950/50"
                        : "border-border/60 bg-muted/40 text-muted-foreground hover:border-border hover:bg-muted hover:text-foreground"
                    }`}
                  >
                    R$ {p}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Custom Amount & Toggle */}
          <div className="flex items-center gap-2">
            <div className="relative flex-1">
              <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-xs font-bold text-muted-foreground">
                R$
              </span>
              <Input
                type="number"
                min="6"
                max="3000"
                step="0.50"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                placeholder="Outro valor"
                className="h-8 pl-8 pr-2 font-mono text-xs border-border/80"
              />
            </div>
            <button
              type="button"
              onClick={() => setShowAdvanced(!showAdvanced)}
              className="rounded p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
              title="Personalizar descrição"
            >
              {showAdvanced ? (
                <ChevronUp className="h-3.5 w-3.5" />
              ) : (
                <ChevronDown className="h-3.5 w-3.5" />
              )}
            </button>
          </div>

          {showAdvanced && (
            <div className="rounded-lg bg-muted/30 p-2 border border-border/60">
              <Label className="text-[10px] text-muted-foreground">
                Identificação do Serviço:
              </Label>
              <Input
                value={serviceName}
                onChange={(e) => setServiceName(e.target.value)}
                placeholder="Ex: Recarga SMM, Seguidores"
                className="mt-1 h-7 text-xs"
              />
            </div>
          )}

          {/* Generate Button */}
          <Button
            type="button"
            size="sm"
            onClick={() => handleGenerate()}
            disabled={loading || numAmount < 6}
            className="w-full gap-2 bg-gradient-to-r from-cyan-600 via-cyan-500 to-blue-600 hover:from-cyan-500 hover:to-blue-500 text-white font-semibold text-xs shadow-md shadow-cyan-950/50 h-8.5 transition-all"
          >
            {loading ? (
              <>
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                <span>Consultando API BuckPay...</span>
              </>
            ) : (
              <>
                <Zap className="h-3.5 w-3.5 fill-current" />
                <span>
                  Gerar PIX de R$ {numAmount > 0 ? numAmount.toFixed(2).replace(".", ",") : "0,00"}
                </span>
              </>
            )}
          </Button>
        </div>
      ) : (
        /* State 2: PIX Return with QR Code & Copia e Cola Code directly in site */
        <div className="mt-3 space-y-3">
          {/* Status Badge */}
          <div className="flex items-center justify-between">
            {pixResult.status === "paid" ? (
              <span className="inline-flex items-center gap-1.5 rounded-full border border-emerald-500/40 bg-emerald-500/10 px-2 py-0.5 text-[10px] font-semibold text-emerald-400">
                <CheckCircle2 className="h-3 w-3" />
                PIX Pago com Sucesso!
              </span>
            ) : (
              <span className="inline-flex items-center gap-1.5 rounded-full border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-[10px] font-semibold text-amber-300 animate-pulse">
                <Clock className="h-3 w-3" />
                Aguardando Pagamento...
              </span>
            )}
            <span className="font-mono text-xs font-bold text-foreground">
              R$ {pixResult.amount.toFixed(2).replace(".", ",")}
            </span>
          </div>

          {/* Render QR Code Image */}
          {pixResult.qrcode_base64 && (
            <div className="flex justify-center">
              <div className="rounded-xl border border-border/80 bg-white p-2 shadow-sm">
                <img
                  src={`data:image/png;base64,${pixResult.qrcode_base64}`}
                  alt="QR Code PIX"
                  className="h-28 w-28 object-contain"
                />
              </div>
            </div>
          )}

          {/* PIX Copia e Cola Box */}
          <div className="rounded-lg border border-border/80 bg-background/90 p-2 text-left">
            <div className="flex items-center justify-between">
              <Label className="text-[9px] uppercase tracking-wider font-semibold text-muted-foreground">
                Código Copia e Cola:
              </Label>
              <span className="text-[9px] text-cyan-400 font-mono">EMVCo</span>
            </div>
            <p className="mt-1 font-mono text-[11px] leading-tight break-all text-foreground select-all max-h-16 overflow-y-auto rounded bg-muted/30 p-1 border border-border/40">
              {pixResult.code}
            </p>
          </div>

          {/* Action Buttons: Copiar Código & Enviar no WhatsApp */}
          <div className="grid grid-cols-2 gap-1.5">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={handleCopy}
              className="h-8 gap-1 text-[11px] font-semibold border-cyan-500/30 hover:bg-cyan-500/10 hover:text-cyan-300"
            >
              {copied ? (
                <>
                  <Check className="h-3.5 w-3.5 text-emerald-400" />
                  <span className="text-emerald-400">Copiado!</span>
                </>
              ) : (
                <>
                  <Copy className="h-3.5 w-3.5" />
                  <span>Copiar Código</span>
                </>
              )}
            </Button>

            <Button
              type="button"
              size="sm"
              onClick={handleSendToChat}
              disabled={sendingToChat || !conversationId}
              className="h-8 gap-1 bg-emerald-600 hover:bg-emerald-500 text-white text-[11px] font-semibold shadow-sm"
            >
              {sendingToChat ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : (
                <Send className="h-3 w-3" />
              )}
              <span>Enviar no Chat</span>
            </Button>
          </div>

          {/* Reset / New Amount */}
          <div className="pt-1 border-t border-border/40 flex justify-center">
            <button
              type="button"
              onClick={handleReset}
              className="flex items-center gap-1.5 text-[11px] text-muted-foreground hover:text-cyan-400 transition-colors"
            >
              <RefreshCw className="h-3 w-3" />
              <span>Gerar outro valor</span>
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
