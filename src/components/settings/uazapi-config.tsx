'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { toast } from 'sonner';
import {
  QrCode,
  Wifi,
  WifiOff,
  RefreshCw,
  CheckCircle2,
  XCircle,
  Loader2,
  Plus,
  Radio,
  Copy,
  Check,
  Zap,
  Info,
  UserCheck,
  Sparkles,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { PixConfigCard } from './pix-config-card';

export interface UazApiConnectionItem {
  id: string;
  account_id: string;
  display_name: string;
  phone_number: string | null;
  is_active: boolean;
  status: 'connected' | 'connecting' | 'disconnected' | 'hibernated' | 'unknown';
  qrcode?: string | null;
  base_url: string;
  has_token: boolean;
  token_masked: string;
  created_at: string;
  updated_at: string;
}

export function UazApiConfigPanel() {
  const [connections, setConnections] = useState<UazApiConnectionItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeId, setActiveId] = useState<string | null>(null);

  // Form states for selected or new connection
  const [selectedConn, setSelectedConn] = useState<UazApiConnectionItem | null>(null);
  const [isCreatingNew, setIsCreatingNew] = useState(false);
  const [displayName, setDisplayName] = useState('');
  const [baseUrl, setBaseUrl] = useState('https://free.uazapi.com');
  const [token, setToken] = useState('');

  // Actions states
  const [testing, setTesting] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [copiedWebhook, setCopiedWebhook] = useState(false);

  // QR code modal / card state
  const [qrCodeData, setQrCodeData] = useState<string | null>(null);
  const [pairingCodeData, setPairingCodeData] = useState<string | null>(null);
  const pollIntervalRef = useRef<NodeJS.Timeout | null>(null);

  const [autoLeadCapture, setAutoLeadCapture] = useState(true);
  const [capturingLeads, setCapturingLeads] = useState(false);
  const [syncingHistory, setSyncingHistory] = useState(false);

  // IA apenas em conversas novas (sincronizado com /api/ai/config)
  const [onlyNewConversations, setOnlyNewConversations] = useState(false);
  const [updatingOnlyNew, setUpdatingOnlyNew] = useState(false);

  useEffect(() => {
    fetch('/api/ai/config')
      .then((r) => r.json())
      .then((d) => {
        if (d && typeof d.only_new_conversations === 'boolean') {
          setOnlyNewConversations(d.only_new_conversations);
        }
      })
      .catch(() => {});
  }, []);

  const handleToggleOnlyNew = async (val: boolean) => {
    setOnlyNewConversations(val);
    setUpdatingOnlyNew(true);
    try {
      const res = await fetch('/api/ai/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ only_new_conversations: val }),
      });
      if (!res.ok) throw new Error('Falha ao salvar preferência');
      toast.success(
        val
          ? 'IA configurada para responder APENAS novas conversas (SIM)!'
          : 'IA configurada para responder todas as conversas (NÃO)!'
      );
    } catch {
      toast.error('Erro ao atualizar modo de novas conversas');
      setOnlyNewConversations(!val);
    } finally {
      setUpdatingOnlyNew(false);
    }
  };

  const webhookUrl =
    typeof window !== 'undefined'
      ? `${window.location.origin}/api/whatsapp/uazapi/webhook`
      : '';

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
        loadConnections(true);
      } else {
        toast.error(data.error || 'Falha ao sincronizar conversas');
      }
    } catch {
      toast.error('Erro de conexão ao sincronizar');
    } finally {
      setSyncingHistory(false);
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

  const handleCaptureExistingLeads = async () => {
    try {
      setCapturingLeads(true);
      const res = await fetch('/api/whatsapp/uazapi/capture-leads', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'capture-all' }),
      });
      const data = await res.json();
      if (data.success) {
        toast.success(data.message || 'Contatos capturados como leads com sucesso!');
      } else {
        toast.error(data.error || 'Falha ao capturar contatos');
      }
    } catch {
      toast.error('Erro ao executar captura');
    } finally {
      setCapturingLeads(false);
    }
  };


  // Load connections from API
  const loadConnections = useCallback(async (checkLiveStatus = false) => {
    try {
      setLoading(true);
      const res = await fetch(
        `/api/whatsapp/uazapi/config${checkLiveStatus ? '?check_status=true' : ''}`
      );
      const data = await res.json();
      if (data.connections) {
        setConnections(data.connections);
        const active = data.connections.find((c: UazApiConnectionItem) => c.is_active);
        if (active) {
          setActiveId(active.id);
          if (!selectedConn && !isCreatingNew) {
            setSelectedConn(active);
            setDisplayName(active.display_name);
            setBaseUrl(active.base_url || 'https://free.uazapi.com');
            setToken(active.token_masked || '');
          }
        } else if (data.connections.length > 0 && !selectedConn && !isCreatingNew) {
          setSelectedConn(data.connections[0]);
          setDisplayName(data.connections[0].display_name);
          setBaseUrl(data.connections[0].base_url || 'https://free.uazapi.com');
          setToken(data.connections[0].token_masked || '');
        }
      }
    } catch (err) {
      console.error('Error loading UazAPI connections:', err);
      toast.error('Erro ao carregar conexões do UazAPI');
    } finally {
      setLoading(false);
    }
  }, [selectedConn, isCreatingNew]);

  useEffect(() => {
    loadConnections(true);
    return () => {
      if (pollIntervalRef.current) clearInterval(pollIntervalRef.current);
    };
  }, []);

  // Poll status while QR code is open
  const startPollingStatus = useCallback((connId: string) => {
    if (pollIntervalRef.current) clearInterval(pollIntervalRef.current);

    pollIntervalRef.current = setInterval(async () => {
      try {
        const res = await fetch('/api/whatsapp/uazapi/config', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'status', id: connId }),
        });
        const data = await res.json();

        if (data.status === 'connected') {
          if (pollIntervalRef.current) clearInterval(pollIntervalRef.current);
          setQrCodeData(null);
          setPairingCodeData(null);
          toast.success('WhatsApp conectado com sucesso via UazAPI!');
          loadConnections(false);
        } else if (data.qrcode) {
          setQrCodeData(data.qrcode);
        }
      } catch {
        // Continue polling
      }
    }, 3000);
  }, [loadConnections]);

  const handleSelectConnection = (conn: UazApiConnectionItem) => {
    setIsCreatingNew(false);
    setSelectedConn(conn);
    setDisplayName(conn.display_name);
    setBaseUrl(conn.base_url || 'https://free.uazapi.com');
    setToken(conn.token_masked || '');
    setQrCodeData(conn.qrcode || null);
  };

  const handleStartNew = () => {
    setIsCreatingNew(true);
    setSelectedConn(null);
    setDisplayName('WhatsApp Principal');
    setBaseUrl('https://free.uazapi.com');
    setToken('');
    setQrCodeData(null);
  };

  const handleSaveConnection = async () => {
    if (!displayName.trim()) {
      toast.error('Informe um nome para a conexão');
      return;
    }
    if (isCreatingNew && !token.trim()) {
      toast.error('Informe o token da instância do UazAPI');
      return;
    }

    try {
      setSaving(true);
      const payload: Record<string, unknown> = {
        action: 'save',
        display_name: displayName.trim(),
        base_url: baseUrl.trim(),
        is_active: true,
      };

      if (!isCreatingNew && selectedConn) {
        payload.id = selectedConn.id;
      }
      if (token && !token.includes('••••')) {
        payload.token = token.trim();
      }

      const res = await fetch('/api/whatsapp/uazapi/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      const data = await res.json();
      if (!res.ok || data.error) {
        throw new Error(data.error || 'Falha ao salvar conexão');
      }

      toast.success(isCreatingNew ? 'Instância criada com sucesso!' : 'Conexão atualizada!');
      setIsCreatingNew(false);
      await loadConnections(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Erro ao salvar conexão');
    } finally {
      setSaving(false);
    }
  };

  const handleTestStatus = async () => {
    if (!selectedConn) return;
    try {
      setTesting(true);
      const res = await fetch('/api/whatsapp/uazapi/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'status', id: selectedConn.id }),
      });
      const data = await res.json();
      const statusStr = typeof data.status === 'string' ? data.status : data.status?.connected ? 'connected' : 'unknown';
      if (statusStr === 'connected') {
        toast.success(`Conectado! Número: ${data.phone || 'OK'}`);
      } else if (statusStr === 'connecting') {
        toast.info('Instância aguardando leitura do QR Code');
        if (data.qrcode) setQrCodeData(data.qrcode);
      } else {
        toast.warning(`Status: ${statusStr}`);
      }
      await loadConnections(false);
    } catch (err) {
      toast.error('Falha ao verificar status');
    } finally {
      setTesting(false);
    }
  };

  const handleConnectQrCode = async () => {
    if (!selectedConn) return;
    try {
      setConnecting(true);
      setQrCodeData(null);
      setPairingCodeData(null);

      const res = await fetch('/api/whatsapp/uazapi/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'connect', id: selectedConn.id }),
      });

      const data = await res.json();
      if (!res.ok || data.error) {
        throw new Error(data.error || 'Falha ao gerar QR Code');
      }

      if (data.qrcode) {
        setQrCodeData(data.qrcode);
        toast.info('QR Code gerado! Aponte a câmera do WhatsApp para escanear.');
        startPollingStatus(selectedConn.id);
      } else if (data.status === 'connected') {
        const phoneLabel = data.phone ? `(${data.phone})` : '';
        toast.success(`WhatsApp já está conectado nesta instância! ${phoneLabel}`);
        toast.info('Para conectar outro número e gerar novo QR Code, clique no botão "Desconectar" primeiro.');
        setQrCodeData(null);
        await loadConnections(false);
      } else {
        const statusMsg = typeof data.message === 'string' ? data.message : typeof data.status === 'string' ? data.status : 'Aguardando QR Code';
        toast.info(`Status retornado: ${statusMsg}`);
        startPollingStatus(selectedConn.id);
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Erro ao conectar via QR Code');
    } finally {
      setConnecting(false);
    }
  };

  const handleDisconnect = async () => {
    if (!selectedConn) return;
    try {
      setDisconnecting(true);
      if (pollIntervalRef.current) clearInterval(pollIntervalRef.current);
      setQrCodeData(null);

      const res = await fetch('/api/whatsapp/uazapi/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'disconnect', id: selectedConn.id }),
      });

      if (res.ok) {
        toast.success('Instância desconectada com sucesso.');
        await loadConnections(false);
      } else {
        toast.error('Não foi possível desconectar.');
      }
    } catch {
      toast.error('Erro ao desconectar');
    } finally {
      setDisconnecting(false);
    }
  };

  const handleSetActive = async (id: string) => {
    try {
      const res = await fetch('/api/whatsapp/uazapi/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'set-active', id }),
      });
      if (res.ok) {
        setActiveId(id);
        toast.success('Instância definida como ativa para a Inbox!');
        await loadConnections(false);
      }
    } catch {
      toast.error('Erro ao ativar conexão');
    }
  };

  const handleSetupWebhook = async () => {
    if (!selectedConn) return;
    try {
      const res = await fetch('/api/whatsapp/uazapi/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'setup-webhook',
          id: selectedConn.id,
          webhookUrl,
        }),
      });
      const data = await res.json();
      if (data.success) {
        toast.success('Webhook configurado no UazAPI com sucesso!');
      } else {
        toast.error('UazAPI não aceitou a configuração automática de webhook.');
      }
    } catch {
      toast.error('Erro ao configurar webhook');
    }
  };

  const handleCopyWebhook = () => {
    navigator.clipboard.writeText(webhookUrl);
    setCopiedWebhook(true);
    toast.success('URL do Webhook copiada!');
    setTimeout(() => setCopiedWebhook(false), 2000);
  };

  const getStatusBadge = (status?: string) => {
    switch (status) {
      case 'connected':
        return (
          <Badge className="bg-emerald-500/15 text-emerald-500 hover:bg-emerald-500/25 border-emerald-500/30 gap-1.5">
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 animate-pulse" />
            Conectado
          </Badge>
        );
      case 'connecting':
        return (
          <Badge className="bg-amber-500/15 text-amber-500 hover:bg-amber-500/25 border-amber-500/30 gap-1.5">
            <span className="h-1.5 w-1.5 rounded-full bg-amber-500 animate-pulse" />
            Aguardando QR Code
          </Badge>
        );
      default:
        return (
          <Badge variant="outline" className="text-muted-foreground gap-1.5">
            <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground" />
            Desconectado
          </Badge>
        );
    }
  };

  return (
    <div className="space-y-6">
      {/* Header Info */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 p-4 rounded-xl border bg-card/50">
        <div>
          <div className="flex items-center gap-2">
            <h3 className="font-semibold text-base">Integração WhatsApp via UazAPI</h3>
            <Badge variant="secondary" className="text-xs">
              Baileys / Não Oficial
            </Badge>
          </div>
          <p className="text-sm text-muted-foreground mt-1">
            Conecte qualquer WhatsApp escanando um QR Code, sem burocracia de verificação da Meta.
          </p>
        </div>

        <Button
          onClick={handleStartNew}
          size="sm"
          className="gap-2 bg-primary hover:bg-primary/90 shrink-0"
        >
          <Plus className="h-4 w-4" />
          Nova Instância
        </Button>
      </div>

      {/* Regra de Ouro: IA Apenas em Conversas Novas */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 p-4 rounded-xl border-2 border-purple-500/30 bg-purple-500/5 dark:bg-purple-500/10 shadow-xs">
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <h4 className="font-semibold text-sm text-foreground flex items-center gap-1.5">
              🎯 IA Apenas em Conversas Novas
            </h4>
            <span
              className={`text-[11px] font-bold px-2.5 py-0.5 rounded-full border shadow-2xs ${
                onlyNewConversations
                  ? 'bg-emerald-500 text-white border-emerald-600'
                  : 'bg-muted text-muted-foreground border-border'
              }`}
            >
              {onlyNewConversations ? 'SIM (Ativo)' : 'NÃO (Desativado)'}
            </span>
          </div>
          <p className="text-xs text-muted-foreground leading-relaxed max-w-xl">
            Ao marcar <strong>SIM</strong>, a IA responde <strong>apenas novos leads/contatos que chegarem</strong>. Todas as conversas antigas e contatos já existentes serão mantidos automaticamente para <strong>atendimento manual</strong> sem resposta automática da IA.
          </p>
        </div>
        <div className="flex items-center gap-2 self-end sm:self-center shrink-0">
          <Switch
            checked={onlyNewConversations}
            disabled={updatingOnlyNew}
            onCheckedChange={handleToggleOnlyNew}
            className="data-[state=checked]:bg-emerald-600"
          />
        </div>
      </div>

      {/* Grid: Connections List & Form */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Left Column: Saved Connections */}
        <div className="lg:col-span-1 space-y-3">
          <div className="flex items-center justify-between">
            <Label className="text-xs font-semibold uppercase text-muted-foreground tracking-wider">
              Instâncias Cadastradas ({connections.length})
            </Label>
            <Button
              variant="ghost"
              size="icon"
              className="h-6 w-6"
              onClick={() => loadConnections(true)}
              title="Atualizar lista e status"
            >
              <RefreshCw className={loading ? 'h-3.5 w-3.5 animate-spin' : 'h-3.5 w-3.5'} />
            </Button>
          </div>

          {loading && connections.length === 0 ? (
            <div className="flex items-center justify-center p-8 border rounded-xl bg-card/30">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          ) : connections.length === 0 ? (
            <div className="p-6 text-center border rounded-xl bg-card/30 text-sm text-muted-foreground">
              Nenhuma instância UazAPI cadastrada ainda.
            </div>
          ) : (
            <div className="space-y-2">
              {connections.map((conn) => {
                const isSelected = selectedConn?.id === conn.id && !isCreatingNew;
                const isActive = conn.is_active;

                return (
                  <div
                    key={conn.id}
                    onClick={() => handleSelectConnection(conn)}
                    className={`p-3.5 rounded-xl border cursor-pointer transition-all ${
                      isSelected
                        ? 'border-primary bg-primary/5 shadow-sm'
                        : 'hover:border-border/80 bg-card/40'
                    }`}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <span className="font-medium text-sm truncate">
                            {conn.display_name}
                          </span>
                          {isActive && (
                            <Badge className="bg-primary/20 text-primary text-[10px] px-1.5 py-0 h-4 border-none">
                              Ativa
                            </Badge>
                          )}
                        </div>
                        <p className="text-xs text-muted-foreground mt-0.5 truncate">
                          {conn.phone_number ? `+${conn.phone_number}` : conn.base_url}
                        </p>
                      </div>
                      <div className="shrink-0">{getStatusBadge(conn.status)}</div>
                    </div>

                    {!isActive && (
                      <div className="mt-2.5 pt-2 border-t flex justify-end">
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-6 text-[11px] px-2 text-muted-foreground hover:text-primary"
                          onClick={(e) => {
                            e.stopPropagation();
                            handleSetActive(conn.id);
                          }}
                        >
                          Tornar Ativa
                        </Button>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Right Column: Connection Settings & QR Code */}
        <div className="lg:col-span-2 space-y-6">
          <Card className="border shadow-sm">
            <CardHeader className="pb-4">
              <div className="flex items-center justify-between">
                <div>
                  <CardTitle className="text-base">
                    {isCreatingNew
                      ? 'Adicionar Nova Instância UazAPI'
                      : `Configuração: ${selectedConn?.display_name || 'Instância'}`}
                  </CardTitle>
                  <CardDescription className="text-xs">
                    Configure os dados de acesso da instância UazAPI
                  </CardDescription>
                </div>
                {!isCreatingNew && selectedConn && getStatusBadge(selectedConn.status)}
              </div>
            </CardHeader>

            <CardContent className="space-y-4">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div className="space-y-1.5">
                  <Label htmlFor="displayName" className="text-xs">
                    Nome de Identificação
                  </Label>
                  <Input
                    id="displayName"
                    placeholder="Ex: Comercial WhatsApp"
                    value={displayName}
                    onChange={(e) => setDisplayName(e.target.value)}
                  />
                </div>

                <div className="space-y-1.5">
                  <Label htmlFor="baseUrl" className="text-xs">
                    URL da API (Base URL)
                  </Label>
                  <Input
                    id="baseUrl"
                    placeholder="https://free.uazapi.com"
                    value={baseUrl}
                    onChange={(e) => setBaseUrl(e.target.value)}
                  />
                </div>
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="token" className="text-xs">
                  Token da Instância (Token / Instance Token)
                </Label>
                <Input
                  id="token"
                  type="password"
                  placeholder={
                    isCreatingNew ? 'Cole o token da instância' : '•••••••••••••••• (Inalterado)'
                  }
                  value={token}
                  onChange={(e) => setToken(e.target.value)}
                />
                <p className="text-[11px] text-muted-foreground">
                  Seu token é armazenado criptografado no banco de dados via AES-256-GCM.
                </p>
              </div>

              {/* Seção Captura Automática de Leads */}
              <div className="rounded-xl border bg-muted/30 p-4 space-y-3">
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                  <div className="space-y-1">
                    <div className="flex items-center gap-2">
                      <UserCheck className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
                      <Label htmlFor="autoLeadCapture" className="text-sm font-semibold cursor-pointer">
                        Captura Automática de Leads
                      </Label>
                      <Badge className={autoLeadCapture ? "bg-emerald-500/15 text-emerald-600 border-emerald-500/30 text-[10px]" : "bg-muted text-muted-foreground text-[10px]"}>
                        {autoLeadCapture ? "LIGADO (SIM)" : "DESLIGADO (NÃO)"}
                      </Badge>
                    </div>
                    <p className="text-xs text-muted-foreground leading-relaxed">
                      Salva novos contatos automaticamente com o nome que eles já cadastraram no próprio WhatsApp (pushName) e aplica a etiqueta de <strong>Lead</strong>.
                    </p>
                  </div>
                  <div className="flex items-center gap-2 self-end sm:self-center shrink-0">
                    <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                      {autoLeadCapture ? "Sim" : "Não"}
                    </span>
                    <Switch
                      id="autoLeadCapture"
                      checked={autoLeadCapture}
                      onCheckedChange={handleToggleAutoLeadCapture}
                    />
                  </div>
                </div>

                <div className="pt-2 border-t border-border/40 flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                  <span className="text-xs text-muted-foreground">
                    Capturar os nomes reais e etiquetar todos os contatos existentes agora:
                  </span>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={handleCaptureExistingLeads}
                    disabled={capturingLeads}
                    className="gap-1.5 text-xs text-emerald-600 border-emerald-500/30 hover:bg-emerald-500/10 shrink-0"
                  >
                    {capturingLeads ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />}
                    Capturar Leads Existentes
                  </Button>
                </div>
              </div>

              <div className="flex flex-wrap items-center justify-between gap-3 pt-3 border-t">

                <div className="flex items-center gap-2">
                  {!isCreatingNew && selectedConn && (
                    <>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={handleTestStatus}
                        disabled={testing}
                        className="gap-1.5 text-xs"
                      >
                        {testing ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <Zap className="h-3.5 w-3.5 text-amber-500" />
                        )}
                        Testar Conexão
                      </Button>

                      {selectedConn.status === 'connected' ? (
                        <>
                          <Button
                            variant="default"
                            size="sm"
                            onClick={handleSyncHistory}
                            disabled={syncingHistory}
                            className="gap-1.5 text-xs bg-emerald-600 hover:bg-emerald-700 text-white cursor-pointer"
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
                            onClick={handleDisconnect}
                            disabled={disconnecting}
                            className="gap-1.5 text-xs text-destructive hover:bg-destructive/10"
                          >
                            {disconnecting ? (
                              <Loader2 className="h-3.5 w-3.5 animate-spin" />
                            ) : (
                              <WifiOff className="h-3.5 w-3.5" />
                            )}
                            Desconectar
                          </Button>
                        </>
                      ) : (
                        <Button
                          size="sm"
                          onClick={handleConnectQrCode}
                          disabled={connecting}
                          className="gap-1.5 text-xs bg-emerald-600 hover:bg-emerald-700 text-white"
                        >
                          {connecting ? (
                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                          ) : (
                            <QrCode className="h-3.5 w-3.5" />
                          )}
                          Conectar QR Code
                        </Button>
                      )}
                    </>
                  )}
                </div>

                <Button
                  size="sm"
                  onClick={handleSaveConnection}
                  disabled={saving}
                  className="gap-1.5 text-xs ml-auto"
                >
                  {saving && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                  {isCreatingNew ? 'Criar Instância' : 'Salvar Alterações'}
                </Button>
              </div>
            </CardContent>
          </Card>

          {/* Live QR Code Display Card */}
          {qrCodeData && (
            <Card className="border-2 border-emerald-500/40 bg-emerald-500/5 shadow-md animate-in fade-in zoom-in-95 duration-200">
              <CardHeader className="pb-2 text-center">
                <div className="flex items-center justify-center gap-2">
                  <QrCode className="h-5 w-5 text-emerald-500" />
                  <CardTitle className="text-base text-emerald-600 dark:text-emerald-400">
                    Escaneie o QR Code com seu WhatsApp
                  </CardTitle>
                </div>
                <CardDescription className="text-xs">
                  Abra o WhatsApp no celular → Aparelhos Conectados → Conectar Aparelho
                </CardDescription>
              </CardHeader>

              <CardContent className="flex flex-col items-center justify-center p-6 space-y-4">
                <div className="p-3 bg-white rounded-2xl shadow-inner border border-black/10">
                  {/* Image QR Code */}
                  <img
                    src={
                      qrCodeData.startsWith('data:')
                        ? qrCodeData
                        : `data:image/png;base64,${qrCodeData}`
                    }
                    alt="WhatsApp QR Code"
                    className="w-56 h-56 object-contain"
                  />
                </div>

                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <span className="h-2 w-2 rounded-full bg-emerald-500 animate-ping" />
                  <span>Aguardando leitura do QR Code...</span>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-6 text-xs px-2"
                    onClick={handleConnectQrCode}
                  >
                    Recarregar QR
                  </Button>
                </div>
              </CardContent>
            </Card>
          )}

          {/* Webhook Settings Card */}
          <Card className="border bg-card/40">
            <CardHeader className="pb-3">
              <div className="flex items-center gap-2">
                <Radio className="h-4 w-4 text-primary" />
                <CardTitle className="text-sm">Configuração do Webhook UazAPI</CardTitle>
              </div>
              <CardDescription className="text-xs">
                Para que as mensagens recebidas no WhatsApp apareçam instantaneamente na Inbox
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="flex items-center gap-2">
                <Input
                  readOnly
                  value={webhookUrl}
                  className="font-mono text-xs bg-muted/50"
                />
                <Button
                  variant="outline"
                  size="icon"
                  className="shrink-0"
                  onClick={handleCopyWebhook}
                  title="Copiar URL do Webhook"
                >
                  {copiedWebhook ? (
                    <Check className="h-4 w-4 text-emerald-500" />
                  ) : (
                    <Copy className="h-4 w-4" />
                  )}
                </Button>
                {selectedConn && (
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={handleSetupWebhook}
                    className="shrink-0 text-xs gap-1.5"
                  >
                    Auto-Configurar
                  </Button>
                )}
              </div>

              <div className="p-3 rounded-lg bg-muted/40 text-xs text-muted-foreground flex items-start gap-2">
                <Info className="h-4 w-4 text-primary shrink-0 mt-0.5" />
                <p>
                  O botão <strong>Auto-Configurar</strong> envia a URL acima para o endpoint{' '}
                  <code className="bg-muted px-1 rounded">/webhook</code> do UazAPI registrando os
                  eventos de mensagens e conexão automaticamente.
                </p>
              </div>
            </CardContent>
          </Card>
        </div>
      </div>

      {/* Chave PIX Padrão da Empresa (Envio Nativo WhatsApp) */}
      <PixConfigCard />
    </div>
  );
}
