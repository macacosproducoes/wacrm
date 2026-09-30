'use client';

import { useEffect, useState, useMemo } from 'react';
import { createClient } from '@/lib/supabase/client';
import { MessageTemplate } from '@/types';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import {
  ArrowLeft,
  Send,
  Loader2,
  Users,
  Save,
  Clock,
  Layers,
  ShieldCheck,
  Calendar,
  Zap,
  Info,
} from 'lucide-react';
import { useTranslations } from 'next-intl';

export interface CooldownSettings {
  cooldownIntervalSeconds: number;
  batchSize: number;
  batchPauseSeconds: number;
  dailyLimit: number;
  windowStartTime: string;
  windowEndTime: string;
  timezone: string;
}

export const DEFAULT_COOLDOWN_SETTINGS: CooldownSettings = {
  cooldownIntervalSeconds: 5,
  batchSize: 20,
  batchPauseSeconds: 60,
  dailyLimit: 1000,
  windowStartTime: '08:00',
  windowEndTime: '20:00',
  timezone: 'America/Sao_Paulo',
};

interface AudienceConfig {
  type: string;
  tagIds?: string[];
  csvContacts?: { phone: string; name?: string }[];
}

interface Step4Props {
  name: string;
  onNameChange: (name: string) => void;
  template: MessageTemplate;
  audience: AudienceConfig;
  cooldownSettings?: CooldownSettings;
  onCooldownSettingsChange?: (settings: CooldownSettings) => void;
  onSend: (settings?: CooldownSettings) => void;
  onSaveDraft?: () => void;
  onBack: () => void;
  isProcessing: boolean;
  progress: number;
}

const TIMEZONES = [
  { label: 'Brasília (GMT-3) - Padrão', value: 'America/Sao_Paulo' },
  { label: 'Manaus (GMT-4)', value: 'America/Manaus' },
  { label: 'Fortaleza (GMT-3)', value: 'America/Fortaleza' },
  { label: 'Cuiabá (GMT-4)', value: 'America/Cuiaba' },
  { label: 'Rio Branco (GMT-5)', value: 'America/Rio_Branco' },
  { label: 'UTC', value: 'UTC' },
];

