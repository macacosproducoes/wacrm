'use client';

import { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import { createClient } from '@/lib/supabase/client';
import { parseBroadcastCsv } from '@/lib/broadcast-csv';
import { CustomField, Tag } from '@/types';
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
} from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useAuth } from '@/hooks/use-auth';

type AudienceType = 'all' | 'tags' | 'custom_field' | 'csv';
type CustomFieldOperator = 'is' | 'is_not' | 'contains';

interface CustomFieldFilter {
  fieldId: string;
  operator: CustomFieldOperator;
  value: string;
}

interface AudienceConfig {
  type: AudienceType;
  tagIds?: string[];
  customField?: CustomFieldFilter;
  csvContacts?: { phone: string; name?: string }[];
  excludeTagIds?: string[];
}

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
  const [loadingTags, setLoadingTags] = useState(false);
  const [tagSearch, setTagSearch] = useState('');
  const [estimatedCount, setEstimatedCount] = useState<number | null>(null);
  const [loadingCount, setLoadingCount] = useState(false);
  const [pickedCsvName, setPickedCsvName] = useState<string | null>(null);
  const [showExcludeList, setShowExcludeList] = useState(false);

  const csvInputRef = useRef<HTMLInputElement>(null);
  const csvCount = audience.csvContacts?.length ?? 0;
  const csvFileName = csvCount > 0 ? pickedCsvName : null;

  // Load tags and counts for active account
  useEffect(() => {
    async function fetchTagsAndCounts() {
      setLoadingTags(true);
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

        // 2. Fetch total contacts for this account
        let countQuery = supabase.from('contacts').select('*', { count: 'exact', head: true });
        if (accountId) {
          countQuery = countQuery.eq('account_id', accountId);
        }
        const { count: totalContacts } = await countQuery;
        setTotalAccountContacts(totalContacts ?? 0);

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

          // Auto-select 'Leads' or 'Lead' tag if no tag is selected yet
          if (!audience.tagIds || audience.tagIds.length === 0) {
            const defaultLeadTag = loadedTags.find(
              (t) => t.name.toLowerCase() === 'leads' || t.name.toLowerCase() === 'lead'
            );
            if (defaultLeadTag) {
              onUpdate({
                ...audience,
                type: 'tags',
                tagIds: [defaultLeadTag.id],
                excludeTagIds: audience.excludeTagIds ?? [],
              });
            }
          }
        }
      } catch (err) {
        console.error('Error fetching tags:', err);
      } finally {
        setLoadingTags(false);
      }
    }

    fetchTagsAndCounts();
  }, [accountId]);

  // Calculate estimated reach
  const fetchEstimatedCount = useCallback(async () => {
    setLoadingCount(true);
    try {
      const supabase = createClient();

      if (audience.type === 'tags' && audience.tagIds && audience.tagIds.length > 0) {
        const { data } = await supabase
          .from('contact_tags')
          .select('contact_id')
          .in('tag_id', audience.tagIds);

        const uniqueContacts = new Set((data ?? []).map((r) => r.contact_id));

        // Remove excludes if any
        if (audience.excludeTagIds && audience.excludeTagIds.length > 0) {
          const { data: excludeRows } = await supabase
            .from('contact_tags')
            .select('contact_id')
            .in('tag_id', audience.excludeTagIds);
          for (const r of excludeRows ?? []) {
            uniqueContacts.delete(r.contact_id);
          }
        }
        setEstimatedCount(uniqueContacts.size);
      } else if (audience.type === 'all') {
        let q = supabase.from('contacts').select('*', { count: 'exact', head: true });
        if (accountId) q = q.eq('account_id', accountId);
        const { count } = await q;
        setEstimatedCount(count ?? 0);
      } else if (audience.type === 'csv' && audience.csvContacts) {
        setEstimatedCount(audience.csvContacts.length);
      } else {
        setEstimatedCount(0);
      }
    } finally {
      setLoadingCount(false);
    }
  }, [audience.type, audience.tagIds, audience.excludeTagIds, audience.csvContacts, accountId]);

  useEffect(() => {
    fetchEstimatedCount();
  }, [fetchEstimatedCount]);

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
    (audience.type === 'tags' && audience.tagIds && audience.tagIds.length > 0) ||
    audience.type === 'all' ||
    (audience.type === 'csv' && audience.csvContacts && audience.csvContacts.length > 0);

  return (
    <div className="space-y-6">
      {/* Title Header */}
      <div>
        <h2 className="text-lg font-semibold text-foreground">Seleção do Público-Alvo</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {account?.name ? (
            <span>Conta ativa: <strong className="text-primary">{account.name}</strong>. Defina quem receberá este disparo.</span>
          ) : (
            'Defina exatamente quem receberá esta transmissão do WhatsApp.'
          )}
        </p>
      </div>

      {/* 3 Audience Type Option Cards */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        {/* Option 1: Tags */}
        <button
          type="button"
          onClick={() => onUpdate({ ...audience, type: 'tags' })}
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
              Filtrar por grupos como <strong>Leads</strong> ou clientes específicos.
            </p>
          </div>
        </button>

        {/* Option 2: All Contacts */}
        <button
          type="button"
          onClick={() => onUpdate({ ...audience, type: 'all', tagIds: undefined })}
          className={`flex items-start gap-3 rounded-xl border p-4 text-left transition-all ${
            audience.type === 'all'
              ? 'border-primary bg-primary/10 ring-2 ring-primary/40 shadow-sm'
              : 'border-border bg-card/60 hover:border-border hover:bg-card'
          }`}
        >
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-blue-500/15 text-blue-400">
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
          onClick={() => onUpdate({ ...audience, type: 'csv', tagIds: undefined })}
          className={`flex items-start gap-3 rounded-xl border p-4 text-left transition-all ${
            audience.type === 'csv'
              ? 'border-primary bg-primary/10 ring-2 ring-primary/40 shadow-sm'
              : 'border-border bg-card/60 hover:border-border hover:bg-card'
          }`}
        >
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-purple-500/15 text-purple-400">
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

      {/* --- TAGS AUDIENCE SECTION --- */}
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
                    <span className={`text-[11px] px-1.5 py-0.2 rounded-full font-mono ${
                      isSelected ? 'bg-primary/30 text-primary' : 'bg-muted text-muted-foreground'
                    }`}>{count}</span>
                    {isSelected && <Check className="h-3.5 w-3.5 stroke-[2.5]" />}
                  </button>
                );
              })}
            </div>
          )}

          {/* Exclude Tags Accordion */}
          {tags.length > 1 && (
            <div className="pt-2 border-t border-border/60">
              <button
                type="button"
                onClick={() => setShowExcludeList(!showExcludeList)}
                className="text-xs text-muted-foreground hover:text-foreground flex items-center gap-1.5 transition-colors"
              >
                <Filter className="h-3.5 w-3.5" />
                <span>
                  {showExcludeList
                    ? 'Ocultar exclusão de etiquetas'
                    : 'Excluir contatos de alguma etiqueta (Opcional)'}
                </span>
                {(audience.excludeTagIds?.length ?? 0) > 0 && (
                  <span className="ml-1 rounded-full bg-red-500/20 text-red-400 px-1.5 py-0.2 text-[10px] font-bold">
                    {audience.excludeTagIds?.length} excluída(s)
                  </span>
                )}
              </button>

              {showExcludeList && (
                <div className="mt-3 p-3 rounded-lg border border-red-500/20 bg-red-950/10 space-y-2">
                  <p className="text-[11px] text-red-300 font-medium">
                    Contatos marcados com as etiquetas abaixo serão ignorados no disparo:
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
            <div className="flex items-center justify-between rounded-lg border border-purple-500/30 bg-purple-950/20 p-4">
              <div className="flex items-center gap-3">
                <FileText className="h-6 w-6 text-purple-400" />
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
            Alcance Estimado Confirmado
          </p>
          <div className="flex items-center gap-2 text-foreground font-black text-xl mt-0.5">
            <Users className="h-5 w-5 text-emerald-400" />
            {loadingCount ? (
              <span className="text-sm font-normal text-muted-foreground flex items-center gap-2">
                <Loader2 className="h-4 w-4 animate-spin text-emerald-400" />
                Calculando leads...
              </span>
            ) : (
              <span className="text-emerald-400 font-extrabold text-2xl">
                {estimatedCount !== null ? `${estimatedCount.toLocaleString()} contatos` : '0 contatos'}
              </span>
            )}
          </div>
        </div>

        <p className="text-xs text-muted-foreground max-w-xs leading-relaxed">
          {audience.type === 'tags'
            ? 'Apenas os contatos com as etiquetas selecionadas receberão a mensagem.'
            : audience.type === 'all'
            ? 'Todos os contatos da conta ativa serão incluídos.'
            : 'Apenas os contatos da lista CSV carregada serão incluídos.'}
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
          disabled={!isValid || (audience.type === 'tags' && (!audience.tagIds || audience.tagIds.length === 0))}
          className="bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50 font-bold px-6"
        >
          {t('next')}
          <ArrowRight className="h-4 w-4 ml-1.5" />
        </Button>
      </div>
    </div>
  );
}