'use client';

import { useEffect, useState, useRef } from 'react';
import { createClient } from '@/lib/supabase/client';
import { MessageTemplate } from '@/types';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Loader2,
  FileText,
  ArrowRight,
  Edit3,
  Plus,
  Sparkles,
  Layers,
  Check,
  MessageSquare,
  Eye,
  Info,
  ImageIcon,
  Upload,
  Trash2,
  Link as LinkIcon,
  CheckCircle2,
} from 'lucide-react';
import { uploadAccountMedia, CHAT_MEDIA_BUCKET } from '@/lib/storage/upload-media';
import { toast } from 'sonner';
import { useTranslations } from 'next-intl';

const categoryColors: Record<string, string> = {
  Marketing: 'bg-purple-500/10 text-purple-400 border-purple-500/20',
  Utility: 'bg-blue-500/10 text-blue-400 border-blue-500/20',
  Authentication: 'bg-orange-500/10 text-orange-400 border-orange-500/20',
};

interface Step1Props {
  selectedTemplate: MessageTemplate | null;
  onSelect: (template: MessageTemplate) => void;
  onNext: () => void;
  onBack: () => void;
}

const DEFAULT_BROADCAST_TEMPLATES: MessageTemplate[] = [
  {
    id: 'default-promocao',
    name: 'promocao_exclusiva',
    category: 'Marketing',
    language: 'pt_BR',
    body_text: 'Olá {{1}}, preparamos uma condição especial exclusiva para você hoje! Responda esta mensagem para saber mais.',
    variations: [
      'Olá {{1}}, preparamos uma condição especial exclusiva para você hoje! Responda esta mensagem para saber mais.',
      'Oi {{1}}, tudo bem? Temos uma novidade incrível reservada especialmente para você hoje! Dá uma olhada e nos avise.',
      'Tudo bem, {{1}}? Passando para te avisar que liberamos benefícios especiais na sua conta hoje. Responda para conferir!',
      'Fala {{1}}, como você está? Não perca a oportunidade exclusiva que separamos para você esta semana. Chame nossa equipe aqui!',
    ],
    status: 'APPROVED',
    created_at: new Date().toISOString(),
    
    buttons: [],
    sample_values: { body: ['Cliente'] },
  } as unknown as MessageTemplate,
  {
    id: 'default-lembrete',
    name: 'lembrete_importante',
    category: 'Utility',
    language: 'pt_BR',
    body_text: 'Olá {{1}}, este é um lembrete importante sobre o seu atendimento. Qualquer dúvida nossa equipe está à disposição.',
    variations: [
      'Olá {{1}}, este é um lembrete importante sobre o seu atendimento. Qualquer dúvida nossa equipe está à disposição.',
      'Oi {{1}}! Passando apenas para te lembrar do seu atendimento em andamento. Estamos prontos para te ajudar.',
      'Prezado(a) {{1}}, lembramos que estamos acompanhando sua solicitação. Se precisar de algo, basta responder aqui.',
      'Olá {{1}}, tudo certo? Um rápido lembrete sobre sua conta. Caso tenha qualquer dúvida, responda por este canal.',
    ],
    status: 'APPROVED',
    created_at: new Date().toISOString(),
    
    buttons: [],
    sample_values: { body: ['Cliente'] },
  } as unknown as MessageTemplate,
  {
    id: 'default-atendimento',
    name: 'contato_suporte',
    category: 'Utility',
    language: 'pt_BR',
    body_text: 'Olá {{1}}! Como podemos ajudar você hoje? Nossa equipe está pronta para te atender.',
    variations: [
      'Olá {{1}}! Como podemos ajudar você hoje? Nossa equipe está pronta para te atender.',
      'Oi {{1}}, tudo ótimo? Estamos aqui para esclarecer qualquer dúvida ou te apoiar no que precisar agora.',
      'Tudo bem, {{1}}? Se precisar de suporte ou alguma informação rápida, nos avise por aqui!',
      'Olá {{1}}, passando para saber como estão as coisas e se você precisa de algum auxílio no momento.',
    ],
    status: 'APPROVED',
    created_at: new Date().toISOString(),
    
    buttons: [],
    sample_values: { body: ['Cliente'] },
  } as unknown as MessageTemplate,
];

