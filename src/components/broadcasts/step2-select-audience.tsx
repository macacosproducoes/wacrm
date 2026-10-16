'use client';

import { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import { createClient } from '@/lib/supabase/client';
import { parseBroadcastCsv } from '@/lib/broadcast-csv';
import { Tag } from '@/types';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { toast } from 'sonner';
import {
  Users,
  Tags,
  Upload,
  FileText,
  Loader2,
  ArrowRight,
  ArrowLeft,
  X,
  Check,
  Search,
  Filter,
  ShoppingCart,
  Zap,
  Sparkles,
  Flame,
  BadgeCheck,
} from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useAuth } from '@/hooks/use-auth';
import {
  AudienceType,
  AudienceConfig,
  AudienceCounts,
  fetchAudienceQuickCounts,
  resolveBroadcastContacts,
} from '@/lib/broadcasts/audience-resolver';

interface Step2Props {
  audience: AudienceConfig;
  onUpdate: (audience: AudienceConfig) => void;
  onNext: () => void;
  onBack: () => void;
}

export function Step2SelectAudience({
  audience,
  onUpdate,
  onNext,
  onBack,
}: Step2Props) {
  const t = useTranslations('Broadcasts.wizard');
  const { accountId, account } = useAuth();

  const [tags, setTags] = useState<Tag[]>([]);
  const [tagCounts, setTagCounts] = useState<Record<string, number>>({});
  const [totalAccountContacts, setTotalAccountContacts] = useState<number>(0);
  const [quickCounts, setQuickCounts] = useState<AudienceCounts | null>(null);
  const [loadingQuickCounts, setLoadingQuickCounts] = useState(false);
  const [loadingTags, setLoadingTags] = useState(false);
  const [tagSearch, setTagSearch] = useState('');
  const [estimatedCount, setEstimatedCount] = useState<number | null>(null);
  const [loadingCount, setLoadingCount] = useState(false);
  const [pickedCsvName, setPickedCsvName] = useState<string | null>(null);
  const [showExcludeList, setShowExcludeList] = useState(false);

  const csvInputRef = useRef<HTMLInputElement>(null);
  const csvCount = audience.csvContacts?.length ?? 0;
  const csvFileName = csvCount > 0 ? pickedCsvName : null;

  // Load tags, contact totals, and live smart-segment counts for the active account
  useEffect(() => {
    async function fetchTagsAndCounts() {
      setLoadingTags(true);
      setLoadingQuickCounts(true);
      try {
        const supabase = createClient();

        // 1. Fetch tags for this account
        let query = supabase.from('tags').select('*').order('name');
        if (accountId) {
          query = query.eq('account_id', accountId);
        }
        const { data: tagsData } = await query;
        const loadedTags = tagsData ?? [];
        setTags(loadedTags);

        // 2. Fetch quick smart segment counts
        const qc = await fetchAudienceQuickCounts(supabase, accountId);
        setQuickCounts(qc);
        setTotalAccountContacts(qc.totalContacts);

        // 3. Count contacts per tag
        if (loadedTags.length > 0) {
          const counts: Record<string, number> = {};
          const CHUNK = 50;
          for (let i = 0; i < loadedTags.length; i += CHUNK) {
            const chunk = loadedTags.slice(i, i + CHUNK);
            const { data: ctData } = await supabase
              .from('contact_tags')
              .select('tag_id')
              .in('tag_id', chunk.map((t) => t.id));

            for (const row of ctData ?? []) {
              counts[row.tag_id] = (counts[row.tag_id] || 0) + 1;
            }
          }
          setTagCounts(counts);

          // If no audience type is selected yet, default to 'unpaid' if available, otherwise 'tags'
          if (!audience.type) {
            onUpdate({
              ...audience,
              type: 'unpaid',
              excludeTagIds: audience.excludeTagIds ?? [],
            });
          }
        }
      } catch (err) {
        console.error('Error fetching tags and counts:', err);
      } finally {
        setLoadingTags(false);
        setLoadingQuickCounts(false);
      }
    }

    fetchTagsAndCounts();
  }, [accountId]);

  // Calculate estimated reach using the centralized resolveBroadcastContacts
  const fetchEstimatedCount = useCallback(async () => {
    setLoadingCount(true);
    try {
      const supabase = createClient();

      if (audience.type === 'csv' && audience.csvContacts) {
        setEstimatedCount(audience.csvContacts.length);
      } else {
        const resolved = await resolveBroadcastContacts(supabase, audience, accountId);
        setEstimatedCount(resolved.length);
      }
    } catch (err) {
      console.error('Error calculating reach:', err);
      setEstimatedCount(0);
    } finally {
      setLoadingCount(false);
    }
  }, [audience, accountId]);

  useEffect(() => {
    fetchEstimatedCount();
  }, [fetchEstimatedCount]);

  function selectAudienceType(type: AudienceType) {
    onUpdate({
      ...audience,
      type,
      // Keep selected tags if switching to tags, otherwise undefined
      tagIds: type === 'tags' ? audience.tagIds : undefined,
    });
  }

  function toggleTag(tagId: string) {
    const current = audience.tagIds ?? [];
    const updated = current.includes(tagId)
      ? current.filter((id) => id !== tagId)
      : [...current, tagId];

    const cleanExclude = (audience.excludeTagIds ?? []).filter((id) => id !== tagId);

    onUpdate({
      ...audience,
      type: 'tags',
      tagIds: updated,
      excludeTagIds: cleanExclude,
    });
  }

  function toggleExcludeTag(tagId: string) {
    const current = audience.excludeTagIds ?? [];
    const updated = current.includes(tagId)
      ? current.filter((id) => id !== tagId)
      : [...current, tagId];

    const cleanInclude = (audience.tagIds ?? []).filter((id) => id !== tagId);

    onUpdate({
      ...audience,
      excludeTagIds: updated,
      tagIds: cleanInclude,
    });
  }

  async function handleCsvUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;

    try {
      const text = await file.text();
      const parsed = parseBroadcastCsv(text);
      if (!parsed.ok || parsed.contacts.length === 0) {
        toast.error(!parsed.ok ? parsed.error : 'O arquivo CSV não contém contatos válidos.');
        return;
      }
      setPickedCsvName(file.name);
      onUpdate({
        ...audience,
        type: 'csv',
        csvContacts: parsed.contacts,
      });
      toast.success(parsed.contacts.length + ' contatos carregados do CSV!');
    } catch (err: any) {
      toast.error('Erro ao ler CSV: ' + (err.message || 'Formato inválido'));
    }
  }

  const filteredTags = useMemo(() => {
    if (!tagSearch.trim()) return tags;
    const term = tagSearch.toLowerCase();
    return tags.filter((t) => t.name.toLowerCase().includes(term));
  }, [tags, tagSearch]);

  const isValid =
    audience.type === 'unpaid' ||
    audience.type === 'new_24h' ||
    audience.type === 'new_24h_unpaid' ||
    audience.type === 'all' ||
    (audience.type === 'tags' && audience.tagIds && audience.tagIds.length > 0) ||
    (audience.type === 'csv' && audience.csvContacts && audience.csvContacts.length > 0);

  return (
    <div className="space-y-6">
      {/* Title Header */}
      <div>
        <h2 className="text-lg font-semibold text-foreground">Seleção do Público-Alvo</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {account?.name ? (
            <span>Conta ativa: <strong className="text-primary">{account.name}</strong>. Escolha o segmento ou filtro para este disparo.</span>
          ) : (
            'Defina exatamente quem receberá esta transmissão do WhatsApp.'
          )}
        </p>
      </div>

      {/* --- SEÇÃO 1: SEGMENTOS INTELIGENTES DE CONVERSÃO --- */}
      <div className="space-y-3">
        <div className="flex items-center gap-2">
          <Flame className="h-4 w-4 text-amber-400" />
          <h3 className="text-xs font-bold uppercase tracking-wider text-amber-400">
            Segmentos Automáticos de Conversão & Recuperação
          </h3>
          <span className="text-[10px] font-semibold bg-amber-500/10 text-amber-400 border border-amber-500/20 px-2 py-0.5 rounded-full">
            Recomendado
          </span>
        </div>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          {/* Option A: Unpaid (Não Finalizaram / Não Pagaram) */}
          <button
            type="button"
            onClick={() => selectAudienceType('unpaid')}
            className={`relative flex flex-col justify-between rounded-xl border p-4 text-left transition-all ${
              audience.type === 'unpaid'
                ? 'border-amber-500 bg-amber-500/10 ring-2 ring-amber-500/40 shadow-md shadow-amber-500/5'
                : 'border-border bg-card/60 hover:border-amber-500/40 hover:bg-card'
            }`}
          >
            <div>
              <div className="flex items-center justify-between gap-2 mb-2">
                <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-amber-500/15 text-amber-400">
                  <ShoppingCart className="h-5 w-5" />
                </div>
                <span className="rounded-full bg-amber-500/20 border border-amber-500/30 px-2 py-0.5 text-[11px] font-bold text-amber-300 font-mono">
                  {loadingQuickCounts ? (
                    <Loader2 className="h-3 w-3 animate-spin inline" />
                  ) : (
                    `${quickCounts?.unpaidCount ?? 0} leads`
                  )}
                </span>
              </div>
              <p className="text-sm font-bold text-foreground">Não Finalizaram / Não Pagaram</p>
              <p className="text-xs text-muted-foreground mt-1 leading-relaxed">
                Leads cadastrados que ainda não tiveram pagamento aprovado. Ideal para recuperação e ofertas.
              </p>
            </div>
            {audience.type === 'unpaid' && (
              <div className="mt-3 flex items-center gap-1.5 text-[11px] font-semibold text-amber-400">
                <BadgeCheck className="h-4 w-4" /> Selecionado
              </div>
            )}
          </button>

          {/* Option B: New Leads 24h */}
          <button
            type="button"
            onClick={() => selectAudienceType('new_24h')}
            className={`relative flex flex-col justify-between rounded-xl border p-4 text-left transition-all ${
              audience.type === 'new_24h'
                ? 'border-blue-500 bg-blue-500/10 ring-2 ring-blue-500/40 shadow-md shadow-blue-500/5'
                : 'border-border bg-card/60 hover:border-blue-500/40 hover:bg-card'
            }`}
          >
            <div>
              <div className="flex items-center justify-between gap-2 mb-2">
                <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-blue-500/15 text-blue-400">
                  <Sparkles className="h-5 w-5" />
                </div>
                <span className="rounded-full bg-blue-500/20 border border-blue-500/30 px-2 py-0.5 text-[11px] font-bold text-blue-300 font-mono">
                  {loadingQuickCounts ? (
                    <Loader2 className="h-3 w-3 animate-spin inline" />
                  ) : (
                    `${quickCounts?.new24hCount ?? 0} novos`
                  )}
                </span>
              </div>
              <p className="text-sm font-bold text-foreground">Novos Leads (Últimas 24h)</p>
              <p className="text-xs text-muted-foreground mt-1 leading-relaxed">
                Todos os contatos que entraram no CRM nas últimas 24 horas. Máximo engajamento e lembretes rápidos.
              </p>
            </div>
            {audience.type === 'new_24h' && (
              <div className="mt-3 flex items-center gap-1.5 text-[11px] font-semibold text-blue-400">
                <BadgeCheck className="h-4 w-4" /> Selecionado
              </div>
            )}
          </button>

          {/* Option C: New Leads 24h Unpaid */}
          <button
            type="button"
            onClick={() => selectAudienceType('new_24h_unpaid')}
            className={`relative flex flex-col justify-between rounded-xl border p-4 text-left transition-all ${
              audience.type === 'new_24h_unpaid'
                ? 'border-emerald-500 bg-emerald-500/10 ring-2 ring-emerald-500/40 shadow-md shadow-emerald-500/5'
                : 'border-border bg-card/60 hover:border-emerald-500/40 hover:bg-card'
            }`}
          >
            <div>
              <div className="flex items-center justify-between gap-2 mb-2">
                <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-emerald-500/15 text-emerald-400">
                  <Zap className="h-5 w-5" />
                </div>
                <span className="rounded-full bg-emerald-500/20 border border-emerald-500/30 px-2 py-0.5 text-[11px] font-bold text-emerald-300 font-mono">
                  {loadingQuickCounts ? (
                    <Loader2 className="h-3 w-3 animate-spin inline" />
                  ) : (
                    `${quickCounts?.new24hUnpaidCount ?? 0} leads`
                  )}
                </span>
              </div>
              <p className="text-sm font-bold text-foreground">Novos (24h) Que Não Pagaram</p>
              <p className="text-xs text-muted-foreground mt-1 leading-relaxed">
                Entraram nas últimas 24h e ainda não compraram. O segmento mais quente para fechamento imediato.
              </p>
            </div>
            {audience.type === 'new_24h_unpaid' && (
              <div className="mt-3 flex items-center gap-1.5 text-[11px] font-semibold text-emerald-400">
                <BadgeCheck className="h-4 w-4" /> Selecionado
              </div>
            )}
          </button>
        </div>
      </div>

      {/* --- SEÇÃO 2: AUDIÊNCIAS TRADICIONAIS & BASE GERAL --- */}
      <div className="space-y-3 pt-2">
        <h3 className="text-xs font-bold uppercase tracking-wider text-muted-foreground">
          Segmentação por Tags ou Base Completa
        </h3>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          {/* Option 1: Tags */}
          <button
            type="button"
            onClick={() => selectAudienceType('tags')}
            className={`flex items-start gap-3 rounded-xl border p-4 text-left transition-all ${
              audience.type === 'tags'
                ? 'border-primary bg-primary/10 ring-2 ring-primary/40 shadow-sm'
                : 'border-border bg-card/60 hover:border-border hover:bg-card'
            }`}
          >
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary/15 text-primary">
              <Tags className="h-5 w-5" />
            </div>
            <div>
              <p className="text-sm font-semibold text-foreground">Por Etiquetas (Tags)</p>
              <p className="text-xs text-muted-foreground mt-0.5">
                Filtrar por tags específicas como Leads, Clientes, etc.
              </p>
            </div>
          </button>

          {/* Option 2: All Contacts */}
          <button
            type="button"
            onClick={() => selectAudienceType('all')}
            className={`flex items-start gap-3 rounded-xl border p-4 text-left transition-all ${
              audience.type === 'all'
                ? 'border-primary bg-primary/10 ring-2 ring-primary/40 shadow-sm'
                : 'border-border bg-card/60 hover:border-border hover:bg-card'
            }`}
          >
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-purple-500/15 text-purple-400">
              <Users className="h-5 w-5" />
            </div>
            <div>
              <p className="text-sm font-semibold text-foreground">
                Toda a Base ({totalAccountContacts})
              </p>
              <p className="text-xs text-muted-foreground mt-0.5">
                Disparar para todos os contatos cadastrados nesta conta.
              </p>
            </div>
          </button>

          {/* Option 3: CSV */}
          <button
            type="button"
            onClick={() => selectAudienceType('csv')}
            className={`flex items-start gap-3 rounded-xl border p-4 text-left transition-all ${
              audience.type === 'csv'
                ? 'border-primary bg-primary/10 ring-2 ring-primary/40 shadow-sm'
                : 'border-border bg-card/60 hover:border-border hover:bg-card'
            }`}
          >
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-indigo-500/15 text-indigo-400">
              <Upload className="h-5 w-5" />
            </div>
            <div>
              <p className="text-sm font-semibold text-foreground">Importar CSV</p>
              <p className="text-xs text-muted-foreground mt-0.5">
                {csvCount > 0 ? `${csvCount} contatos carregados` : 'Carregar planilha externa com telefones.'}
              </p>
            </div>
          </button>
        </div>
      </div>

      {/* --- DETALHE DA SELEÇÃO DE TAGS --- */}
      {audience.type === 'tags' && (
        <div className="rounded-xl border border-border bg-card/80 p-5 space-y-4">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <div>
              <h3 className="text-sm font-semibold text-foreground flex items-center gap-2">
                <Tags className="h-4 w-4 text-primary" />
                Selecione as Etiquetas para o Disparo
              </h3>
              <p className="text-xs text-muted-foreground mt-0.5">
                Clique nas tags para incluir no alcance da campanha.
              </p>
            </div>

            {tags.length > 5 && (
              <div className="relative w-full sm:w-56">
                <Search className="absolute left-2.5 top-2.5 h-3.5 w-3.5 text-muted-foreground" />
                <Input
                  value={tagSearch}
                  onChange={(e) => setTagSearch(e.target.value)}
                  placeholder="Buscar etiqueta..."
                  className="h-8 pl-8 text-xs border-border bg-muted/40"
                />
              </div>
            )}
          </div>

          {loadingTags ? (
            <div className="flex items-center justify-center py-8 text-muted-foreground text-xs gap-2">
              <Loader2 className="h-4 w-4 animate-spin text-primary" />
              Carregando etiquetas da conta...
            </div>
          ) : filteredTags.length === 0 ? (
            <div className="text-center py-6 text-xs text-muted-foreground border border-dashed border-border rounded-lg">
              Nenhuma etiqueta encontrada para esta conta.
            </div>
          ) : (
            <div className="flex flex-wrap gap-2.5">
              {filteredTags.map((tag) => {
                const isSelected = audience.tagIds?.includes(tag.id);
                const count = tagCounts[tag.id] ?? 0;
                return (
                  <button
                    key={tag.id}
                    type="button"
                    onClick={() => toggleTag(tag.id)}
                    className={`inline-flex items-center gap-2 rounded-xl border px-3.5 py-2 text-xs font-medium transition-all shadow-2xs ${
                      isSelected
                        ? 'border-primary bg-primary/20 text-primary font-bold ring-1 ring-primary/50'
                        : 'border-border bg-muted/40 text-foreground hover:border-border hover:bg-muted/70'
                    }`}
                  >
                    <span
                      className="h-2.5 w-2.5 rounded-full shrink-0"
                      style={{ backgroundColor: tag.color || '#10B981' }}
                    />
                    <span>{tag.name}</span>
                    <span
                      className={`text-[11px] px-1.5 py-0.2 rounded-full font-mono ${
                        isSelected ? 'bg-primary/30 text-primary' : 'bg-muted text-muted-foreground'
                      }`}
                    >
                      {count}
                    </span>
                    {isSelected && <Check className="h-3.5 w-3.5 stroke-[2.5]" />}
                  </button>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* --- EXCLUDE TAGS ACCORDION (Works across all contact-based segments) --- */}
      {audience.type !== 'csv' && tags.length > 0 && (
        <div className="rounded-xl border border-border/80 bg-card/50 p-4">
          <button
            type="button"
            onClick={() => setShowExcludeList(!showExcludeList)}
            className="text-xs text-muted-foreground hover:text-foreground flex items-center justify-between w-full transition-colors"
          >
            <div className="flex items-center gap-2">
              <Filter className="h-3.5 w-3.5 text-muted-foreground" />
              <span>
                {showExcludeList
                  ? 'Ocultar exclusão de etiquetas'
                  : 'Deseja excluir contatos de alguma etiqueta? (Opcional)'}
              </span>
            </div>
            {(audience.excludeTagIds?.length ?? 0) > 0 && (
              <span className="rounded-full bg-red-500/20 text-red-400 px-2 py-0.5 text-[10px] font-bold">
                {audience.excludeTagIds?.length} tag(s) excluída(s)
              </span>
            )}
          </button>

          {showExcludeList && (
            <div className="mt-3 pt-3 border-t border-border/60 space-y-2">
              <p className="text-[11px] text-red-300 font-medium">
                Contatos marcados com as etiquetas abaixo NÃO receberão este disparo:
              </p>
              <div className="flex flex-wrap gap-2">
                {tags.map((tag) => {
                  const isExcluded = audience.excludeTagIds?.includes(tag.id);
                  return (
                    <button
                      key={tag.id}
                      type="button"
                      onClick={() => toggleExcludeTag(tag.id)}
                      className={`inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-xs transition-all ${
                        isExcluded
                          ? 'border-red-500 bg-red-500/20 text-red-300 font-bold'
                          : 'border-border bg-card/60 text-muted-foreground hover:text-foreground'
                      }`}
                    >
                      <span>{tag.name}</span>
                      {isExcluded && <X className="h-3 w-3 text-red-400" />}
                    </button>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      )}

      {/* --- CSV AUDIENCE SECTION --- */}
      {audience.type === 'csv' && (
        <div className="rounded-xl border border-border bg-card/80 p-5 space-y-3">
          <input
            ref={csvInputRef}
            type="file"
            accept=".csv,text/csv"
            className="hidden"
            onChange={handleCsvUpload}
          />
          {csvCount > 0 ? (
            <div className="flex items-center justify-between rounded-lg border border-indigo-500/30 bg-indigo-950/20 p-4">
              <div className="flex items-center gap-3">
                <FileText className="h-6 w-6 text-indigo-400" />
                <div>
                  <p className="text-sm font-semibold text-foreground">{csvFileName}</p>
                  <p className="text-xs text-muted-foreground">
                    {csvCount} contatos válidos prontos para o disparo
                  </p>
                </div>
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={() => csvInputRef.current?.click()}
                className="border-border text-xs"
              >
                Trocar Arquivo
              </Button>
            </div>
          ) : (
            <div
              onClick={() => csvInputRef.current?.click()}
              className="flex flex-col items-center justify-center rounded-xl border-2 border-dashed border-border p-6 text-center cursor-pointer hover:border-primary/50 hover:bg-muted/30 transition-all"
            >
              <Upload className="h-8 w-8 text-primary mb-2" />
              <p className="text-sm font-semibold text-foreground">
                Clique para selecionar sua planilha CSV
              </p>
              <p className="text-xs text-muted-foreground mt-1">
                A planilha deve conter colunas como "telefone" / "phone" e "nome" / "name".
              </p>
            </div>
          )}
        </div>
      )}

      {/* --- ESTIMATED REACH CONFIRMATION BAR --- */}
      <div className="rounded-xl border border-emerald-500/30 bg-emerald-950/20 p-4 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div>
          <p className="text-xs font-semibold text-emerald-400 uppercase tracking-wider">
            Alcance Confirmado Para Envio
          </p>
          <div className="flex items-center gap-2 text-foreground font-black text-xl mt-0.5">
            <Users className="h-5 w-5 text-emerald-400" />
            {loadingCount ? (
              <span className="text-sm font-normal text-muted-foreground flex items-center gap-2">
                <Loader2 className="h-4 w-4 animate-spin text-emerald-400" />
                Calculando contatos elegíveis...
              </span>
            ) : (
              <span className="text-emerald-400 font-extrabold text-2xl">
                {estimatedCount !== null ? `${estimatedCount.toLocaleString()} contatos` : '0 contatos'}
              </span>
            )}
          </div>
        </div>

        <p className="text-xs text-muted-foreground max-w-sm leading-relaxed">
          {audience.type === 'unpaid'
            ? 'Apenas leads sem compra confirmada no CRM receberão esta mensagem.'
            : audience.type === 'new_24h'
            ? 'Todos os contatos cadastrados nas últimas 24 horas receberão a mensagem.'
            : audience.type === 'new_24h_unpaid'
            ? 'Leads novos das últimas 24 horas que ainda não compraram receberão a mensagem.'
            : audience.type === 'tags'
            ? 'Apenas os contatos com as etiquetas selecionadas receberão a mensagem.'
            : audience.type === 'all'
            ? 'Todos os contatos da conta ativa serão incluídos.'
            : 'Apenas os contatos da planilha CSV carregada serão incluídos.'}
          {(audience.excludeTagIds?.length ?? 0) > 0 &&
            ' (Excluindo contatos das tags selecionadas).'}
        </p>
      </div>

      {/* Navigation Footer */}
      <div className="flex items-center justify-between border-t border-border pt-4">
        <Button variant="outline" onClick={onBack} className="border-border text-muted-foreground">
          <ArrowLeft className="h-4 w-4 mr-1.5" />
          {t('back')}
        </Button>
        <Button
          onClick={onNext}
          disabled={
            !isValid ||
            (audience.type === 'tags' && (!audience.tagIds || audience.tagIds.length === 0))
          }
          className="bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50 font-bold px-6"
        >
          {t('next')}
          <ArrowRight className="h-4 w-4 ml-1.5" />
        </Button>
      </div>
    </div>
  );
}