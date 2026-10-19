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
  Sparkles,
  MessageSquare,
  Mic,
  Clock,
  User,
  Zap,
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

export interface SendPixModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  conversationId: string;
  contactName?: string | null;
  defaultTab?: "custom" | "company";
}

export function SendPixModal({
  open,
  onOpenChange,
  conversationId,
  contactName,
  defaultTab = "custom",
}: SendPixModalProps) {
  const [activeTab, setActiveTab] = useState<"custom" | "company">(defaultTab);
  const [loadingConfig, setLoadingConfig] = useState(false);
  const [sending, setSending] = useState(false);
  const [isConfigured, setIsConfigured] = useState(false);

  // Company default fields
  const [companyPixKey, setCompanyPixKey] = useState("");
  const [companyPixKeyType, setCompanyPixKeyType] = useState<PixKeyType>("EVP");
  const [companyMerchantName, setCompanyMerchantName] = useState("");

  // Custom key fields (Chave Personalizada por Mim)
  const [customPixKey, setCustomPixKey] = useState("");
  const [customPixKeyType, setCustomPixKeyType] = useState<PixKeyType>("CPF");
  const [customMerchantName, setCustomMerchantName] = useState("");
  const [saveAsDefault, setSaveAsDefault] = useState(false);

  // Common message fields
  const [optionalText, setOptionalText] = useState("");
  const [sendMode, setSendMode] = useState<"both" | "copia_e_cola" | "button">("button");
  const [amount, setAmount] = useState("");
  const [copiedCopiaECola, setCopiedCopiaECola] = useState(false);

  // ZapPlus follow-up toggle states
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

    setActiveTab(defaultTab || "custom");
    setLoadingConfig(true);
    setLoadingReplies(true);

    // Try to load last used custom key from localStorage
    try {
      const savedCustom = localStorage.getItem("wacrm_last_custom_pix");
      if (savedCustom) {
        const parsed = JSON.parse(savedCustom);
        if (parsed.key) {
          setCustomPixKey(parsed.key);
          setCustomPixKeyType(parsed.type || "CPF");
          if (parsed.name) setCustomMerchantName(parsed.name);
        }
      }
    } catch {}

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
          setCompanyPixKey(data.config.pix_key || "");
          setCompanyPixKeyType((data.config.pix_key_type as PixKeyType) || "EVP");
          setCompanyMerchantName(data.config.pix_merchant_name || "");

          if (!customMerchantName && data.config.pix_merchant_name) {
            setCustomMerchantName(data.config.pix_merchant_name);
          }

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
          setActiveTab("custom");
        }
      })
      .catch((err) => {
        console.error("Erro ao carregar configuração PIX:", err);
      })
      .finally(() => {
        setLoadingConfig(false);
      });
  }, [open, defaultTab]);

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
    const keyToSave = activeTab === "custom" ? customPixKey.trim() : companyPixKey.trim();
    const typeToSave = activeTab === "custom" ? customPixKeyType : companyPixKeyType;
    const nameToSave = activeTab === "custom" ? customMerchantName : companyMerchantName;

    if (keyToSave) {
      try {
        setSavingFollowUp(true);
        await fetch("/api/pix/config", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            pix_key: keyToSave,
            pix_key_type: typeToSave,
            pix_merchant_name: nameToSave || "Pix",
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
            ? "Disparo pós-PIX ativado! O cliente receberá o áudio/mensagem configurado após o envio."
            : "Disparo pós-PIX desativado para envios de PIX."
        );
      } catch (err) {
        console.warn("Erro ao salvar status do pós-PIX:", err);
      } finally {
        setSavingFollowUp(false);
      }
    }
  };

  // Auto-detect type when user types/pastes a custom key
  const handleCustomKeyChange = (val: string) => {
    setCustomPixKey(val);
    const detected = detectPixKeyType(val);
    if (detected) {
      setCustomPixKeyType(detected);
    }
  };

  // Active key data depending on tab
  const activeKey = activeTab === "custom" ? customPixKey : companyPixKey;
  const activeType = activeTab === "custom" ? customPixKeyType : companyPixKeyType;
  const activeMerchant = (activeTab === "custom" ? customMerchantName : companyMerchantName).trim() || "Pix";

  // Live generated BACEN standard Pix Copia e Cola
  const liveCopiaECola = useMemo(() => {
    if (!activeKey.trim()) return "";
    if (activeType === "COPIA_E_COLA" || activeKey.trim().startsWith("000201")) {
      return activeKey.trim();
    }
    try {
      return generatePixCopiaECola({
        pixKey: activeKey.trim(),
        pixKeyType: activeType,
        merchantName: activeMerchant,
        merchantCity: "SAO PAULO",
        amount: amount ? parseFloat(amount.replace(",", ".")) : undefined,
      });
    } catch {
      return "";
    }
  }, [activeKey, activeType, activeMerchant, amount]);

  const handleCopyCode = () => {
    if (!liveCopiaECola) return;
    navigator.clipboard.writeText(liveCopiaECola);
    setCopiedCopiaECola(true);
    toast.success("Código PIX Copia e Cola copiado!");
    setTimeout(() => setCopiedCopiaECola(false), 2000);
  };

  const handleSend = async () => {
    if (!activeKey.trim()) {
      toast.error(activeTab === "custom" ? "Informe sua chave PIX personalizada." : "Nenhuma chave PIX configurada para a empresa.");
      return;
    }

    const validation = validatePixKey(activeKey, activeType);
    if (!validation.valid) {
      toast.error(validation.error || "Chave PIX inválida.");
      return;
    }

    setSending(true);
    try {
      // Remember custom key locally
      if (activeTab === "custom") {
        try {
          localStorage.setItem(
            "wacrm_last_custom_pix",
            JSON.stringify({
              key: validation.formattedKey,
              type: activeType,
              name: customMerchantName.trim(),
            })
          );
        } catch {}
      }

      // If requested to save as default or if company is not configured, save to backend
      if ((activeTab === "custom" && saveAsDefault) || (!isConfigured && activeTab === "custom")) {
        await fetch("/api/pix/config", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            pix_key: validation.formattedKey,
            pix_key_type: activeType,
            pix_merchant_name: activeMerchant,
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
          pixKeyType: activeType,
          merchantName: activeMerchant,
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
      <DialogContent className="sm:max-w-md p-5 bg-card border-border max-h-[92vh] overflow-y-auto shadow-2xl">
        <DialogHeader className="pb-3 border-b border-border/60">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2.5">
              <div className="h-9 w-9 rounded-xl bg-emerald-500/15 text-emerald-600 flex items-center justify-center border border-emerald-500/30 shadow-xs">
                <QrCode className="h-5 w-5" />
              </div>
              <div>
                <DialogTitle className="text-sm font-bold text-foreground flex items-center gap-1.5">
                  Enviar Chave PIX
                  <Badge variant="outline" className="text-[9px] px-1.5 py-0 border-emerald-500/40 text-emerald-600 bg-emerald-500/10 font-normal">
                    Nativo WhatsApp
                  </Badge>
                </DialogTitle>
                <DialogDescription className="text-xs text-muted-foreground mt-0.5">
                  {contactName ? `Destinatário: ${contactName}` : "Envio de chave com botão oficial de cópia no WhatsApp"}
                </DialogDescription>
              </div>
            </div>
          </div>
        </DialogHeader>

        {/* Segmented Tab Switcher: Chave Personalizada vs Chave da Empresa */}
        <div className="mt-3 mb-1">
          <div className="flex rounded-lg bg-muted/60 p-1 border border-border/70 shadow-inner">
            <button
              type="button"
              onClick={() => setActiveTab("custom")}
              className={`flex-1 flex items-center justify-center gap-1.5 py-1.5 px-3 rounded-md text-xs font-semibold transition-all cursor-pointer ${
                activeTab === "custom"
                  ? "bg-background text-emerald-600 dark:text-emerald-400 shadow-xs border border-border/60"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              <User className="h-3.5 w-3.5 text-emerald-500" />
              <span>Chave Personalizada</span>
              <span className="text-[9px] px-1 py-0.2 rounded bg-emerald-500/10 text-emerald-600 font-mono font-normal">
                Minha Chave
              </span>
            </button>

            <button
              type="button"
              onClick={() => setActiveTab("company")}
              className={`flex-1 flex items-center justify-center gap-1.5 py-1.5 px-3 rounded-md text-xs font-semibold transition-all cursor-pointer ${
                activeTab === "company"
                  ? "bg-background text-emerald-600 dark:text-emerald-400 shadow-xs border border-border/60"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              <Building className="h-3.5 w-3.5 text-blue-500" />
              <span>Chave da Empresa</span>
              {isConfigured && (
                <span className="text-[9px] px-1 py-0.2 rounded bg-blue-500/10 text-blue-600 font-mono font-normal">
                  Salva
                </span>
              )}
            </button>
          </div>
        </div>

        {loadingConfig ? (
          <div className="py-12 flex flex-col items-center justify-center gap-2 text-muted-foreground">
            <Loader2 className="h-6 w-6 animate-spin text-emerald-600" />
            <span className="text-xs">Carregando configuração PIX...</span>
          </div>
        ) : (
          <div className="space-y-3.5 py-2">
            {/* TAB 1: CHAVE PERSONALIZADA POR MIM */}
            {activeTab === "custom" && (
              <div className="rounded-xl border border-emerald-500/30 bg-gradient-to-b from-emerald-500/10 via-emerald-500/5 to-transparent p-3.5 space-y-3 shadow-xs animate-in fade-in duration-150">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-bold text-foreground flex items-center gap-1.5">
                    <ShieldCheck className="h-4 w-4 text-emerald-600" />
                    Dados da Sua Chave Personalizada
                  </span>
                  <span className="text-[10px] text-emerald-700 dark:text-emerald-400 font-medium">
                    Digitar chave avulsa
                  </span>
                </div>

                <div className="space-y-2.5">
                  <div className="grid grid-cols-3 gap-2">
                    <div className="col-span-1">
                      <Label className="text-[11px] font-semibold text-foreground mb-1 block">
                        Tipo de Chave
                      </Label>
                      <select
                        value={customPixKeyType}
                        onChange={(e) => setCustomPixKeyType(e.target.value as PixKeyType)}
                        className="w-full h-8.5 px-2 text-xs rounded-md border border-border bg-background text-foreground font-medium focus:ring-1 focus:ring-emerald-500 cursor-pointer"
                      >
                        <option value="CPF">🪪 CPF / CNPJ</option>
                        <option value="PHONE">📱 Telefone / Celular</option>
                        <option value="EMAIL">✉️ E-mail</option>
                        <option value="EVP">🎲 Chave Aleatória</option>
                        <option value="COPIA_E_COLA">📋 Copia e Cola</option>
                      </select>
                    </div>
                    <div className="col-span-2">
                      <Label className="text-[11px] font-semibold text-foreground mb-1 flex items-center justify-between">
                        <span>{customPixKeyType === "COPIA_E_COLA" ? "Código Copia e Cola" : "Sua Chave PIX"}</span>
                        <span className="text-[9px] text-muted-foreground font-normal">Auto-detecção ativa</span>
                      </Label>
                      <Input
                        type="text"
                        value={customPixKey}
                        onChange={(e) => handleCustomKeyChange(e.target.value)}
                        placeholder={
                          customPixKeyType === "EMAIL"
                            ? "seu-email@dominio.com"
                            : customPixKeyType === "PHONE"
                            ? "11999999999 (com DDD)"
                            : customPixKeyType === "CPF"
                            ? "000.000.000-00 ou CNPJ"
                            : customPixKeyType === "COPIA_E_COLA"
                            ? "00020126..."
                            : "Chave aleatória UUID"
                        }
                        className="h-8.5 text-xs font-mono border-border focus-visible:ring-emerald-500"
                      />
                    </div>
                  </div>

                  <div>
                    <Label className="text-[11px] font-semibold text-foreground mb-1 flex items-center justify-between">
                      <span>Nome do Titular / Beneficiário (Opcional)</span>
                      <span className="text-[10px] text-muted-foreground font-normal">Nome exibido no comprovante</span>
                    </Label>
                    <Input
                      type="text"
                      value={customMerchantName}
                      onChange={(e) => setCustomMerchantName(e.target.value)}
                      placeholder="Ex: Seu Nome ou Razão Social"
                      className="h-8 text-xs border-border"
                    />
                  </div>
                </div>

                <div className="pt-1 flex items-center justify-between border-t border-emerald-500/20">
                  <label className="flex items-center gap-2 text-[11px] text-muted-foreground hover:text-foreground cursor-pointer select-none">
                    <input
                      type="checkbox"
                      checked={saveAsDefault}
                      onChange={(e) => setSaveAsDefault(e.target.checked)}
                      className="rounded border-border text-emerald-600 focus:ring-emerald-500 h-3.5 w-3.5"
                    />
                    <span>Salvar esta chave como padrão da empresa para futuros envios</span>
                  </label>
                </div>
              </div>
            )}

            {/* TAB 2: CHAVE DA EMPRESA CADASTRADA */}
            {activeTab === "company" && (
              <div className="rounded-xl border border-border/80 bg-muted/30 p-3.5 space-y-2.5 animate-in fade-in duration-150">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-bold text-foreground flex items-center gap-1.5">
                    <Building className="h-4 w-4 text-blue-600" />
                    Chave Oficial da Empresa
                  </span>
                  {isConfigured && (
                    <Badge variant="outline" className="text-[10px] text-blue-600 bg-blue-500/10 border-blue-500/20">
                      Cadastrada nas Configurações
                    </Badge>
                  )}
                </div>

                {isConfigured && companyPixKey ? (
                  <div className="space-y-2.5">
                    <div className="grid grid-cols-2 gap-2 text-xs">
                      <div className="p-2 rounded bg-background/90 border border-border/60">
                        <span className="text-[10px] text-muted-foreground block font-medium">Tipo de Chave</span>
                        <span className="font-semibold text-foreground flex items-center gap-1 mt-0.5">
                          <KeyRound className="h-3 w-3 text-emerald-600" />
                          {companyPixKeyType}
                        </span>
                      </div>
                      <div className="p-2 rounded bg-background/90 border border-border/60">
                        <span className="text-[10px] text-muted-foreground block font-medium">Beneficiário</span>
                        <span className="font-semibold text-foreground truncate block mt-0.5">
                          {companyMerchantName || "Empresa"}
                        </span>
                      </div>
                    </div>

                    <div className="p-2.5 rounded bg-background/90 border border-border/60">
                      <span className="text-[10px] text-muted-foreground block font-medium">Chave Cadastrada</span>
                      <span className="font-mono text-xs font-semibold text-emerald-600 dark:text-emerald-400 break-all select-all block mt-0.5">
                        {companyPixKey}
                      </span>
                    </div>
                  </div>
                ) : (
                  <div className="p-4 text-center space-y-2.5 bg-background/60 rounded-lg border border-dashed border-border">
                    <AlertCircle className="h-5 w-5 text-amber-500 mx-auto" />
                    <p className="text-xs text-muted-foreground">
                      Nenhuma chave cadastrada como padrão da empresa nas configurações.
                    </p>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={() => setActiveTab("custom")}
                      className="text-xs text-emerald-600 hover:text-emerald-700 font-semibold cursor-pointer"
                    >
                      Usar Chave Personalizada
                    </Button>
                  </div>
                )}
              </div>
            )}

            {/* Formato de Envio no WhatsApp */}
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
                        rows={2}
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

            {/* Mensagem Introdutória opcional */}
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
            disabled={sending || loadingConfig || !activeKey.trim()}
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
                  {activeTab === "custom"
                    ? (sendMode === "copia_e_cola"
                        ? "⚡ Enviar Chave Personalizada (Copia e Cola)"
                        : sendMode === "both"
                        ? "⚡ Enviar Chave Personalizada (Botão + Código)"
                        : "⚡ Enviar Chave Personalizada")
                    : (sendMode === "copia_e_cola"
                        ? "⚡ Enviar Chave da Empresa (Copia e Cola)"
                        : sendMode === "both"
                        ? "⚡ Enviar Chave da Empresa (Botão + Código)"
                        : "⚡ Enviar Chave da Empresa")}
                </span>
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
