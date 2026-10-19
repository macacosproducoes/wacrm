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
  User,
  Settings2,
} from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { toast } from "sonner";
import { playPaymentNotificationSound } from "@/lib/audio/payment-sound";
import { type PixKeyType, validatePixKey, detectPixKeyType } from "@/lib/pix/pix-validator";

interface LeadPixSidebarCardProps {
  contact: Contact | null;
  conversationId?: string | null;
  onContactUpdated?: (updated: Contact) => void;
  onOpenSendPixModal?: (tab?: "custom" | "company") => void;
}

const PRESET_AMOUNTS = [10, 20, 25, 50, 100];

export function LeadPixSidebarCard({
  contact,
  conversationId,
  onOpenSendPixModal,
}: LeadPixSidebarCardProps) {
  // Mode: "custom" (Minha Chave Personalizada) or "api" (Gerar Cobrança API SMM)
  const [cardMode, setCardMode] = useState<"custom" | "api">("custom");
  const [isCollapsed, setIsCollapsed] = useState(false);

  // Custom key state
  const [customKey, setCustomKey] = useState<string>("");
  const [customKeyType, setCustomKeyType] = useState<PixKeyType>("CPF");
  const [customAmount, setCustomAmount] = useState<string>("");
  const [customSending, setCustomSending] = useState(false);

  // API SMM state
  const [amount, setAmount] = useState<number | string>(25);
  const [serviceName, setServiceName] = useState("Recarga SMM");
  const [loading, setLoading] = useState(false);
  const [sendingToChat, setSendingToChat] = useState(false);
  const [copied, setCopied] = useState(false);
  const [qrModalOpen, setQrModalOpen] = useState(false);

  // Result state for API PIX
  const [pixResult, setPixResult] = useState<{
    code: string;
    qrcode_base64?: string;
    external_id: string;
    amount: number;
    status: "pending" | "paid";
    created_at?: number;
  } | null>(null);

  const pollingRef = useRef<NodeJS.Timeout | null>(null);

  const numAmount = Number(amount) || 0;

  // Restore remembered custom key from localStorage
  useEffect(() => {
    try {
      const saved = localStorage.getItem("wacrm_last_custom_pix");
      if (saved) {
        const parsed = JSON.parse(saved);
        if (parsed?.key) {
          setCustomKey(parsed.key);
          setCustomKeyType(parsed.type || "CPF");
        }
      }
    } catch {}
  }, []);

  // Restore saved API PIX for this contact from server DB and localStorage
  useEffect(() => {
    if (!contact?.id) {
      setPixResult(null);
      return;
    }

    let foundLocal = false;
    if (typeof window !== "undefined") {
      try {
        const saved = localStorage.getItem(`wacrm_pix_${contact.id}`);
        if (saved) {
          const parsed = JSON.parse(saved);
          if (parsed && (!parsed.created_at || Date.now() - parsed.created_at < 24 * 60 * 60 * 1000)) {
            setPixResult(parsed);
            foundLocal = true;
            if (parsed.status === "pending" && parsed.external_id) {
              void checkStatus(parsed.external_id);
            }
          }
        }
      } catch {}
    }

    // Fetch latest generated PIX from server to sync with database
    fetch(`/api/smm/latest-pix?contact_id=${encodeURIComponent(contact.id)}`)
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (data?.success && data?.pix?.code) {
          setPixResult(data.pix);
          if (typeof window !== "undefined") {
            try {
              localStorage.setItem(`wacrm_pix_${contact.id}`, JSON.stringify(data.pix));
            } catch {}
          }
          if (data.pix.status === "pending" && data.pix.external_id) {
            void checkStatus(data.pix.external_id);
          }
        } else if (!foundLocal) {
          setPixResult(null);
        }
      })
      .catch(() => {});
  }, [contact?.id]);

  // Poll status when PIX is generated and pending
  const checkStatus = useCallback(async (externalId: string) => {
    try {
      const res = await fetch(`/api/smm/status?external_id=${encodeURIComponent(externalId)}`);
      if (!res.ok) return;
      const data = await res.json();
      if (data?.data?.status === "paid") {
        setPixResult((prev) => {
          if (!prev) return null;
          const updated = { ...prev, status: "paid" as const };
          if (contact?.id && typeof window !== "undefined") {
            try {
              localStorage.setItem(`wacrm_pix_${contact.id}`, JSON.stringify(updated));
            } catch {}
          }
          return updated;
        });
        toast.success("🎉 PIX Compensado! Pagamento recebido!");
        if (pollingRef.current) {
          clearInterval(pollingRef.current);
          pollingRef.current = null;
        }
      }
    } catch {
      // ignore transient poll errors
    }
  }, [contact?.id]);

  // Handle custom key change with auto-detect
  const handleCustomKeyChange = (val: string) => {
    setCustomKey(val);
    const detected = detectPixKeyType(val);
    if (detected) {
      setCustomKeyType(detected);
    }
  };

  // Send custom PIX directly from sidebar
  const handleSendCustomPix = async () => {
    if (!customKey.trim()) {
      toast.error("Informe a sua chave PIX personalizada.");
      return;
    }
    if (!conversationId) {
      toast.error("Abra uma conversa ativa com o lead para enviar no chat.");
      return;
    }

    const validation = validatePixKey(customKey, customKeyType);
    if (!validation.valid) {
      toast.error(validation.error || "Chave PIX inválida.");
      return;
    }

    setCustomSending(true);
    try {
      try {
        localStorage.setItem(
          "wacrm_last_custom_pix",
          JSON.stringify({ key: validation.formattedKey, type: customKeyType })
        );
      } catch {}

      const res = await fetch("/api/whatsapp/send-pix", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          conversationId,
          pixKey: validation.formattedKey,
          pixKeyType: customKeyType,
          amount: customAmount ? parseFloat(customAmount.replace(",", ".")) : undefined,
          sendMode: "both",
        }),
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || "Falha ao enviar chave PIX pelo WhatsApp.");
      }

      toast.success("✅ Chave PIX personalizada enviada no WhatsApp com sucesso!");
    } catch (err: any) {
      console.error("[LeadPixSidebarCard:SendCustom] Error:", err);
      toast.error(err.message || "Erro ao enviar chave personalizada.");
    } finally {
      setCustomSending(false);
    }
  };

  // Generate PIX via BuckPay API
  const handleGenerateApiPix = async (customVal?: number) => {
    const val = customVal !== undefined ? customVal : numAmount;
    if (val < 6) {
      toast.error("O valor mínimo é R$ 6,00.");
      return;
    }

    setLoading(true);
    setPixResult(null);

    try {
      const res = await fetch("/api/smm/pay", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          amount: val,
          service_name: serviceName,
          name: contact?.name || "Cliente Lead",
          phone: contact?.phone,
          contact_id: contact?.id,
          account_id: contact?.account_id,
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

      const resultObj = {
        code: pixData.code,
        qrcode_base64: pixData.qrcode_base64,
        external_id: data.external_id,
        amount: val,
        status: "pending" as const,
        created_at: Date.now(),
      };

      setPixResult(resultObj);

      if (contact?.id && typeof window !== "undefined") {
        try {
          localStorage.setItem(`wacrm_pix_${contact.id}`, JSON.stringify(resultObj));
        } catch {}
      }

      toast.success(`✅ PIX de R$ ${val.toFixed(2).replace(".", ",")} gerado!`);
    } catch (err: any) {
      console.error("[LeadPixSidebarCard] Error:", err);
      toast.error(err.message || "Erro ao gerar PIX.");
    } finally {
      setLoading(false);
    }
  };

  const handleCopyApiPix = async () => {
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

  const handleSendApiPixToChat = async () => {
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
          externalId: pixResult.external_id,
          text: `Segue a chave PIX Copia e Cola no valor de R$ ${pixResult.amount.toFixed(2).replace(".", ",")}:`,
          followUpEnabled: true,
          followUpType: "text",
          followUpContent: "Assim que realizar o pagamento, confirme por aqui para liberarmos imediatamente!",
          followUpDelaySeconds: 4,
        }),
      });

      const data = await res.json();
      if (!res.ok || data.error) {
        const fallbackRes = await fetch("/api/whatsapp/send", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            conversationId,
            content: `🔑 *Chave PIX Copia e Cola (R$ ${pixResult.amount.toFixed(2).replace(".", ",")})*:\n\n${pixResult.code}\n\n_Copie o código acima e pague no app do seu banco._`,
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

  const handleResetApiPix = () => {
    if (pollingRef.current) {
      clearInterval(pollingRef.current);
      pollingRef.current = null;
    }
    if (contact?.id && typeof window !== "undefined") {
      try {
        localStorage.removeItem(`wacrm_pix_${contact.id}`);
      } catch {}
    }
    setPixResult(null);
  };

  return (
    <div className={`rounded-xl border p-2.5 shadow-sm transition-all ${
      cardMode === "custom"
        ? "border-emerald-500/30 bg-gradient-to-b from-emerald-950/20 via-background/90 to-background"
        : "border-cyan-500/30 bg-gradient-to-b from-cyan-950/30 via-background/90 to-blue-950/20"
    }`}>
      {/* Header Compacto com Botão de Recolher e Seletor de Modo */}
      <div className="flex items-center justify-between">
        <button
          type="button"
          onClick={() => setIsCollapsed(!isCollapsed)}
          className="flex items-center gap-1.5 text-left group cursor-pointer"
        >
          <div className={`flex h-5 w-5 items-center justify-center rounded-md border ${
            cardMode === "custom"
              ? "bg-emerald-500/20 text-emerald-400 border-emerald-500/30"
              : "bg-cyan-500/20 text-cyan-400 border-cyan-500/30"
          }`}>
            {cardMode === "custom" ? (
              <QrCode className="h-3 w-3" />
            ) : (
              <Zap className="h-3 w-3 fill-cyan-400" />
            )}
          </div>
          <span className="text-xs font-semibold text-foreground group-hover:text-emerald-400 transition-colors">
            Chave PIX
          </span>
          {isCollapsed ? (
            <ChevronDown className="h-3 w-3 text-muted-foreground ml-0.5" />
          ) : (
            <ChevronUp className="h-3 w-3 text-muted-foreground ml-0.5" />
          )}
        </button>

        {/* Mode switcher pills */}
        <div className="flex items-center gap-0.5 bg-muted/70 p-0.5 rounded-lg border border-border/60">
          <button
            type="button"
            onClick={() => {
              setCardMode("custom");
              setIsCollapsed(false);
            }}
            className={`px-1.5 py-0.5 rounded-md text-[9px] font-semibold transition-all cursor-pointer ${
              cardMode === "custom"
                ? "bg-emerald-600 text-white shadow-xs"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            Personalizada
          </button>
          <button
            type="button"
            onClick={() => {
              setCardMode("api");
              setIsCollapsed(false);
            }}
            className={`px-1.5 py-0.5 rounded-md text-[9px] font-semibold transition-all cursor-pointer ${
              cardMode === "api"
                ? "bg-cyan-600 text-white shadow-xs"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            API
          </button>
        </div>
      </div>

      {!isCollapsed && (
        <div className="mt-2 pt-1.5 border-t border-border/40">
          {/* MODO 1: CHAVE PERSONALIZADA */}
          {cardMode === "custom" ? (
            <div className="space-y-2">
              <div className="grid grid-cols-3 gap-1.5">
                <div className="col-span-1">
                  <select
                    value={customKeyType}
                    onChange={(e) => setCustomKeyType(e.target.value as PixKeyType)}
                    className="w-full h-7 px-1 text-[10px] rounded-md border border-border bg-background text-foreground font-medium"
                  >
                    <option value="CPF">CPF/CNPJ</option>
                    <option value="PHONE">Telefone</option>
                    <option value="EMAIL">E-mail</option>
                    <option value="EVP">Aleatória</option>
                    <option value="COPIA_E_COLA">Copia/Cola</option>
                  </select>
                </div>
                <div className="col-span-2">
                  <Input
                    type="text"
                    value={customKey}
                    onChange={(e) => handleCustomKeyChange(e.target.value)}
                    placeholder="Sua chave PIX..."
                    className="h-7 text-[11px] font-mono px-2"
                  />
                </div>
              </div>

              <div className="flex items-center gap-1.5">
                <div className="relative w-20 shrink-0">
                  <span className="absolute left-1.5 top-1/2 -translate-y-1/2 text-[9px] font-bold text-muted-foreground">
                    R$
                  </span>
                  <Input
                    type="text"
                    value={customAmount}
                    onChange={(e) => setCustomAmount(e.target.value)}
                    placeholder="Livre"
                    className="h-7 pl-6 pr-1 font-mono text-[10px]"
                  />
                </div>

                <Button
                  type="button"
                  size="sm"
                  onClick={handleSendCustomPix}
                  disabled={customSending || !customKey.trim()}
                  className="flex-1 h-7 gap-1 bg-emerald-600 hover:bg-emerald-700 text-white font-semibold text-[11px] px-2 shadow-xs cursor-pointer"
                >
                  {customSending ? (
                    <Loader2 className="h-3 w-3 animate-spin" />
                  ) : (
                    <Send className="h-3 w-3" />
                  )}
                  <span>Enviar no Chat</span>
                </Button>
              </div>

              {onOpenSendPixModal && (
                <div className="flex justify-end pt-0.5">
                  <button
                    type="button"
                    onClick={() => onOpenSendPixModal("custom")}
                    className="text-[10px] text-emerald-600 dark:text-emerald-400 hover:underline flex items-center gap-1 cursor-pointer"
                  >
                    <Settings2 className="h-2.5 w-2.5" /> Abrir Modal Completo (Opções Avançadas)
                  </button>
                </div>
              )}
            </div>
          ) : (
            /* MODO 2: GERAR VIA API BUCKPAY SMM */
            !pixResult ? (
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
                    onClick={() => handleGenerateApiPix()}
                    disabled={loading || numAmount < 6}
                    className="flex-1 h-7 gap-1 bg-gradient-to-r from-cyan-600 to-blue-600 hover:from-cyan-500 hover:to-blue-500 text-white font-semibold text-[11px] px-2 shadow-sm cursor-pointer"
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
              /* State 2: Super Compact Result API */
              <div className="space-y-2">
                <div className="flex items-center gap-2">
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

                  <div className="flex-1 min-w-0 space-y-1">
                    <div className="flex items-center justify-between">
                      {pixResult.status === "paid" ? (
                        <span className="text-[10px] font-bold text-emerald-400 flex items-center gap-1">
                          <CheckCircle2 className="h-3 w-3" /> Pago!
                        </span>
                      ) : (
                        <div className="flex items-center gap-1.5">
                          <span className="text-[10px] font-semibold text-amber-300 flex items-center gap-1 animate-pulse">
                            <Clock className="h-3 w-3" /> Aguardando
                          </span>
                        </div>
                      )}
                      <button
                        type="button"
                        onClick={handleResetApiPix}
                        className="text-[9px] text-muted-foreground hover:text-foreground transition-colors"
                      >
                        Novo
                      </button>
                    </div>

                    <p className="font-mono text-[9px] text-muted-foreground truncate bg-muted/40 p-1 rounded">
                      {pixResult.code}
                    </p>

                    <div className="flex items-center gap-1">
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        onClick={handleCopyApiPix}
                        className="h-6 text-[10px] px-2 flex-1 border-border/80"
                      >
                        {copied ? (
                          <Check className="h-2.5 w-2.5 text-emerald-400" />
                        ) : (
                          <Copy className="h-2.5 w-2.5" />
                        )}
                        <span>{copied ? "Copiado" : "Copiar"}</span>
                      </Button>

                      <Button
                        type="button"
                        size="sm"
                        onClick={handleSendApiPixToChat}
                        disabled={sendingToChat}
                        className="h-6 text-[10px] px-2 flex-1 bg-emerald-600 hover:bg-emerald-500 text-white font-semibold"
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
              </div>
            )
          )}
        </div>
      )}

      {/* QR Code Zoom Modal */}
      <Dialog open={qrModalOpen} onOpenChange={setQrModalOpen}>
        <DialogContent className="sm:max-w-xs p-4 flex flex-col items-center text-center">
          <DialogHeader>
            <DialogTitle className="text-sm">QR Code PIX</DialogTitle>
          </DialogHeader>
          {pixResult?.qrcode_base64 && (
            <img
              src={`data:image/png;base64,${pixResult.qrcode_base64}`}
              alt="QR Code"
              className="h-56 w-56 object-contain my-2"
            />
          )}
          <p className="text-xs text-muted-foreground font-mono">
            R$ {pixResult?.amount.toFixed(2).replace(".", ",")}
          </p>
        </DialogContent>
      </Dialog>
    </div>
  );
}
