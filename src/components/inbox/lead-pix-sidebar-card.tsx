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
  ChevronDown,
  ChevronUp,
  Maximize2,
} from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { toast } from "sonner";

interface LeadPixSidebarCardProps {
  contact: Contact | null;
  conversationId?: string | null;
  onContactUpdated?: (updated: Contact) => void;
}

const PRESET_AMOUNTS = [10, 20, 25, 50, 100];

export function LeadPixSidebarCard({
  contact,
  conversationId,
}: LeadPixSidebarCardProps) {
  const [amount, setAmount] = useState<number | string>(25);
  const [serviceName, setServiceName] = useState("Recarga SMM");
  const [isCollapsed, setIsCollapsed] = useState(false);
  const [loading, setLoading] = useState(false);
  const [sendingToChat, setSendingToChat] = useState(false);
  const [copied, setCopied] = useState(false);
  const [qrModalOpen, setQrModalOpen] = useState(false);

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
        toast.success("🎉 PIX Compensado! Pagamento recebido!");
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

      toast.success(`✅ PIX de R$ ${val.toFixed(2).replace(".", ",")} gerado!`);
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
      toast.success("📋 Código Copia e Cola copiado!");
      setTimeout(() => setCopied(false), 2000);
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
        // Fallback to text send if native button is not supported
        const fallbackRes = await fetch("/api/whatsapp/send", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            conversationId,
            content: `🔑 *Chave PIX Copia e Cola (R$ ${pixResult.amount.toFixed(2).replace(".", ",")})*:

${pixResult.code}

_Copie o código acima e pague no app do seu banco._`,
          }),
        });
        const fallbackData = await fallbackRes.json();
        if (!fallbackRes.ok || fallbackData.error) {
          throw new Error(data.error || fallbackData.error || "Falha ao enviar no chat");
        }
      }

      toast.success("🚀 Chave PIX enviada no WhatsApp!");
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
    <div className="rounded-xl border border-cyan-500/30 bg-gradient-to-b from-cyan-950/30 via-background/90 to-blue-950/20 p-2.5 shadow-sm transition-all">
      {/* Header Compacto com Botão de Recolher */}
      <div className="flex items-center justify-between">
        <button
          type="button"
          onClick={() => setIsCollapsed(!isCollapsed)}
          className="flex items-center gap-1.5 text-left group"
        >
          <div className="flex h-5 w-5 items-center justify-center rounded-md bg-cyan-500/20 text-cyan-400 border border-cyan-500/30">
            <Zap className="h-3 w-3 fill-cyan-400" />
          </div>
          <span className="text-xs font-semibold text-foreground group-hover:text-cyan-400 transition-colors">
            Chave PIX
          </span>
          {isCollapsed ? (
            <ChevronDown className="h-3 w-3 text-muted-foreground ml-0.5" />
          ) : (
            <ChevronUp className="h-3 w-3 text-muted-foreground ml-0.5" />
          )}
        </button>

        <div className="flex items-center gap-1.5">
          {pixResult && (
            <span className={`text-[9px] font-mono font-bold px-1.5 py-0.2 rounded ${
              pixResult.status === "paid"
                ? "bg-emerald-500/20 text-emerald-300"
                : "bg-amber-500/20 text-amber-300 animate-pulse"
            }`}>
              R$ {pixResult.amount}
            </span>
          )}
          <Badge
            variant="outline"
            className="border-cyan-500/40 bg-cyan-500/10 px-1.5 py-0 text-[8px] font-semibold text-cyan-300 uppercase tracking-wider"
          >
            API
          </Badge>
        </div>
      </div>

      {!isCollapsed && (
        <div className="mt-2 pt-1.5 border-t border-border/40">
          {!pixResult ? (
            /* State 1: Compact Selector & Generate Row */
            <div className="space-y-1.5">
              {/* Presets em Linha Única */}
              <div className="flex items-center justify-between gap-1">
                {PRESET_AMOUNTS.map((p) => {
                  const isSelected = numAmount === p;
                  return (
                    <button
                      key={p}
                      type="button"
                      onClick={() => setAmount(p)}
                      className={`flex-1 rounded border py-1 text-[10px] font-semibold transition-all ${
                        isSelected
                          ? "border-cyan-400 bg-cyan-500/20 text-cyan-300"
                          : "border-border/50 bg-muted/30 text-muted-foreground hover:bg-muted"
                      }`}
                    >
                      {p}
                    </button>
                  );
                })}
              </div>

              {/* Linha Compacta: Input de Valor + Botão Gerar */}
              <div className="flex items-center gap-1.5">
                <div className="relative w-22 shrink-0">
                  <span className="absolute left-1.5 top-1/2 -translate-y-1/2 text-[10px] font-bold text-muted-foreground">
                    R$
                  </span>
                  <Input
                    type="number"
                    min="6"
                    max="3000"
                    step="1"
                    value={amount}
                    onChange={(e) => setAmount(e.target.value)}
                    placeholder="25"
                    className="h-7 pl-6 pr-1 font-mono text-[11px] border-border/70"
                  />
                </div>

                <Button
                  type="button"
                  size="sm"
                  onClick={() => handleGenerate()}
                  disabled={loading || numAmount < 6}
                  className="flex-1 h-7 gap-1 bg-gradient-to-r from-cyan-600 to-blue-600 hover:from-cyan-500 hover:to-blue-500 text-white font-semibold text-[11px] px-2 shadow-sm"
                >
                  {loading ? (
                    <Loader2 className="h-3 w-3 animate-spin" />
                  ) : (
                    <Zap className="h-3 w-3 fill-current" />
                  )}
                  <span>Gerar PIX</span>
                </Button>
              </div>
            </div>
          ) : (
            /* State 2: Super Compact Result (Lado a Lado) */
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                {/* QR Code Miniatura (64x64px) com Clique para Expandir */}
                {pixResult.qrcode_base64 && (
                  <button
                    type="button"
                    onClick={() => setQrModalOpen(true)}
                    className="relative shrink-0 rounded-lg border border-border bg-white p-1 hover:ring-2 hover:ring-cyan-400 transition-all group"
                    title="Clique para ampliar o QR Code"
                  >
                    <img
                      src={`data:image/png;base64,${pixResult.qrcode_base64}`}
                      alt="QR Code"
                      className="h-16 w-16 object-contain"
                    />
                    <div className="absolute inset-0 bg-black/30 rounded-md opacity-0 group-hover:opacity-100 flex items-center justify-center transition-opacity">
                      <Maximize2 className="h-3 w-3 text-white" />
                    </div>
                  </button>
                )}

                {/* Coluna Direita: Código Truncado + Botões de Ação */}
                <div className="flex-1 min-w-0 space-y-1">
                  <div className="flex items-center justify-between">
                    {pixResult.status === "paid" ? (
                      <span className="text-[10px] font-bold text-emerald-400 flex items-center gap-1">
                        <CheckCircle2 className="h-3 w-3" /> Pago!
                      </span>
                    ) : (
                      <span className="text-[10px] font-semibold text-amber-300 flex items-center gap-1 animate-pulse">
                        <Clock className="h-2.5 w-2.5" /> Aguardando...
                      </span>
                    )}
                    <span className="text-[10px] font-mono font-bold text-foreground">
                      R$ {pixResult.amount.toFixed(2).replace(".", ",")}
                    </span>
                  </div>

                  {/* Código Copia e Cola em 1 Linha com Botão Integrado */}
                  <div className="flex items-center gap-1 rounded bg-muted/40 p-1 border border-border/50">
                    <p className="flex-1 font-mono text-[9px] text-muted-foreground truncate select-all">
                      {pixResult.code}
                    </p>
                    <button
                      type="button"
                      onClick={handleCopy}
                      className="shrink-0 p-1 rounded bg-cyan-500/20 text-cyan-300 hover:bg-cyan-500/30 transition-colors"
                      title="Copiar Código PIX"
                    >
                      {copied ? (
                        <Check className="h-3 w-3 text-emerald-400" />
                      ) : (
                        <Copy className="h-3 w-3" />
                      )}
                    </button>
                  </div>

                  {/* Botões Lado a Lado Compactos */}
                  <div className="flex items-center gap-1 pt-0.5">
                    <Button
                      type="button"
                      size="sm"
                      onClick={handleCopy}
                      className="flex-1 h-6 px-1.5 text-[10px] font-semibold border-cyan-500/30 bg-cyan-500/10 hover:bg-cyan-500/20 text-cyan-300"
                      variant="outline"
                    >
                      {copied ? "Copiado!" : "Copiar"}
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      onClick={handleSendToChat}
                      disabled={sendingToChat || !conversationId}
                      className="flex-1 h-6 px-1.5 text-[10px] font-semibold bg-emerald-600 hover:bg-emerald-500 text-white gap-1"
                    >
                      {sendingToChat ? (
                        <Loader2 className="h-2.5 w-2.5 animate-spin" />
                      ) : (
                        <Send className="h-2.5 w-2.5" />
                      )}
                      <span>Enviar</span>
                    </Button>
                  </div>
                </div>
              </div>

              {/* Botão sutil para resetar */}
              <div className="flex justify-between items-center pt-1 border-t border-border/30 text-[9px] text-muted-foreground">
                <span>Clique no QR Code para ampliar</span>
                <button
                  type="button"
                  onClick={handleReset}
                  className="hover:text-cyan-400 flex items-center gap-1 transition-colors"
                >
                  <RefreshCw className="h-2.5 w-2.5" />
                  <span>Novo valor</span>
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Modal para Visualizar QR Code Ampliado se o atendente quiser */}
      <Dialog open={qrModalOpen} onOpenChange={setQrModalOpen}>
        <DialogContent className="max-w-xs p-5 bg-background border-border text-center">
          <DialogHeader>
            <DialogTitle className="text-sm font-semibold">
              QR Code PIX (R$ {pixResult?.amount.toFixed(2).replace(".", ",")})
            </DialogTitle>
          </DialogHeader>
          {pixResult?.qrcode_base64 && (
            <div className="mt-2 flex justify-center">
              <div className="rounded-xl border border-border bg-white p-3 shadow-md">
                <img
                  src={`data:image/png;base64,${pixResult.qrcode_base64}`}
                  alt="QR Code PIX Ampliado"
                  className="h-48 w-48 object-contain"
                />
              </div>
            </div>
          )}
          <Button
            type="button"
            size="sm"
            onClick={handleCopy}
            className="mt-3 w-full gap-1.5 text-xs font-semibold"
          >
            {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
            <span>Copiar Código Copia e Cola</span>
          </Button>
        </DialogContent>
      </Dialog>
    </div>
  );
}
