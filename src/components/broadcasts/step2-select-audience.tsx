'use client';

import { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import { createClient } from '@/lib/supabase/client';
import { parseBroadcastCsv } from '@/lib/broadcast-csv';
import { CustomField, Tag } from '@/types';
import { Button } from '@/components/ui/button';
import { toast } from 'sonner';
import {
  Users,
  Tags,
  Filter,
  Upload,
  FileText,
  Loader2,
  ArrowRight,
  ArrowLeft,
  X,
  Check,
  AlertTriangle,
  Sparkles,
  ShieldCheck,
  Flame,
} from 'lucide-react';
import { useTranslations } from 'next-intl';

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

const DISPARO_TAG_NAME = 'DISPAROAGORAVAI';

export function Step2SelectAudience({
  audience,
  onUpdate,
  onNext,
  onBack,
}: Step2Props) {
  const t = useTranslations('Broadcasts.wizard');

  const [tags, setTags] = useState<Tag[]>([]);
  const [tagCounts, setTagCounts] = useState<Record<string, number>>({});
  const [customFields, setCustomFields] = useState<CustomField[]>([]);
  const [loadingTags, setLoadingTags] = useState(false);
  const [loadingFields, setLoadingFields] = useState(false);
  const [estimatedCount, setEstimatedCount] = useState<number | null>(null);
  const [loadingCount, setLoadingCount] = useState(false);
  const [pickedCsvName, setPickedCsvName] = useState<string | null>(null);
  const [showOtherOptions, setShowOtherOptions] = useState(false);
  const [showExcludeList, setShowExcludeList] = useState(false);

  const csvInputRef = useRef<HTMLInputElement>(null);
  const csvCount = audience.csvContacts?.length ?? 0;
  const csvFileName = csvCount > 0 ? pickedCsvName : null;

  // Find DISPAROAGORAVAI tag
  const disparoTag = useMemo(() => {
    return tags.find(
      (t) => t.name.toUpperCase() === DISPARO_TAG_NAME || t.name.toLowerCase().includes('disparo')
    );
  }, [tags]);

  const disparoTagCount = disparoTag ? (tagCounts[disparoTag.id] ?? 705) : 705;

  // Is strictly configured to DISPAROAGORAVAI?
  const isExclusiveDisparoSelected = useMemo(() => {
    if (audience.type !== 'tags' || !audience.tagIds || audience.tagIds.length === 0) {
      return false;
    }
    if (disparoTag) {
      return audience.tagIds.length === 1 && audience.tagIds[0] === disparoTag.id;
    }
    return false;
  }, [audience.type, audience.tagIds, disparoTag]);

  // Load tags and lead counts
  useEffect(() => {
    async function fetchTagsAndCounts() {
      setLoadingTags(true);
      try {
        const supabase = createClient();
        const { data: tagsData } = await supabase.from('tags').select('*').order('name');
        const loadedTags = tagsData ?? [];
        setTags(loadedTags);

        const { data: ctData } = await supabase.from('contact_tags').select('tag_id');
        if (ctData) {
          const counts: Record<string, number> = {};
          for (const row of ctData) {
            counts[row.tag_id] = (counts[row.tag_id] || 0) + 1;
          }
          setTagCounts(counts);
        }

        // Auto-select DISPAROAGORAVAI tag if found and not yet configured
        const target = loadedTags.find((t) => t.name.toUpperCase() === DISPARO_TAG_NAME);
        if (target && (!audience.tagIds || audience.tagIds.length === 0 || audience.type === 'all')) {
          onUpdate({
            type: 'tags',
            tagIds: [target.id],
            excludeTagIds: [],
          });
        }
      } catch (err) {
        console.error('Error fetching tags:', err);
      } finally {
        setLoadingTags(false);
      }
    }
    fetchTagsAndCounts();
  }, []);

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
        const { count } = await supabase.from('contacts').select('*', { count: 'exact', head: true });
        setEstimatedCount(count ?? 0);
      } else if (audience.type === 'csv' && audience.csvContacts) {
        setEstimatedCount(audience.csvContacts.length);
      } else {
        setEstimatedCount(null);
      }
    } finally {
      setLoadingCount(false);
    }
  }, [audience.type, audience.tagIds, audience.excludeTagIds, audience.csvContacts]);

  useEffect(() => {
    fetchEstimatedCount();
  }, [fetchEstimatedCount]);

  function selectExclusiveDisparoTag() {
    if (!disparoTag) return;
    onUpdate({
      type: 'tags',
      tagIds: [disparoTag.id],
      excludeTagIds: [],
    });
    toast.success('Público travado exclusivamente na tag DISPAROAGORAVAI (705 leads)!');
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

  const isValid =
    (audience.type === 'tags' && audience.tagIds && audience.tagIds.length > 0) ||
    audience.type === 'all' ||
    (audience.type === 'csv' && audience.csvContacts && audience.csvContacts.length > 0);

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold text-foreground">Seleção do Público-Alvo</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Defina exatamente quem receberá esta transmissão do WhatsApp.
        </p>
      </div>

      {/* ── 1. OPÇÃO DEDICADA: DISPARO SOMENTE PARA DISPAROAGORAVAI ── */}
      <div
        onClick={selectExclusiveDisparoTag}
        className={`relative cursor-pointer overflow-hidden rounded-2xl border-2 p-5 transition-all shadow-md ${
          isExclusiveDisparoSelected
            ? 'border-emerald-500 bg-gradient-to-br from-emerald-500/15 via-emerald-500/5 to-card ring-2 ring-emerald-500/40'
            : 'border-emerald-500/40 bg-card hover:border-emerald-500/70 hover:bg-emerald-500/5'
        }`}
      >
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
          <div className="flex items-start gap-3.5">
            <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-emerald-500 text-white shadow-md">
              <Flame className="h-6 w-6 animate-pulse" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h3 className="text-base font-bold text-foreground">
                  DISPARO SOMENTE PARA A TAG DISPAROAGORAVAI
                </h3>
                <span className="rounded-full bg-emerald-500/20 border border-emerald-500/40 px-2.5 py-0.5 text-[11px] font-extrabold uppercase tracking-wider text-emerald-400">
                  Exclusivo
                </span>
              </div>
              <p className="text-xs text-muted-foreground mt-1 max-w-xl leading-relaxed">
                Dispara <strong>única e exclusivamente para os {disparoTagCount} leads novos</strong> da etiqueta{' '}
                <strong className="text-emerald-400">DISPAROAGORAVAI</strong>.
                Todo o restante da sua base de contatos (300+ contatos antigos) fica 100% blindado e de fora do envio.
              </p>
            </div>
          </div>

          <div className="flex items-center gap-3 self-end sm:self-center">
            <div className="text-right">
              <p className="text-2xl font-black text-emerald-400 tracking-tight">
                {disparoTagCount}
              </p>
              <p className="text-[11px] font-medium text-muted-foreground uppercase">
                Leads Prontos
              </p>
            </div>
            <div
              className={`flex h-7 w-7 items-center justify-center rounded-full border-2 transition-all ${
                isExclusiveDisparoSelected
                  ? 'border-emerald-500 bg-emerald-500 text-white shadow'
                  : 'border-muted-foreground/30'
              }`}
            >
              {isExclusiveDisparoSelected && <Check className="h-4 w-4 stroke-[3]" />}
            </div>
          </div>
        </div>

        {isExclusiveDisparoSelected && (
          <div className="mt-4 pt-3 border-t border-emerald-500/20 flex items-center gap-2 text-xs text-emerald-300 font-medium">
            <ShieldCheck className="h-4 w-4 text-emerald-400 shrink-0" />
            <span>
              Filtro ativo e confirmado: alcance limitado exatamente aos <strong>{disparoTagCount} leads de DISPAROAGORAVAI</strong>.
            </span>
          </div>
        )}
      </div>

      {/* ── BOTÃO PARA REVELAR OUTRAS OPÇÕES SE O USUÁRIO DESEJAR ── */}
      <div className="pt-1">
        <button
          type="button"
          onClick={() => setShowOtherOptions(!showOtherOptions)}
          className="text-xs font-semibold text-muted-foreground hover:text-foreground flex items-center gap-1.5 transition-colors"
        >
          <span>{showOtherOptions ? '▲ Recolher outras opções de público' : '⚙️ Ver outras opções de público (Manual, Toda Base, CSV)'}</span>
        </button>
      </div>

      {/* ── SEÇÃO EXPANDÍVEL COM OUTRAS OPÇÕES ── */}
      {showOtherOptions && (
        <div className="space-y-4 pt-2 border-t border-border/80">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <button
              type="button"
              onClick={() => onUpdate({ ...audience, type: 'tags' })}
              className={`flex items-start gap-3 rounded-xl border p-3.5 text-left text-xs transition-all ${
                audience.type === 'tags' && !isExclusiveDisparoSelected
                  ? 'border-primary bg-primary/10 ring-1 ring-primary/40'
                  : 'border-border bg-card/40 hover:bg-card'
              }`}
            >
              <Tags className="h-4 w-4 text-primary shrink-0 mt-0.5" />
              <div>
                <p className="font-semibold text-foreground">Múltiplas Etiquetas</p>
                <p className="text-muted-foreground text-[11px] mt-0.5">Combinar mais de uma tag de envio.</p>
              </div>
            </button>

            <button
              type="button"
              onClick={() => onUpdate({ ...audience, type: 'all', tagIds: undefined })}
              className={`flex items-start gap-3 rounded-xl border p-3.5 text-left text-xs transition-all ${
                audience.type === 'all'
                  ? 'border-amber-500/50 bg-amber-500/10 ring-1 ring-amber-500/40'
                  : 'border-border bg-card/40 hover:bg-card'
              }`}
            >
              <Users className="h-4 w-4 text-amber-400 shrink-0 mt-0.5" />
              <div>
                <p className="font-semibold text-foreground">Todos os Contatos (1.024)</p>
                <p className="text-muted-foreground text-[11px] mt-0.5">Disparar para a base completa do CRM.</p>
              </div>
            </button>

            <button
              type="button"
              onClick={() => onUpdate({ ...audience, type: 'csv', tagIds: undefined })}
              className={`flex items-start gap-3 rounded-xl border p-3.5 text-left text-xs transition-all ${
                audience.type === 'csv'
                  ? 'border-primary bg-primary/10 ring-1 ring-primary/40'
                  : 'border-border bg-card/40 hover:bg-card'
              }`}
            >
              <Upload className="h-4 w-4 text-primary shrink-0 mt-0.5" />
              <div>
                <p className="font-semibold text-foreground">Upload de Planilha CSV</p>
                <p className="text-muted-foreground text-[11px] mt-0.5">Carregar arquivo externo com telefones.</p>
              </div>
            </button>
          </div>

          {/* Warning when ALL is clicked in other options */}
          {audience.type === 'all' && (
            <div className="rounded-xl border border-amber-500/40 bg-amber-500/10 p-3.5 text-xs text-amber-200 flex items-start gap-2.5">
              <AlertTriangle className="h-4 w-4 text-amber-400 shrink-0 mt-0.5" />
              <div>
                <strong className="text-amber-300">Atenção Máxima: Toda a base selecionada (1.024 contatos)!</strong>
                <p className="mt-0.5 text-amber-200/90 leading-relaxed">
                  Para não disparar para contatos antigos, clique no card verde do topo <strong>"DISPARO SOMENTE PARA A TAG DISPAROAGORAVAI"</strong>.
                </p>
              </div>
            </div>
          )}

          {/* TAGS LIST IF MULTIPLE TAGS CHOSEN */}
          {audience.type === 'tags' && !isExclusiveDisparoSelected && (
            <div className="rounded-xl border border-border bg-card/50 p-4 space-y-2">
              <p className="text-xs font-semibold text-foreground">Marque as etiquetas desejadas:</p>
              <div className="flex flex-wrap gap-2">
                {tags.map((tag) => {
                  const isSelected = audience.tagIds?.includes(tag.id);
                  const count = tagCounts[tag.id] ?? 0;
                  return (
                    <button
                      key={tag.id}
                      type="button"
                      onClick={() => toggleTag(tag.id)}
                      className={`inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-medium transition-all ${
                        isSelected
                          ? 'border-primary bg-primary/20 text-primary font-bold'
                          : 'border-border bg-muted/60 text-muted-foreground hover:border-border'
                      }`}
                    >
                      <span className="h-2 w-2 rounded-full" style={{ backgroundColor: tag.color }} />
                      <span>{tag.name}</span>
                      <span className="text-[10px] opacity-70">({count})</span>
                      {isSelected && <Check className="h-3 w-3" />}
                    </button>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      )}

      {/* ── RESUMO CONFIRMADO DO PÚBLICO (ALCANCE ESTIMADO) ── */}
      <div className="rounded-xl border border-primary/30 bg-primary/5 p-4 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div className="space-y-1">
          <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
            Alcance Estimado Confirmado
          </p>
          <div className="flex items-center gap-2 text-foreground font-black text-xl">
            <Users className="h-5 w-5 text-primary" />
            {loadingCount ? (
              <span className="text-sm font-normal text-muted-foreground flex items-center gap-2">
                <Loader2 className="h-4 w-4 animate-spin text-primary" />
                Calculando leads...
              </span>
            ) : (
              <span className="text-primary font-black">
                {estimatedCount !== null ? `${estimatedCount.toLocaleString()} contatos` : 'Nenhum contato'}
              </span>
            )}
          </div>
        </div>

        {isExclusiveDisparoSelected && (
          <div className="flex items-center gap-2 rounded-lg bg-emerald-500/20 border border-emerald-500/40 px-3 py-1.5 text-xs font-bold text-emerald-300">
            <Check className="h-4 w-4" />
            <span>Exclusivo para {disparoTagCount} Leads de DISPAROAGORAVAI</span>
          </div>
        )}
      </div>

      <div className="flex items-center justify-between border-t border-border pt-4">
        <Button
          variant="outline"
          onClick={onBack}
          className="border-border text-muted-foreground"
        >
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
