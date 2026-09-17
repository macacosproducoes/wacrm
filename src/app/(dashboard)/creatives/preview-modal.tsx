'use client';

import { useState, useEffect } from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Loader2, RefreshCw, Send, CheckCircle2, AlertCircle, Copy } from 'lucide-react';
import type { CreativeTemplate, TemplateDefinition } from '@/lib/creative-engine/types';

interface PreviewModalProps {
  template: CreativeTemplate | null;
  definitionOverride?: TemplateDefinition;
  isOpen: boolean;
  onClose: () => void;
}

export function PreviewModal({
  template,
  definitionOverride,
  isOpen,
  onClose,
}: PreviewModalProps) {
  const [loading, setLoading] = useState(false);
  const [previewData, setPreviewData] = useState<{
    pngDataUrl: string;
    width: number;
    height: number;
    sizeBytes: number;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Generic, neutral test data
  const [testDataJson, setTestDataJson] = useState<string>(() =>
    JSON.stringify(
      {
        name: 'Cliente Exemplo',
        code: '5288',
        amount: 2500,
        date: new Date().toISOString(),
        title: 'Confirmação de Registro',
        status: 'Concluído',
        tag: 'Destaque',
      },
      null,
      2
    )
  );

  // Sending state
  const [sendPhone, setSendPhone] = useState('');
  const [sending, setSending] = useState(false);
  const [sendSuccess, setSendSuccess] = useState<string | null>(null);

  const activeDefinition = definitionOverride || template?.definition;

  const fetchPreview = async () => {
    if (!activeDefinition) return;
    setLoading(true);
    setError(null);

    try {
      let parsedData = {};
      try {
        parsedData = JSON.parse(testDataJson);
      } catch {
        setError('JSON de dados de teste inválido.');
        setLoading(false);
        return;
      }

      const templateId = template?.id || 'preview_draft';
      const res = await fetch(`/api/creatives/templates/${templateId}/preview`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          definition: activeDefinition,
          testData: parsedData,
        }),
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'Falha ao renderizar preview');
      }

      setPreviewData(data);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Erro ao carregar preview');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (isOpen && activeDefinition) {
      void fetchPreview();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, template?.id]);

  const handleGenerateAndSend = async () => {
    if (!template) {
      setError('Salve o template antes de disparar um envio real.');
      return;
    }
    if (!sendPhone.trim()) {
      setError('Informe um número de telefone para envio.');
      return;
    }

    setSending(true);
    setSendSuccess(null);
    setError(null);

    try {
      let parsedData = {};
      try {
        parsedData = JSON.parse(testDataJson);
      } catch {
        throw new Error('JSON de dados de teste inválido');
      }

      const res = await fetch('/api/creatives/jobs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          template_id: template.id,
          template_version: template.version,
          source_type: 'MANUAL',
          source_id: `test_${Date.now()}`,
          input_data: parsedData,
          deliver: true,
          delivery_options: {
            recipient: sendPhone.trim(),
            channel: 'whatsapp',
            caption: `Criativo gerado: ${template.name}`,
          },
        }),
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'Erro ao gerar e enviar criativo');
      }

      setSendSuccess(`Criativo gerado com sucesso (Job ID: ${data.job?.id}) e enviado para ${sendPhone}!`);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Falha no disparo');
    } finally {
      setSending(false);
    }
  };

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-4xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <div className="flex items-center justify-between">
            <div>
              <DialogTitle className="text-xl font-bold flex items-center gap-2">
                Preview & Test Data
                {template && <Badge variant="outline">v{template.version}</Badge>}
              </DialogTitle>
              <DialogDescription>
                Renderizado deterministicamente com o motor oficial de produção.
              </DialogDescription>
            </div>
            {previewData && (
              <Badge variant="secondary" className="text-xs">
                {previewData.width} × {previewData.height} px ({(previewData.sizeBytes / 1024).toFixed(1)} KB)
              </Badge>
            )}
          </div>
        </DialogHeader>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mt-4">
          {/* Visual Canvas Output */}
          <div className="flex flex-col items-center justify-center bg-slate-950/40 border border-border/80 rounded-xl p-4 min-h-[350px]">
            {loading ? (
              <div className="flex flex-col items-center gap-2 text-muted-foreground">
                <Loader2 className="w-8 h-8 animate-spin text-primary" />
                <span className="text-sm">Renderizando PNG deterministicamente...</span>
              </div>
            ) : previewData?.pngDataUrl ? (
              <div className="relative group max-w-full">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={previewData.pngDataUrl}
                  alt="Preview do Criativo"
                  className="max-h-[460px] w-auto object-contain rounded-lg shadow-2xl border border-border"
                />
                <div className="absolute top-2 right-2 opacity-0 group-hover:opacity-100 transition-opacity">
                  <Button
                    size="sm"
                    variant="secondary"
                    className="h-8 gap-1 shadow bg-background/80 backdrop-blur"
                    onClick={() => {
                      const link = document.createElement('a');
                      link.download = `preview-${template?.name || 'creative'}.png`;
                      link.href = previewData.pngDataUrl;
                      link.click();
                    }}
                  >
                    <Copy className="w-3.5 h-3.5" /> Baixar
                  </Button>
                </div>
              </div>
            ) : (
              <div className="text-sm text-muted-foreground">Nenhum preview gerado</div>
            )}
          </div>

          {/* Controls & Test Data */}
          <div className="flex flex-col gap-4">
            <div>
              <div className="flex items-center justify-between mb-1.5">
                <label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  Dados de Teste (JSON)
                </label>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 text-xs gap-1"
                  onClick={fetchPreview}
                  disabled={loading}
                >
                  <RefreshCw className={`w-3 h-3 ${loading ? 'animate-spin' : ''}`} />
                  Atualizar Preview
                </Button>
              </div>
              <textarea
                value={testDataJson}
                onChange={(e) => setTestDataJson(e.target.value)}
                rows={9}
                className="w-full font-mono text-xs p-3 rounded-lg bg-background border border-input focus:outline-none focus:ring-1 focus:ring-primary leading-relaxed"
                placeholder='{ "key": "value" }'
              />
              <p className="text-[11px] text-muted-foreground mt-1">
                Utilize variáveis como {'{{name}}'}, {'{{code | uppercase}}'}, {'{{amount | currency}}'}, etc.
              </p>
            </div>

            {/* Test WhatsApp Delivery */}
            <div className="border border-border/70 rounded-xl p-3.5 bg-card/60 flex flex-col gap-2">
              <span className="text-xs font-semibold text-foreground flex items-center gap-1.5">
                <Send className="w-3.5 h-3.5 text-primary" /> Testar Envio WhatsApp
              </span>
              <div className="flex gap-2">
                <input
                  type="text"
                  value={sendPhone}
                  onChange={(e) => setSendPhone(e.target.value)}
                  placeholder="DDD + Número (ex: 5511999999999)"
                  className="flex-1 text-xs px-3 py-2 rounded-md bg-background border border-input"
                />
                <Button
                  size="sm"
                  onClick={handleGenerateAndSend}
                  disabled={sending || !template}
                  className="gap-1.5"
                >
                  {sending ? (
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  ) : (
                    <Send className="w-3.5 h-3.5" />
                  )}
                  Enviar
                </Button>
              </div>
            </div>

            {error && (
              <div className="p-3 bg-destructive/10 border border-destructive/20 text-destructive text-xs rounded-lg flex items-center gap-2">
                <AlertCircle className="w-4 h-4 shrink-0" />
                <span>{error}</span>
              </div>
            )}

            {sendSuccess && (
              <div className="p-3 bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 text-xs rounded-lg flex items-center gap-2">
                <CheckCircle2 className="w-4 h-4 shrink-0" />
                <span>{sendSuccess}</span>
              </div>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
