'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase/client';
import { Broadcast, BroadcastRecipient, BroadcastEvent, RecipientStatus } from '@/types';
import { Button } from '@/components/ui/button';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  ArrowLeft,
  Loader2,
  Users,
  Send,
  CheckCheck,
  Eye,
  AlertCircle,
  MessageCircle,
  Filter,
  Download,
  ChevronDown,
  Trash2,
  RotateCcw,
  Play,
  Pause,
  XCircle,
  AlertTriangle,
  Clock,
  Layers,
  ShieldCheck,
  ShieldAlert,
  Activity,
  History,
  CheckCircle2,
  RefreshCw,
} from 'lucide-react';
import { toast } from 'sonner';
import {
  getBroadcastStatus,
  getRecipientStatus,
} from '@/lib/broadcast-status';
import { useTranslations } from 'next-intl';

interface StatCardProps {
  label: string;
  value: number;
  total: number;
  icon: React.ReactNode;
  color: string;
}

function StatCard({ label, value, total, icon, color }: StatCardProps) {
  const pct = total > 0 ? Math.round((value / total) * 100) : 0;
  return (
    <div className="rounded-xl border border-border bg-card p-4 shadow-sm">
      <div className="flex items-center justify-between">
        <div className={`flex h-8 w-8 items-center justify-center rounded-lg ${color}`}>
          {icon}
        </div>
        <span className="text-xs text-muted-foreground">{pct}%</span>
      </div>
      <p className="mt-3 text-2xl font-bold text-foreground">{value.toLocaleString()}</p>
      <p className="text-xs text-muted-foreground">{label}</p>
    </div>
  );
}

interface FunnelStep {
  label: string;
  value: number;
  color: string;
}

