"use client";

import { useState, useEffect } from "react";
import { toast } from "sonner";
import {
  QrCode,
  Send,
  Loader2,
  Copy,
  Check,
  Building,
  KeyRound,
  ShieldCheck,
  AlertCircle,
  Pencil,
} from "lucide-react";
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
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { type PixKeyType, validatePixKey, detectPixKeyType } from "@/lib/pix/pix-validator";

interface SendPixModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  conversationId: string;
  contactName?: string | null;
}

export function SendPixModal({
  open,
  onOpenChange,
  conversationId,
  contactName,
}: SendPixModalProps) {
  const [loadingConfig, setLoadingConfig] = useState(false);
  const [sending, setSending] = useState(false);
  const [isConfigured, setIsConfigured] = useState(false);

  // Config / override fields
  const [pixKey, setPixKey] = useState("");
  const [pixKeyType, setPixKeyType] = useState<PixKeyType>("EVP");
  const [merchantName, setMerchantName] = useState("");
  const [optionalText, setOptionalText] = useState("Segue a nossa chave PIX para pagamento:");
  const [isEditingOverride, setIsEditingOverride] = useState(false);
  const [saveAsDefault, setSaveAsDefault] = useState(false);

  // Load account config when opening
  useEffect(() => {
    if (!open) return;
    setLoadingConfig(true);
    fetch("/api/pix/config")
      .then((res) => res.json())
      .then((data) => {
        if (data.is_configured && data.config) {
          setIsConfigured(true);
          setPixKey(data.config.pix_key || "");
          setPixKeyType((data.config.pix_key_type as PixKeyType) || "EVP");
          setMerchantName(data.config.pix_merchant_name || "");
          setIsEditingOverride(false);
        } else {
          setIsConfigured(false);
          setIsEditingOverride(true);
          setSaveAsDefault(true);
        }
      })
      .catch((err) => {
        console.error("Erro ao carregar configuração PIX:", err);
      })
      .finally(() => {
        setLoadingConfig(false);
      });
  }, [open]);

  // Auto-detect type when key changes and in edit mode
  const handleKeyChange = (val: string) => {
    setPixKey(val);
    const detected = detectPixKeyType(val);
    if (detected && isEditingOverride) {
      setPixKeyType(detected);
    }
  };

  const handleSend = async () => {
    if (!pixKey.trim()) {
      toast.error("Informe a chave PIX.");
      return;
    }

    const validation = validatePixKey(pixKey, pixKeyType);
    if (!validation.valid) {
      toast.error(validation.error || "Chave PIX inválida.");
      return;
    }

    setSending(true);
    try {
      // If requested or if not configured, save as default in background
      if (saveAsDefault || !isConfigured) {
        await fetch("/api/pix/config", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            pix_key: validation.formattedKey,
            pix_key_type: pixKeyType,
            pix_merchant_name: merchantName || "Pix",
          }),
        }).catch(() => {});
      }

      const res = await fetch("/api/whatsapp/send-pix", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          conversationId,
          text: optionalText.trim() || undefined,
          pixKey: validation.formattedKey,
          pixKeyType,
          merchantName: merchantName.trim() || undefined,
        }),
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || "Falha ao enviar chave PIX pelo WhatsApp.");
      }

      toast.success(
        `✅ Mensagem PIX nativa enviada com sucesso para ${contactName || "o cliente"}!`
      );
      onOpenChange(false);
    } catch (err: any) {
      console.error("[SendPixModal] Error:", err);
      toast.error(err?.message || "Erro ao disparar mensagem PIX.");
    } finally {
      setSending(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md p-5 bg-card border-border">
        <DialogHeader className="pb-3 border-b border-border/60">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <div className="h-8 w-8 rounded-lg bg-emerald-500/15 text-emerald-600 flex items-center justify-center">
                <QrCode className="h-4 w-4" />
              </div>
              <div>
                <DialogTitle className="text-sm font-bold text-foreground">
                  Enviar Chave PIX (Nativo WhatsApp)
                </DialogTitle>
                <DialogDescription className="text-xs text-muted-foreground">
                  {contactName ? `Destinatário: ${contactName}` : "Mensagem nativa com botão de cópia automática"}
                </DialogDescription>
              </div>
            </div>
            <Badge variant="outline" className="bg-emerald-500/10 text-emerald-600 border-emerald-500/30 text-[10px] uppercase font-bold">
              WhatsApp Pay
            </Badge>
          </div>
        </DialogHeader>

        {loadingConfig ? (
          <div className="flex h-44 items-center justify-center gap-2 text-xs text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin text-emerald-500" />
            <span>Carregando configuração PIX...</span>
          </div>
        ) : (
          <div className="space-y-4 py-2 text-xs">
            {/* Modo Configurado vs Modo Edição */}
            {isConfigured && !isEditingOverride ? (
              <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/5 p-3.5 space-y-2.5">
                <div className="flex items-center justify-between">
                  <span className="font-semibold text-foreground flex items-center gap-1.5">
                    <ShieldCheck className="h-4 w-4 text-emerald-600" />
                    Chave PIX da Empresa
                  </span>
                  <button
                    type="button"
                    onClick={() => setIsEditingOverride(true)}
                    className="text-[11px] text-emerald-700 dark:text-emerald-400 hover:underline flex items-center gap-1 cursor-pointer font-medium"
                  >
                    <Pencil className="h-3 w-3" />
                    Alterar
                  </button>
                </div>

                <div className="space-y-1">
                  <div className="flex items-center justify-between text-[11px] text-muted-foreground">
                    <span>Recebedor:</span>
                    <span className="font-semibold text-foreground">{merchantName || "Pix"}</span>
                  </div>
                  <div className="flex items-center justify-between text-[11px] text-muted-foreground">
                    <span>Tipo:</span>
                    <span className="font-mono uppercase font-bold text-emerald-600">{pixKeyType}</span>
                  </div>
                  <div className="pt-1">
                    <span className="font-mono text-xs text-foreground bg-background/80 p-2 rounded border border-border/60 break-all select-all block">
                      {pixKey}
                    </span>
                  </div>
                </div>
              </div>
            ) : (
              <div className="rounded-xl border border-border bg-muted/20 p-3.5 space-y-3">
                <div className="flex items-center justify-between">
                  <span className="font-semibold text-foreground flex items-center gap-1.5">
                    <KeyRound className="h-4 w-4 text-primary" />
                    {isConfigured ? "Alterar Chave para Este Envio" : "Cadastrar Chave PIX da Empresa"}
                  </span>
                  {isConfigured && (
                    <button
                      type="button"
                      onClick={() => setIsEditingOverride(false)}
                      className="text-[11px] text-muted-foreground hover:underline cursor-pointer"
                    >
                      Voltar ao padrão
                    </button>
                  )}
                </div>

                <div className="grid grid-cols-3 gap-2">
                  <div className="col-span-1">
                    <Label className="text-[11px] text-muted-foreground mb-1 block">Tipo</Label>
                    <select
                      value={pixKeyType}
                      onChange={(e) => setPixKeyType(e.target.value as PixKeyType)}
                      className="w-full h-8 px-2 text-xs rounded-md border border-border bg-background text-foreground"
                    >
                      <option value="EMAIL">E-mail</option>
                      <option value="PHONE">Telefone</option>
                      <option value="CPF">CPF/CNPJ</option>
                      <option value="EVP">Aleatória (EVP)</option>
                    </select>
                  </div>
                  <div className="col-span-2">
                    <Label className="text-[11px] text-muted-foreground mb-1 block">Chave PIX</Label>
                    <Input
                      value={pixKey}
                      onChange={(e) => handleKeyChange(e.target.value)}
                      placeholder={
                        pixKeyType === "EMAIL"
                          ? "financeiro@empresa.com"
                          : pixKeyType === "PHONE"
                          ? "11987654321"
                          : pixKeyType === "CPF"
                          ? "123.456.789-00"
                          : "UUID da chave aleatória"
                      }
                      className="h-8 text-xs font-mono"
                    />
                  </div>
                </div>

                <div>
                  <Label className="text-[11px] text-muted-foreground mb-1 block">
                    Nome do Recebedor (Razão Social / Nome Fantasia)
                  </Label>
                  <Input
                    value={merchantName}
                    onChange={(e) => setMerchantName(e.target.value)}
                    placeholder="Ex: Macacos Produções"
                    className="h-8 text-xs"
                  />
                </div>

                <label className="flex items-center gap-2 cursor-pointer pt-1 text-[11px] text-muted-foreground hover:text-foreground">
                  <input
                    type="checkbox"
                    checked={saveAsDefault}
                    onChange={(e) => setSaveAsDefault(e.target.checked)}
                    className="rounded border-border text-emerald-600 focus:ring-emerald-500 h-3.5 w-3.5"
                  />
                  <span>Salvar como chave PIX padrão da empresa</span>
                </label>
              </div>
            )}

            {/* Mensagem opcional de texto */}
            <div>
              <Label className="text-[11px] font-medium text-foreground mb-1 block">
                Mensagem Introdutória (Opcional)
              </Label>
              <Textarea
                rows={2}
                value={optionalText}
                onChange={(e) => setOptionalText(e.target.value)}
                placeholder="Ex: Segue a nossa chave PIX para pagamento:"
                className="text-xs leading-relaxed resize-none"
              />
              <p className="mt-1 text-[10px] text-muted-foreground">
                O cliente receberá esta mensagem acompanhada do card nativo do WhatsApp com o botão oficial "Copiar Chave".
              </p>
            </div>
          </div>
        )}

        <DialogFooter className="pt-2 border-t border-border/60 gap-2 sm:gap-0">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => onOpenChange(false)}
            disabled={sending}
          >
            Cancelar
          </Button>
          <Button
            type="button"
            size="sm"
            onClick={handleSend}
            disabled={sending || loadingConfig || !pixKey.trim()}
            className="gap-1.5 bg-emerald-600 text-white hover:bg-emerald-700 shadow-sm font-semibold"
          >
            {sending ? (
              <>
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                <span>Disparando PIX...</span>
              </>
            ) : (
              <>
                <Send className="h-3.5 w-3.5" />
                <span>⚡ Enviar PIX Nativo</span>
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
