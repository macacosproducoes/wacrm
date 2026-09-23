'use client';

import { Suspense, useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { Bot, Sparkles, Settings2, BarChart3, CheckCircle2 } from 'lucide-react';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { AiPlayground } from '@/components/agents/ai-playground';
import { AiUsageCard } from '@/components/agents/ai-usage';
import { AiConfig } from '@/components/settings/ai-config';
import { useAuth } from '@/hooks/use-auth';
import { canEditSettings } from '@/lib/auth/roles';

type Tab = 'setup' | 'playground' | 'usage';

interface AgentSummary {
  configured: boolean;
  provider?: string;
  model?: string;
  is_active?: boolean;
  auto_reply_enabled?: boolean;
  system_prompt?: string;
}

export default function AgentsPage() {
  return (
    <Suspense fallback={null}>
      <AgentsPageInner />
    </Suspense>
  );
}

function AgentsPageInner() {
  const { accountRole } = useAuth();
  const searchParams = useSearchParams();
  const canViewUsage = accountRole ? canEditSettings(accountRole) : false;

  const urlTab = searchParams.get('tab');
  const [tab, setTab] = useState<Tab>(urlTab === 'playground' ? 'playground' : 'setup');
  const [summary, setSummary] = useState<AgentSummary | null>(null);
  const [decided, setDecided] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/ai/config');
        const data = await res.json().catch(() => ({}));
        if (!cancelled) {
          setSummary(data);
          if (urlTab === 'playground') {
            setTab('playground');
          } else {
            // Default to setup so the user immediately sees the active agent and its options
            setTab('setup');
          }
        }
      } catch {
        if (!cancelled) setTab('setup');
      } finally {
        if (!cancelled) setDecided(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [urlTab]);

  return (
    <div className="space-y-6">
      <div>
        <div className="flex items-center gap-2">
          <Bot className="h-6 w-6 text-primary" />
          <h1 className="text-2xl font-bold tracking-tight text-foreground">
            Agente de IA (WhatsApp & CRM)
          </h1>
        </div>
        <p className="mt-1 text-sm text-muted-foreground">
          Gerencie seu assistente de IA, configure chaves, prompts e opções de atendimento automático no WhatsApp.
        </p>
      </div>

      {/* Summary Card of Current Agent */}
      {summary?.configured && (
        <div className="rounded-xl border border-border/80 bg-card p-4 shadow-xs">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
            <div className="flex items-start gap-3">
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary border border-primary/20">
                <Bot className="h-5 w-5" />
              </div>
              <div>
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-semibold text-foreground text-sm">
                    {summary.provider === 'gemini' ? 'Google Gemini (Kie.ai)' : summary.provider}
                  </span>
                  <span className="text-xs text-muted-foreground font-mono bg-muted px-2 py-0.5 rounded border">
                    {summary.model || 'gemini-2.5-flash'}
                  </span>
                  <Badge className={summary.is_active ? "bg-emerald-500/15 text-emerald-600 border-emerald-500/30 text-[10px]" : "bg-muted text-muted-foreground text-[10px]"}>
                    <CheckCircle2 className="h-3 w-3 mr-1" />
                    {summary.is_active ? "Ativo (Ligado)" : "Inativo"}
                  </Badge>
                  {summary.auto_reply_enabled && (
                    <Badge className="bg-primary/15 text-primary border-primary/30 text-[10px]">
                      Auto-Resposta WhatsApp Ativada
                    </Badge>
                  )}
                </div>
                <p className="mt-1 text-xs text-muted-foreground line-clamp-1">
                  {summary.system_prompt || 'Assistente de IA configurado para atendimento.'}
                </p>
              </div>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <Button
                variant={tab === 'setup' ? 'default' : 'outline'}
                size="sm"
                onClick={() => setTab('setup')}
                className="text-xs gap-1.5"
              >
                <Settings2 className="h-3.5 w-3.5" />
                Opções do Agente
              </Button>
              <Button
                variant={tab === 'playground' ? 'default' : 'outline'}
                size="sm"
                onClick={() => setTab('playground')}
                className="text-xs gap-1.5"
              >
                <Sparkles className="h-3.5 w-3.5" />
                Testar Respostas
              </Button>
            </div>
          </div>
        </div>
      )}

      {decided && (
        <Tabs
          value={tab}
          onValueChange={(v) => setTab(v as Tab)}
          className="mt-6"
        >
          <TabsList>
            <TabsTrigger value="setup">
              <Settings2 className="mr-1.5 h-4 w-4" /> Opções & Configuração
            </TabsTrigger>
            <TabsTrigger value="playground">
              <Sparkles className="mr-1.5 h-4 w-4" /> Testar no Playground
            </TabsTrigger>
            {canViewUsage && (
              <TabsTrigger value="usage">
                <BarChart3 className="mr-1.5 h-4 w-4" /> Métricas & Consumo
              </TabsTrigger>
            )}
          </TabsList>

          <TabsContent value="setup" className="mt-4">
            <AiConfig />
          </TabsContent>

          <TabsContent value="playground" className="mt-4">
            <AiPlayground
              onGoToSetup={() => setTab('setup')}
              modelName={summary?.model}
              providerName={summary?.provider}
            />
          </TabsContent>

          {canViewUsage && (
            <TabsContent value="usage" className="mt-4">
              <AiUsageCard />
            </TabsContent>
          )}
        </Tabs>
      )}
    </div>
  );
}
