'use client';

import { useState, useEffect } from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { Badge } from '@/components/ui/badge';
import {
  Trash2,
  Type,
  Image as ImageIcon,
  Square,
  Circle,
  Eye,
  Loader2,
  Sparkles,
} from 'lucide-react';
import type {
  CreativeTemplate,
  TemplateDefinition,
  CreativeElement,
  CreativeElementType,
} from '@/lib/creative-engine/types';
import { PreviewModal } from './preview-modal';

interface TemplateModalProps {
  template: CreativeTemplate | null;
  isOpen: boolean;
  onClose: () => void;
  onSaved: () => void;
}

const DEFAULT_DEFINITION: TemplateDefinition = {
  width: 1080,
  height: 1080,
  background: '#0f172a',
  elements: [
    {
      id: 'header_bg',
      type: 'ROUNDED_RECTANGLE',
      x: 60,
      y: 60,
      width: 960,
      height: 960,
      borderRadius: 24,
      fill: '#1e293b',
      stroke: '#334155',
      strokeWidth: 2,
    },
    {
      id: 'title_text',
      type: 'TEXT',
      x: 100,
      y: 120,
      width: 880,
      height: 60,
      text: '{{title | uppercase | default("Notificação Oficial")}}',
      fontSize: 38,
      fontWeight: 'bold',
      color: '#38bdf8',
      alignment: 'left',
    },
    {
      id: 'client_name',
      type: 'TEXT',
      x: 100,
      y: 220,
      width: 880,
      height: 40,
      text: 'Destinatário: {{name | capitalize}}',
      fontSize: 32,
      fontWeight: 'normal',
      color: '#f8fafc',
      alignment: 'left',
    },
    {
      id: 'code_box',
      type: 'ROUNDED_RECTANGLE',
      x: 100,
      y: 300,
      width: 880,
      height: 140,
      borderRadius: 16,
      fill: '#0284c7',
      opacity: 0.9,
    },
    {
      id: 'code_text',
      type: 'TEXT',
      x: 140,
      y: 345,
      width: 800,
      height: 50,
      text: 'Código: #{{code}}',
      fontSize: 36,
      fontWeight: 'bold',
      color: '#ffffff',
      alignment: 'left',
    },
    {
      id: 'amount_text',
      type: 'TEXT',
      x: 100,
      y: 500,
      width: 880,
      height: 50,
      text: 'Valor: {{amount | currency}}',
      fontSize: 36,
      fontWeight: '600',
      color: '#4ade80',
      alignment: 'left',
    },
    {
      id: 'footer_tag',
      type: 'TEXT',
      x: 100,
      y: 920,
      width: 880,
      height: 40,
      text: 'Automação Visual Determinística • {{date | date}}',
      fontSize: 22,
      fontWeight: '300',
      color: '#94a3b8',
      alignment: 'center',
    },
  ],
};