export function Step1ChooseTemplate({ selectedTemplate, onSelect, onNext, onBack }: Step1Props) {
  const t = useTranslations('Broadcasts.wizard');
  const [templates, setTemplates] = useState<MessageTemplate[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Editor Modal State
  const [editorOpen, setEditorOpen] = useState(false);
  const [editingTemplate, setEditingTemplate] = useState<MessageTemplate | null>(null);
  const [editName, setEditName] = useState('');
  const [editCategory, setEditCategory] = useState<'Marketing' | 'Utility'>('Marketing');
  const [editHeader, setEditHeader] = useState('');
  const [editFooter, setEditFooter] = useState('');
  const [activeVarTab, setActiveVarTab] = useState<number>(0); // 0, 1, 2, 3
  const [varTexts, setVarTexts] = useState<string[]>(['', '', '', '']);
  const [savingTemplate, setSavingTemplate] = useState(false);

  // Template Photo state
  const [editMediaUrl, setEditMediaUrl] = useState('');
  const [uploadingTemplatePhoto, setUploadingTemplatePhoto] = useState(false);
  const [templatePhotoMode, setTemplatePhotoMode] = useState<'upload' | 'url'>('upload');
  const templateFileInputRef = useRef<HTMLInputElement>(null);

  async function handleTemplatePhotoUpload(file: File) {
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      toast.error('Selecione um arquivo de imagem (PNG, JPG, WEBP).');
      return;
    }
    if (file.size > 10 * 1024 * 1024) {
      toast.error('A imagem não pode ultrapassar 10MB.');
      return;
    }

    setUploadingTemplatePhoto(true);
    try {
      let publicUrl: string | null = null;
      try {
        const res = await uploadAccountMedia(CHAT_MEDIA_BUCKET, file);
        if (res?.publicUrl) publicUrl = res.publicUrl;
      } catch (clientErr) {
        console.warn('[TemplatePhoto] Direct upload fallback:', clientErr);
      }

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
        setEditMediaUrl(publicUrl);
        toast.success('Foto do template anexada com sucesso!');
      }
    } catch (err: any) {
      console.error('[TemplatePhoto] Error:', err);
      toast.error('Erro no upload: ' + (err.message || 'Tente novamente'));
    } finally {
      setUploadingTemplatePhoto(false);
    }
  }

  // Quick preview tab inside template cards
  const [previewVarMap, setPreviewVarMap] = useState<Record<string, number>>({});

  useEffect(() => {
    async function fetchTemplates() {
      try {
        const res = await fetch('/api/whatsapp/templates');
        if (res.ok) {
          const json = await res.json();
          if (Array.isArray(json.templates) && json.templates.length > 0) {
            setTemplates(json.templates);
            if (!selectedTemplate) {
              onSelect(json.templates[0]);
            }
            return;
          }
        }
        // Fallback to supabase direct
        const supabase = createClient();
        const { data } = await supabase
          .from('message_templates')
          .select('*')
          .in('status', ['APPROVED', 'DRAFT'])
          .order('created_at', { ascending: false });

        const loaded = data && data.length > 0 ? (data as MessageTemplate[]) : DEFAULT_BROADCAST_TEMPLATES;
        setTemplates(loaded);
        if (!selectedTemplate && loaded.length > 0) {
          onSelect(loaded[0]);
        }
      } catch (err) {
        setTemplates(DEFAULT_BROADCAST_TEMPLATES);
        if (!selectedTemplate) {
          onSelect(DEFAULT_BROADCAST_TEMPLATES[0]);
        }
      } finally {
        setLoading(false);
      }
    }

    fetchTemplates();
  }, []);

  function handleOpenEditor(tpl?: MessageTemplate) {
    if (tpl) {
      setEditingTemplate(tpl);
      setEditName(tpl.name || '');
      setEditCategory((tpl.category as any) || 'Marketing');
      setEditHeader(tpl.header_content || '');
      setEditFooter(tpl.footer_text || '');
      setEditMediaUrl(tpl.header_media_url || '');

      // Load up to 4 variations (Var 1 is main body, Vars 2, 3, 4 are alternative options)
      const existingVars = Array.isArray(tpl.variations) && tpl.variations.length > 0
        ? tpl.variations
        : [tpl.body_text || ''];

      const v0 = existingVars[0] || tpl.body_text || '';
      const v1 = existingVars[1] || '';
      const v2 = existingVars[2] || '';
      const v3 = existingVars[3] || '';

      setVarTexts([v0, v1, v2, v3]);
    } else {
      // New template
      setEditingTemplate(null);
      setEditName('meu_novo_template');
      setEditCategory('Marketing');
      setEditHeader('');
      setEditFooter('');
      setEditMediaUrl('');
      setVarTexts([
        'Olá {{1}}, temos uma ótima novidade para você!',
        'Oi {{1}}, tudo bem? Passando para te trazer uma oportunidade especial!',
        'Tudo bem, {{1}}? Confira as novidades exclusivas que preparamos.',
        'Fala {{1}}, como você está? Não perca os benefícios liberados para você.',
      ]);
    }
    setActiveVarTab(0);
    setEditorOpen(true);
  }

  async function handleSaveTemplate() {
    if (!editName.trim()) {
      toast.error('Informe um nome para o template.');
      return;
    }
    const mainBody = varTexts[0].trim();
    if (!mainBody) {
      toast.error('A Variação 1 (Principal) não pode ficar em branco.');
      return;
    }

    // Filter non-empty variations
    const cleanedVariations = varTexts.map((v) => v.trim()).filter((v) => v.length > 0);

    setSavingTemplate(true);
    try {
      const templatePayload = {
        id: editingTemplate?.id,
        name: editName.trim(),
        category: editCategory,
        language: 'pt_BR',
        body_text: mainBody,
        variations: cleanedVariations,
        header_content: editHeader.trim() || undefined,
        header_type: editMediaUrl.trim() ? 'image' : (editHeader.trim() ? 'text' : undefined),
        header_media_url: editMediaUrl.trim() || undefined,
        footer_text: editFooter.trim() || undefined,
      };

      const res = await fetch('/api/whatsapp/templates', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(templatePayload),
      });

      const resData = await res.json().catch(() => ({}));
      if (!res.ok || !resData.success) {
        throw new Error(resData.error || 'Falha ao salvar template no servidor.');
      }

      const savedTemplate = resData.template as MessageTemplate;

      setTemplates((prev) => {
        const exists = prev.some((t) => t.id === savedTemplate.id || t.name === savedTemplate.name);
        if (exists) {
          return prev.map((t) =>
            t.id === savedTemplate.id || t.name === savedTemplate.name ? savedTemplate : t
          );
        }
        return [savedTemplate, ...prev];
      });

      onSelect(savedTemplate);
      toast.success(
        cleanedVariations.length > 1
          ? `Template salvo com ${cleanedVariations.length} variações ativas!`
          : 'Template salvo com sucesso!'
      );
      setEditorOpen(false);
    } catch (err) {
      console.error('Error saving template:', err);
      const msg = err instanceof Error ? err.message : 'Erro ao salvar template.';
      toast.error(msg);
    } finally {
      setSavingTemplate(false);
    }
  }

  function insertVariableInActiveTab(varTag: string) {
    const current = varTexts[activeVarTab] || '';
    const updated = current + (current.endsWith(' ') ? '' : ' ') + varTag;
    const newVars = [...varTexts];
    newVars[activeVarTab] = updated;
    setVarTexts(newVars);
  }

  if (loading) {
    return (
      <div className="flex h-64 items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-primary" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex h-64 flex-col items-center justify-center gap-2">
        <p className="text-sm text-red-400">{error}</p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-foreground">Escolha ou Edite o Template</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Selecione o modelo de mensagem e configure até 4 variações rotativas para proteção antispam.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {selectedTemplate && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => handleOpenEditor(selectedTemplate)}
              className="border-primary/40 text-primary hover:bg-primary/10"
            >
              <Edit3 className="h-4 w-4 mr-1.5" />
              Editar Template & Variações
            </Button>
          )}
          <Button
            size="sm"
            onClick={() => handleOpenEditor()}
            className="bg-primary text-primary-foreground hover:bg-primary/90"
          >
            <Plus className="h-4 w-4 mr-1.5" />
            Novo Template
          </Button>
        </div>
      </div>

      {templates.length === 0 ? (
        <div className="flex h-48 flex-col items-center justify-center rounded-xl border border-border bg-card/50">
          <FileText className="mb-2 h-8 w-8 text-muted-foreground" />
          <p className="text-sm text-muted-foreground">Nenhum template encontrado.</p>
          <Button size="sm" onClick={() => handleOpenEditor()} className="mt-3">
            <Plus className="h-4 w-4 mr-1.5" />
            Criar Primeiro Template
          </Button>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {templates.map((template) => {
            const isSelected = selectedTemplate?.id === template.id;
            const catColor = categoryColors[template.category] ?? categoryColors.Utility;

            const tplVariations = Array.isArray(template.variations) && template.variations.length > 0
              ? template.variations
              : [template.body_text];

            const previewIdx = previewVarMap[template.id] ?? 0;
            const currentPreviewText = tplVariations[previewIdx] || template.body_text;
            const hasPhoto = Boolean(template.header_media_url && template.header_media_url.trim());

            return (
              <div
                key={template.id}
                onClick={() => onSelect(template)}
                className={`flex flex-col justify-between rounded-xl border p-4 text-left transition-all cursor-pointer relative ${
                  isSelected
                    ? 'border-primary bg-primary/5 ring-2 ring-primary/40 shadow-sm'
                    : 'border-border bg-card/60 hover:border-border hover:bg-card'
                }`}
              >
                <div className="space-y-3">
                  {hasPhoto && (
                    <div className="relative w-full aspect-video max-h-36 rounded-lg overflow-hidden bg-black/40 border border-white/10 mb-2">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={template.header_media_url!}
                        alt={template.name}
                        className="h-full w-full object-cover"
                      />
                      <span className="absolute top-2 right-2 rounded-md bg-black/75 backdrop-blur-sm px-2 py-0.5 text-[10px] font-medium text-emerald-400 flex items-center gap-1 border border-emerald-500/30">
                        <ImageIcon className="h-3 w-3" /> Foto Anexada
                      </span>
                    </div>
                  )}
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex items-center gap-1.5">
                      <h3 className="text-sm font-semibold text-foreground truncate max-w-[180px]">
                        {template.name}
                      </h3>
                      {isSelected && (
                        <span className="flex h-5 w-5 items-center justify-center rounded-full bg-primary text-primary-foreground">
                          <Check className="h-3 w-3" />
                        </span>
                      )}
                    </div>
                    <span
                      className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-medium ${catColor}`}
                    >
                      {template.category}
                    </span>
                  </div>

                  {/* Variation badge if multiple variations exist */}
                  {tplVariations.length > 1 ? (
                    <div className="flex items-center justify-between gap-1 rounded-md border border-purple-500/20 bg-purple-500/10 px-2 py-1 text-[11px] text-purple-300">
                      <span className="flex items-center gap-1 font-medium">
                        <Sparkles className="h-3 w-3 text-purple-400" />
                        {tplVariations.length} Variações Ativas (Rotação)
                      </span>
                      <div className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
                        {tplVariations.map((_, vIdx) => (
                          <button
                            key={vIdx}
                            type="button"
                            onClick={() =>
                              setPreviewVarMap((prev) => ({ ...prev, [template.id]: vIdx }))
                            }
                            className={`h-4 w-4 rounded text-[9px] font-bold flex items-center justify-center transition-colors ${
                              previewIdx === vIdx
                                ? 'bg-purple-600 text-white'
                                : 'bg-muted/60 text-muted-foreground hover:bg-muted'
                            }`}
                          >
                            {vIdx + 1}
                          </button>
                        ))}
                      </div>
                    </div>
                  ) : (
                    <div className="text-[11px] text-muted-foreground/80 flex items-center gap-1">
                      <Layers className="h-3 w-3" /> 1 variação de texto
                    </div>
                  )}

                  {/* Preview WhatsApp Bubble */}
                  <div className="rounded-lg border border-border/80 bg-muted/40 p-3 text-xs">
                    {template.header_content && (
                      <p className="font-semibold text-foreground mb-1 text-[11px]">
                        {template.header_content}
                      </p>
                    )}
                    <p className="line-clamp-4 text-foreground/90 leading-relaxed whitespace-pre-wrap">
                      {currentPreviewText}
                    </p>
                    {template.footer_text && (
                      <p className="text-[10px] text-muted-foreground/80 mt-1 italic">
                        {template.footer_text}
                      </p>
                    )}
                  </div>
                </div>

                <div className="flex items-center justify-between border-t border-border/60 pt-3 mt-3 text-[11px] text-muted-foreground">
                  <span>{template.language ?? 'pt_BR'}</span>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={(e) => {
                      e.stopPropagation();
                      handleOpenEditor(template);
                    }}
                    className="h-7 px-2 text-primary hover:text-primary hover:bg-primary/10 text-xs"
                  >
                    <Edit3 className="h-3.5 w-3.5 mr-1" />
                    Editar
                  </Button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Navigation Footer */}
      <div className="flex items-center justify-between border-t border-border pt-4">
        <Button variant="outline" onClick={onBack} className="border-border text-muted-foreground">
          {t('back')}
        </Button>
        <Button
          onClick={onNext}
          disabled={!selectedTemplate}
          className="bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
        >
          {t('next')}
          <ArrowRight className="h-4 w-4 ml-1.5" />
        </Button>
      </div>

      {/* TEMPLATE & 3-VARIATIONS FULL EDITOR MODAL */}
      <Dialog open={editorOpen} onOpenChange={setEditorOpen}>
        <DialogContent className="border-border bg-popover sm:max-w-3xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="text-popover-foreground flex items-center gap-2">
              <Edit3 className="h-5 w-5 text-primary" />
              {editingTemplate ? 'Editar Template & Variações' : 'Criar Novo Template'}
            </DialogTitle>
            <DialogDescription className="text-muted-foreground">
              Configure o texto principal e até 3 variações alternativas. O motor de envio alternará automaticamente entre elas para cada contato disparado.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-2">
            {/* Header info: Name & Category */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="mb-1 block text-xs font-medium text-foreground">
                  Identificador / Nome do Template
                </label>
                <Input
                  value={editName}
                  onChange={(e) => setEditName(e.target.value)}
                  placeholder="ex: promocao_exclusiva"
                  className="border-border bg-card text-sm"
                />
              </div>
              <div>
                <label className="mb-1 block text-xs font-medium text-foreground">
                  Categoria
                </label>
                <select
                  value={editCategory}
                  onChange={(e) => setEditCategory(e.target.value as any)}
                  className="h-10 w-full rounded-md border border-border bg-card px-3 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary"
                >
                  <option value="Marketing">Marketing</option>
                  <option value="Utility">Utilidade (Utility)</option>
                </select>
              </div>
            </div>

            {/* Cabeçalho opcional */}
            <div>
              <label className="mb-1 block text-xs font-medium text-foreground">
                Título do Cabeçalho (Opcional)
              </label>
              <Input
                value={editHeader}
                onChange={(e) => setEditHeader(e.target.value)}
                placeholder="Ex: 📢 SUPER OFERTA DO DIA"
                className="border-border bg-card text-sm"
              />
            </div>

            {/* Foto / Imagem do Template (Opcional) */}
            <div className="rounded-xl border border-border/80 bg-card/60 p-4 space-y-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <ImageIcon className="h-4 w-4 text-primary" />
                  <span className="text-xs font-semibold text-foreground">
                    Foto / Imagem do Template (Opcional)
                  </span>
                </div>
                {editMediaUrl.trim() && (
                  <span className="inline-flex items-center gap-1 text-[11px] font-medium text-emerald-400 bg-emerald-500/10 border border-emerald-500/20 px-2 py-0.5 rounded-full">
                    <CheckCircle2 className="h-3 w-3" /> Foto anexada
                  </span>
                )}
              </div>

              {/* Mode Selector: Upload do Computador vs URL Direta */}
              <div className="flex items-center gap-2 border-b border-border/50 pb-2">
                <button
                  type="button"
                  onClick={() => setTemplatePhotoMode('upload')}
                  className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg transition-all ${
                    templatePhotoMode === 'upload'
                      ? 'bg-primary/15 text-primary border border-primary/30'
                      : 'text-muted-foreground hover:text-foreground hover:bg-muted/50'
                  }`}
                >
                  <Upload className="h-3.5 w-3.5" />
                  Enviar do Computador
                </button>
                <button
                  type="button"
                  onClick={() => setTemplatePhotoMode('url')}
                  className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg transition-all ${
                    templatePhotoMode === 'url'
                      ? 'bg-primary/15 text-primary border border-primary/30'
                      : 'text-muted-foreground hover:text-foreground hover:bg-muted/50'
                  }`}
                >
                  <LinkIcon className="h-3.5 w-3.5" />
                  Inserir Link / URL
                </button>
              </div>

              <input
                ref={templateFileInputRef}
                type="file"
                accept="image/*"
                className="hidden"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) {
                    handleTemplatePhotoUpload(file);
                    e.target.value = '';
                  }
                }}
              />

              {templatePhotoMode === 'upload' ? (
                <div className="space-y-3">
                  {editMediaUrl.trim() ? (
                    <div className="flex items-center gap-3 rounded-lg border border-emerald-500/30 bg-emerald-950/20 p-3">
                      <div className="relative h-14 w-14 rounded-md overflow-hidden bg-black/40 border border-white/10 shrink-0">
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img
                          src={editMediaUrl.trim()}
                          alt="Foto anexada"
                          className="h-full w-full object-cover"
                        />
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className="text-xs font-medium text-foreground flex items-center gap-1">
                          <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400" />
                          Foto anexada com sucesso
                        </p>
                        <p className="text-[11px] text-muted-foreground truncate">
                          {editMediaUrl}
                        </p>
                      </div>
                      <div className="flex items-center gap-2">
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          disabled={uploadingTemplatePhoto}
                          onClick={() => templateFileInputRef.current?.click()}
                          className="h-8 text-xs border-border"
                        >
                          <Upload className="h-3.5 w-3.5 mr-1" />
                          Trocar
                        </Button>
                        <Button
                          type="button"
                          variant="destructive"
                          size="sm"
                          disabled={uploadingTemplatePhoto}
                          onClick={() => setEditMediaUrl('')}
                          className="h-8 text-xs"
                        >
                          <Trash2 className="h-3.5 w-3.5 mr-1" />
                          Remover
                        </Button>
                      </div>
                    </div>
                  ) : (
                    <div
                      onClick={() => !uploadingTemplatePhoto && templateFileInputRef.current?.click()}
                      className={`flex flex-col items-center justify-center rounded-lg border-2 border-dashed border-border/80 bg-muted/20 p-5 text-center cursor-pointer transition-colors hover:border-primary/50 hover:bg-muted/40 ${
                        uploadingTemplatePhoto ? 'opacity-60 cursor-not-allowed' : ''
                      }`}
                    >
                      {uploadingTemplatePhoto ? (
                        <div className="flex flex-col items-center gap-2 text-primary">
                          <Loader2 className="h-7 w-7 animate-spin" />
                          <span className="text-xs font-medium">Enviando foto para o servidor...</span>
                        </div>
                      ) : (
                        <div className="flex flex-col items-center gap-1.5 text-muted-foreground">
                          <div className="flex h-10 w-10 items-center justify-center rounded-full bg-primary/10 text-primary mb-1">
                            <Upload className="h-5 w-5" />
                          </div>
                          <p className="text-xs font-medium text-foreground">
                            Clique aqui para selecionar uma foto do seu computador
                          </p>
                          <p className="text-[11px] text-muted-foreground">
                            Formatos suportados: PNG, JPG, JPEG, WEBP (até 10MB)
                          </p>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              ) : (
                <div className="space-y-2">
                  <div className="flex items-center gap-2">
                    <Input
                      type="url"
                      value={editMediaUrl}
                      onChange={(e) => setEditMediaUrl(e.target.value)}
                      placeholder="https://exemplo.com/sua-imagem.jpg"
                      className="border-border bg-card text-xs placeholder:text-muted-foreground"
                    />
                    {editMediaUrl.trim() && (
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => setEditMediaUrl('')}
                        className="text-xs text-muted-foreground hover:text-foreground shrink-0"
                      >
                        Limpar
                      </Button>
                    )}
                  </div>
                  <p className="text-[11px] text-muted-foreground">
                    Cole uma URL pública acessível de uma imagem.
                  </p>
                </div>
              )}
            </div>

            {/* SEÇÃO DE VARIAÇÕES DE TEXTO (4 ABAS) */}
            <div className="rounded-xl border border-purple-500/30 bg-purple-950/10 p-4 space-y-3">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 border-b border-border/60 pb-2">
                <div className="flex items-center gap-2">
                  <Sparkles className="h-4 w-4 text-purple-400" />
                  <span className="text-xs font-semibold text-foreground">
                    Variações de Texto do Template (Rotação Antispam)
                  </span>
                </div>
                <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <span>Variáveis:</span>
                  <button
                    type="button"
                    onClick={() => insertVariableInActiveTab('{{1}}')}
                    className="rounded bg-muted px-2 py-0.5 text-[11px] font-mono text-primary hover:bg-muted/80"
                  >
                    + {'{{1}}'} (Nome)
                  </button>
                  <button
                    type="button"
                    onClick={() => insertVariableInActiveTab('{{2}}')}
                    className="rounded bg-muted px-2 py-0.5 text-[11px] font-mono text-primary hover:bg-muted/80"
                  >
                    + {'{{2}}'}
                  </button>
                </div>
              </div>

              {/* 4 Tabs Selector */}
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                {[
                  { label: 'Variação 1 (Principal)', idx: 0, required: true },
                  { label: 'Variação 2', idx: 1, required: false },
                  { label: 'Variação 3', idx: 2, required: false },
                  { label: 'Variação 4', idx: 3, required: false },
                ].map((tab) => {
                  const hasContent = varTexts[tab.idx]?.trim().length > 0;
                  const isActive = activeVarTab === tab.idx;
                  return (
                    <button
                      key={tab.idx}
                      type="button"
                      onClick={() => setActiveVarTab(tab.idx)}
                      className={`flex flex-col items-start p-2 rounded-lg border text-left transition-all text-xs ${
                        isActive
                          ? 'border-purple-500 bg-purple-500/20 text-foreground font-semibold shadow-sm'
                          : hasContent
                            ? 'border-border bg-card/80 text-foreground hover:bg-card'
                            : 'border-dashed border-border/70 bg-card/40 text-muted-foreground hover:bg-card'
                      }`}
                    >
                      <div className="flex items-center justify-between w-full">
                        <span>{tab.label}</span>
                        {hasContent && (
                          <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
                        )}
                      </div>
                      <span className="text-[10px] text-muted-foreground/80 mt-0.5 font-normal">
                        {hasContent ? `${varTexts[tab.idx].length} caracteres` : '(Opcional)'}
                      </span>
                    </button>
                  );
                })}
              </div>

              {/* Active Tab Textarea */}
              <div className="space-y-1.5 pt-1">
                <div className="flex items-center justify-between text-xs">
                  <label className="font-medium text-foreground">
                    Texto da {activeVarTab === 0 ? 'Variação 1 (Principal)' : `Variação ${activeVarTab + 1}`}
                  </label>
                  <span className="text-muted-foreground text-[11px]">
                    {varTexts[activeVarTab]?.length || 0} caracteres
                  </span>
                </div>
                <Textarea
                  rows={4}
                  value={varTexts[activeVarTab]}
                  onChange={(e) => {
                    const newVars = [...varTexts];
                    newVars[activeVarTab] = e.target.value;
                    setVarTexts(newVars);
                  }}
                  placeholder={
                    activeVarTab === 0
                      ? 'Digite a mensagem principal da campanha... Ex: Olá {{1}}, preparamos uma oferta incrível!'
                      : `Digite a variação alternativa ${activeVarTab + 1}... Ex: Oi {{1}}, tudo bem? Temos uma novidade incrível para você hoje!`
                  }
                  className="border-border bg-card text-sm leading-relaxed"
                />
              </div>

              {/* Informative alert */}
              <div className="flex items-center gap-2 rounded-lg border border-border/80 bg-muted/30 p-2.5 text-xs text-muted-foreground">
                <Info className="h-4 w-4 text-purple-400 shrink-0" />
                <span>
                  Cada contato disparado na fila receberá uma das variações de forma alternada (1, 2, 3, 4...).
                  Variações que ficarem em branco serão automaticamente desconsideradas na rotação.
                </span>
              </div>
            </div>

            {/* Rodapé opcional */}
            <div>
              <label className="mb-1 block text-xs font-medium text-foreground">
                Texto do Rodapé (Opcional)
              </label>
              <Input
                value={editFooter}
                onChange={(e) => setEditFooter(e.target.value)}
                placeholder="Ex: Responda 'SAIR' para descadastrar"
                className="border-border bg-card text-sm"
              />
            </div>

            {/* Live WhatsApp Preview */}
            <div className="rounded-xl border border-border bg-card/60 p-4 space-y-2">
              <p className="text-xs font-medium text-foreground flex items-center gap-1.5">
                <Eye className="h-3.5 w-3.5 text-primary" />
                Prévia da Variação Selecionada no WhatsApp:
              </p>
              <div className="max-w-sm rounded-lg border border-border bg-emerald-950/20 overflow-hidden text-xs shadow-sm">
                {editMediaUrl.trim() && (
                  <div className="relative w-full aspect-video max-h-36 bg-black/40 border-b border-white/10">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={editMediaUrl.trim()} alt="Preview" className="h-full w-full object-cover" />
                  </div>
                )}
                <div className="p-3">
                {editHeader.trim() && (
                  <p className="font-bold text-foreground mb-1 text-xs">{editHeader}</p>
                )}
                <p className="text-foreground/95 whitespace-pre-wrap leading-relaxed">
                  {varTexts[activeVarTab]
                    ? varTexts[activeVarTab].replaceAll('{{1}}', 'João Silva').replaceAll('{{2}}', 'R$ 99,00')
                    : 'Aguardando texto da variação...'}
                </p>
                {editFooter.trim() && (
                  <p className="text-[10px] text-muted-foreground/80 mt-1.5 italic">
                    {editFooter}
                  </p>
                )}
                <span className="text-[9px] text-muted-foreground/60 block text-right mt-1">16:45 ✓✓</span>
                </div>
              </div>
            </div>
          </div>

          <DialogFooter className="gap-2 sm:gap-0">
            <Button
              variant="outline"
              onClick={() => setEditorOpen(false)}
              className="border-border text-muted-foreground"
            >
              Cancelar
            </Button>
            <Button
              onClick={handleSaveTemplate}
              disabled={savingTemplate || !editName.trim() || !varTexts[0].trim()}
              className="bg-primary text-primary-foreground hover:bg-primary/90"
            >
              {savingTemplate ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
              Salvar Template & Variações
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