export function Step4ScheduleSend({
  name,
  onNameChange,
  template,
  audience,
  cooldownSettings: externalSettings,
  onCooldownSettingsChange,
  onSend,
  onSaveDraft,
  onBack,
  isProcessing,
  progress,
}: Step4Props) {
  const t = useTranslations('Broadcasts.wizard');
  const [showConfirm, setShowConfirm] = useState(false);
  const [estimatedReach, setEstimatedReach] = useState<number>(0);
  const [loadingReach, setLoadingReach] = useState(true);

  const [settings, setSettings] = useState<CooldownSettings>(
    externalSettings || DEFAULT_COOLDOWN_SETTINGS
  );

  function updateSetting<K extends keyof CooldownSettings>(
    key: K,
    val: CooldownSettings[K]
  ) {
    const updated = { ...settings, [key]: val };
    setSettings(updated);
    if (onCooldownSettingsChange) {
      onCooldownSettingsChange(updated);
    }
  }

  useEffect(() => {
    async function calculateReach() {
      setLoadingReach(true);
      try {
        const supabase = createClient();

        if (audience.type === 'all') {
          const { count } = await supabase
            .from('contacts')
            .select('*', { count: 'exact', head: true });
          setEstimatedReach(count ?? 0);
        } else if (audience.type === 'tags' && audience.tagIds && audience.tagIds.length > 0) {
          const { data: contactTags } = await supabase
            .from('contact_tags')
            .select('contact_id')
            .in('tag_id', audience.tagIds);

          const uniqueIds = new Set((contactTags ?? []).map((ct) => ct.contact_id));
          setEstimatedReach(uniqueIds.size);
        } else if (audience.type === 'csv' && audience.csvContacts) {
          setEstimatedReach(audience.csvContacts.length);
        } else {
          setEstimatedReach(0);
        }
      } finally {
        setLoadingReach(false);
      }
    }

    calculateReach();
  }, [audience]);

  // Calculate completion estimate
  const etaCalculation = useMemo(() => {
    if (estimatedReach <= 0) return { totalSeconds: 0, text: 'Instantâneo', batches: 0 };
    const numBatches = Math.ceil(estimatedReach / Math.max(1, settings.batchSize));
    const pauses = Math.max(0, numBatches - 1);
    const sendTime = estimatedReach * settings.cooldownIntervalSeconds;
    const pauseTime = pauses * settings.batchPauseSeconds;
    const totalSec = sendTime + pauseTime;

    if (totalSec < 60) {
      return { totalSeconds: totalSec, text: `~${totalSec} segundos`, batches: numBatches };
    }
    const mins = Math.floor(totalSec / 60);
    const secs = totalSec % 60;
    if (mins < 60) {
      return {
        totalSeconds: totalSec,
        text: secs > 0 ? `~${mins} min ${secs}s` : `~${mins} minutos`,
        batches: numBatches,
      };
    }
    const hours = Math.floor(mins / 60);
    const remainMins = mins % 60;
    return {
      totalSeconds: totalSec,
      text: `~${hours}h ${remainMins}m`,
      batches: numBatches,
    };
  }, [estimatedReach, settings]);

  const audienceLabel =
    audience.type === 'all'
      ? t('scheduleSend.audienceAll')
      : audience.type === 'tags'
        ? t('scheduleSend.audienceTags')
        : audience.type === 'csv'
          ? t('scheduleSend.audienceCsv')
          : t('scheduleSend.audienceField');

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold text-foreground">{t('scheduleSend.title')}</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {t('scheduleSend.subtitle')}
        </p>
      </div>

      {/* Broadcast Name */}
      <div>
        <label className="mb-1.5 block text-sm font-medium text-foreground">
          {t('scheduleSend.broadcastName')}
        </label>
        <Input
          value={name}
          onChange={(e) => onNameChange(e.target.value)}
          placeholder={t('scheduleSend.broadcastNamePlaceholder')}
          className="border-border bg-muted text-foreground placeholder:text-muted-foreground"
        />
      </div>

      {/* Summary Card */}
      <div className="rounded-xl border border-border bg-card/50 p-4 space-y-3">
        <p className="text-sm font-medium text-foreground">{t('scheduleSend.summary')}</p>
        <div className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
          <div>
            <p className="text-xs text-muted-foreground">{t('scheduleSend.template')}</p>
            <p className="font-medium text-foreground truncate">{template.name}</p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">{t('scheduleSend.audience')}</p>
            <p className="font-medium text-foreground">{audienceLabel}</p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">Alcance Estimado</p>
            <div className="flex items-center gap-1.5">
              {loadingReach ? (
                <Loader2 className="h-3 w-3 animate-spin text-primary" />
              ) : (
                <>
                  <Users className="h-3.5 w-3.5 text-primary" />
                  <p className="font-medium text-foreground">{estimatedReach.toLocaleString()}</p>
                </>
              )}
            </div>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">Idioma</p>
            <p className="font-medium text-foreground">{template.language ?? 'pt_BR'}</p>
          </div>
        </div>
      </div>

      {/* CONTROLE DE ENVIO (COOLDOWN & FILA SEGURA) */}
      <div className="rounded-xl border border-emerald-500/20 bg-emerald-950/10 p-5 space-y-4">
        <div className="flex items-center justify-between border-b border-border/60 pb-3">
          <div className="flex items-center gap-2">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-emerald-500/20 text-emerald-400">
              <ShieldCheck className="h-4 w-4" />
            </div>
            <div>
              <h3 className="text-sm font-semibold text-foreground">Controle de Envio (Cooldown & Fila)</h3>
              <p className="text-xs text-muted-foreground">
                Configurações persistidas no backend para proteção de conta e conformidade
              </p>
            </div>
          </div>
          <span className="inline-flex items-center gap-1 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2.5 py-0.5 text-xs font-medium text-emerald-400">
            <Zap className="h-3 w-3" /> Fila Persistente Ativa
          </span>
        </div>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {/* Intervalo entre mensagens */}
          <div className="space-y-1.5">
            <label className="flex items-center gap-1.5 text-xs font-medium text-foreground">
              <Clock className="h-3.5 w-3.5 text-primary" />
              Intervalo entre mensagens
            </label>
            <div className="relative">
              <Input
                type="number"
                min={1}
                max={300}
                value={settings.cooldownIntervalSeconds}
                onChange={(e) =>
                  updateSetting(
                    'cooldownIntervalSeconds',
                    Math.max(1, parseInt(e.target.value) || 1)
                  )
                }
                className="border-border bg-card pr-12 text-sm"
              />
              <span className="absolute right-3 top-2.5 text-xs text-muted-foreground">seg</span>
            </div>
            <p className="text-[11px] text-muted-foreground">Pausa entre cada envio individual</p>
          </div>

          {/* Tamanho do lote */}
          <div className="space-y-1.5">
            <label className="flex items-center gap-1.5 text-xs font-medium text-foreground">
              <Layers className="h-3.5 w-3.5 text-primary" />
              Mensagens por lote
            </label>
            <div className="relative">
              <Input
                type="number"
                min={1}
                max={500}
                value={settings.batchSize}
                onChange={(e) =>
                  updateSetting('batchSize', Math.max(1, parseInt(e.target.value) || 1))
                }
                className="border-border bg-card pr-12 text-sm"
              />
              <span className="absolute right-3 top-2.5 text-xs text-muted-foreground">msgs</span>
            </div>
            <p className="text-[11px] text-muted-foreground">Quantidade disparada antes da pausa</p>
          </div>

          {/* Tempo de pausa entre lotes */}
          <div className="space-y-1.5">
            <label className="flex items-center gap-1.5 text-xs font-medium text-foreground">
              <Clock className="h-3.5 w-3.5 text-primary" />
              Pausa entre os lotes
            </label>
            <div className="relative">
              <Input
                type="number"
                min={5}
                max={3600}
                value={settings.batchPauseSeconds}
                onChange={(e) =>
                  updateSetting(
                    'batchPauseSeconds',
                    Math.max(5, parseInt(e.target.value) || 5)
                  )
                }
                className="border-border bg-card pr-12 text-sm"
              />
              <span className="absolute right-3 top-2.5 text-xs text-muted-foreground">seg</span>
            </div>
            <p className="text-[11px] text-muted-foreground">Espera programada antes do próximo lote</p>
          </div>

          {/* Limite diário de envios */}
          <div className="space-y-1.5">
            <label className="flex items-center gap-1.5 text-xs font-medium text-foreground">
              <ShieldCheck className="h-3.5 w-3.5 text-primary" />
              Limite diário da conta
            </label>
            <div className="relative">
              <Input
                type="number"
                min={10}
                max={50000}
                value={settings.dailyLimit}
                onChange={(e) =>
                  updateSetting('dailyLimit', Math.max(10, parseInt(e.target.value) || 10))
                }
                className="border-border bg-card pr-12 text-sm"
              />
              <span className="absolute right-3 top-2.5 text-xs text-muted-foreground">envios</span>
            </div>
            <p className="text-[11px] text-muted-foreground">Teto máximo por dia para esta conta</p>
          </div>
        </div>

        {/* Janela de Horário e Fuso */}
        <div className="grid grid-cols-1 gap-4 pt-2 sm:grid-cols-3 border-t border-border/40">
          <div className="space-y-1.5">
            <label className="flex items-center gap-1.5 text-xs font-medium text-foreground">
              <Calendar className="h-3.5 w-3.5 text-primary" />
              Horário de Início
            </label>
            <Input
              type="time"
              value={settings.windowStartTime}
              onChange={(e) => updateSetting('windowStartTime', e.target.value || '08:00')}
              className="border-border bg-card text-sm"
            />
          </div>

          <div className="space-y-1.5">
            <label className="flex items-center gap-1.5 text-xs font-medium text-foreground">
              <Calendar className="h-3.5 w-3.5 text-primary" />
              Horário de Término
            </label>
            <Input
              type="time"
              value={settings.windowEndTime}
              onChange={(e) => updateSetting('windowEndTime', e.target.value || '20:00')}
              className="border-border bg-card text-sm"
            />
          </div>

          <div className="space-y-1.5">
            <label className="flex items-center gap-1.5 text-xs font-medium text-foreground">
              Fuso Horário
            </label>
            <select
              value={settings.timezone}
              onChange={(e) => updateSetting('timezone', e.target.value)}
              className="h-10 w-full rounded-md border border-border bg-card px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary"
            >
              {TIMEZONES.map((tz) => (
                <option key={tz.value} value={tz.value}>
                  {tz.label}
                </option>
              ))}
            </select>
          </div>
        </div>

        {/* Box Informativo de Estimativa */}
        <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 rounded-lg border border-border bg-card p-3 text-xs text-muted-foreground">
          <div className="flex items-center gap-2">
            <Info className="h-4 w-4 text-primary shrink-0" />
            <span>
              Estimativa total para <strong>{estimatedReach.toLocaleString()} contatos</strong>:
              <span className="text-foreground font-semibold ml-1">{etaCalculation.text}</span>
              {etaCalculation.batches > 1 && (
                <span className="ml-1">
                  ({etaCalculation.batches} lotes de {settings.batchSize} msgs com pausa de {settings.batchPauseSeconds}s)
                </span>
              )}
            </span>
          </div>
          <span className="text-[11px] text-muted-foreground/80 shrink-0">
            Pausa automática se houver 5 falhas consecutivas ou bloqueio.
          </span>
        </div>
      </div>

      {/* Processing overlay */}
      {isProcessing && (
        <div className="rounded-xl border border-primary/20 bg-primary/5 p-4">
          <div className="mb-2 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Loader2 className="h-4 w-4 animate-spin text-primary" />
              <p className="text-sm font-medium text-foreground">Iniciando fila no backend...</p>
            </div>
            <span className="text-xs font-medium text-primary">{progress}%</span>
          </div>
          <div className="h-1.5 w-full rounded-full bg-muted">
            <div
              className="h-1.5 rounded-full bg-primary transition-all duration-300"
              style={{ width: `${progress}%` }}
            />
          </div>
        </div>
      )}

      {/* Action Footer */}
      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border pt-4">
        <Button
          variant="outline"
          onClick={onBack}
          disabled={isProcessing}
          className="border-border text-muted-foreground"
        >
          <ArrowLeft className="h-4 w-4 mr-2" />
          {t('back')}
        </Button>

        <div className="flex items-center gap-2">
          {onSaveDraft && (
            <Button
              variant="outline"
              onClick={onSaveDraft}
              disabled={!name.trim() || isProcessing}
              className="border-border text-muted-foreground hover:bg-muted disabled:opacity-50"
            >
              <Save className="h-4 w-4 mr-2" />
              {t('scheduleSend.saveDraft')}
            </Button>
          )}

          <Dialog open={showConfirm} onOpenChange={setShowConfirm}>
            <DialogTrigger
              render={
                <Button
                  disabled={!name.trim() || isProcessing}
                  className="bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
                />
              }
            >
              <Send className="h-4 w-4 mr-2" />
              Iniciar Disparo
            </DialogTrigger>
            <DialogContent className="border-border bg-popover sm:max-w-lg">
              <DialogHeader>
                <DialogTitle className="text-popover-foreground">Confirmar Início da Campanha</DialogTitle>
                <DialogDescription className="text-muted-foreground space-y-2 pt-2">
                  <p>
                    Você está prestes a enfileirar o disparo para{' '}
                    <span className="font-semibold text-foreground">{estimatedReach.toLocaleString()}</span>{' '}
                    contatos utilizando o template{' '}
                    <span className="font-semibold text-foreground">{template.name}</span>.
                  </p>
                  <div className="rounded-lg border border-border bg-muted/50 p-3 text-xs text-foreground space-y-1">
                    <p><strong>Cooldown:</strong> {settings.cooldownIntervalSeconds}s entre mensagens</p>
                    <p><strong>Lote:</strong> {settings.batchSize} msgs (pausa de {settings.batchPauseSeconds}s)</p>
                    <p><strong>Janela:</strong> {settings.windowStartTime} às {settings.windowEndTime} ({settings.timezone})</p>
                    <p><strong>Estimativa:</strong> {etaCalculation.text}</p>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    A fila será processada no servidor com proteção contra duplicidade e parada automática de segurança.
                  </p>
                </DialogDescription>
              </DialogHeader>
              <DialogFooter className="gap-2 sm:gap-0">
                <Button
                  variant="outline"
                  onClick={() => setShowConfirm(false)}
                  className="border-border text-muted-foreground"
                >
                  {t('cancel')}
                </Button>
                <Button
                  onClick={() => {
                    setShowConfirm(false);
                    onSend(settings);
                  }}
                  className="bg-primary text-primary-foreground hover:bg-primary/90"
                >
                  <Send className="h-4 w-4 mr-2" />
                  Confirmar e Iniciar
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </div>
      </div>
    </div>
  );
}