function FunnelChart({ steps }: { steps: FunnelStep[] }) {
  const max = Math.max(...steps.map((s) => s.value), 1);
  return (
    <div className="rounded-xl border border-border bg-card p-4 shadow-sm">
      <h3 className="mb-4 text-sm font-medium text-foreground">Funil de Conversão</h3>
      <div className="space-y-2">
        {steps.map((step) => {
          const pctOfMax = Math.max(5, Math.round((step.value / max) * 100));
          const pctOfSent =
            steps[0].value > 0
              ? Math.round((step.value / steps[0].value) * 100)
              : 0;
          return (
            <div key={step.label} className="flex items-center gap-3">
              <span className="w-20 shrink-0 text-xs text-muted-foreground">
                {step.label}
              </span>
              <div className="relative h-7 flex-1 rounded-full bg-muted">
                <div
                  className={`h-7 rounded-full ${step.color} transition-[width] duration-500`}
                  style={{ width: `${pctOfMax}%` }}
                />
                <span className="absolute inset-0 flex items-center px-3 text-xs font-medium text-foreground">
                  {step.value.toLocaleString()}
                  <span className="ml-2 text-muted-foreground/80">
                    ({pctOfSent}%)
                  </span>
                </span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

const RECIPIENT_STATUSES: readonly RecipientStatus[] = [
  'pending',
  'processing',
  'sent',
  'delivered',
  'read',
  'replied',
  'failed',
  'cancelled',
];

function toCsv(rows: string[][]): string {
  const escape = (v: string) => `"${v.replace(/"/g, '""')}"`;
  return rows.map((r) => r.map(escape).join(',')).join('\n');
}

function downloadBlob(filename: string, content: string) {
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export default function BroadcastDetailPage() {
  const params = useParams();
  const router = useRouter();
  const t = useTranslations('Broadcasts.detail');
  const tStatus = useTranslations('Broadcasts.status');
  const broadcastId = params.id as string;

  const [broadcast, setBroadcast] = useState<Broadcast | null>(null);
  const [recipients, setRecipients] = useState<BroadcastRecipient[]>([]);
  const [events, setEvents] = useState<BroadcastEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<RecipientStatus | 'all'>('all');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [resumingScope, setResumingScope] = useState<'pending' | 'failed' | null>(null);

  // Control actions dialog states
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [confirmPauseDialog, setConfirmPauseDialog] = useState(false);
  const [confirmResumeDialog, setConfirmResumeDialog] = useState(false);
  const [confirmCancelDialog, setConfirmCancelDialog] = useState(false);
  const [countdownSeconds, setCountdownSeconds] = useState<number | null>(null);
  const [countdownLabel, setCountdownLabel] = useState<string>('');

  const fetchData = useCallback(async (silent = false) => {
    try {
      const supabase = createClient();

      const { data: bc, error: bcError } = await supabase
        .from('broadcasts')
        .select('*')
        .eq('id', broadcastId)
        .single();

      if (bcError) throw bcError;
      setBroadcast(bc);

      const { data: recs, error: recsError } = await supabase
        .from('broadcast_recipients')
        .select('*, contact:contacts(*)')
        .eq('broadcast_id', broadcastId)
        .order('created_at', { ascending: false });

      if (recsError) throw recsError;
      setRecipients(recs ?? []);

      // Fetch recent timeline events
      const { data: evts } = await supabase
        .from('broadcast_events')
        .select('*')
        .eq('broadcast_id', broadcastId)
        .order('created_at', { ascending: false })
        .limit(25);

      setEvents(evts ?? []);
    } catch (err) {
      if (!silent) {
        setError(err instanceof Error ? err.message : t('notFound'));
      }
    } finally {
      if (!silent) setLoading(false);
    }
  }, [broadcastId, t]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  // Live countdown timer calculation
  useEffect(() => {
    if (!broadcast) return;

    const interval = setInterval(() => {
      if (broadcast.status === 'paused') {
        setCountdownSeconds(null);
        setCountdownLabel('Campanha pausada');
        return;
      }

      if (broadcast.status !== 'sending') {
        setCountdownSeconds(null);
        setCountdownLabel('');
        return;
      }

      // Check batch pause (next_run_at)
      if (broadcast.next_run_at) {
        const target = new Date(broadcast.next_run_at).getTime();
        const diffMs = target - Date.now();
        if (diffMs > 0) {
          const secs = Math.ceil(diffMs / 1000);
          setCountdownSeconds(secs);
          setCountdownLabel(`Pausa do lote: retomando em ${secs}s`);
          return;
        }
      }

      // Live queue sending tick
      const cooldownSec = broadcast.cooldown_interval_seconds ?? 5;
      setCountdownLabel(`Fila ativa: envio a cada ${cooldownSec}s`);
      setCountdownSeconds(null);
    }, 1000);

    return () => clearInterval(interval);
  }, [broadcast]);

  // Autonomous background heartbeat & polling while sending
  useEffect(() => {
    if (!broadcast || broadcast.status !== 'sending') return;

    const pollTimer = setInterval(async () => {
      await fetchData(true);
      // Heartbeat queue tick trigger
      try {
        await fetch(`/api/whatsapp/broadcast/${broadcastId}/tick`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ maxMessages: 5 }),
        });
      } catch {
        // Ignored
      }
    }, 4000);

    return () => clearInterval(pollTimer);
  }, [broadcast, broadcastId, fetchData]);

  // Control Actions handler
  async function handleControlAction(action: 'start' | 'pause' | 'resume' | 'cancel', reason?: string) {
    setActionLoading(action);
    try {
      const res = await fetch(`/api/whatsapp/broadcast/${broadcastId}/control`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, reason }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'Falha ao executar ação de controle.');
      }

      toast.success(
        action === 'pause'
          ? 'Campanha pausada com sucesso.'
          : action === 'resume'
            ? 'Campanha retomada com sucesso.'
            : action === 'cancel'
              ? 'Campanha cancelada.'
              : 'Campanha iniciada com sucesso.'
      );

      await fetchData(true);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Erro ao controlar envio';
      toast.error(msg);
    } finally {
      setActionLoading(null);
      setConfirmPauseDialog(false);
      setConfirmResumeDialog(false);
      setConfirmCancelDialog(false);
    }
  }

  // Filtered recipients
  const filteredRecipients = useMemo(
    () =>
      statusFilter === 'all'
        ? recipients
        : recipients.filter((r) => r.status === statusFilter),
    [recipients, statusFilter],
  );

  const pendingCount = useMemo(
    () => recipients.filter((r) => r.status === 'pending' || r.status === 'processing').length,
    [recipients]
  );

  const retryableCount = useMemo(
    () => recipients.filter((r) => r.status === 'failed').length,
    [recipients]
  );

  // Remaining ETA Calculation
  const remainingEtaText = useMemo(() => {
    if (!broadcast || pendingCount <= 0) return 'Concluído';
    const cooldown = Math.max(1, broadcast.cooldown_interval_seconds ?? 5);
    const batchSize = Math.max(1, broadcast.batch_size ?? 20);
    const batchPause = Math.max(1, broadcast.batch_pause_seconds ?? 60);

    const remainingBatches = Math.ceil(pendingCount / batchSize);
    const remainingPauses = Math.max(0, remainingBatches - 1);
    const totalSec = pendingCount * cooldown + remainingPauses * batchPause;

    if (totalSec < 60) return `~${totalSec}s restantes`;
    const mins = Math.floor(totalSec / 60);
    const secs = totalSec % 60;
    if (mins < 60) return secs > 0 ? `~${mins}m ${secs}s restantes` : `~${mins}m restantes`;
    const hrs = Math.floor(mins / 60);
    const rm = mins % 60;
    return `~${hrs}h ${rm}m restantes`;
  }, [broadcast, pendingCount]);

  function handleExport() {
    if (!broadcast) return;
    const header = [
      t('table.contact'),
      t('table.phone'),
      t('table.status'),
      'Tentativas',
      t('table.sent'),
      t('table.delivered'),
      t('table.read'),
      t('table.error'),
    ];
    const rows = recipients.map((r) => [
      r.contact?.name ?? '',
      r.contact?.phone ?? '',
      r.status,
      String(r.attempts ?? 0),
      r.sent_at ?? '',
      r.delivered_at ?? '',
      r.read_at ?? '',
      r.error_message ?? '',
    ]);
    const csv = toCsv([header, ...rows]);
    const safeName = broadcast.name.replace(/[^a-z0-9-_]+/gi, '-').toLowerCase();
    downloadBlob(`broadcast-${safeName}-${broadcastId.slice(0, 8)}.csv`, csv);
  }

  async function handleResumeLegacy(scope: 'pending' | 'failed') {
    setResumingScope(scope);
    try {
      const res = await fetch(`/api/whatsapp/broadcast/${broadcastId}/resume`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scope }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Falha ao reprocessar.');
      toast.success('Reprocessamento iniciado.');
      await fetchData(true);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Erro ao reprocessar');
    } finally {
      setResumingScope(null);
    }
  }

  async function handleDelete() {
    setDeleting(true);
    try {
      const supabase = createClient();
      const { error: delError } = await supabase
        .from('broadcasts')
        .delete()
        .eq('id', broadcastId);

      if (delError) throw delError;
      toast.success(t('deleteSuccess'));
      router.push('/broadcasts');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('deleteFailed'));
      setDeleting(false);
      setConfirmDelete(false);
    }
  }

  if (loading) {
    return (
      <div className="flex h-96 items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    );
  }

  if (error || !broadcast) {
    return (
      <div className="flex h-96 flex-col items-center justify-center gap-4">
        <p className="text-muted-foreground">{error ?? t('notFound')}</p>
        <Button variant="outline" onClick={() => router.push('/broadcasts')}>
          <ArrowLeft className="h-4 w-4 mr-2" />
          {t('back')}
        </Button>
      </div>
    );
  }

  const bStatus = getBroadcastStatus(broadcast.status);
  const total = broadcast.total_recipients || recipients.length || 1;
  const processed = broadcast.sent_count + broadcast.failed_count;
  const progressPct = Math.min(100, Math.round((processed / total) * 100));

  const funnelSteps: FunnelStep[] = [
    { label: t('funnel.sent'), value: broadcast.sent_count, color: 'bg-primary' },
    { label: t('funnel.delivered'), value: broadcast.delivered_count, color: 'bg-teal-500' },
    { label: t('funnel.read'), value: broadcast.read_count, color: 'bg-blue-500' },
    { label: t('funnel.replied'), value: broadcast.replied_count, color: 'bg-indigo-500' },
  ];

  return (
    <div className="space-y-6">
      {/* Header Bar */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-3">
          <Button
            variant="ghost"
            size="icon"
            onClick={() => router.push('/broadcasts')}
            className="h-9 w-9 text-muted-foreground hover:bg-muted"
          >
            <ArrowLeft className="h-5 w-5" />
          </Button>
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-xl font-bold text-foreground">{broadcast.name}</h1>
              <span
                className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium ${bStatus.classes}`}
              >
                {bStatus.pulse && (
                  <span className="relative flex h-2 w-2">
                    <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-yellow-400 opacity-75" />
                    <span className="relative inline-flex h-2 w-2 rounded-full bg-yellow-500" />
                  </span>
                )}
                {broadcast.status === 'paused' && '⏸️ Pausada'}
                {broadcast.status === 'sending' && '🟢 Enviando (Fila Ativa)'}
                {broadcast.status === 'sent' && '✅ Concluída'}
                {broadcast.status === 'cancelled' && '⏹️ Cancelada'}
                {broadcast.status === 'failed' && '❌ Falhou'}
                {broadcast.status === 'draft' && '📝 Rascunho'}
                {broadcast.status === 'scheduled' && '📅 Agendada'}
              </span>
            </div>
            <p className="text-xs text-muted-foreground mt-0.5">
              Template: <span className="font-medium text-foreground">{broadcast.template_name}</span> • Criado em{' '}
              {new Date(broadcast.created_at).toLocaleString('pt-BR')}
            </p>
          </div>
        </div>

        {/* Action Control Buttons */}
        <div className="flex flex-wrap items-center gap-2">
          {/* Iniciar (if draft or scheduled) */}
          {(broadcast.status === 'draft' || broadcast.status === 'scheduled') && (
            <Button
              size="sm"
              onClick={() => handleControlAction('start')}
              disabled={actionLoading !== null}
              className="bg-emerald-600 hover:bg-emerald-700 text-white"
            >
              {actionLoading === 'start' ? (
                <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />
              ) : (
                <Play className="h-4 w-4 mr-1.5 fill-current" />
              )}
              Iniciar Fila
            </Button>
          )}

          {/* Pausar (if sending) */}
          {broadcast.status === 'sending' && (
            <Button
              size="sm"
              variant="outline"
              onClick={() => setConfirmPauseDialog(true)}
              disabled={actionLoading !== null}
              className="border-amber-500/30 text-amber-400 hover:bg-amber-500/10"
            >
              {actionLoading === 'pause' ? (
                <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />
              ) : (
                <Pause className="h-4 w-4 mr-1.5 fill-current" />
              )}
              Pausar
            </Button>
          )}

          {/* Retomar (if paused) */}
          {broadcast.status === 'paused' && (
            <Button
              size="sm"
              onClick={() => setConfirmResumeDialog(true)}
              disabled={actionLoading !== null}
              className="bg-primary text-primary-foreground hover:bg-primary/90"
            >
              {actionLoading === 'resume' ? (
                <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />
              ) : (
                <Play className="h-4 w-4 mr-1.5 fill-current" />
              )}
              Retomar Disparo
            </Button>
          )}

          {/* Cancelar (if sending or paused) */}
          {(broadcast.status === 'sending' || broadcast.status === 'paused') && (
            <Button
              size="sm"
              variant="outline"
              onClick={() => setConfirmCancelDialog(true)}
              disabled={actionLoading !== null}
              className="border-red-500/30 text-red-400 hover:bg-red-500/10"
            >
              <XCircle className="h-4 w-4 mr-1.5" />
              Cancelar
            </Button>
          )}

          {/* Reenviar falhas */}
          {retryableCount > 0 && broadcast.status !== 'sending' && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => handleResumeLegacy('failed')}
              disabled={resumingScope !== null}
              className="border-border text-muted-foreground hover:bg-muted"
            >
              {resumingScope === 'failed' ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" />
              ) : (
                <RotateCcw className="h-3.5 w-3.5 mr-1.5" />
              )}
              Reenviar Falhas ({retryableCount})
            </Button>
          )}

          {/* Delete Dialog */}
          <Dialog open={confirmDelete} onOpenChange={setConfirmDelete}>
            <Button
              variant="outline"
              size="icon"
              onClick={() => setConfirmDelete(true)}
              className="border-border text-muted-foreground hover:bg-muted hover:text-red-400"
            >
              <Trash2 className="h-4 w-4" />
            </Button>
            <DialogContent className="border-border bg-popover sm:max-w-md">
              <DialogHeader>
                <DialogTitle className="text-popover-foreground">{t('deleteConfirmTitle')}</DialogTitle>
                <DialogDescription className="text-muted-foreground">
                  {t('deleteConfirmDescription')}
                </DialogDescription>
              </DialogHeader>
              <DialogFooter>
                <Button
                  variant="outline"
                  onClick={() => setConfirmDelete(false)}
                  className="border-border text-muted-foreground"
                >
                  {t('cancel')}
                </Button>
                <Button
                  variant="destructive"
                  onClick={handleDelete}
                  disabled={deleting}
                >
                  {deleting ? (
                    <Loader2 className="h-4 w-4 animate-spin mr-2" />
                  ) : null}
                  {t('delete')}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </div>
      </div>

      {/* Safety Pause Banner (Shown when Paused) */}
      {broadcast.status === 'paused' && (
        <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-4 shadow-sm space-y-3">
          <div className="flex items-start justify-between gap-3">
            <div className="flex items-start gap-3">
              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-amber-500/20 text-amber-400">
                <AlertTriangle className="h-5 w-5" />
              </div>
              <div>
                <h3 className="text-sm font-semibold text-foreground">Campanha Pausada por Segurança</h3>
                <p className="text-xs text-amber-200/90 mt-1">
                  <strong>Motivo:</strong> {broadcast.paused_reason || 'Pausado manualmente pelo administrador.'}
                </p>
                <p className="text-[11px] text-muted-foreground mt-1">
                  O sistema de fila de segurança interrompeu os disparos para prevenir sanções ou bloqueios adicionais. Verifique a qualidade do template e a conexão do WhatsApp antes de retomar.
                </p>
              </div>
            </div>
            <Button
              size="sm"
              onClick={() => setConfirmResumeDialog(true)}
              className="bg-primary text-primary-foreground hover:bg-primary/90 shrink-0"
            >
              <Play className="h-3.5 w-3.5 mr-1.5 fill-current" />
              Retomar Envio
            </Button>
          </div>
        </div>
      )}

      {/* Queue & Cooldown Dashboard Card */}
      <div className="rounded-xl border border-border bg-card p-5 space-y-4 shadow-sm">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-border pb-3">
          <div>
            <h2 className="text-sm font-semibold text-foreground flex items-center gap-2">
              <Activity className="h-4 w-4 text-primary" />
              Painel de Controle da Fila & Cooldown
            </h2>
            <p className="text-xs text-muted-foreground">
              Monitoramento em tempo real do processamento sequencial e limites
            </p>
          </div>

          <div className="flex items-center gap-2 text-xs">
            {broadcast.status === 'sending' && (
              <span className="inline-flex items-center gap-1.5 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2.5 py-1 text-emerald-400 font-medium">
                <span className="relative flex h-2 w-2">
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" />
                  <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-500" />
                </span>
                {countdownLabel || 'Fila em Execução'}
              </span>
            )}
            <Button
              variant="outline"
              size="sm"
              onClick={() => fetchData(false)}
              className="h-8 border-border text-muted-foreground hover:bg-muted"
            >
              <RefreshCw className="h-3.5 w-3.5 mr-1" />
              Atualizar
            </Button>
          </div>
        </div>

        {/* Progress Bar & Countdown Banner */}
        <div className="space-y-2">
          <div className="flex items-center justify-between text-xs">
            <span className="font-medium text-foreground">
              Progresso Geral: <span className="text-primary">{progressPct}%</span> ({processed} de {total} contatos)
            </span>
            <span className="text-muted-foreground">
              {pendingCount > 0 ? (
                <>Tempo Estimado: <strong className="text-foreground">{remainingEtaText}</strong></>
              ) : (
                <span className="text-emerald-400 font-medium flex items-center gap-1">
                  <CheckCircle2 className="h-3.5 w-3.5" /> Fila Concluída
                </span>
              )}
            </span>
          </div>
          <div className="h-2 w-full rounded-full bg-muted overflow-hidden">
            <div
              className="h-full rounded-full bg-primary transition-all duration-500"
              style={{ width: `${progressPct}%` }}
            />
          </div>
        </div>

        {/* Parameters Chips */}
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground pt-1">
          <span className="inline-flex items-center gap-1.5 rounded-md border border-border bg-muted/40 px-2.5 py-1 text-foreground">
            <Clock className="h-3.5 w-3.5 text-primary" />
            Cooldown: <strong>{broadcast.cooldown_interval_seconds ?? 5}s</strong>
          </span>
          <span className="inline-flex items-center gap-1.5 rounded-md border border-border bg-muted/40 px-2.5 py-1 text-foreground">
            <Layers className="h-3.5 w-3.5 text-primary" />
            Lote: <strong>{broadcast.batch_size ?? 20} msgs</strong> (Pausa de {broadcast.batch_pause_seconds ?? 60}s)
          </span>
          <span className="inline-flex items-center gap-1.5 rounded-md border border-border bg-muted/40 px-2.5 py-1 text-foreground">
            <ShieldCheck className="h-3.5 w-3.5 text-primary" />
            Limite Diário: <strong>{broadcast.daily_limit ?? 1000}</strong>
          </span>
          <span className="inline-flex items-center gap-1.5 rounded-md border border-border bg-muted/40 px-2.5 py-1 text-foreground">
            <ShieldAlert className="h-3.5 w-3.5 text-primary" />
            Janela: <strong>{broadcast.window_start_time ?? '08:00'} - {broadcast.window_end_time ?? '20:00'}</strong> ({broadcast.timezone ?? 'America/Sao_Paulo'})
          </span>
        </div>
      </div>

      {/* Stats — 6 cards: Total / Sent / Delivered / Read / Replied / Failed */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <StatCard
          label={t('stats.totalRecipients')}
          value={broadcast.total_recipients}
          total={broadcast.total_recipients}
          icon={<Users className="h-4 w-4" />}
          color="bg-muted text-muted-foreground"
        />
        <StatCard
          label={t('stats.sent')}
          value={broadcast.sent_count}
          total={broadcast.total_recipients}
          icon={<Send className="h-4 w-4" />}
          color="bg-primary/10 text-primary"
        />
        <StatCard
          label={t('stats.delivered')}
          value={broadcast.delivered_count}
          total={broadcast.total_recipients}
          icon={<CheckCheck className="h-4 w-4" />}
          color="bg-teal-500/10 text-teal-400"
        />
        <StatCard
          label={t('stats.read')}
          value={broadcast.read_count}
          total={broadcast.total_recipients}
          icon={<Eye className="h-4 w-4" />}
          color="bg-blue-500/10 text-blue-400"
        />
        <StatCard
          label={t('stats.replied')}
          value={broadcast.replied_count}
          total={broadcast.total_recipients}
          icon={<MessageCircle className="h-4 w-4" />}
          color="bg-indigo-500/10 text-indigo-400"
        />
        <StatCard
          label={t('stats.failed')}
          value={broadcast.failed_count}
          total={broadcast.total_recipients}
          icon={<AlertCircle className="h-4 w-4" />}
          color="bg-red-500/10 text-red-400"
        />
      </div>

      <FunnelChart steps={funnelSteps} />

      {/* Timeline de Eventos & Histórico de Erros */}
      <div className="rounded-xl border border-border bg-card p-4 shadow-sm space-y-3">
        <div className="flex items-center justify-between border-b border-border pb-2.5">
          <div className="flex items-center gap-2">
            <History className="h-4 w-4 text-primary" />
            <h2 className="text-sm font-semibold text-foreground">Histórico de Eventos & Erros</h2>
          </div>
          <span className="text-xs text-muted-foreground">{events.length} eventos registrados</span>
        </div>

        {events.length === 0 ? (
          <p className="text-xs text-muted-foreground py-3 text-center">Nenhum evento registrado ainda.</p>
        ) : (
          <div className="max-h-56 overflow-y-auto space-y-2 pr-1">
            {events.map((ev) => (
              <div
                key={ev.id}
                className="flex items-start justify-between gap-3 rounded-lg border border-border/60 bg-muted/20 p-2.5 text-xs"
              >
                <div className="space-y-0.5">
                  <div className="flex items-center gap-2">
                    <span
                      className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium ${
                        ev.event_type === 'auto_pause_safety'
                          ? 'bg-red-500/20 text-red-400 border border-red-500/30'
                          : ev.event_type === 'paused'
                            ? 'bg-amber-500/20 text-amber-400 border border-amber-500/30'
                            : ev.event_type === 'batch_pause'
                              ? 'bg-blue-500/20 text-blue-400 border border-blue-500/30'
                              : ev.event_type === 'resumed'
                                ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30'
                                : 'bg-muted text-muted-foreground'
                      }`}
                    >
                      {ev.event_type}
                    </span>
                    <span className="text-foreground font-medium">{ev.message}</span>
                  </div>
                  {ev.details && Object.keys(ev.details).length > 0 && (
                    <p className="text-[11px] text-muted-foreground truncate max-w-xl">
                      {JSON.stringify(ev.details)}
                    </p>
                  )}
                </div>
                <span className="text-[10px] text-muted-foreground shrink-0">
                  {new Date(ev.created_at).toLocaleTimeString('pt-BR')}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Recipients Table */}
      <div className="rounded-xl border border-border bg-card shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-3">
          <h2 className="text-sm font-medium text-foreground">
            {statusFilter !== 'all'
              ? t('recipientsHeader', { filtered: filteredRecipients.length, total: recipients.length })
              : t('recipientsHeaderAll', { total: recipients.length })}
          </h2>
          <div className="flex items-center gap-2">
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <Button
                    variant="outline"
                    size="sm"
                    className="border-border text-muted-foreground hover:bg-muted"
                  />
                }
              >
                <Filter className="h-3.5 w-3.5 mr-1.5" />
                {statusFilter === 'all'
                  ? t('allStatuses')
                  : tStatus(getRecipientStatus(statusFilter).label)}
                <ChevronDown className="h-3 w-3 ml-1.5" />
              </DropdownMenuTrigger>
              <DropdownMenuContent className="border-border bg-popover">
                <DropdownMenuItem
                  onClick={() => setStatusFilter('all')}
                  className={statusFilter === 'all' ? 'text-primary' : 'text-popover-foreground'}
                >
                  {t('allStatuses')}
                </DropdownMenuItem>
                {RECIPIENT_STATUSES.map((s) => (
                  <DropdownMenuItem
                    key={s}
                    onClick={() => setStatusFilter(s)}
                    className={statusFilter === s ? 'text-primary' : 'text-popover-foreground'}
                  >
                    {tStatus(getRecipientStatus(s).label)}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>

            <Button
              variant="outline"
              size="sm"
              onClick={handleExport}
              disabled={recipients.length === 0}
              className="border-border text-muted-foreground hover:bg-muted"
            >
              <Download className="h-3.5 w-3.5 mr-1.5" />
              {t('exportCsv')}
            </Button>
          </div>
        </div>

        {filteredRecipients.length === 0 ? (
          <div className="flex h-32 items-center justify-center">
            <p className="text-sm text-muted-foreground">
              {recipients.length === 0 ? t('noRecipients') : t('noRecipientsFilter')}
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow className="border-border hover:bg-transparent">
                  <TableHead className="text-muted-foreground">{t('table.contact')}</TableHead>
                  <TableHead className="text-muted-foreground">{t('table.phone')}</TableHead>
                  <TableHead className="text-muted-foreground">{t('table.status')}</TableHead>
                  <TableHead className="text-muted-foreground">Tentativas</TableHead>
                  <TableHead className="text-muted-foreground">{t('table.sent')}</TableHead>
                  <TableHead className="text-muted-foreground">{t('table.delivered')}</TableHead>
                  <TableHead className="text-muted-foreground">{t('table.read')}</TableHead>
                  <TableHead className="text-muted-foreground">{t('table.error')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filteredRecipients.map((recipient) => {
                  const rStatus = getRecipientStatus(recipient.status);
                  return (
                    <TableRow key={recipient.id} className="border-border">
                      <TableCell className="font-medium text-foreground">
                        {recipient.contact?.name ?? 'Desconhecido'}
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {recipient.contact?.phone ?? '-'}
                      </TableCell>
                      <TableCell>
                        <span
                          className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${rStatus.classes}`}
                        >
                          {tStatus(rStatus.label)}
                        </span>
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {recipient.attempts ?? 0}
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {recipient.sent_at
                          ? new Date(recipient.sent_at).toLocaleTimeString('pt-BR')
                          : '-'}
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {recipient.delivered_at
                          ? new Date(recipient.delivered_at).toLocaleTimeString('pt-BR')
                          : '-'}
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {recipient.read_at
                          ? new Date(recipient.read_at).toLocaleTimeString('pt-BR')
                          : '-'}
                      </TableCell>
                      <TableCell className="max-w-xs truncate text-xs text-red-400">
                        {recipient.error_message ?? '-'}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        )}
      </div>

      {/* Confirmation Dialog: Pausar */}
      <Dialog open={confirmPauseDialog} onOpenChange={setConfirmPauseDialog}>
        <DialogContent className="border-border bg-popover sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="text-popover-foreground">Pausar Campanha</DialogTitle>
            <DialogDescription className="text-muted-foreground">
              Deseja realmente pausar a fila de envios? O processamento será imediatamente interrompido e nenhuma nova mensagem será enviada até que você clique em Retomar.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setConfirmPauseDialog(false)}
              className="border-border text-muted-foreground"
            >
              Voltar
            </Button>
            <Button
              onClick={() => handleControlAction('pause', 'Pausado manualmente pelo administrador')}
              className="bg-amber-600 hover:bg-amber-700 text-white"
            >
              Confirmar Pausa
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Confirmation Dialog: Retomar (Exigência do administrador) */}
      <Dialog open={confirmResumeDialog} onOpenChange={setConfirmResumeDialog}>
        <DialogContent className="border-border bg-popover sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="text-popover-foreground">Retomar Disparo da Fila</DialogTitle>
            <DialogDescription className="text-muted-foreground space-y-2 pt-1">
              <p>
                Confirma a retomada dos envios para os <strong>{pendingCount}</strong> contatos restantes na fila?
              </p>
              <div className="rounded-lg border border-border bg-muted/40 p-2.5 text-xs text-foreground">
                <p>✓ Cooldown de {broadcast.cooldown_interval_seconds ?? 5}s aplicado entre mensagens</p>
                <p>✓ Pausa de lote de {broadcast.batch_pause_seconds ?? 60}s a cada {broadcast.batch_size ?? 20} envios</p>
                <p>✓ Bloqueios de spam e limite de taxa monitorados em tempo real</p>
              </div>
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setConfirmResumeDialog(false)}
              className="border-border text-muted-foreground"
            >
              Cancelar
            </Button>
            <Button
              onClick={() => handleControlAction('resume')}
              className="bg-primary text-primary-foreground hover:bg-primary/90"
            >
              Confirmar e Retomar
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Confirmation Dialog: Cancelar */}
      <Dialog open={confirmCancelDialog} onOpenChange={setConfirmCancelDialog}>
        <DialogContent className="border-border bg-popover sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="text-popover-foreground">Cancelar Campanha Definitivamente</DialogTitle>
            <DialogDescription className="text-muted-foreground">
              Esta ação cancelará todos os <strong>{pendingCount}</strong> contatos pendentes restantes na fila. Esta operação não poderá ser desfeita.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setConfirmCancelDialog(false)}
              className="border-border text-muted-foreground"
            >
              Voltar
            </Button>
            <Button
              variant="destructive"
              onClick={() => handleControlAction('cancel', 'Cancelado pelo administrador')}
            >
              Confirmar Cancelamento
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
