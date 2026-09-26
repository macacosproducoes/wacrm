'use client';

import { useState, useEffect } from 'react';
import { toast } from 'sonner';
import {
  QrCode,
  CheckCircle2,
  AlertCircle,
  Copy,
  Check,
  Building2,
  CreditCard,
  Loader2,
  ShieldCheck,
  SendHorizontal,
} from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  type PixKeyType,
  validatePixKey,
  detectPixKeyType,
} from '@/lib/pix/pix-validator';

export function PixConfigCard() {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [pixKey, setPixKey] = useState('');
  const [pixKeyType, setPixKeyType] = useState<PixKeyType>('EVP');
  const [pixMerchantName, setPixMerchantName] = useState('');
  const [copiedKey, setCopiedKey] = useState(false);

  // Load config on mount
  useEffect(() => {
    async function load() {
      try {
        setLoading(true);
        const res = await fetch('/api/pix/config', { cache: 'no-store' });
        if (res.ok) {
          const data = await res.json();
          if (data?.config) {
            setPixKey(data.config.pix_key || '');
            setPixKeyType((data.config.pix_key_type as PixKeyType) || 'EVP');
            setPixMerchantName(data.config.pix_merchant_name || '');
          }
        }
      } catch (err) {
        console.error('Failed to load PIX config:', err);
      } finally {
        setLoading(false);
      }
    }
    void load();
  }, []);

  const validation = validatePixKey(pixKey, pixKeyType);

  const handleKeyChange = (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    const val = e.target.value;
    setPixKey(val);
    // Optional auto-detection of type if user hasn't locked one
    const detected = detectPixKeyType(val);
    if (detected && detected !== pixKeyType && val.length > 5) {
      setPixKeyType(detected);
    }
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!validation.valid) {
      toast.error(validation.error || 'Por favor, corrija a chave PIX antes de salvar.');
      return;
    }

    setSaving(true);
    try {
      const res = await fetch('/api/pix/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          pix_key: pixKey.trim(),
          pix_key_type: pixKeyType,
          pix_merchant_name: pixMerchantName.trim() || 'Pix',
        }),
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'Erro ao salvar configurações PIX.');
      }

      toast.success('Configuração de PIX salva com sucesso!');
      if (data?.config) {
        setPixKey(data.config.pix_key);
        setPixKeyType(data.config.pix_key_type);
        setPixMerchantName(data.config.pix_merchant_name);
      }
    } catch (err: any) {
      toast.error(err?.message || 'Falha ao salvar configuração');
    } finally {
      setSaving(false);
    }
  };

  const handleCopyPreview = () => {
    if (!pixKey) return;
    navigator.clipboard.writeText(validation.formattedKey || pixKey);
    setCopiedKey(true);
    toast.success('Chave PIX copiada!');
    setTimeout(() => setCopiedKey(false), 2000);
  };

  return (
    <Card className="border-border bg-card shadow-sm">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div className="p-2 rounded-xl bg-teal-500/10 text-teal-600 dark:text-teal-400 border border-teal-500/20">
              <QrCode className="h-5 w-5" />
            </div>
            <div>
              <CardTitle className="text-base font-semibold flex items-center gap-2">
                Chave PIX da Empresa (Nativo WhatsApp)
                {pixKey && validation.valid ? (
                  <Badge className="bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/20 text-[10px] font-medium">
                    Ativo & Validado
                  </Badge>
                ) : (
                  <Badge variant="outline" className="text-muted-foreground text-[10px]">
                    Não Configurado
                  </Badge>
                )}
              </CardTitle>
              <CardDescription className="text-xs text-muted-foreground mt-0.5">
                Configure a chave PIX padrão enviada aos leads no WhatsApp como cartão nativo com botão de 1 clique para copiar chave.
              </CardDescription>
            </div>
          </div>
        </div>
      </CardHeader>

      <CardContent>
        {loading ? (
          <div className="flex items-center justify-center p-8">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <form onSubmit={handleSave} className="space-y-5">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6 items-start">
              {/* Left Column: Form Fields */}
              <div className="space-y-4">
                {/* Tipo de Chave */}
                <div className="space-y-1.5">
                  <Label className="text-xs font-semibold uppercase text-muted-foreground tracking-wider">
                    Tipo de Chave PIX
                  </Label>
                  <div className="grid grid-cols-5 gap-1.5">
                    {(['COPIA_E_COLA', 'CPF', 'PHONE', 'EMAIL', 'EVP'] as PixKeyType[]).map((type) => {
                      const active = pixKeyType === type;
                      const label =
                        type === 'COPIA_E_COLA'
                          ? 'Copia e Cola'
                          : type === 'PHONE'
                          ? 'Telefone'
                          : type;
                      return (
                        <button
                          key={type}
                          type="button"
                          onClick={() => setPixKeyType(type)}
                          className={`py-2 px-1 text-center rounded-lg text-xs font-medium border transition-all ${
                            active
                              ? 'bg-teal-500/15 border-teal-500/40 text-teal-700 dark:text-teal-300 font-semibold shadow-xs'
                              : 'bg-muted/40 border-border/70 text-muted-foreground hover:bg-muted'
                          }`}
                        >
                          {label}
                        </button>
                      );
                    })}
                  </div>
                </div>

                {/* Chave PIX */}
                <div className="space-y-1.5">
                  <div className="flex items-center justify-between">
                    <Label className="text-xs font-semibold uppercase text-muted-foreground tracking-wider">
                      {pixKeyType === 'COPIA_E_COLA' ? 'Código PIX Copia e Cola' : `Chave PIX (${pixKeyType})`}
                    </Label>
                    {pixKey && (
                      <span className="text-[11px]">
                        {validation.valid ? (
                          <span className="text-emerald-600 dark:text-emerald-400 flex items-center gap-1 font-medium">
                            <CheckCircle2 className="h-3 w-3" /> Válida
                          </span>
                        ) : (
                          <span className="text-rose-600 dark:text-rose-400 flex items-center gap-1 font-medium">
                            <AlertCircle className="h-3 w-3" /> {validation.error}
                          </span>
                        )}
                      </span>
                    )}
                  </div>
                  {pixKeyType === 'COPIA_E_COLA' ? (
                    <Textarea
                      value={pixKey}
                      onChange={handleKeyChange}
                      placeholder="Cole aqui o código PIX Copia e Cola completo gerado pelo seu banco (000201...)"
                      rows={3}
                      className="font-mono text-xs border-border resize-none"
                    />
                  ) : (
                    <Input
                      value={pixKey}
                      onChange={handleKeyChange}
                      placeholder={
                        pixKeyType === 'CPF'
                          ? '000.000.000-00 ou CNPJ'
                          : pixKeyType === 'PHONE'
                          ? '+55 11 99999-9999'
                          : pixKeyType === 'EMAIL'
                          ? 'pix@minhaempresa.com.br'
                          : 'UUID chave aleatória (ex: e2a609d5-47fe-...)'
                      }
                      className="font-mono text-sm border-border"
                    />
                  )}
                  <p className="text-[11px] text-muted-foreground">
                    {pixKeyType === 'COPIA_E_COLA' && 'Código BR Code do Pix Copia e Cola (padrão BACEN 000201...). O cliente poderá pagar com 1 toque no WhatsApp.'}
                    {pixKeyType === 'PHONE' && 'Informe o DDD e o número celular.'}
                    {pixKeyType === 'CPF' && 'Informe os 11 dígitos do CPF ou 14 dígitos do CNPJ.'}
                    {pixKeyType === 'EMAIL' && 'Informe o e-mail completo associado à conta bancária.'}
                    {pixKeyType === 'EVP' && 'Chave aleatória gerada pelo seu banco (formato UUID).'}
                  </p>
                </div>

                {/* Nome do Beneficiário */}
                <div className="space-y-1.5">
                  <Label className="text-xs font-semibold uppercase text-muted-foreground tracking-wider">
                    Nome do Titular / Razão Social
                  </Label>
                  <Input
                    value={pixMerchantName}
                    onChange={(e) => setPixMerchantName(e.target.value)}
                    placeholder="Ex: Minha Empresa Soluções Digitais"
                    className="text-sm border-border"
                  />
                  <p className="text-[11px] text-muted-foreground">
                    Exibido no cartão do WhatsApp como nome do recebedor cadastrado.
                  </p>
                </div>
              </div>

              {/* Right Column: Real-time WhatsApp Preview */}
              <div className="space-y-3">
                <Label className="text-xs font-semibold uppercase text-muted-foreground tracking-wider flex items-center gap-1.5">
                  <span>Prévia Nativa no WhatsApp</span>
                  <Badge variant="outline" className="text-[9px] py-0 px-1 border-teal-500/30 text-teal-600 dark:text-teal-400">
                    NativeFlowMessage
                  </Badge>
                </Label>

                {/* WhatsApp Chat Bubble Simulation */}
                <div className="p-4 rounded-xl border border-emerald-500/20 bg-emerald-500/5 dark:bg-emerald-950/20 space-y-3">
                  <div className="max-w-[320px] rounded-2xl bg-white dark:bg-[#1f2c34] shadow-md border border-slate-200 dark:border-[#2a3942] overflow-hidden text-slate-800 dark:text-[#e9edef] text-sm">
                    {/* Header */}
                    <div className="px-3.5 pt-3 pb-2 flex items-center justify-between border-b border-slate-100 dark:border-[#2a3942]">
                      <div className="flex items-center gap-2">
                        <div className="w-6 h-6 rounded-full bg-teal-600 text-white flex items-center justify-center font-bold text-[10px]">
                          P
                        </div>
                        <span className="font-semibold text-xs text-teal-600 dark:text-teal-400">
                          WhatsApp Pay • PIX
                        </span>
                      </div>
                      <span className="text-[10px] text-muted-foreground">Agora</span>
                    </div>

                    {/* Body */}
                    <div className="p-3.5 space-y-2">
                      <div className="text-xs font-medium text-slate-500 dark:text-[#8696a0]">
                        Transferência PIX
                      </div>
                      <div className="text-sm font-semibold truncate text-slate-900 dark:text-white">
                        {pixMerchantName || 'Nome da Sua Empresa'}
                      </div>
                      <div className="p-2.5 rounded-lg bg-slate-100 dark:bg-[#111b21] border border-slate-200 dark:border-[#2a3942] space-y-1">
                        <div className="text-[10px] uppercase tracking-wider text-muted-foreground flex items-center justify-between">
                          <span>Chave ({pixKeyType})</span>
                          <span className="text-[9px] font-mono">1-CLIQUE</span>
                        </div>
                        <div className="font-mono text-xs break-all select-all font-medium text-slate-900 dark:text-slate-100">
                          {validation.valid ? validation.formattedKey : pixKey || '••••••••••••••••'}
                        </div>
                      </div>
                    </div>

                    {/* WhatsApp Action Button */}
                    <div className="border-t border-slate-100 dark:border-[#2a3942]">
                      <button
                        type="button"
                        onClick={handleCopyPreview}
                        className="w-full py-2.5 text-center text-xs font-semibold text-teal-600 dark:text-teal-400 hover:bg-teal-500/10 flex items-center justify-center gap-1.5 transition-colors"
                      >
                        {copiedKey ? (
                          <>
                            <Check className="h-3.5 w-3.5 text-emerald-500" />
                            <span>Chave Copiada!</span>
                          </>
                        ) : (
                          <>
                            <Copy className="h-3.5 w-3.5" />
                            <span>Copiar código PIX</span>
                          </>
                        )}
                      </button>
                    </div>
                  </div>

                  <p className="text-[11px] text-muted-foreground flex items-center gap-1">
                    <ShieldCheck className="h-3.5 w-3.5 text-emerald-500" />
                    Enviado diretamente via UAZAPI com o endpoint nativo <code className="text-[10px] font-mono">/send/pix-button</code>.
                  </p>
                </div>
              </div>
            </div>

            <div className="pt-3 border-t border-border flex items-center justify-end gap-2.5">
              <Button
                type="submit"
                disabled={saving || (Boolean(pixKey) && !validation.valid)}
                className="bg-teal-600 hover:bg-teal-700 text-white font-medium text-xs h-9 px-4 gap-1.5"
              >
                {saving ? (
                  <>
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    Salvando...
                  </>
                ) : (
                  <>
                    <CheckCircle2 className="h-3.5 w-3.5" />
                    Salvar Chave PIX Padrão
                  </>
                )}
              </Button>
            </div>
          </form>
        )}
      </CardContent>
    </Card>
  );
}
