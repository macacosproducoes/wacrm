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
  Info,
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

export function Step2SelectAudience({
  audience,
  onUpdate,
  onNext,
  onBack,
}: Step2Props) {
  const t = useTranslations('Broadcasts.wizard');

  const OPERATOR_OPTIONS = useMemo<{ value: CustomFieldOperator; label: string }[]>(() => [
    { value: 'is', label: t('selectAudience.operatorIs') },
    { value: 'is_not', label: t('selectAudience.operatorIsNot') },
    { value: 'contains', label: t('selectAudience.operatorContains') },
  ], [t]);

  const audienceOptions = useMemo<{
    type: AudienceType;
    label: string;
    description: string;
    icon: typeof Users;
    badge?: string;
  }[]>(() => [
    {
      type: 'tags',
      label: 'Por Etiquetas (Recomendado)',
      description: 'Envie apenas para contatos com tags específicas (ex: DISPAROAGORAVAI).',
      icon: Tags,
      badge: 'Recomendado',
    },
    {
      type: 'all',
      label: 'Todos os Contatos',
      description: 'Disparar para absolutamente toda a base de contatos cadastrada.',
      icon: Users,
    },
    {
      type: 'custom_field',
      label: t('selectAudience.method.customField'),
      description: t('selectAudience.customFieldDesc'),
      icon: Filter,
    },
    {
      type: 'csv',
      label: t('selectAudience.method.csv'),
      description: t('selectAudience.csvDesc'),
      icon: Upload,
    },
  ], [t]);

  const [tags, setTags] = useState<Tag[]>([]);
  const [tagCounts, setTagCounts] = useState<Record<string, number>>({});
  const [customFields, setCustomFields] = useState<CustomField[]>([]);
  const [loadingTags, setLoadingTags] = useState(false);
  const [loadingFields, setLoadingFields] = useState(false);
  const [estimatedCount, setEstimatedCount] = useState<number | null>(null);
  const [loadingCount, setLoadingCount] = useState(false);
  const [pickedCsvName, setPickedCsvName] = useState<string | null>(null);
  const [showExcludeList, setShowExcludeList] = useState(
    (audience.excludeTagIds && audience.excludeTagIds.length > 0) || false
  );

  const csvInputRef = useRef<HTMLInputElement>(null);
  const csvCount = audience.csvContacts?.length ?? 0;
  const csvFileName = csvCount > 0 ? pickedCsvName : null;

  // Load tags and their lead counts
  useEffect(() => {
    async function fetchTagsAndCounts() {
      setLoadingTags(true);
      try {
        const supabase = createClient();
        const { data: tagsData } = await supabase.from('tags').select('*').order('name');
        setTags(tagsData ?? []);

        const { data: ctData } = await supabase.from('contact_tags').select('tag_id');
        if (ctData) {
          const counts: Record<string, number> = {};
          for (const row of ctData) {
            counts[row.tag_id] = (counts[row.tag_id] || 0) + 1;
          }
          setTagCounts(counts);

          // Auto-select DISPAROAGORAVAI or the first populated tag if none selected
          if ((!audience.tagIds || audience.tagIds.length === 0) && audience.type === 'tags') {
            const disparoTag = tagsData?.find(
              (tg) => tg.name.toUpperCase() === 'DISPAROAGORAVAI' || tg.name.toLowerCase().includes('disparo')
            );
            if (disparoTag) {
              onUpdate({
                ...audience,
                type: 'tags',
                tagIds: [disparoTag.id],
                excludeTagIds: [],
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
  }, []);

  // Lazy-load custom fields
  useEffect(() => {
    if (audience.type !== 'custom_field') return;
    async function fetchFields() {
      setLoadingFields(true);
      try {
        const supabase = createClient();
        const { data } = await supabase
          .from('custom_fields')
          .select('*')
          .order('field_name');
        setCustomFields(data ?? []);
      } finally {
        setLoadingFields(false);
      }
    }
    fetchFields();
  }, [audience.type]);

  const fetchEstimatedCount = useCallback(async () => {
    setLoadingCount(true);
    try {
      const supabase = createClient();

      let baseIds: Set<string> | null = null;

      if (audience.type === 'all') {
        // Will fetch full-table count below
      } else if (
        audience.type === 'tags' &&
        audience.tagIds &&
        audience.tagIds.length > 0
      ) {
        const { data } = await supabase
          .from('contact_tags')
          .select('contact_id')
          .in('tag_id', audience.tagIds);
        baseIds = new Set((data ?? []).map((r) => r.contact_id));
      } else if (
        audience.type === 'custom_field' &&
        audience.customField?.fieldId &&
        audience.customField.value
      ) {
        const { fieldId, operator, value } = audience.customField;
        let q = supabase
          .from('contact_custom_values')
          .select('contact_id')
          .eq('custom_field_id', fieldId);
        if (operator === 'is') q = q.eq('value', value);
        else if (operator === 'is_not') q = q.neq('value', value);
        else q = q.ilike('value', `%${value}%`);
        const { data } = await q;
        baseIds = new Set((data ?? []).map((r) => r.contact_id));
      } else if (
        audience.type === 'csv' &&
        audience.csvContacts &&
        audience.csvContacts.length > 0
      ) {
        setEstimatedCount(audience.csvContacts.length);
        return;
      } else {
        setEstimatedCount(null);
        return;
      }

      // Apply exclude tags
      let excludeSet: Set<string> | null = null;
      if (audience.excludeTagIds && audience.excludeTagIds.length > 0) {
        const { data: excludeRows } = await supabase
          .from('contact_tags')
          .select('contact_id')
          .in('tag_id', audience.excludeTagIds);
        excludeSet = new Set((excludeRows ?? []).map((r) => r.contact_id));
      }

      if (baseIds) {
        const effective = [...baseIds].filter(
          (id) => !excludeSet?.has(id),
        );
        setEstimatedCount(effective.length);
      } else {
        const { count } = await supabase
          .from('contacts')
          .select('*', { count: 'exact', head: true });
        const total = count ?? 0;
        setEstimatedCount(excludeSet ? Math.max(0, total - excludeSet.size) : total);
      }
    } finally {
      setLoadingCount(false);
    }
  }, [
    audience.type,
    audience.tagIds,
    audience.customField,
    audience.csvContacts,
    audience.excludeTagIds,
  ]);

  useEffect(() => {
    fetchEstimatedCount();
  }, [fetchEstimatedCount]);

  async function handleCsvChange(e: React.ChangeEvent<HTMLInputElement>) {
    const selected = e.target.files?.[0];
    if (!selected) return;

    const result = parseBroadcastCsv(await selected.text());

    if (!result.ok) {
      toast.error(
        result.error === 'missing_phone_column'
          ? t('selectAudience.errorCsvMissingPhone')
          : t('selectAudience.errorCsvParse'),
      );
      e.target.value = '';
      setPickedCsvName(null);
      onUpdate({ ...audience, csvContacts: undefined });
      return;
    }

    setPickedCsvName(selected.name);
    onUpdate({ ...audience, csvContacts: result.contacts });
  }

  function toggleTag(tagId: string) {
    const current = audience.tagIds ?? [];
    const updated = current.includes(tagId)
      ? current.filter((id) => id !== tagId)
      : [...current, tagId];

    // Clean exclude list from this tag to avoid accidental contradiction
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

    // Clean include list from this tag
    const cleanInclude = (audience.tagIds ?? []).filter((id) => id !== tagId);

    onUpdate({
      ...audience,
      excludeTagIds: updated,
      tagIds: cleanInclude,
    });
  }

  function updateCustomField(patch: Partial<CustomFieldFilter>) {
    const prev = audience.customField ?? {
      fieldId: '',
      operator: 'is' as CustomFieldOperator,
      value: '',
    };
    onUpdate({ ...audience, customField: { ...prev, ...patch } });
  }

  const isValid =
    (audience.type === 'tags' && audience.tagIds && audience.tagIds.length > 0) ||
    audience.type === 'all' ||
    (audience.type === 'custom_field' &&
      !!audience.customField?.fieldId &&
      audience.customField.value.length > 0) ||
    (audience.type === 'csv' &&
      audience.csvContacts &&
      audience.csvContacts.length > 0);

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold text-foreground">Seleção do Público-Alvo</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Escolha os destinatários que receberão esta campanha de transmissão.
        </p>
      </div>

      {/* Primary Audience Type Cards */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {audienceOptions.map((option) => {
          const isSelected = audience.type === option.type;
          const Icon = option.icon;
          return (
            <button
              key={option.type}
              type="button"
              onClick={() =>
                onUpdate({
                  ...audience,
                  type: option.type,
                  tagIds: option.type === 'tags' ? (audience.tagIds || []) : undefined,
                  customField:
                    option.type === 'custom_field'
                      ? audience.customField
                      : undefined,
                  csvContacts:
                    option.type === 'csv' ? audience.csvContacts : undefined,
                })
              }
              className={`relative flex items-start gap-3 rounded-xl border p-4 text-left transition-all ${
                isSelected
                  ? 'border-primary bg-primary/10 ring-2 ring-primary/40'
                  : 'border-border bg-card/50 hover:border-border hover:bg-card'
              }`}
            >
              {option.badge && (
                <span className="absolute top-2.5 right-2.5 rounded-full bg-emerald-500/20 border border-emerald-500/30 px-2 py-0.5 text-[10px] font-bold text-emerald-400 uppercase tracking-wider">
                  {option.badge}
                </span>
              )}
              <div
                className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg ${
                  isSelected
                    ? 'bg-primary text-primary-foreground'
                    : 'bg-muted text-muted-foreground'
                }`}
              >
                <Icon className="h-4 w-4" />
              </div>
              <div>
                <p className="text-sm font-semibold text-foreground">{option.label}</p>
                <p className="mt-0.5 text-xs text-muted-foreground leading-relaxed pr-6">
                  {option.description}
                </p>
              </div>
            </button>
          );
        })}
      </div>

      {/* Warning when ALL contacts is selected */}
      {audience.type === 'all' && (
        <div className="rounded-xl border border-amber-500/40 bg-amber-500/10 p-4 text-xs text-amber-200 space-y-1.5">
          <div className="flex items-center gap-2 font-bold text-amber-400">
            <AlertTriangle className="h-4 w-4 shrink-0" />
            <span>ATENÇÃO: Você selecionou "Todos os Contatos"!</span>
          </div>
          <p className="text-amber-200/90 leading-relaxed">
            Esta opção enviará mensagens para absolutamente <strong>TODOS os contatos da sua base</strong>.
            Se você deseja disparar apenas para os novos leads importados (ex: <strong>DISPAROAGORAVAI</strong>), selecione a opção <strong>"Por Etiquetas (Recomendado)"</strong> acima.
          </p>
        </div>
      )}

      {/* TAG SELECTION SECTION */}
      {audience.type === 'tags' && (
        <div className="rounded-xl border border-primary/30 bg-card/60 p-5 space-y-3">
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
            <div>
              <p className="text-sm font-semibold text-foreground flex items-center gap-2">
                <Tags className="h-4 w-4 text-primary" />
                Selecione as Etiquetas de Destino (Quem deve receber):
              </p>
              <p className="text-xs text-muted-foreground mt-0.5">
                Clique nas etiquetas abaixo para incluir os contatos no disparo.
              </p>
            </div>
            {audience.tagIds && audience.tagIds.length > 0 && (
              <span className="text-xs font-semibold text-emerald-400 bg-emerald-500/10 px-2.5 py-1 rounded-md border border-emerald-500/20">
                {audience.tagIds.length} etiqueta(s) selecionada(s)
              </span>
            )}
          </div>

          {loadingTags ? (
            <div className="flex h-20 items-center justify-center">
              <Loader2 className="h-5 w-5 animate-spin text-primary" />
            </div>
          ) : tags.length === 0 ? (
            <p className="text-xs text-muted-foreground">Nenhuma etiqueta encontrada.</p>
          ) : (
            <div className="flex flex-wrap gap-2.5 pt-1">
              {tags.map((tag) => {
                const isSelected = audience.tagIds?.includes(tag.id);
                const count = tagCounts[tag.id] ?? 0;
                return (
                  <button
                    key={tag.id}
                    type="button"
                    onClick={() => toggleTag(tag.id)}
                    className={`inline-flex items-center gap-2 rounded-xl border px-3.5 py-2 text-xs font-semibold transition-all ${
                      isSelected
                        ? 'border-emerald-500 bg-emerald-500/20 text-emerald-300 ring-2 ring-emerald-500/40 shadow-sm'
                        : 'border-border bg-card hover:border-primary/50 text-foreground'
                    }`}
                  >
                    <span
                      className="h-2.5 w-2.5 rounded-full"
                      style={{ backgroundColor: tag.color }}
                    />
                    <span>{tag.name}</span>
                    <span
                      className={`rounded-md px-1.5 py-0.5 text-[10px] font-mono ${
                        isSelected
                          ? 'bg-emerald-500/30 text-emerald-200 font-bold'
                          : 'bg-muted text-muted-foreground'
                      }`}
                    >
                      {count} {count === 1 ? 'lead' : 'leads'}
                    </span>
                    {isSelected && <Check className="h-3.5 w-3.5 text-emerald-400" />}
                  </button>
                );
              })}
            </div>
          )}

          {(!audience.tagIds || audience.tagIds.length === 0) && (
            <p className="text-xs text-amber-400 flex items-center gap-1.5 pt-1 font-medium">
              <AlertTriangle className="h-3.5 w-3.5" />
              Por favor, clique em ao menos uma etiqueta acima para habilitar o envio.
            </p>
          )}
        </div>
      )}

      {/* CUSTOM FIELD SECTION */}
      {audience.type === 'custom_field' && (
        <div className="space-y-3 rounded-xl border border-border bg-card/50 p-4">
          <p className="text-sm font-medium text-foreground">{t('selectAudience.method.customField')}</p>
          {loadingFields ? (
            <Loader2 className="h-5 w-5 animate-spin text-primary" />
          ) : customFields.length === 0 ? (
            <p className="text-xs text-muted-foreground">{t('selectAudience.errorLoadFields')}</p>
          ) : (
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-[minmax(0,1fr)_140px_minmax(0,1fr)]">
              <select
                value={audience.customField?.fieldId ?? ''}
                onChange={(e) => updateCustomField({ fieldId: e.target.value })}
                className="h-9 rounded-lg border border-border bg-muted px-2.5 text-sm text-foreground outline-none focus:border-primary focus:ring-1 focus:ring-primary"
              >
                <option value="">{t('selectAudience.selectField')}</option>
                {customFields.map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.field_name}
                  </option>
                ))}
              </select>
              <select
                value={audience.customField?.operator ?? 'is'}
                onChange={(e) =>
                  updateCustomField({
                    operator: e.target.value as CustomFieldOperator,
                  })
                }
                className="h-9 rounded-lg border border-border bg-muted px-2.5 text-sm text-foreground outline-none focus:border-primary focus:ring-1 focus:ring-primary"
              >
                {OPERATOR_OPTIONS.map((op: { value: CustomFieldOperator; label: string }) => (
                  <option key={op.value} value={op.value}>
                    {op.label}
                  </option>
                ))}
              </select>
              <input
                type="text"
                value={audience.customField?.value ?? ''}
                onChange={(e) => updateCustomField({ value: e.target.value })}
                placeholder={t('selectAudience.valuePlaceholder')}
                className="h-9 rounded-lg border border-border bg-muted px-2.5 text-sm text-foreground outline-none placeholder:text-muted-foreground focus:border-primary focus:ring-1 focus:ring-primary"
              />
            </div>
          )}
        </div>
      )}

      {/* CSV SECTION */}
      {audience.type === 'csv' && (
        <div className="space-y-3 rounded-xl border border-border bg-card/50 p-4">
          <div>
            <p className="text-sm font-medium text-foreground">{t('selectAudience.uploadCsv')}</p>
            <p className="mt-0.5 text-xs text-muted-foreground">{t('selectAudience.csvFormatDesc')}</p>
          </div>

          <button
            type="button"
            onClick={() => csvInputRef.current?.click()}
            className="group flex w-full flex-col items-center gap-2 rounded-lg border border-dashed border-border bg-muted/40 px-4 py-6 text-center transition-colors hover:border-primary/40 hover:bg-muted/70"
          >
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-muted text-muted-foreground group-hover:text-foreground">
              {csvFileName ? <FileText className="h-5 w-5" /> : <Upload className="h-5 w-5" />}
            </div>
            <p className="text-sm text-foreground">
              {csvFileName ?? t('selectAudience.uploadCsv')}
            </p>
            {csvCount > 0 && (
              <p className="text-xs text-primary">
                {t('selectAudience.csvContactsFound', { count: csvCount })}
              </p>
            )}
          </button>

          <input
            ref={csvInputRef}
            type="file"
            accept=".csv,text/csv"
            onChange={handleCsvChange}
            className="hidden"
          />
        </div>
      )}

      {/* COLLAPSIBLE EXCLUDE LIST (SAFE & OPTIONAL) */}
      <div className="rounded-xl border border-border/80 bg-card/30 p-4">
        <button
          type="button"
          onClick={() => setShowExcludeList(!showExcludeList)}
          className="flex w-full items-center justify-between text-left text-xs font-medium text-muted-foreground hover:text-foreground"
        >
          <span className="flex items-center gap-2">
            <X className="h-4 w-4 text-red-400" />
            <span>Filtro de Exclusão: Bloquear contatos que tenham certas tags (Opcional)</span>
            {(audience.excludeTagIds?.length ?? 0) > 0 && (
              <span className="rounded-full bg-red-500/20 border border-red-500/30 px-2 py-0.5 text-[10px] font-bold text-red-300">
                {audience.excludeTagIds?.length} bloqueada(s)
              </span>
            )}
          </span>
          <span className="text-[11px] text-muted-foreground font-mono">
            {showExcludeList ? '▲ Ocultar' : '▼ Expandir'}
          </span>
        </button>

        {showExcludeList && (
          <div className="mt-3 pt-3 border-t border-border/60 space-y-2">
            <p className="text-[11px] text-red-400/90 font-medium">
              ⚠️ CUIDADO: Contatos que tiverem as etiquetas marcadas abaixo serão EXCLUÍDOS e NÃO receberão esta mensagem. Não use esta seção para escolher os destinatários!
            </p>
            {tags.length === 0 ? (
              <p className="text-xs text-muted-foreground">Nenhuma etiqueta encontrada.</p>
            ) : (
              <div className="flex flex-wrap gap-2 pt-1">
                {tags.map((tag) => {
                  const isExcluded = audience.excludeTagIds?.includes(tag.id);
                  return (
                    <button
                      key={tag.id}
                      type="button"
                      onClick={() => toggleExcludeTag(tag.id)}
                      className={`inline-flex items-center rounded-full border px-3 py-1 text-xs font-medium transition-all ${
                        isExcluded
                          ? 'border-red-500/40 bg-red-500/20 text-red-300 font-bold'
                          : 'border-border bg-muted text-muted-foreground hover:border-border'
                      }`}
                    >
                      <span
                        className="mr-1.5 h-2 w-2 rounded-full"
                        style={{ backgroundColor: tag.color }}
                      />
                      {tag.name}
                      {isExcluded && <span className="ml-1 text-[10px] text-red-400">(Bloqueado)</span>}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        )}
      </div>

      {/* AUDIENCE SUMMARY */}
      <div className="rounded-xl border border-primary/30 bg-primary/5 p-4 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div className="space-y-1">
          <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
            Destinatários Confirmados para Envio
          </p>
          <div className="flex items-center gap-2 text-foreground font-bold text-lg">
            <Users className="h-5 w-5 text-primary" />
            {loadingCount ? (
              <span className="text-sm font-normal text-muted-foreground flex items-center gap-2">
                <Loader2 className="h-4 w-4 animate-spin text-primary" />
                Calculando contatos...
              </span>
            ) : (
              <span className="text-primary font-bold">
                {estimatedCount !== null
                  ? `${estimatedCount.toLocaleString()} contatos`
                  : 'Nenhum contato selecionado'}
              </span>
            )}
          </div>
        </div>

        {audience.type === 'tags' && audience.tagIds && audience.tagIds.length > 0 && (
          <div className="flex items-center gap-1.5 self-start sm:self-center">
            <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-500/20 px-3 py-1 text-xs font-bold text-emerald-400 border border-emerald-500/30">
              <Check className="h-3.5 w-3.5" />
              Envio Direcionado por Etiqueta
            </span>
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
          className="bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
        >
          {t('next')}
          <ArrowRight className="h-4 w-4 ml-1.5" />
        </Button>
      </div>
    </div>
  );
}
