'use client';

import { Suspense, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Loader2 } from 'lucide-react';
import { toast } from 'sonner';

import { useAuth } from '@/hooks/use-auth';
import { useTheme } from '@/hooks/use-theme';
import { Switch } from '@/components/ui/switch';
import { SettingsRail } from '@/components/settings/settings-rail';
import { SettingsOverview } from '@/components/settings/settings-overview';
import { ProfileForm } from '@/components/settings/profile-form';
import { SecurityPanel } from '@/components/settings/security-panel';
import { AppearancePanel } from '@/components/settings/appearance-panel';
import { WhatsAppConfig } from '@/components/settings/whatsapp-config';
import { TemplateManager } from '@/components/settings/template-manager';
import { QuickRepliesManager } from '@/components/settings/quick-replies-manager';
import { FieldsAndTagsPanel } from '@/components/settings/fields-and-tags-panel';
import { DealsSettings } from '@/components/settings/deals-settings';
import { MembersTab } from '@/components/settings/members-tab';
import { ApiKeysSettings } from '@/components/settings/api-keys-settings';
import { AiConfig } from '@/components/settings/ai-config';
import {
  resolveSection,
  type SettingsSection,
} from '@/components/settings/settings-sections';

// `useSearchParams` opts this page out of static prerendering unless it
// sits under a Suspense boundary. Without one, the production build hits
// the "missing Suspense with CSR bailout" error and the whole page bails
// to client-side rendering — shipping a settings screen whose rail never
// wires up its click handlers. You land on the section the URL carried
// (the account-menu Settings link points at `?tab=whatsapp`) and can't
// navigate away. Mirror the login/signup split: a thin wrapper supplies
// the boundary; the inner component reads the query string.
export default function SettingsPage() {
  return (
    <Suspense fallback={null}>
      <SettingsPageInner />
    </Suspense>
  );
}

function SettingsPageInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { defaultCurrency } = useAuth();
  const { mode } = useTheme();
  const t = useTranslations('Settings');

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

  const handleToggleOnlyNew = async (checked: boolean) => {
    setOnlyNewConversations(checked);
    setUpdatingOnlyNew(true);
    try {
      const res = await fetch('/api/ai/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ only_new_conversations: checked }),
      });
      if (!res.ok) throw new Error('Falha ao salvar preferência');
      toast.success(
        checked
          ? '🎯 IA configurada: responderá APENAS conversas novas (SIM)! Conversas antigas ficam 100% manuais.'
          : 'IA responderá todas as conversas elegíveis (NÃO).'
      );
    } catch {
      toast.error('Erro ao atualizar modo de conversas novas');
      setOnlyNewConversations(!checked);
    } finally {
      setUpdatingOnlyNew(false);
    }
  };

  // The URL (`?tab=`) is the single source of truth for the active
  // section — deep-linkable, and it keeps the existing links in the
  // app sidebar/header working. Legacy tab values (tags, custom-fields)
  // resolve onto their new home; unknown/empty → the Overview landing.
  const section = resolveSection(searchParams.get('tab'));

  const go = (next: SettingsSection) => {
    const params = new URLSearchParams(searchParams.toString());
    params.set('tab', next);
    router.replace(`/settings?${params.toString()}`, { scroll: false });
  };

  // Cheap, fetch-free rail hints. The Overview landing carries the
  // full live status/counts; the rail just surfaces the two that are
  // already in context.
  const hints: Partial<Record<SettingsSection, ReactNode>> = useMemo(
    () => ({
      appearance: mode.charAt(0).toUpperCase() + mode.slice(1),
      deals: defaultCurrency,
    }),
    [mode, defaultCurrency],
  );

  const panel: Record<SettingsSection, ReactNode> = {
    overview: <SettingsOverview onSelect={go} />,
    profile: <ProfileForm />,
    security: <SecurityPanel />,
    appearance: <AppearancePanel />,
    ai: <AiConfig />,
    whatsapp: <WhatsAppConfig />,
    templates: <TemplateManager />,
    'quick-replies': <QuickRepliesManager />,
    fields: <FieldsAndTagsPanel />,
    deals: <DealsSettings />,
    members: <MembersTab />,
    api: <ApiKeysSettings />,
  };

  return (
    <div>
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-foreground">
          {t('pageTitle')}
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {t('pageDesc')}
        </p>
      </div>

      {/* 🎯 SWITCH ABAIXO DE SETTINGS: IA APENAS EM CONVERSAS NOVAS */}
      <div className="mt-4 rounded-xl border-2 border-slate-200 dark:border-slate-700 bg-white dark:bg-card p-4 sm:p-5 shadow-sm text-foreground">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div className="space-y-1 max-w-2xl">
            <div className="flex flex-wrap items-center gap-2.5">
              <span className="text-base font-bold text-slate-900 dark:text-white flex items-center gap-2">
                <span className="text-lg">🎯</span> IA Apenas em Conversas Novas
              </span>
              <span
                className={`text-xs font-bold px-3 py-0.5 rounded-full transition-all shadow-2xs ${
                  onlyNewConversations
                    ? 'bg-emerald-600 text-white'
                    : 'bg-slate-100 dark:bg-muted text-slate-700 dark:text-muted-foreground border border-slate-300 dark:border-border'
                }`}
              >
                {onlyNewConversations ? 'SIM (Ativo)' : 'NÃO (Desativado)'}
              </span>
              {updatingOnlyNew && (
                <Loader2 className="h-4 w-4 animate-spin text-primary" />
              )}
            </div>
            <p className="text-xs sm:text-sm text-slate-600 dark:text-slate-300 leading-relaxed">
              Ao marcar <strong className="text-emerald-600 dark:text-emerald-400 font-semibold">SIM</strong>, a IA responderá <strong className="text-slate-900 dark:text-white underline decoration-emerald-500/60 decoration-2 underline-offset-2">apenas novos leads/contatos que chegarem</strong>. Todas as conversas e contatos antigos continuam em <strong className="text-slate-900 dark:text-white font-semibold">atendimento 100% manual</strong> sem resposta automática da IA.
            </p>
          </div>

          <div className="flex items-center gap-3 shrink-0 self-start sm:self-center bg-slate-50 dark:bg-muted/40 px-3.5 py-2 rounded-xl border border-slate-200 dark:border-border">
            <span className="text-xs font-bold uppercase tracking-wider text-slate-600 dark:text-slate-300">
              {onlyNewConversations ? 'Sim (Novas)' : 'Não (Todas)'}
            </span>
            <Switch
              checked={onlyNewConversations}
              onCheckedChange={handleToggleOnlyNew}
              disabled={updatingOnlyNew}
              className="data-[state=checked]:bg-emerald-600 scale-105"
            />
          </div>
        </div>
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-[236px_minmax(0,1fr)] lg:items-start">
        <SettingsRail active={section} onSelect={go} hints={hints} />
        <div className="min-w-0">{panel[section]}</div>
      </div>
    </div>
  );
}
