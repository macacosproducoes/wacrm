'use client';

import { useEffect, useMemo, useState, useRef } from 'react';
import { createClient } from '@/lib/supabase/client';
import { Contact, CustomField, MessageTemplate } from '@/types';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  ArrowLeft,
  ArrowRight,
  Eye,
  ImageIcon,
  Loader2,
  Upload,
  Trash2,
  Link as LinkIcon,
  CheckCircle2,
  AlertCircle,
} from 'lucide-react';
import { useTranslations } from 'next-intl';
import { uploadAccountMedia, CHAT_MEDIA_BUCKET } from '@/lib/storage/upload-media';
import { toast } from 'sonner';

type VariableType = 'static' | 'field' | 'custom_field';

interface VariableMapping {
  type: VariableType;
  value: string;
}

interface Step3Props {
  template: MessageTemplate;
  variables: Record<string, VariableMapping>;
  onUpdate: (variables: Record<string, VariableMapping>) => void;
  /** Media URL for an IMAGE/VIDEO/DOCUMENT header, when the template has one or user attached one. */
  headerMediaUrl: string;
  onHeaderMediaUrlChange: (url: string) => void;
  onNext: () => void;
  onBack: () => void;
}

const MEDIA_HEADER_TYPES = ['image', 'video', 'document'] as const;
type MediaHeaderType = (typeof MEDIA_HEADER_TYPES)[number];

function isMediaHeaderType(value: unknown): value is MediaHeaderType {
  return MEDIA_HEADER_TYPES.includes(value as MediaHeaderType);
}