export function TemplateModal({
  template,
  isOpen,
  onClose,
  onSaved,
}: TemplateModalProps) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [category, setCategory] = useState('general');
  const [definition, setDefinition] = useState<TemplateDefinition>(DEFAULT_DEFINITION);
  const [jsonText, setJsonText] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<'elements' | 'json' | 'canvas'>('elements');

  // Preview state
  const [showPreview, setShowPreview] = useState(false);

  useEffect(() => {
    if (template) {
      setName(template.name);
      setDescription(template.description || '');
      setCategory(template.category);
      setDefinition(template.definition || DEFAULT_DEFINITION);
      setJsonText(JSON.stringify(template.definition || DEFAULT_DEFINITION, null, 2));
    } else {
      setName('Novo Template de Criativo');
      setDescription('');
      setCategory('general');
      setDefinition(DEFAULT_DEFINITION);
      setJsonText(JSON.stringify(DEFAULT_DEFINITION, null, 2));
    }
    setError(null);
  }, [template, isOpen]);

  const handleJsonChange = (val: string) => {
    setJsonText(val);
    try {
      const parsed = JSON.parse(val);
      if (parsed && typeof parsed === 'object') {
        setDefinition(parsed);
        setError(null);
      }
    } catch {
      setError('JSON de definição possui erro de sintaxe');
    }
  };

  const handleSave = async (publishNewVersion = false) => {
    if (!name.trim()) {
      setError('O nome do template é obrigatório');
      return;
    }

    setSaving(true);
    setError(null);

    try {
      let finalDef = definition;
      if (activeTab === 'json') {
        try {
          finalDef = JSON.parse(jsonText);
        } catch {
          throw new Error('Sintaxe JSON inválida');
        }
      }

      if (template?.id) {
        // Update
        const res = await fetch(`/api/creatives/templates/${template.id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: name.trim(),
            description: description.trim(),
            category: category.trim(),
            definition: finalDef,
            publishNewVersion,
          }),
        });
        if (!res.ok) {
          const errData = await res.json();
          throw new Error(errData.error || 'Erro ao salvar alterações');
        }
      } else {
        // Create
        const res = await fetch('/api/creatives/templates', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: name.trim(),
            description: description.trim(),
            category: category.trim(),
            status: 'ACTIVE',
            definition: finalDef,
          }),
        });
        if (!res.ok) {
          const errData = await res.json();
          throw new Error(errData.error || 'Erro ao criar template');
        }
      }

      onSaved();
      onClose();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Erro ao salvar template');
    } finally {
      setSaving(false);
    }
  };

  const addElement = (type: CreativeElementType) => {
    const id = `el_${Date.now()}`;
    const newEl: CreativeElement =
      type === 'TEXT'
        ? {
            id,
            type: 'TEXT',
            x: 100,
            y: 100,
            width: 400,
            height: 40,
            text: 'Novo Texto {{var}}',
            fontSize: 28,
            color: '#ffffff',
            alignment: 'left',
          }
        : type === 'CIRCLE_IMAGE'
        ? {
            id,
            type: 'CIRCLE_IMAGE',
            x: 100,
            y: 100,
            width: 150,
            height: 150,
            variable: 'profile_image',
            borderColor: '#38bdf8',
            borderWidth: 2,
          }
        : type === 'IMAGE'
        ? {
            id,
            type: 'IMAGE',
            x: 100,
            y: 100,
            width: 300,
            height: 200,
            variable: 'product_image',
            fit: 'cover',
          }
        : {
            id,
            type: 'ROUNDED_RECTANGLE',
            x: 100,
            y: 100,
            width: 300,
            height: 150,
            fill: '#1e293b',
            stroke: '#334155',
            strokeWidth: 1,
            borderRadius: 12,
          };

    const updatedElements = [...(definition.elements || []), newEl];
    const updatedDef = { ...definition, elements: updatedElements };
    setDefinition(updatedDef);
    setJsonText(JSON.stringify(updatedDef, null, 2));
  };

  const removeElement = (id: string) => {
    const updatedElements = (definition.elements || []).filter((el) => el.id !== id);
    const updatedDef = { ...definition, elements: updatedElements };
    setDefinition(updatedDef);
    setJsonText(JSON.stringify(updatedDef, null, 2));
  };

  return (
    <>
      <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
        <DialogContent className="max-w-4xl max-h-[92vh] overflow-y-auto">
          <DialogHeader>
            <div className="flex items-center justify-between">
              <div>
                <DialogTitle className="text-xl font-bold flex items-center gap-2">
                  {template ? `Editar Template: ${template.name}` : 'Criar Novo Template'}
                  {template && <Badge variant="outline">v{template.version}</Badge>}
                </DialogTitle>
                <DialogDescription>
                  Configure layout, dimensões e variáveis visuais de forma reutilizável.
                </DialogDescription>
              </div>
              <Button
                variant="outline"
                size="sm"
                className="gap-1.5"
                onClick={() => setShowPreview(true)}
              >
                <Eye className="w-4 h-4 text-primary" /> Testar & Preview
              </Button>
            </div>
          </DialogHeader>

          {/* Basic Fields */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mt-2">
            <div>
              <label className="text-xs font-semibold text-muted-foreground">Nome do Template</label>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Ex: Confirmação de Operação"
                className="w-full text-xs px-3 py-2 mt-1 rounded-md bg-background border border-input focus:ring-1 focus:ring-primary"
              />
            </div>
            <div>
              <label className="text-xs font-semibold text-muted-foreground">Categoria</label>
              <input
                type="text"
                value={category}
                onChange={(e) => setCategory(e.target.value)}
                placeholder="Ex: notifications, billing, onboarding"
                className="w-full text-xs px-3 py-2 mt-1 rounded-md bg-background border border-input focus:ring-1 focus:ring-primary"
              />
            </div>
            <div>
              <label className="text-xs font-semibold text-muted-foreground">Descrição</label>
              <input
                type="text"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Finalidade do criativo"
                className="w-full text-xs px-3 py-2 mt-1 rounded-md bg-background border border-input focus:ring-1 focus:ring-primary"
              />
            </div>
          </div>

          <Tabs
            value={activeTab}
            onValueChange={(v) => setActiveTab(v as 'elements' | 'json' | 'canvas')}
            className="mt-4"
          >
            <TabsList className="grid grid-cols-3 w-full max-w-sm">
              <TabsTrigger value="elements">Elementos ({definition.elements?.length || 0})</TabsTrigger>
              <TabsTrigger value="canvas">Dimensões & Fundo</TabsTrigger>
              <TabsTrigger value="json">Código JSON</TabsTrigger>
            </TabsList>

            {/* Elements Tab */}
            <TabsContent value="elements" className="mt-4 flex flex-col gap-4">
              <div className="flex items-center gap-2 flex-wrap pb-2 border-b border-border/60">
                <span className="text-xs font-semibold text-muted-foreground mr-1">Adicionar:</span>
                <Button size="sm" variant="outline" className="h-8 gap-1 text-xs" onClick={() => addElement('TEXT')}>
                  <Type className="w-3.5 h-3.5 text-sky-400" /> Texto
                </Button>
                <Button size="sm" variant="outline" className="h-8 gap-1 text-xs" onClick={() => addElement('ROUNDED_RECTANGLE')}>
                  <Square className="w-3.5 h-3.5 text-amber-400" /> Retângulo
                </Button>
                <Button size="sm" variant="outline" className="h-8 gap-1 text-xs" onClick={() => addElement('IMAGE')}>
                  <ImageIcon className="w-3.5 h-3.5 text-emerald-400" /> Imagem
                </Button>
                <Button size="sm" variant="outline" className="h-8 gap-1 text-xs" onClick={() => addElement('CIRCLE_IMAGE')}>
                  <Circle className="w-3.5 h-3.5 text-indigo-400" /> Foto Circular
                </Button>
              </div>

              <div className="flex flex-col gap-2 max-h-[360px] overflow-y-auto pr-1">
                {(definition.elements || []).map((el, idx) => (
                  <div
                    key={el.id || idx}
                    className="flex items-center justify-between p-3 rounded-lg bg-card/60 border border-border/80 text-xs gap-3 hover:border-primary/40 transition-colors"
                  >
                    <div className="flex items-center gap-3 min-w-0">
                      <Badge variant="secondary" className="font-mono text-[10px] shrink-0">
                        {el.type}
                      </Badge>
                      <div className="truncate">
                        <span className="font-semibold text-foreground mr-2">{el.id}</span>
                        {'text' in el && (
                          <span className="text-muted-foreground truncate italic">
                            &ldquo;{(el as { text?: string }).text}&rdquo;
                          </span>
                        )}
                        {'variable' in el && (
                          <span className="text-sky-400 truncate ml-1 font-mono">
                            {'{'}{(el as { variable?: string }).variable}{'}'}
                          </span>
                        )}
                      </div>
                    </div>
                    <div className="flex items-center gap-3 shrink-0">
                      <span className="text-[11px] font-mono text-muted-foreground">
                        ({el.x}, {el.y}) • {el.width}×{el.height}px
                      </span>
                      <Button
                        size="icon"
                        variant="ghost"
                        className="h-7 w-7 text-muted-foreground hover:text-destructive"
                        onClick={() => removeElement(el.id)}
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            </TabsContent>

            {/* Canvas Tab */}
            <TabsContent value="canvas" className="mt-4 grid grid-cols-1 md:grid-cols-3 gap-4">
              <div>
                <label className="text-xs font-semibold text-muted-foreground">Largura (px)</label>
                <input
                  type="number"
                  value={definition.width || 1080}
                  onChange={(e) => {
                    const val = Number(e.target.value);
                    const updated = { ...definition, width: val };
                    setDefinition(updated);
                    setJsonText(JSON.stringify(updated, null, 2));
                  }}
                  className="w-full text-xs px-3 py-2 mt-1 rounded-md bg-background border border-input"
                />
              </div>
              <div>
                <label className="text-xs font-semibold text-muted-foreground">Altura (px)</label>
                <input
                  type="number"
                  value={definition.height || 1080}
                  onChange={(e) => {
                    const val = Number(e.target.value);
                    const updated = { ...definition, height: val };
                    setDefinition(updated);
                    setJsonText(JSON.stringify(updated, null, 2));
                  }}
                  className="w-full text-xs px-3 py-2 mt-1 rounded-md bg-background border border-input"
                />
              </div>
              <div>
                <label className="text-xs font-semibold text-muted-foreground">Cor de Fundo</label>
                <div className="flex items-center gap-2 mt-1">
                  <input
                    type="color"
                    value={
                      typeof definition.background === 'string' && definition.background.startsWith('#')
                        ? definition.background
                        : '#0f172a'
                    }
                    onChange={(e) => {
                      const updated = { ...definition, background: e.target.value };
                      setDefinition(updated);
                      setJsonText(JSON.stringify(updated, null, 2));
                    }}
                    className="w-8 h-8 rounded border border-border cursor-pointer bg-transparent"
                  />
                  <input
                    type="text"
                    value={
                      typeof definition.background === 'string'
                        ? definition.background
                        : '#0f172a'
                    }
                    onChange={(e) => {
                      const updated = { ...definition, background: e.target.value };
                      setDefinition(updated);
                      setJsonText(JSON.stringify(updated, null, 2));
                    }}
                    className="flex-1 text-xs px-3 py-2 rounded-md bg-background border border-input font-mono"
                  />
                </div>
              </div>
            </TabsContent>

            {/* JSON Tab */}
            <TabsContent value="json" className="mt-4">
              <textarea
                value={jsonText}
                onChange={(e) => handleJsonChange(e.target.value)}
                rows={14}
                className="w-full font-mono text-xs p-3 rounded-lg bg-slate-950 text-slate-100 border border-slate-800 focus:outline-none focus:ring-1 focus:ring-primary leading-relaxed"
                placeholder="Definition JSON..."
              />
            </TabsContent>
          </Tabs>

          {error && (
            <div className="p-3 bg-destructive/10 border border-destructive/20 text-destructive text-xs rounded-lg mt-2">
              {error}
            </div>
          )}

          <DialogFooter className="mt-6 flex items-center justify-between sm:justify-between w-full">
            <div className="flex items-center gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setShowPreview(true)}
                className="gap-1.5"
              >
                <Eye className="w-3.5 h-3.5" /> Visualizar
              </Button>
            </div>
            <div className="flex items-center gap-2">
              <Button type="button" variant="ghost" size="sm" onClick={onClose} disabled={saving}>
                Cancelar
              </Button>
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={() => handleSave(false)}
                disabled={saving}
              >
                {saving && <Loader2 className="w-3.5 h-3.5 animate-spin mr-1.5" />}
                Salvar Rascunho
              </Button>
              <Button
                type="button"
                size="sm"
                onClick={() => handleSave(true)}
                disabled={saving}
                className="gap-1.5"
              >
                {saving ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <Sparkles className="w-3.5 h-3.5" />
                )}
                Publicar Nova Versão
              </Button>
            </div>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {showPreview && (
        <PreviewModal
          template={template}
          definitionOverride={definition}
          isOpen={showPreview}
          onClose={() => setShowPreview(false)}
        />
      )}
    </>
  );
}
