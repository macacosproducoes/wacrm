"use client";

import { useState, useEffect, useMemo } from "react";
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
  Sparkles,
  MessageSquare,
  Mic,
  Clock,
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
import { Switch } from "@/components/ui/switch";
import { type PixKeyType, validatePixKey, detectPixKeyType } from "@/lib/pix/pix-validator";
import { generatePixCopiaECola } from "@/lib/pix/pix-copia-e-cola";

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
  const [optionalText, setOptionalText] = useState("");
  const [isEditingOverride, setIsEditingOverride] = useState(false);
  const [saveAsDefault, setSaveAsDefault] = useState(false);
  const [sendMode, setSendMode] = useState<"both" | "copia_e_cola" | "button">("button");
  const [amount, setAmount] = useState("");
  const [copiedCopiaECola, setCopiedCopiaECola] = useState(false);

  // ZapPlus follow-up toggle states (default: deactivated)
  const [quickReplies, setQuickReplies] = useState<any[]>([]);
  const [loadingReplies, setLoadingReplies] = useState(false);
  const [followUpEnabled, setFollowUpEnabled] = useState(false);
  const [followUpType, setFollowUpType] = useState<"text" | "audio">("text");
  const [followUpQuickReplyId, setFollowUpQuickReplyId] = useState<string>("");
  const [followUpContent, setFollowUpContent] = useState<string>("");
  const [followUpMediaUrl, setFollowUpMediaUrl] = useState<string>("");
  const [followUpDelay, setFollowUpDelay] = useState<number>(5);
  const [savingFollowUp, setSavingFollowUp] = useState(false);

  // Load account config & ZapPlus quick replies when opening
  useEffect(() => {
    if (!open) return;
    setLoadingConfig(true);
    setLoadingReplies(true);

    fetch("/api/quick-replies")
      .then((res) => res.json())
      .then((data) => {
        const items = Array.isArray(data) ? data : data?.quick_replies || data?.data || [];
        setQuickReplies(items);
      })
      .catch((err) => console.error("Erro ao carregar ZapPlus:", err))
      .finally(() => setLoadingReplies(false));

    fetch("/api/pix/config")
      .then((res) => res.json())
      .then((data) => {
        if (data.is_configured && data.config) {
          setIsConfigured(true);
          setPixKey(data.config.pix_key || "");
          setPixKeyType((data.config.pix_key_type as PixKeyType) || "EVP");
          setMerchantName(data.config.pix_merchant_name || "");
          setIsEditingOverride(false);

          // Follow-up toggle loaded from server
          setFollowUpEnabled(Boolean(data.config.pix_follow_up_enabled));
          if (data.config.pix_follow_up_type) {
            setFollowUpType(data.config.pix_follow_up_type);
          }
          if (data.config.pix_follow_up_quick_reply_id) {
            setFollowUpQuickReplyId(data.config.pix_follow_up_quick_reply_id);
          }
          if (data.config.pix_follow_up_content) {
            setFollowUpContent(data.config.pix_follow_up_content);
          }
          if (data.config.pix_follow_up_media_url) {
            setFollowUpMediaUrl(data.config.pix_follow_up_media_url);
          }
          if (typeof data.config.pix_follow_up_delay_seconds === "number") {
            setFollowUpDelay(data.config.pix_follow_up_delay_seconds);
          }
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

  // Available ZapPlus replies (filtered to text and audio)
  const availableZapPlus = useMemo(() => {
    return quickReplies.filter((qr) => !qr.kind || qr.kind === "text" || qr.kind === "audio");
  }, [quickReplies]);

  // Handle Quick Reply selection
  const handleSelectQuickReply = (selectedId: string) => {
    setFollowUpQuickReplyId(selectedId);
    if (!selectedId) {
      setFollowUpContent("");
      setFollowUpMediaUrl("");
      return;
    }
    const found = quickReplies.find((qr) => String(qr.id) === String(selectedId));
    if (found) {
      const isAudio = found.kind === "audio";
      setFollowUpType(isAudio ? "audio" : "text");
      setFollowUpMediaUrl(found.media_url || "");
      setFollowUpContent(found.content_text || found.title || "");
    }
  };

  // Toggle follow-up state and auto-sync with company settings
  const handleToggleFollowUp = async (enabled: boolean) => {
    setFollowUpEnabled(enabled);
    if (pixKey.trim()) {
      try {
        setSavingFollowUp(true);
        await fetch("/api/pix/config", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            pix_key: pixKey.trim(),
            pix_key_type: pixKeyType,
            pix_merchant_name: merchantName || "Pix",
            pix_follow_up_enabled: enabled,
            pix_follow_up_type: followUpType,
            pix_follow_up_quick_reply_id: followUpQuickReplyId || null,
            pix_follow_up_content: followUpContent,
            pix_follow_up_media_url: followUpMediaUrl || null,
            pix_follow_up_delay_seconds: followUpDelay,
          }),
        });
        toast.success(
          enabled
            ? "Disparo pós-PIX ativado! Todos os envios de PIX realizarão o envio automático após o atraso configurado."
            : "Disparo pós-PIX desativado para todos os envios de PIX."
        );
      } catch (err) {
        console.warn("Erro ao salvar status do pós-PIX:", err);
      } finally {
        setSavingFollowUp(false);
      }
    }
  };

  // Auto-detect type when key changes and in edit mode
  const handleKeyChange = (val: string) => {
    setPixKey(val);
    const detected = detectPixKeyType(val);
    if (detected && isEditingOverride) {
      setPixKeyType(detected);
    }
  };

  // Live generated BACEN standard Pix Copia e Cola
  const liveCopiaECola = useMemo(() => {
    if (!pixKey.trim()) return "";
    if (pixKeyType === "COPIA_E_COLA" || pixKey.trim().startsWith("000201")) {
      return pixKey.trim();
    }
    try {
      return generatePixCopiaECola({
        pixKey: pixKey.trim(),
        pixKeyType,
        merchantName: merchantName.trim() || "PIX",
        merchantCity: "SAO PAULO",
        amount: amount ? parseFloat(amount.replace(",", ".")) : undefined,
      });
    } catch {
      return "";
    }
  }, [pixKey, pixKeyType, merchantName, amount]);

  const handleCopyCode = () => {
    if (!liveCopiaECola) return;
    navigator.clipboard.writeText(liveCopiaECola);
    setCopiedCopiaECola(true);
    toast.success("Código PIX Copia e Cola copiado!");
    setTimeout(() => setCopiedCopiaECola(false), 2000);
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
      if (saveAsDefault || !isConfigured || followUpEnabled) {
        await fetch("/api/pix/config", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            pix_key: validation.formattedKey,
            pix_key_type: pixKeyType,
            pix_merchant_name: merchantName || "Pix",
            pix_follow_up_enabled: followUpEnabled,
            pix_follow_up_type: followUpType,
            pix_follow_up_quick_reply_id: followUpQuickReplyId || null,
            pix_follow_up_content: followUpContent,
            pix_follow_up_media_url: followUpMediaUrl || null,
            pix_follow_up_delay_seconds: followUpDelay,
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
          sendMode,
          amount: amount ? parseFloat(amount.replace(",", ".")) : undefined,
          followUpEnabled,
          followUpType,
          followUpContent: followUpContent || undefined,
          followUpMediaUrl: followUpMediaUrl || undefined,
          followUpDelaySeconds: followUpDelay,
        }),
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || "Falha ao enviar chave PIX pelo WhatsApp.");
      }

      toast.success(
        sendMode === "copia_e_cola"
          ? `✅ PIX Copia e Cola enviado com sucesso para ${contactName || "o cliente"}!`
          : sendMode === "both"
          ? `✅ PIX (Botão Nativo + Copia e Cola) enviado para ${contactName || "o cliente"}!`
          : `✅ Mensagem PIX nativa enviada com sucesso para ${contactName || "o cliente"}!`
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
      <DialogContent className="sm:max-w-md p-5 bg-card border-border max-h-[90vh] overflow-y-auto">
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
            <Badge variant="secondary" className="text-[10px] bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 border-emerald-500/20">
              Nativo WhatsApp
            </Badge>
          </div>
        </DialogHeader>

        {loadingConfig ? (
          <div className="py-12 flex flex-col items-center justify-center gap-2 text-muted-foreground">
            <Loader2 className="h-6 w-6 animate-spin text-emerald-600" />
            <span className="text-xs">Carregando configuração PIX...</span>
          </div>
        ) : (
          <div className="space-y-3.5 py-2">
            {/* Chave da Empresa Configurada */}
            {isConfigured && !isEditingOverride && (
              <div className="rounded-lg border border-border/80 bg-muted/40 p-3 space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-[11px] font-semibold text-foreground flex items-center gap-1.5">
                    <Building className="h-3.5 w-3.5 text-emerald-600" />
                    Chave PIX da Empresa
                  </span>
                  <button
                    type="button"
                    onClick={() => setIsEditingOverride(true)}
                    className="text-[10px] text-muted-foreground hover:text-foreground flex items-center gap-1 underline underline-offset-2 cursor-pointer"
                  >
                    <Pencil className="h-2.5 w-2.5" /> Alterar para este envio
                  </button>
                </div>

                <div className="grid grid-cols-2 gap-2 text-xs">
                  <div className="p-2 rounded bg-background/80 border border-border/60">
                    <span className="text-[10px] text-muted-foreground block">Tipo</span>
                    <span className="font-semibold text-foreground flex items-center gap-1">
                      <KeyRound className="h-3 w-3 text-emerald-600" />
                      {pixKeyType}
                    </span>
                  </div>
                  <div className="p-2 rounded bg-background/80 border border-border/60">
                    <span className="text-[10px] text-muted-foreground block">Beneficiário</span>
                    <span className="font-semibold text-foreground truncate block">
                      {merchantName || "Empresa"}
                    </span>
                  </div>
                </div>

                <div className="p-2 rounded bg-background/80 border border-border/60">
                  <span className="text-[10px] text-muted-foreground block">Chave</span>
                  <span className="font-mono text-xs font-semibold text-emerald-600 dark:text-emerald-400 break-all select-all">
                    {pixKey}
                  </span>
                </div>
              </div>
            )}

            {/* Custom / Override Form */}
            {(!isConfigured || isEditingOverride) && (
              <div className="rounded-lg border border-border/80 bg-muted/20 p-3 space-y-2.5">
                <div className="flex items-center justify-between">
                  <span className="text-[11px] font-semibold text-foreground flex items-center gap-1">
                    <ShieldCheck className="h-3.5 w-3.5 text-emerald-600" />
                    {isConfigured ? "Personalizar Chave para Este Envio" : "Configurar Chave PIX da Empresa"}
                  </span>
                  {isConfigured && (
                    <button
                      type="button"
                      onClick={() => setIsEditingOverride(false)}
                      className="text-[10px] text-muted-foreground hover:text-foreground underline cursor-pointer"
                    >
                      Voltar ao padrão
                    </button>
                  )}
                </div>

                <div className="space-y-2">
                  <div className="grid grid-cols-3 gap-2">
                    <div className="col-span-1">
                      <Label className="text-[11px] text-muted-foreground mb-1 block">Tipo</Label>
                      <select
                        value={pixKeyType}
                        onChange={(e) => setPixKeyType(e.target.value as PixKeyType)}
                        className="w-full h-8 px-2 text-xs rounded-md border border-border bg-background text-foreground"
                      >
                        <option value="COPIA_E_COLA">PIX Copia e Cola</option>
                        <option value="EMAIL">E-mail</option>
                        <option value="PHONE">Telefone</option>
                        <option value="CPF">CPF/CNPJ</option>
                        <option value="EVP">Aleatória (EVP)</option>
                      </select>
                    </div>
                    <div className="col-span-2">
                      <Label className="text-[11px] text-muted-foreground mb-1 block">
                        {pixKeyType === "COPIA_E_COLA" ? "Código PIX Copia e Cola" : "Chave PIX"}
                      </Label>
                      <Input
                        type="text"
                        value={pixKey}
                        onChange={(e) => handleKeyChange(e.target.value)}
                        placeholder={
                          pixKeyType === "EMAIL"
                            ? "contato@empresa.com"
                            : pixKeyType === "PHONE"
                            ? "+55 11 99999-9999"
                            : pixKeyType === "CPF"
                            ? "000.000.000-00"
                            : pixKeyType === "COPIA_E_COLA"
                            ? "00020126..."
                            : "Chave aleatória EVP"
                        }
                        className="h-8 text-xs font-mono"
                      />
                    </div>
                  </div>

                  <div>
                    <Label className="text-[11px] text-muted-foreground mb-1 block">
                      Nome do Titular / Beneficiário (Opcional)
                    </Label>
                    <Input
                      type="text"
                      value={merchantName}
                      onChange={(e) => setMerchantName(e.target.value)}
                      placeholder="Ex: Minha Empresa LTDA"
                      className="h-8 text-xs"
                    />
                  </div>
                </div>

                <label className="flex items-center gap-2 pt-1 text-[11px] text-muted-foreground cursor-pointer">
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

            {/* Formato de Envio */}
            <div className="space-y-1.5">
              <Label className="text-[11px] font-semibold text-foreground flex items-center justify-between">
                <span>Formato de Envio no WhatsApp</span>
                <span className="text-[10px] text-muted-foreground font-normal">
                  Padrão BACEN aceito por todos os bancos
                </span>
              </Label>
              <div className="grid grid-cols-3 gap-1.5">
                <button
                  type="button"
                  onClick={() => setSendMode("button")}
                  className={`px-2 py-1.5 rounded-lg border text-[11px] font-medium transition-all text-center cursor-pointer ${
                    sendMode === "button"
                      ? "border-emerald-500 bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 font-semibold shadow-xs"
                      : "border-border bg-background hover:bg-muted/60 text-muted-foreground"
                  }`}
                >
                  <span className="block font-bold">Botão Nativo</span>
                  <span className="text-[9px] opacity-80">Somente Card Oficial</span>
                </button>
                <button
                  type="button"
                  onClick={() => setSendMode("copia_e_cola")}
                  className={`px-2 py-1.5 rounded-lg border text-[11px] font-medium transition-all text-center cursor-pointer ${
                    sendMode === "copia_e_cola"
                      ? "border-emerald-500 bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 font-semibold shadow-xs"
                      : "border-border bg-background hover:bg-muted/60 text-muted-foreground"
                  }`}
                >
                  <span className="block font-bold">Copia e Cola</span>
                  <span className="text-[9px] opacity-80">Padrão Bancário</span>
                </button>
                <button
                  type="button"
                  onClick={() => setSendMode("both")}
                  className={`px-2 py-1.5 rounded-lg border text-[11px] font-medium transition-all text-center cursor-pointer ${
                    sendMode === "both"
                      ? "border-emerald-500 bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 font-semibold shadow-xs"
                      : "border-border bg-background hover:bg-muted/60 text-muted-foreground"
                  }`}
                >
                  <span className="block font-bold">Ambos</span>
                  <span className="text-[9px] opacity-80">Botão + Copia e Cola</span>
                </button>
              </div>
            </div>

            {/* Disparo Automático Pós-PIX (ZapPlus Toggle) */}
            <div className="rounded-lg border border-border/70 bg-card/60 p-3 space-y-2.5">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <div className="h-6 w-6 rounded-md bg-emerald-500/10 text-emerald-600 flex items-center justify-center">
                    <Sparkles className="h-3.5 w-3.5" />
                  </div>
                  <div>
                    <Label className="text-xs font-semibold text-foreground cursor-pointer flex items-center gap-1.5" htmlFor="follow-up-switch">
                      <span>Mensagem ou Áudio após o PIX</span>
                      <Badge variant="outline" className="text-[9px] px-1.5 py-0 border-emerald-500/40 text-emerald-600 bg-emerald-500/5">
                        ZapPlus
                      </Badge>
                    </Label>
                    <p className="text-[10px] text-muted-foreground">
                      Envia uma mensagem ou áudio após a chave PIX com atraso configurável
                    </p>
                  </div>
                </div>
                <Switch
                  id="follow-up-switch"
                  checked={followUpEnabled}
                  onCheckedChange={(checked) => handleToggleFollowUp(checked)}
                  disabled={savingFollowUp}
                />
              </div>

              {followUpEnabled && (
                <div className="pt-2 border-t border-border/50 space-y-2.5 animate-in fade-in slide-in-from-top-1 duration-200">
                  <div className="space-y-1">
                    <Label className="text-[11px] font-medium text-foreground flex items-center justify-between">
                      <span>Conteúdo Salvo (ZapPlus)</span>
                      {loadingReplies && <span className="text-[10px] text-muted-foreground">Carregando...</span>}
                    </Label>
                    <select
                      value={followUpQuickReplyId}
                      onChange={(e) => handleSelectQuickReply(e.target.value)}
                      className="w-full h-8 px-2 text-xs rounded-md border border-border bg-background text-foreground"
                    >
                      <option value="">-- Selecione uma mensagem ou áudio salvo --</option>
                      {availableZapPlus.map((qr) => (
                        <option key={qr.id} value={qr.id}>
                          {qr.kind === "audio" ? "🎙️ [Áudio] " : "💬 [Texto] "}{qr.title || (qr.content_text ? qr.content_text.slice(0, 30) : "Item ZapPlus")}
                        </option>
                      ))}
                    </select>
                  </div>

                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <Label className="text-[11px] font-medium text-foreground mb-1 flex items-center gap-1">
                        <Clock className="h-3 w-3 text-muted-foreground" />
                        <span>Atraso no Envio</span>
                      </Label>
                      <div className="flex items-center gap-1.5">
                        <Input
                          type="number"
                          min={1}
                          max={60}
                          value={followUpDelay}
                          onChange={(e) => {
                            const val = Math.max(1, Math.min(60, Number(e.target.value) || 1));
                            setFollowUpDelay(val);
                          }}
                          className="h-8 text-xs font-mono"
                        />
                        <span className="text-[11px] text-muted-foreground">segundos</span>
                      </div>
                    </div>

                    <div>
                      <Label className="text-[11px] font-medium text-foreground mb-1 block">
                        Tipo Detectado
                      </Label>
                      <div className="h-8 flex items-center px-2.5 rounded-md border border-border bg-muted/40 text-xs text-foreground font-medium">
                        {followUpType === "audio" ? (
                          <span className="flex items-center gap-1.5 text-blue-600 dark:text-blue-400">
                            <Mic className="h-3.5 w-3.5" /> Áudio (Nota de Voz)
                          </span>
                        ) : (
                          <span className="flex items-center gap-1.5 text-emerald-600 dark:text-emerald-400">
                            <MessageSquare className="h-3.5 w-3.5" /> Mensagem de Texto
                          </span>
                        )}
                      </div>
                    </div>
                  </div>

                  {followUpType === "text" ? (
                    <div className="space-y-1">
                      <Label className="text-[11px] font-medium text-foreground flex items-center justify-between">
                        <span>Texto da Mensagem após o PIX</span>
                        <span className="text-[10px] text-muted-foreground">Personalizável</span>
                      </Label>
                      <Textarea
                        value={followUpContent}
                        onChange={(e) => setFollowUpContent(e.target.value)}
                        placeholder="Digite o texto que será enviado automaticamente após o PIX..."
                        className="text-xs min-h-[60px] resize-y"
                      />
                    </div>
                  ) : (
                    followUpContent && (
                      <div className="p-2 rounded bg-muted/30 border border-border/40 text-[10px] text-muted-foreground space-y-0.5">
                        <span className="font-semibold text-foreground flex items-center gap-1">
                          Áudio selecionado (ZapPlus):
                        </span>
                        <p className="line-clamp-2 italic text-foreground/80 font-medium">
                          🎙️ {followUpContent}
                        </p>
                      </div>
                    )
                  )}
                </div>
              )}
            </div>

            {/* Valor do PIX (Opcional) */}
            <div>
              <Label className="text-[11px] font-medium text-foreground mb-1 flex items-center justify-between">
                <span>Valor (R$) — Opcional</span>
                <span className="text-[10px] text-muted-foreground">Deixe em branco para valor livre</span>
              </Label>
              <Input
                type="text"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                placeholder="Ex: 49,90"
                className="h-8 text-xs font-mono"
              />
            </div>

            {/* Live Copia e Cola Preview */}
            {liveCopiaECola && sendMode !== "button" && (
              <div className="rounded-lg border border-border bg-muted/30 p-2.5 space-y-1.5">
                <div className="flex items-center justify-between">
                  <span className="text-[11px] font-semibold text-foreground flex items-center gap-1">
                    <Copy className="h-3 w-3 text-emerald-600" />
                    Código Pix Copia e Cola Oficial (BACEN):
                  </span>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    onClick={handleCopyCode}
                    className="h-6 px-2 text-[10px] gap-1 text-emerald-600 hover:text-emerald-700 hover:bg-emerald-500/10 cursor-pointer"
                  >
                    {copiedCopiaECola ? (
                      <>
                        <Check className="h-3 w-3 text-emerald-600" />
                        <span>Copiado</span>
                      </>
                    ) : (
                      <>
                        <Copy className="h-3 w-3" />
                        <span>Copiar</span>
                      </>
                    )}
                  </Button>
                </div>
                <div className="font-mono text-[10px] text-muted-foreground bg-background/80 p-2 rounded border border-border/50 break-all select-all leading-tight max-h-16 overflow-y-auto">
                  {liveCopiaECola}
                </div>
                <p className="text-[10px] text-emerald-600 dark:text-emerald-400">
                  ✓ Reconhecido instantaneamente em Nubank, Itaú, Bradesco, Inter, Santander, etc.
                </p>
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
                placeholder="Deixe em branco para enviar somente o Card nativo do PIX..."
                className="text-xs leading-relaxed resize-none"
              />
              <p className="mt-1 text-[10px] text-muted-foreground">
                {sendMode === "copia_e_cola"
                  ? "O cliente receberá esta mensagem e em seguida o código oficial Copia e Cola para colar no aplicativo do banco."
                  : sendMode === "both"
                  ? "O cliente receberá o card oficial do WhatsApp com botão e o código Copia e Cola padrão."
                  : "O cliente receberá SOMENTE o card oficial nativo do WhatsApp com o botão oficial \"Copiar Chave\" (sem texto extra)."}
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
            className="gap-1.5 bg-emerald-600 text-white hover:bg-emerald-700 shadow-sm font-semibold cursor-pointer"
          >
            {sending ? (
              <>
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                <span>Disparando PIX...</span>
              </>
            ) : (
              <>
                <Send className="h-3.5 w-3.5" />
                <span>
                  {sendMode === "copia_e_cola"
                    ? "⚡ Enviar Copia e Cola"
                    : sendMode === "both"
                    ? "⚡ Enviar Botão + Copia e Cola"
                    : "⚡ Enviar PIX Nativo (Somente Card)"}
                </span>
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
