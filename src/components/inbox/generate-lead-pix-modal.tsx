"use client";

import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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
  Sparkles,
  AlertCircle,
  RefreshCw,
  ExternalLink,
} from "lucide-react";
import { toast } from "sonner";
import type { Contact } from "@/types";

interface GenerateLeadPixModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  contact: Contact | null;
  conversationId?: string | null;
}

const PRESET_AMOUNTS = [10, 20, 25, 50, 100, 200];

export function GenerateLeadPixModal({
  open,
  onOpenChange,
  contact,
  conversationId,
}: GenerateLeadPixModalProps) {
  const [amount, setAmount] = useState<number | string>(25);
  const [serviceName, setServiceName] = useState("Recarga de Saldo SMM");
  const [loading, setLoading] = useState(false);
  const [sendingToChat, setSendingToChat] = useState(false);
  const [copied, setCopied] = useState(false);
  const [pixResult, setPixResult] = useState<{
    code: string;
    qrcode_base64?: string;
    external_id: string;
    amount: number;
  } | null>(null);

  const numAmount = Number(amount) || 0;

  const handleGenerate = async () => {
    if (numAmount < 6) {
      toast.error("O valor mínimo para gerar a chave é R$ 6,00.");
      return;
    }

    setLoading(true);
    setPixResult(null);

    try {
      const res = await fetch("/api/smm/pay", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          amount: numAmount,
          service_name: serviceName,
          name: contact?.name || "Cliente Lead",
          phone: contact?.phone,
        }),
      });

      const data = await res.json();

      if (!res.ok || data.error) {
        throw new Error(data.detail ? `${data.error}: ${data.detail}` : (data.error || "Erro ao gerar PIX"));
      }

      const pixData = data.data?.pix;
      if (!pixData?.code) {
        throw new Error("A API não retornou o código Copia e Cola.");
      }

      setPixResult({
        code: pixData.code,
        qrcode_base64: pixData.qrcode_base64,
        external_id: data.external_id,
        amount: numAmount,
      });

      toast.success("✅ Chave PIX gerada com sucesso!");
    } catch (err: any) {
      console.error("[GenerateLeadPixModal] Error:", err);
      toast.error(err.message || "Erro ao gerar cobrança PIX.");
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
      setTimeout(() => setCopied(false), 2500);
    } catch {
      toast.error("Não foi possível copiar automaticamente.");
    }
  };

  const handleSendToChat = async () => {
    if (!pixResult?.code) return;
    if (!conversationId) {
      toast.error("Abra uma conversa ativa para enviar diretamente no chat.");
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
        throw new Error(data.error || "Falha ao enviar PIX no chat");
      }

      toast.success("🚀 Chave PIX enviada no WhatsApp do lead!");
      onOpenChange(false);
    } catch (err: any) {
      console.error("[SendToChat] Error:", err);
      toast.error(err.message || "Erro ao enviar chave no WhatsApp.");
    } finally {
      setSendingToChat(false);
    }
  };

  const handleClose = () => {
    setPixResult(null);
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md bg-background border-border shadow-2xl p-6">
        <DialogHeader>
          <div className="flex items-center gap-2">
            <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-cyan-500/10 text-cyan-400 border border-cyan-500/20">
              <Zap className="h-5 w-5 fill-current" />
            </div>
            <div>
              <DialogTitle className="text-base font-semibold">
                Gerar Chave PIX para o Lead
              </DialogTitle>
              <DialogDescription className="text-xs text-muted-foreground">
                Cobrança instantânea via BuckPay com botão de envio direto
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>

        {contact && (
          <div className="rounded-lg bg-muted/50 p-2.5 text-xs text-muted-foreground border border-border flex items-center justify-between">
            <div>
              <span className="font-semibold text-foreground">
                {contact.name || "Contato"}
              </span>
              {contact.phone && (
                <span className="ml-2 font-mono text-[11px] opacity-80">
                  {contact.phone}
                </span>
              )}
            </div>
            <Badge variant="secondary" className="text-[10px] uppercase font-mono">
              Lead Ativo
            </Badge>
          </div>
        )}

        {!pixResult ? (
          <div className="space-y-4 py-2">
            {/* Amount Selection */}
            <div>
              <Label className="text-xs font-medium">Valor da Cobrança (R$)</Label>
              <div className="mt-1.5 flex flex-wrap gap-1.5">
                {PRESET_AMOUNTS.map((p) => (
                  <Button
                    key={p}
                    type="button"
                    size="sm"
                    variant={numAmount === p ? "default" : "outline"}
                    className={
                      numAmount === p
                        ? "bg-cyan-600 hover:bg-cyan-500 text-white font-semibold text-xs h-7 px-2.5"
                        : "text-xs h-7 px-2.5 border-border hover:bg-muted"
                    }
                    onClick={() => setAmount(p)}
                  >
                    R$ {p}
                  </Button>
                ))}
              </div>

              <div className="mt-2">
                <Input
                  type="number"
                  min="6"
                  max="3000"
                  step="0.50"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  placeholder="Ou digite outro valor (ex: 35.00)"
                  className="font-mono text-sm"
                />
                <p className="mt-1 text-[11px] text-muted-foreground">
                  Mínimo: R$ 6,00 • Máximo: R$ 3.000,00
                </p>
              </div>
            </div>

            {/* Service Name */}
            <div>
              <Label className="text-xs font-medium">Identificação do Pedido / Serviço</Label>
              <Input
                value={serviceName}
                onChange={(e) => setServiceName(e.target.value)}
                placeholder="Ex: Recarga SMM, Seguidores, Mimo"
                className="mt-1 text-xs"
              />
            </div>

            <Button
              type="button"
              className="w-full gap-2 bg-gradient-to-r from-cyan-600 to-blue-600 hover:from-cyan-500 hover:to-blue-500 text-white font-semibold shadow-md shadow-cyan-950/40"
              onClick={handleGenerate}
              disabled={loading}
            >
              {loading ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  <span>Gerando PIX no Gateway...</span>
                </>
              ) : (
                <>
                  <Zap className="h-4 w-4 fill-current" />
                  <span>Gerar PIX de R$ {numAmount > 0 ? numAmount.toFixed(2).replace(".", ",") : "0,00"}</span>
                </>
              )}
            </Button>
          </div>
        ) : (
          <div className="space-y-4 py-2">
            {/* PIX Generated Result */}
            <div className="rounded-xl border border-emerald-500/30 bg-emerald-950/20 p-4 text-center">
              <div className="inline-flex items-center gap-1.5 rounded-full border border-emerald-500/40 bg-emerald-500/10 px-2.5 py-0.5 text-xs font-semibold text-emerald-400">
                <Check className="h-3 w-3" />
                PIX Gerado: R$ {pixResult.amount.toFixed(2).replace(".", ",")}
              </div>

              {/* QR Code image if available */}
              {pixResult.qrcode_base64 && (
                <div className="mt-3 flex justify-center">
                  <div className="rounded-xl bg-white p-2 shadow-md">
                    <img
                      src={`data:image/png;base64,${pixResult.qrcode_base64}`}
                      alt="QR Code PIX"
                      className="h-36 w-36 object-contain"
                    />
                  </div>
                </div>
              )}

              {/* Code Box */}
              <div className="mt-3 rounded-lg border border-border bg-background/80 p-2 text-left">
                <Label className="text-[10px] text-muted-foreground uppercase font-semibold">
                  Código Copia e Cola:
                </Label>
                <p className="mt-0.5 font-mono text-xs break-all text-foreground line-clamp-2 select-all">
                  {pixResult.code}
                </p>
              </div>

              {/* Action Buttons */}
              <div className="mt-3 grid grid-cols-2 gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={handleCopy}
                  className="gap-1.5 text-xs font-semibold"
                >
                  {copied ? (
                    <>
                      <Check className="h-3.5 w-3.5 text-emerald-400" />
                      <span>Copiado!</span>
                    </>
                  ) : (
                    <>
                      <Copy className="h-3.5 w-3.5" />
                      <span>Copiar Chave</span>
                    </>
                  )}
                </Button>

                <Button
                  type="button"
                  size="sm"
                  onClick={handleSendToChat}
                  disabled={sendingToChat || !conversationId}
                  className="gap-1.5 bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-semibold"
                >
                  {sendingToChat ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Send className="h-3.5 w-3.5" />
                  )}
                  <span>Enviar no Chat</span>
                </Button>
              </div>
            </div>

            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="w-full text-xs text-muted-foreground hover:text-foreground gap-1.5"
              onClick={() => setPixResult(null)}
            >
              <RefreshCw className="h-3 w-3" />
              <span>Gerar outro valor</span>
            </Button>
          </div>
        )}

        <DialogFooter className="sm:justify-end">
          <Button type="button" variant="ghost" size="sm" onClick={handleClose}>
            Fechar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
