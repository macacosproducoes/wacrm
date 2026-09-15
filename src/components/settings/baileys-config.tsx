'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { toast } from 'sonner';
import {
  QrCode,
  CheckCircle2,
  XCircle,
  Loader2,
  RefreshCw,
  Power,
  Smartphone,
  ShieldCheck,
  Zap,
  Sparkles,
  Users,
  KeyRound,
  Copy,
  Check,
  Info,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import { cn } from '@/lib/utils';
import { formatUazApiNumber } from '@/lib/whatsapp/uazapi-client';

export function BaileysConfigPanel() {
  const [status, setStatus] = useState<'connected' | 'connecting' | 'disconnected'>('disconnected');
  const [qrCode, setQrCode] = useState<string | null>(null);
  const [phoneNumber, setPhoneNumber] = useState<string | null>(null);
  const [userName, setUserName] = useState<string | null>(null);
  const [profilePicUrl, setProfilePicUrl] = useState<string | null>(null);
  const [profileStatus, setProfileStatus] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [connecting, setConnecting] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const [syncingHistory, setSyncingHistory] = useState(false);
  const [autoLeadCapture, setAutoLeadCapture] = useState(true);

  // Pairing code state
  const [connectMethod, setConnectMethod] = useState<'code' | 'qr'>('code');
  const [pairingPhone, setPairingPhone] = useState('');
  const [pairingCode, setPairingCode] = useState<string | null>(null);
  const [generatingCode, setGeneratingCode] = useState(false);
  const [copied, setCopied] = useState(false);

  const pollRef = useRef<NodeJS.Timeout | null>(null);

  const checkStatus = useCallback(async () => {
    try {
      const res = await fetch('/api/whatsapp/baileys/status', { cache: 'no-store' });
      const data = await res.json();
      if (data.success) {
        setStatus(data.status);
        setPhoneNumber(data.phoneNumber || null);
        setUserName(data.userName || null);
        setProfilePicUrl(data.profilePicUrl || null);
        setProfileStatus(data.profileStatus || null);
        if (data.qrCode) {
          setQrCode(data.qrCode);
        } else if (data.status === 'connected') {
          setQrCode(null);
          setPairingCode(null);
        }
        if (data.pairingCode) {
          setPairingCode(data.pairingCode);
        }
      }
    } catch {
      // Background poll silently fails if offline
    } finally {
      setLoading(false);
    }
  }, []);

  // Poll status while connecting / displaying QR code
  useEffect(() => {
    checkStatus();

    // Check lead capture status
    fetch('/api/whatsapp/uazapi/capture-leads', { cache: 'no-store' })
      .then((r) => r.json())
      .then((d) => {
        if (d.success) setAutoLeadCapture(Boolean(d.autoLeadCapture));
      })
      .catch(() => {});
  }, [checkStatus]);

  useEffect(() => {
    if (status === 'connecting' || connecting || Boolean(pairingCode)) {
      if (pollRef.current) clearInterval(pollRef.current);
      pollRef.current = setInterval(async () => {
        try {
          const res = await fetch('/api/whatsapp/baileys/status', { cache: 'no-store' });
          const data = await res.json();
          if (data.success) {
            setStatus(data.status);
            if (data.status === 'connected') {
              setQrCode(null);
              setPairingCode(null);
              setConnecting(false);
              setPhoneNumber(data.phoneNumber || null);
              setUserName(data.userName || null);
              setProfilePicUrl(data.profilePicUrl || null);
              setProfileStatus(data.profileStatus || null);
              toast.success('WhatsApp conectado com sucesso!');
              if (pollRef.current) clearInterval(pollRef.current);
            } else if (data.qrCode) {
              setQrCode(data.qrCode);
              setConnecting(false);
            } else if (data.status === 'disconnected') {
              if (data.error) {
                toast.error(data.error);
              }
              setConnecting(false);
            }
            if (data.pairingCode) {
              setPairingCode(data.pairingCode);
            }
          }
        } catch {}
      }, 1500);
    } else {
      if (pollRef.current) clearInterval(pollRef.current);
    }

    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [status, connecting, pairingCode]);

  const handleStartConnect = async () => {
    setConnecting(true);
    setQrCode(null);
    setStatus('connecting');
    try {
      const res = await fetch('/api/whatsapp/baileys/connect', { method: 'POST' });
      const data = await res.json();
      if (!res.ok || data.error) {
        toast.error(data.error || 'Falha ao iniciar conexão com WhatsApp');
        setConnecting(false);
        setStatus('disconnected');
        return;
      }
      setStatus(data.status);
      if (data.qrCode) {
        setQrCode(data.qrCode);
        setConnecting(false);
        toast.info('QR Code gerado! Aponte o WhatsApp do seu celular.');
      } else if (data.status === 'connected') {
        toast.success('WhatsApp já está conectado!');
        setConnecting(false);
      }
    } catch {
      toast.error('Erro de comunicação com o servidor');
      setConnecting(false);
      setStatus('disconnected');
    }
  };

  const handleRequestPairingCode = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    const clean = pairingPhone.replace(/\D/g, '');
    if (!clean || clean.length < 10) {
      toast.error('Informe seu número com código do país e DDD (ex: 5511999998888)');
      return;
    }

    setGeneratingCode(true);
    setPairingCode(null);
    try {
      const res = await fetch('/api/whatsapp/baileys/pairing-code', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phoneNumber: clean }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        toast.error(data.error || 'Erro ao gerar código de conexão');
        return;
      }

      setPairingCode(data.pairingCode);
      setStatus('connecting');
      toast.success('Código gerado! Digite-o no WhatsApp do seu celular.');
    } catch {
      toast.error('Erro de comunicação ao solicitar código');
    } finally {
      setGeneratingCode(false);
    }
  };

  const copyPairingCode = () => {
    if (!pairingCode) return;
    navigator.clipboard.writeText(pairingCode);
    setCopied(true);
    toast.success('Código copiado para a área de transferência!');
    setTimeout(() => setCopied(false), 2000);
  };

  const handleSyncHistory = async () => {
    try {
      setSyncingHistory(true);
      const res = await fetch('/api/whatsapp/sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ limit: 500 }),
      });
      const data = await res.json();
      if (res.ok && data.success) {
        toast.success(data.message || 'Histórico do WhatsApp sincronizado com sucesso!');
        await checkStatus();
      } else {
        toast.error(data.error || 'Falha ao sincronizar histórico');
      }
    } catch {
      toast.error('Erro de conexão ao sincronizar histórico');
    } finally {
      setSyncingHistory(false);
    }
  };

  const handleDisconnect = async () => {
    if (!confirm('Deseja realmente desconectar o WhatsApp desta conta?')) return;
    setDisconnecting(true);
    try {
      const res = await fetch('/api/whatsapp/baileys/disconnect', { method: 'POST' });
      const data = await res.json();
      if (res.ok) {
        toast.success('WhatsApp desconectado com sucesso');
        setStatus('disconnected');
        setQrCode(null);
        setPhoneNumber(null);
      } else {
        toast.error(data.error || 'Erro ao desconectar');
      }
    } catch {
      toast.error('Erro ao desconectar');
    } finally {
      setDisconnecting(false);
    }
  };

  const handleToggleAutoLeadCapture = async (checked: boolean) => {
    setAutoLeadCapture(checked);
    try {
      const res = await fetch('/api/whatsapp/uazapi/capture-leads', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'toggle', enabled: checked }),
      });
      const data = await res.json();
      if (data.success) {
        toast.success(checked ? 'Captura de Leads ATIVADA (Sim)' : 'Captura de Leads DESATIVADA (Não)');
      }
    } catch {
      toast.error('Erro ao atualizar configuração de captura');
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-16 text-muted-foreground">
        <Loader2 className="mr-2 h-5 w-5 animate-spin text-primary" />
        <span className="text-sm">Carregando status do WhatsApp...</span>
      </div>
    );
  }

  return (
    <div className="space-y-6 animate-in fade-in-50 duration-200">
      {/* Top Status Card */}
      <Card className="border-border/80 shadow-xs">
        <CardHeader className="pb-4">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <div className="flex items-center gap-3">
              <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border border-emerald-500/20">
                <QrCode className="h-6 w-6" />
              </div>
              <div>
                <div className="flex items-center gap-2 flex-wrap">
                  <CardTitle className="text-base">WhatsApp Direto (QR Code)</CardTitle>
                  <Badge
                    className={
                      status === 'connected'
                        ? 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border-emerald-500/30'
                        : status === 'connecting'
                        ? 'bg-amber-500/15 text-amber-600 dark:text-amber-400 border-amber-500/30 animate-pulse'
                        : 'bg-muted text-muted-foreground'
                    }
                  >
                    {status === 'connected' ? (
                      <>
                        <CheckCircle2 className="h-3 w-3 mr-1" /> Conectado
                      </>
                    ) : status === 'connecting' ? (
                      <>
                        <Loader2 className="h-3 w-3 mr-1 animate-spin" /> Aguardando QR Code
                      </>
                    ) : (
                      <>
                        <XCircle className="h-3 w-3 mr-1" /> Desconectado
                      </>
                    )}
                  </Badge>
                </div>
                <CardDescription className="text-xs mt-0.5">
                  Conexão nativa do WhatsApp Web pelo CRM. Não necessita de UazAPI ou servidores externos.
                </CardDescription>
              </div>
            </div>

            {status === 'connected' && (
              <Button
                variant="outline"
                size="sm"
                onClick={handleDisconnect}
                disabled={disconnecting}
                className="text-destructive hover:text-destructive border-destructive/30 hover:bg-destructive/10 text-xs shrink-0"
              >
                {disconnecting ? (
                  <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
                ) : (
                  <Power className="h-3.5 w-3.5 mr-1.5" />
                )}
                Desconectar WhatsApp
              </Button>
            )}
          </div>
        </CardHeader>

        <CardContent className="space-y-6 pt-0">
          {/* If Connected */}
          {status === 'connected' && (
            <div className="rounded-2xl border border-emerald-500/30 bg-gradient-to-br from-emerald-500/10 via-emerald-500/5 to-transparent p-5 shadow-xs">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-5">
                <div className="flex items-center gap-4">
                  {/* WhatsApp Profile Avatar */}
                  <div className="relative shrink-0">
                    {profilePicUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={profilePicUrl}
                        alt={userName || 'WhatsApp Profile'}
                        className="size-16 rounded-2xl object-cover border-2 border-emerald-500/40 shadow-sm"
                      />
                    ) : (
                      <div className="size-16 rounded-2xl bg-gradient-to-br from-emerald-500 to-teal-600 flex items-center justify-center text-white font-bold text-2xl shadow-sm border border-emerald-500/30">
                        {(userName || phoneNumber || 'W').charAt(0).toUpperCase()}
                      </div>
                    )}
                    <span className="absolute -bottom-1 -right-1 flex h-4 w-4 items-center justify-center rounded-full bg-emerald-500 ring-2 ring-background">
                      <Check className="h-2.5 w-2.5 text-white" />
                    </span>
                  </div>

                  {/* Profile Details */}
                  <div className="space-y-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <h4 className="text-base font-bold text-foreground">
                        {userName || 'WhatsApp Conectado'}
                      </h4>
                      <Badge className="bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border-emerald-500/30 text-[10px]">
                        <CheckCircle2 className="h-3 w-3 mr-1" /> Conectado no CRM
                      </Badge>
                    </div>

                    <div className="flex items-center gap-2">
                      <Smartphone className="h-3.5 w-3.5 text-muted-foreground" />
                      <span className="font-mono text-xs font-semibold text-foreground">
                        {phoneNumber ? formatUazApiNumber(phoneNumber) : 'Número Ativo'}
                      </span>
                    </div>

                    {profileStatus && (
                      <p className="text-xs text-muted-foreground italic mt-0.5 bg-muted/50 px-2.5 py-0.5 rounded-md border border-border/50 inline-block">
                        &quot;{profileStatus}&quot;
                      </p>
                    )}

                    <div className="flex flex-wrap items-center gap-1.5 pt-1">
                      <Badge variant="outline" className="text-[10px] gap-1 bg-emerald-500/5 text-emerald-600 dark:text-emerald-400 border-emerald-500/30">
                        <Zap className="h-3 w-3" /> Conexão Nativa QR Code
                      </Badge>
                      <Badge variant="outline" className="text-[10px] gap-1 bg-background border-border text-muted-foreground">
                        <Sparkles className="h-3 w-3 text-amber-500" /> IA e Inbox Sincronizados
                      </Badge>
                    </div>
                  </div>
                </div>

                <div className="flex sm:flex-col items-center sm:items-end gap-2 shrink-0">
                  <Button
                    variant="default"
                    size="sm"
                    onClick={handleSyncHistory}
                    disabled={syncingHistory}
                    className="bg-emerald-600 hover:bg-emerald-700 text-white text-xs gap-1.5 cursor-pointer shadow-xs"
                  >
                    {syncingHistory ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <RefreshCw className="h-3.5 w-3.5" />
                    )}
                    Sincronizar Histórico
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={checkStatus}
                    className="text-xs gap-1.5 cursor-pointer"
                  >
                    <RefreshCw className="h-3.5 w-3.5" /> Atualizar Dados
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={handleDisconnect}
                    disabled={disconnecting}
                    className="text-destructive hover:text-destructive border-destructive/30 hover:bg-destructive/10 text-xs gap-1.5 cursor-pointer"
                  >
                    {disconnecting ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Power className="h-3.5 w-3.5" />
                    )}
                    Desconectar
                  </Button>
                </div>
              </div>
            </div>
          )}

          {/* If Disconnected or Connecting */}
          {status !== 'connected' && (
            <div className="flex flex-col items-center p-6 border border-border/80 rounded-xl bg-card">
              {/* Method Switcher Tabs */}
              <div className="flex items-center gap-1 p-1 bg-muted/70 rounded-xl border border-border/80 w-full max-w-md mb-6">
                <button
                  type="button"
                  onClick={() => setConnectMethod('code')}
                  className={cn(
                    'flex-1 flex items-center justify-center gap-2 py-2 px-3 rounded-lg text-xs font-semibold transition-all cursor-pointer',
                    connectMethod === 'code'
                      ? 'bg-background text-foreground shadow-xs border border-border/80'
                      : 'text-muted-foreground hover:text-foreground'
                  )}
                >
                  <KeyRound className="h-3.5 w-3.5 text-emerald-500" />
                  Código de 8 Dígitos (Bypass / Recomendado)
                </button>
                <button
                  type="button"
                  onClick={() => setConnectMethod('qr')}
                  className={cn(
                    'flex-1 flex items-center justify-center gap-2 py-2 px-3 rounded-lg text-xs font-semibold transition-all cursor-pointer',
                    connectMethod === 'qr'
                      ? 'bg-background text-foreground shadow-xs border border-border/80'
                      : 'text-muted-foreground hover:text-foreground'
                  )}
                >
                  <QrCode className="h-3.5 w-3.5" />
                  QR Code (Câmera)
                </button>
              </div>

              {/* METHOD 1: PAIRING CODE (BYPASS) */}
              {connectMethod === 'code' && (
                <div className="flex flex-col items-center text-center space-y-4 max-w-md w-full py-2">
                  {pairingCode ? (
                    <div className="flex flex-col items-center space-y-5 w-full">
                      <div className="space-y-1.5 w-full">
                        <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                          Seu Código de Conexão WhatsApp:
                        </span>
                        <div className="flex items-center justify-center gap-3 mt-2">
                          <div className="font-mono text-3xl sm:text-4xl font-black tracking-widest px-6 py-3 bg-emerald-500/10 border-2 border-emerald-500/40 text-emerald-600 dark:text-emerald-400 rounded-2xl shadow-inner select-all">
                            {pairingCode.length === 8 ? `${pairingCode.slice(0, 4)} - ${pairingCode.slice(4)}` : pairingCode}
                          </div>
                          <Button
                            variant="outline"
                            size="icon"
                            onClick={copyPairingCode}
                            className="size-12 rounded-xl shrink-0 cursor-pointer"
                            title="Copiar Código"
                          >
                            {copied ? <Check className="h-5 w-5 text-emerald-500" /> : <Copy className="h-5 w-5" />}
                          </Button>
                        </div>
                      </div>

                      <div className="flex items-center gap-2 text-xs font-medium text-amber-600 dark:text-amber-400 bg-amber-500/10 px-3 py-1.5 rounded-full border border-amber-500/20">
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        Aguardando você digitar o código no celular...
                      </div>

                      <div className="space-y-2 text-left bg-muted/50 p-4 rounded-xl border border-border text-xs text-muted-foreground w-full">
                        <p className="font-semibold text-foreground flex items-center gap-1.5">
                          <Smartphone className="h-4 w-4 text-emerald-500" /> Onde digitar no celular (Passo a passo):
                        </p>
                        <ol className="list-decimal list-inside space-y-1.5 pl-1 text-[11px] leading-relaxed">
                          <li>Abra o WhatsApp no seu celular</li>
                          <li>Toque nos <strong>três pontos ⋮</strong> (Android) ou <strong>Configurações ⚙️</strong> (iPhone)</li>
                          <li>Toque em <strong>Aparelhos conectados</strong></li>
                          <li>Toque em <strong>Conectar um aparelho</strong></li>
                          <li>No rodapé da tela da câmera, toque em <strong>&quot;Conectar com número de telefone&quot;</strong></li>
                          <li>Digite o código de 8 dígitos exibido acima no seu celular.</li>
                        </ol>
                      </div>

                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => {
                          setPairingCode(null);
                          setStatus('disconnected');
                        }}
                        className="text-xs gap-1.5 cursor-pointer"
                      >
                        <RefreshCw className="h-3.5 w-3.5" /> Gerar Outro Código
                      </Button>
                    </div>
                  ) : (
                    <form onSubmit={handleRequestPairingCode} className="space-y-5 w-full">
                      <div className="flex h-16 w-16 mx-auto items-center justify-center rounded-2xl bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border border-emerald-500/20 shadow-xs">
                        <KeyRound className="h-8 w-8" />
                      </div>

                      <div>
                        <h3 className="font-bold text-foreground text-lg">Conectar via Código de 8 Dígitos</h3>
                        <p className="text-xs text-muted-foreground mt-1 max-w-sm mx-auto">
                          <strong>Bypass Oficial do WhatsApp:</strong> Não precisa de câmera nem de QR Code. Você digita o código diretamente no aplicativo do seu celular.
                        </p>
                      </div>

                      <div className="space-y-2 text-left max-w-sm mx-auto w-full">
                        <label className="text-xs font-semibold text-foreground">
                          Seu número de WhatsApp (com DDI e DDD):
                        </label>
                        <div className="flex gap-2">
                          <Input
                            placeholder="Ex: 5511999998888"
                            value={pairingPhone}
                            onChange={(e) => setPairingPhone(e.target.value)}
                            disabled={generatingCode}
                            className="h-10 text-sm font-mono"
                          />
                          <Button
                            type="submit"
                            disabled={generatingCode || !pairingPhone.trim()}
                            className="h-10 bg-emerald-600 hover:bg-emerald-700 text-white font-semibold shadow-md px-4 shrink-0 cursor-pointer"
                          >
                            {generatingCode ? (
                              <>
                                <Loader2 className="h-4 w-4 animate-spin mr-1.5" /> Gerando...
                              </>
                            ) : (
                              'Gerar Código'
                            )}
                          </Button>
                        </div>
                        <p className="text-[11px] text-muted-foreground">
                          Informe o código do país (55 para Brasil) + DDD + número. Ex: <code>5511999998888</code>
                        </p>
                      </div>
                    </form>
                  )}
                </div>
              )}

              {/* METHOD 2: QR CODE */}
              {connectMethod === 'qr' && (
                <div className="flex flex-col items-center text-center space-y-4 max-w-md w-full py-2">
                  {qrCode ? (
                    <div className="flex flex-col items-center space-y-4 max-w-sm text-center">
                      <div className="relative p-3 bg-white rounded-2xl border border-border shadow-lg">
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img
                          src={qrCode}
                          alt="WhatsApp QR Code"
                          className="size-64 object-contain rounded-xl"
                        />
                      </div>

                      <div className="flex items-center gap-2 text-xs font-medium text-amber-600 dark:text-amber-400 bg-amber-500/10 px-3 py-1.5 rounded-full border border-amber-500/20">
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        Aguardando leitura pelo seu celular...
                      </div>

                      <div className="space-y-2 text-left bg-muted/50 p-4 rounded-xl border border-border text-xs text-muted-foreground w-full">
                        <p className="font-semibold text-foreground flex items-center gap-1.5">
                          <Smartphone className="h-4 w-4 text-emerald-500" /> Como conectar:
                        </p>
                        <ol className="list-decimal list-inside space-y-1 pl-1 text-[11px]">
                          <li>Abra o WhatsApp no seu celular</li>
                          <li>Toque nos <strong>três pontos ⋮</strong> (Android) ou <strong>Configurações ⚙️</strong> (iPhone)</li>
                          <li>Toque em <strong>Aparelhos conectados</strong></li>
                          <li>Toque em <strong>Conectar um aparelho</strong> e aponte para o QR Code acima</li>
                        </ol>
                      </div>

                      <div className="rounded-xl border border-amber-500/30 bg-amber-500/5 p-3 text-left text-xs text-amber-700 dark:text-amber-300 w-full space-y-1">
                        <p className="font-semibold flex items-center gap-1.5">
                          <Info className="h-4 w-4 shrink-0" /> Deu erro de novos dispositivos?
                        </p>
                        <p className="text-[11px] leading-relaxed">
                          1. Desconecte aparelhos antigos no seu WhatsApp.<br />
                          2. Ou use a aba <strong>&quot;Código de 8 Dígitos&quot;</strong> acima para conectar pelo número de telefone sem precisar da câmera!
                        </p>
                      </div>

                      <Button
                        variant="outline"
                        size="sm"
                        onClick={handleStartConnect}
                        disabled={connecting}
                        className="text-xs gap-1.5 cursor-pointer"
                      >
                        <RefreshCw className="h-3.5 w-3.5" /> Gerar Novo QR Code
                      </Button>
                    </div>
                  ) : connecting || status === 'connecting' ? (
                    <div className="flex flex-col items-center text-center space-y-4 max-w-sm py-6">
                      <div className="relative flex items-center justify-center size-44 rounded-2xl border-2 border-dashed border-emerald-500/40 bg-emerald-500/5 shadow-inner">
                        <div className="flex flex-col items-center gap-3 text-emerald-600 dark:text-emerald-400">
                          <Loader2 className="h-10 w-10 animate-spin" />
                          <span className="text-xs font-semibold">Gerando QR Code...</span>
                        </div>
                      </div>
                      <div className="space-y-1">
                        <p className="text-xs font-medium text-foreground flex items-center justify-center gap-1.5">
                          <RefreshCw className="h-3 w-3 animate-spin text-emerald-500" />
                          Iniciando sessão com o WhatsApp...
                        </p>
                        <p className="text-[11px] text-muted-foreground">
                          O código aparecerá aqui na tela em instantes.
                        </p>
                      </div>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => {
                          setConnecting(false);
                          setStatus('disconnected');
                        }}
                        className="text-xs text-muted-foreground hover:text-foreground h-8 cursor-pointer"
                      >
                        Cancelar
                      </Button>
                    </div>
                  ) : (
                    <div className="flex flex-col items-center text-center space-y-4 max-w-md py-4">
                      <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border border-emerald-500/20 shadow-xs">
                        <QrCode className="h-8 w-8" />
                      </div>
                      <div>
                        <h3 className="font-bold text-foreground text-lg">Conectar WhatsApp via QR Code</h3>
                        <p className="text-xs text-muted-foreground mt-1">
                          Conecte apontando a câmera do WhatsApp para a tela.
                        </p>
                      </div>

                      <Button
                        onClick={handleStartConnect}
                        className="gap-2 bg-emerald-600 hover:bg-emerald-700 text-white font-semibold shadow-md px-6 cursor-pointer"
                      >
                        <QrCode className="h-4 w-4" /> Gerar QR Code para Conectar
                      </Button>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Auto Lead Capture Setting Card */}
      <Card className="border-border/80 shadow-xs">
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between gap-4">
            <div className="flex items-center gap-3">
              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary border border-primary/20">
                <Users className="h-5 w-5" />
              </div>
              <div>
                <CardTitle className="text-sm">Captura Automática de Leads (Sim / Não)</CardTitle>
                <CardDescription className="text-xs mt-0.5">
                  Salva novos contatos automaticamente com o nome real que eles cadastraram no WhatsApp e aplica a etiqueta Lead.
                </CardDescription>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <span className={`text-xs font-semibold ${autoLeadCapture ? 'text-emerald-600 dark:text-emerald-400' : 'text-muted-foreground'}`}>
                {autoLeadCapture ? 'Sim (Ativado)' : 'Não (Desativado)'}
              </span>
              <Switch
                checked={autoLeadCapture}
                onCheckedChange={handleToggleAutoLeadCapture}
              />
            </div>
          </div>
        </CardHeader>
      </Card>

      {/* Features & Security Info */}
      <div className="grid gap-4 sm:grid-cols-3">
        <div className="flex items-start gap-3 rounded-xl border border-border bg-card p-4">
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-emerald-500/10 text-emerald-600 dark:text-emerald-400">
            <ShieldCheck className="h-4 w-4" />
          </div>
          <div>
            <h4 className="text-xs font-semibold text-foreground">100% Gratuito & Independente</h4>
            <p className="text-[11px] text-muted-foreground mt-0.5">
              Sem mensalidades de APIs externas, sem intermediários e sem limites artificiais de mensagens.
            </p>
          </div>
        </div>

        <div className="flex items-start gap-3 rounded-xl border border-border bg-card p-4">
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
            <Sparkles className="h-4 w-4" />
          </div>
          <div>
            <h4 className="text-xs font-semibold text-foreground">Integrado ao Agente de IA</h4>
            <p className="text-[11px] text-muted-foreground mt-0.5">
              Suas mensagens são atendidas em tempo real pelo seu Gemini 2.5 Flash via Kie.ai.
            </p>
          </div>
        </div>

        <div className="flex items-start gap-3 rounded-xl border border-border bg-card p-4">
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-blue-500/10 text-blue-600 dark:text-blue-400">
            <Zap className="h-4 w-4" />
          </div>
          <div>
            <h4 className="text-xs font-semibold text-foreground">Sessão Persistente</h4>
            <p className="text-[11px] text-muted-foreground mt-0.5">
              Seu login fica salvo no servidor do CRM, reconectando automaticamente se reiniciar.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