function isValidHttpUrl(value: string): boolean {
  try {
    const u = new URL(value);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

const contactFields = [
  { value: 'name', labelKey: 'name' },
  { value: 'phone', labelKey: 'phone' },
  { value: 'email', labelKey: 'email' },
];

const SAMPLE_CONTACT: Contact = {
  id: 'sample',
  user_id: '',
  account_id: '',
  name: 'João Silva',
  phone: '+55 11 98888-7777',
  email: 'joao@exemplo.com',
  company: 'Empresa Exemplo',
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
};

export function Step3Personalize({
  template,
  variables,
  onUpdate,
  headerMediaUrl,
  onHeaderMediaUrlChange,
  onNext,
  onBack,
}: Step3Props) {
  const t = useTranslations('Broadcasts.wizard');
  const [customFields, setCustomFields] = useState<CustomField[]>([]);
  const [loadingFields, setLoadingFields] = useState(true);
  const [firstContact, setFirstContact] = useState<Contact | null>(null);
  const [firstContactCustomValues, setFirstContactCustomValues] = useState<
    Map<string, string>
  >(new Map());
  const [loadingPreview, setLoadingPreview] = useState(true);

  // Photo upload state
  const [uploadingPhoto, setUploadingPhoto] = useState(false);
  const [photoMode, setPhotoMode] = useState<'upload' | 'url'>('upload');
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Load user's custom fields + a representative contact for the
  // live preview. Fall back to sample data if no contacts exist yet.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const supabase = createClient();
      const [fieldsRes, contactRes] = await Promise.all([
        supabase.from('custom_fields').select('*').order('field_name'),
        supabase
          .from('contacts')
          .select('*')
          .order('created_at', { ascending: false })
          .limit(1)
          .maybeSingle(),
      ]);
      if (cancelled) return;

      setCustomFields(fieldsRes.data ?? []);
      setLoadingFields(false);

      const contact = contactRes.data ?? null;
      setFirstContact(contact);

      if (contact) {
        const { data: customVals } = await supabase
          .from('contact_custom_values')
          .select('custom_field_id, value')
          .eq('contact_id', contact.id);
        if (!cancelled) {
          const map = new Map<string, string>();
          for (const row of customVals ?? []) {
            map.set(row.custom_field_id, row.value ?? '');
          }
          setFirstContactCustomValues(map);
        }
      }
      setLoadingPreview(false);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const placeholders = useMemo(() => {
    const matches = template.body_text.match(/\{\{(\d+)\}\}/g);
    if (!matches) return [];
    return [...new Set(matches)].sort();
  }, [template.body_text]);

  const mediaHeaderType = isMediaHeaderType(template.header_type)
    ? template.header_type
    : null;

  // Seed with template header_media_url if provided
  useEffect(() => {
    if (!headerMediaUrl && template.header_media_url) {
      onHeaderMediaUrlChange(template.header_media_url);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [template.header_media_url]);

  const headerMediaError = useMemo<'missing' | 'invalid' | null>(() => {
    // If the template strictly requires media (Meta Cloud API template)
    if (mediaHeaderType) {
      const value = headerMediaUrl.trim();
      if (!value) return 'missing';
      if (!isValidHttpUrl(value)) return 'invalid';
      return null;
    }
    // If optional, only check validity if filled
    const value = headerMediaUrl.trim();
    if (value && !isValidHttpUrl(value)) return 'invalid';
    return null;
  }, [mediaHeaderType, headerMediaUrl]);

  const unmappedKeys = useMemo(() => {
    const missing: string[] = [];
    for (const placeholder of placeholders) {
      const key = placeholder.replace(/^\{\{|\}\}$/g, '');
      const mapping = variables[key];
      if (!mapping || !mapping.value?.trim()) {
        missing.push(placeholder);
      }
    }
    return missing;
  }, [placeholders, variables]);

  function updateVariable(key: string, patch: Partial<VariableMapping>) {
    const current = variables[key] ?? { type: 'static' as VariableType, value: '' };
    onUpdate({
      ...variables,
      [key]: { ...current, ...patch },
    });
  }

  // Handle local photo upload
  async function handlePhotoUpload(file: File) {
    if (!file) return;

    if (!file.type.startsWith('image/')) {
      toast.error('Por favor, selecione um arquivo de imagem (PNG, JPG, WEBP).');
      return;
    }

    if (file.size > 10 * 1024 * 1024) {
      toast.error('A imagem não pode ultrapassar 10MB.');
      return;
    }

    setUploadingPhoto(true);
    try {
      let publicUrl: string | null = null;

      // 1. Direct Supabase Storage client-side upload
      try {
        const res = await uploadAccountMedia(CHAT_MEDIA_BUCKET, file);
        if (res?.publicUrl) {
          publicUrl = res.publicUrl;
        }
      } catch (clientErr) {
        console.warn('[BroadcastPhoto] Direct upload fallback:', clientErr);
      }

      // 2. Server-side API route fallback
      if (!publicUrl) {
        const formData = new FormData();
        formData.append('file', file);
        const res = await fetch('/api/whatsapp/media/upload', {
          method: 'POST',
          body: formData,
        });
        const data = await res.json();
        if (data.publicUrl) {
          publicUrl = data.publicUrl;
        } else {
          throw new Error(data.error || 'Falha no upload da foto');
        }
      }

      if (publicUrl) {
        onHeaderMediaUrlChange(publicUrl);
        toast.success('Foto carregada com sucesso!');
      }
    } catch (err: any) {
      console.error('[BroadcastPhoto] Upload error:', err);
      toast.error('Erro ao enviar foto: ' + (err.message || 'Tente novamente'));
    } finally {
      setUploadingPhoto(false);
    }
  }

  const previewText = useMemo(() => {
    const contact = firstContact ?? SAMPLE_CONTACT;
    const customValues = firstContact
      ? firstContactCustomValues
      : new Map<string, string>();

    let text = template.body_text;
    for (const placeholder of placeholders) {
      const key = placeholder.replace(/^\{\{|\}\}$/g, '');
      const mapping = variables[key];
      let replacement = placeholder;

      if (mapping) {
        if (mapping.type === 'static' && mapping.value) {
          replacement = mapping.value;
        } else if (mapping.type === 'field' && mapping.value) {
          const fieldMap: Record<string, string | undefined> = {
            name: contact.name,
            phone: contact.phone,
            email: contact.email,
            company: contact.company,
          };
          replacement = fieldMap[mapping.value] ?? placeholder;
        } else if (mapping.type === 'custom_field' && mapping.value) {
          replacement = customValues.get(mapping.value) || placeholder;
        }
      }
      text = text.replaceAll(placeholder, replacement);
    }
    return text;
  }, [
    template.body_text,
    variables,
    placeholders,
    firstContact,
    firstContactCustomValues,
  ]);

  const previewLabel = firstContact
    ? firstContact.name || firstContact.phone
    : t('personalize.previewSample');

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold text-foreground">{t('personalize.title')}</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {t('personalize.subtitle')}
        </p>
      </div>

      {/* SECÃO DE FOTO / IMAGEM DO DISPARO */}
      <div className="rounded-xl border border-border bg-card/50 p-5 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border/50 pb-3">
          <div className="flex items-center gap-2">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary/10 text-primary">
              <ImageIcon className="h-4 w-4" />
            </div>
            <div>
              <h3 className="text-sm font-semibold text-foreground">
                {mediaHeaderType ? 'Foto / Imagem do Cabeçalho' : 'Foto / Imagem do Disparo'}
              </h3>
              <p className="text-xs text-muted-foreground">
                {mediaHeaderType
                  ? 'Este modelo exige uma imagem no cabeçalho.'
                  : 'Opcional: Anexe uma foto para ser enviada junto com o texto da mensagem.'}
              </p>
            </div>
          </div>
          <span
            className={`inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-medium ${
              mediaHeaderType
                ? 'border border-amber-500/30 bg-amber-500/10 text-amber-300'
                : headerMediaUrl.trim()
                ? 'border border-emerald-500/30 bg-emerald-500/10 text-emerald-400'
                : 'border border-border bg-muted text-muted-foreground'
            }`}
          >
            {mediaHeaderType
              ? 'Obrigatório pelo Modelo'
              : headerMediaUrl.trim()
              ? 'Foto Anexada'
              : 'Opcional'}
          </span>
        </div>

        {/* Alternador de Modo: Upload vs Link */}
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setPhotoMode('upload')}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
              photoMode === 'upload'
                ? 'bg-primary text-primary-foreground shadow-sm'
                : 'bg-muted text-muted-foreground hover:text-foreground'
            }`}
          >
            <Upload className="h-3.5 w-3.5" />
            Upload do Computador / Celular
          </button>
          <button
            type="button"
            onClick={() => setPhotoMode('url')}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
              photoMode === 'url'
                ? 'bg-primary text-primary-foreground shadow-sm'
                : 'bg-muted text-muted-foreground hover:text-foreground'
            }`}
          >
            <LinkIcon className="h-3.5 w-3.5" />
            Inserir Link / URL
          </button>
        </div>

        {photoMode === 'upload' ? (
          <div>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/png,image/jpeg,image/jpg,image/webp"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) handlePhotoUpload(f);
                e.target.value = '';
              }}
            />

            {headerMediaUrl.trim() ? (
              <div className="flex flex-col sm:flex-row items-center gap-4 rounded-xl border border-emerald-500/30 bg-emerald-950/20 p-4">
                <div className="relative h-20 w-20 rounded-lg overflow-hidden bg-black/40 border border-white/10 flex-shrink-0 shadow">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={headerMediaUrl.trim()}
                    alt="Foto do disparo"
                    className="h-full w-full object-cover"
                  />
                </div>
                <div className="flex-1 min-w-0 text-center sm:text-left space-y-1">
                  <p className="text-sm font-medium text-emerald-400 flex items-center justify-center sm:justify-start gap-1.5">
                    <CheckCircle2 className="h-4 w-4" /> Foto anexada e pronta para envio
                  </p>
                  <p className="text-xs text-muted-foreground truncate max-w-md">
                    {headerMediaUrl}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={uploadingPhoto}
                    onClick={() => fileInputRef.current?.click()}
                    className="text-xs border-border text-foreground hover:bg-muted"
                  >
                    Trocar Foto
                  </Button>
                  <Button
                    type="button"
                    variant="destructive"
                    size="sm"
                    disabled={uploadingPhoto}
                    onClick={() => onHeaderMediaUrlChange('')}
                    className="text-xs"
                  >
                    <Trash2 className="h-3.5 w-3.5 mr-1" />
                    Remover
                  </Button>
                </div>
              </div>
            ) : (
              <div
                onClick={() => !uploadingPhoto && fileInputRef.current?.click()}
                onDragOver={(e) => e.preventDefault()}
                onDrop={(e) => {
                  e.preventDefault();
                  const f = e.dataTransfer.files?.[0];
                  if (f) handlePhotoUpload(f);
                }}
                className={`group flex flex-col items-center justify-center rounded-xl border-2 border-dashed border-border/80 bg-muted/20 p-6 text-center cursor-pointer transition-all hover:border-primary/50 hover:bg-muted/40 ${
                  uploadingPhoto ? 'opacity-60 pointer-events-none' : ''
                }`}
              >
                {uploadingPhoto ? (
                  <div className="flex flex-col items-center gap-2 py-2">
                    <Loader2 className="h-8 w-8 animate-spin text-primary" />
                    <p className="text-sm font-medium text-foreground">Enviando foto para o servidor...</p>
                    <p className="text-xs text-muted-foreground">Aguarde o processamento</p>
                  </div>
                ) : (
                  <div className="flex flex-col items-center gap-2">
                    <div className="flex h-12 w-12 items-center justify-center rounded-full bg-primary/10 text-primary transition-transform group-hover:scale-105">
                      <Upload className="h-6 w-6" />
                    </div>
                    <div>
                      <p className="text-sm font-medium text-foreground">
                        Clique aqui ou arraste uma foto para enviar
                      </p>
                      <p className="text-xs text-muted-foreground mt-0.5">
                        Formatos aceitos: JPG, PNG ou WEBP (máx. 10MB)
                      </p>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        ) : (
          <div className="space-y-2">
            <label className="block text-xs font-medium text-muted-foreground">
              Link / URL pública da imagem (https://...)
            </label>
            <div className="flex items-center gap-2">
              <Input
                type="url"
                value={headerMediaUrl}
                onChange={(e) => onHeaderMediaUrlChange(e.target.value)}
                placeholder="https://exemplo.com/sua-imagem.jpg"
                className="border-border bg-muted text-foreground placeholder:text-muted-foreground"
              />
              {headerMediaUrl.trim() && (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => onHeaderMediaUrlChange('')}
                  className="border-border text-muted-foreground hover:text-foreground"
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              )}
            </div>
            {headerMediaUrl.trim() && (
              <div className="mt-2 flex items-center gap-3 rounded-lg border border-border bg-muted/40 p-2">
                <div className="relative h-16 w-16 rounded overflow-hidden bg-black/40 border border-white/10 flex-shrink-0">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={headerMediaUrl.trim()}
                    alt="Preview da URL"
                    className="h-full w-full object-cover"
                    onError={(e) => {
                      (e.target as HTMLElement).style.display = 'none';
                    }}
                  />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="text-xs font-medium text-foreground">Pré-visualização da URL</p>
                  <p className="text-[11px] text-muted-foreground truncate">{headerMediaUrl.trim()}</p>
                </div>
              </div>
            )}
          </div>
        )}

        {headerMediaError && (
          <div className="flex items-center gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-300">
            <AlertCircle className="h-4 w-4 shrink-0 text-amber-400" />
            <p>
              {headerMediaError === 'missing'
                ? 'Uma foto ou URL de mídia é obrigatória para este modelo.'
                : 'Por favor, informe uma URL válida iniciando com http:// ou https://'}
            </p>
          </div>
        )}
      </div>

      {placeholders.length === 0 ? (
        <div className="rounded-xl border border-border bg-card/50 p-6 text-center">
          <p className="text-sm text-muted-foreground">
            {t('personalize.noPreview')}
          </p>
        </div>
      ) : (
        <div className="space-y-4">
          {placeholders.map((placeholder) => {
            const key = placeholder.replace(/^\{\{|\}\}$/g, '');
            const mapping = variables[key] ?? { type: 'static', value: '' };

            return (
              <div
                key={placeholder}
                className="rounded-xl border border-border bg-card/50 p-4"
              >
                <div className="mb-3 flex items-center gap-2">
                  <span className="inline-flex items-center rounded-md bg-primary/10 px-2 py-0.5 text-xs font-mono font-medium text-primary">
                    {placeholder}
                  </span>
                </div>

                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <div>
                    <label className="mb-1.5 block text-xs font-medium text-muted-foreground">
                      {t('personalize.type')}
                    </label>
                    <Select
                      value={mapping.type}
                      onValueChange={(val) =>
                        updateVariable(key, {
                          type: val as VariableType,
                          value: '',
                        })
                      }
                    >
                      <SelectTrigger className="w-full border-border bg-muted text-foreground">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent className="border-border bg-popover">
                        <SelectItem value="static">{t('personalize.typeStatic')}</SelectItem>
                        <SelectItem value="field">{t('personalize.typeContact')}</SelectItem>
                        <SelectItem value="custom_field">
                          {t('personalize.typeCustom')}
                        </SelectItem>
                      </SelectContent>
                    </Select>
                  </div>

                  <div>
                    <label className="mb-1.5 block text-xs font-medium text-muted-foreground">
                      {mapping.type === 'static' ? t('personalize.staticValue') : t('personalize.contactField')}
                    </label>
                    {mapping.type === 'static' ? (
                      <Input
                        value={mapping.value}
                        onChange={(e) =>
                          updateVariable(key, { value: e.target.value })
                        }
                        placeholder="Insira o valor..."
                        className="border-border bg-muted text-foreground placeholder:text-muted-foreground"
                      />
                    ) : mapping.type === 'field' ? (
                      <Select
                        value={mapping.value || undefined}
                        onValueChange={(val) =>
                          updateVariable(key, { value: val || '' })
                        }
                      >
                        <SelectTrigger className="w-full border-border bg-muted text-foreground">
                          <SelectValue placeholder={t('personalize.selectContactField')} />
                        </SelectTrigger>
                        <SelectContent className="border-border bg-popover">
                          {contactFields.map((field) => (
                            <SelectItem key={field.value} value={field.value}>
                              {t(`personalize.fieldMap.${field.labelKey}`)}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    ) : (
                      <Select
                        value={mapping.value || undefined}
                        onValueChange={(val) =>
                          updateVariable(key, { value: val || '' })
                        }
                      >
                        <SelectTrigger className="w-full border-border bg-muted text-foreground">
                          <SelectValue
                            placeholder={
                              loadingFields
                                ? 'Carregando...'
                                : customFields.length === 0
                                  ? 'Nenhum campo personalizado'
                                  : 'Selecione campo...'
                            }
                          />
                        </SelectTrigger>
                        <SelectContent className="border-border bg-popover">
                          {customFields.map((f) => (
                            <SelectItem key={f.id} value={f.id}>
                              {f.field_name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Live Preview estilo WhatsApp */}
      <div className="rounded-xl border border-border bg-card/50 p-4">
        <div className="mb-3 flex items-center gap-2">
          <Eye className="h-4 w-4 text-primary" />
          <p className="text-sm font-medium text-foreground">{t('personalize.preview')}</p>
          <span className="text-xs text-muted-foreground">({previewLabel})</span>
          {loadingPreview && (
            <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" />
          )}
        </div>
        <div className="rounded-lg bg-[#0e1a12] p-3">
          <div className="ml-auto max-w-[85%] rounded-lg bg-primary/30 overflow-hidden shadow-sm border border-emerald-500/10">
            {headerMediaUrl && headerMediaUrl.trim() && (
              <div className="relative w-full aspect-video max-h-52 bg-black/50 overflow-hidden border-b border-white/10">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={headerMediaUrl.trim()}
                  alt="Foto da mensagem"
                  className="h-full w-full object-cover"
                  onError={(e) => {
                    (e.target as HTMLElement).style.display = 'none';
                  }}
                />
              </div>
            )}
            <div className="px-3 py-2">
              <p className="whitespace-pre-wrap text-sm text-primary">
                {previewText}
              </p>
            </div>
          </div>
        </div>
      </div>

      {unmappedKeys.length > 0 && (
        <div className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-300">
          Mapeie todos os campos antes de continuar — ainda restam{' '}
          <span className="font-mono font-semibold">
            {unmappedKeys.join(', ')}
          </span>
          .
        </div>
      )}

      <div className="flex items-center justify-between border-t border-border pt-4">
        <Button
          variant="outline"
          onClick={onBack}
          className="border-border text-muted-foreground"
        >
          <ArrowLeft className="h-4 w-4 mr-2" />
          {t('back')}
        </Button>
        <Button
          onClick={onNext}
          disabled={unmappedKeys.length > 0 || headerMediaError !== null || uploadingPhoto}
          className="bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
        >
          {t('next')}
          <ArrowRight className="h-4 w-4 ml-2" />
        </Button>
      </div>
    </div>
  );
}
