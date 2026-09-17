'use client';

import { useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Table,
  TableHeader,
  TableRow,
  TableHead,
  TableBody,
  TableCell,
} from '@/components/ui/table';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Send,
  ExternalLink,
  Copy,
  CheckCircle2,
  AlertCircle,
  Loader2,
  RefreshCw,
} from 'lucide-react';
import type { CreativeJob } from '@/lib/creative-engine/types';

interface JobsListProps {
  jobs: CreativeJob[];
  loading: boolean;
  onRefresh: () => void;
}

export function JobsList({ jobs, loading, onRefresh }: JobsListProps) {
  const [selectedImage, setSelectedImage] = useState<string | null>(null);
  const [resendingId, setResendingId] = useState<string | null>(null);
  const [resendPhone, setResendPhone] = useState('');
  const [showResendModal, setShowResendModal] = useState<CreativeJob | null>(null);
  const [resendFeedback, setResendFeedback] = useState<{ success?: string; error?: string } | null>(null);

  const getStatusBadge = (status: string) => {
    switch (status) {
      case 'SENT':
        return <Badge className="bg-emerald-500/10 text-emerald-400 border-emerald-500/20">Enviado</Badge>;
      case 'GENERATED':
        return <Badge className="bg-sky-500/10 text-sky-400 border-sky-500/20">Gerado</Badge>;
      case 'PROCESSING':
        return <Badge className="bg-amber-500/10 text-amber-400 border-amber-500/20 animate-pulse">Processando</Badge>;
      case 'FAILED':
        return <Badge variant="destructive">Falhou</Badge>;
      default:
        return <Badge variant="outline">{status}</Badge>;
    }
  };

  const handleResend = async () => {
    if (!showResendModal || !resendPhone.trim()) return;

    setResendingId(showResendModal.id);
    setResendFeedback(null);

    try {
      const res = await fetch(`/api/creatives/jobs/${showResendModal.id}/send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          recipient: resendPhone.trim(),
          channel: 'whatsapp',
        }),
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'Falha ao reenviar');
      }

      setResendFeedback({ success: `Enviado com sucesso para ${resendPhone}!` });
      onRefresh();
    } catch (err: unknown) {
      setResendFeedback({ error: err instanceof Error ? err.message : 'Erro no reenvio' });
    } finally {
      setResendingId(null);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <span className="text-xs text-muted-foreground">
          {jobs.length} criativos gerados nesta conta
        </span>
        <Button
          size="sm"
          variant="outline"
          onClick={onRefresh}
          disabled={loading}
          className="h-8 gap-1.5 text-xs"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
          Atualizar
        </Button>
      </div>

      <div className="border border-border rounded-xl overflow-hidden bg-card/40">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-[100px]">Criativo</TableHead>
              <TableHead>Template / Versão</TableHead>
              <TableHead>Origem</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Tentativas</TableHead>
              <TableHead>Data</TableHead>
              <TableHead className="text-right">Ações</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading && jobs.length === 0 ? (
              <TableRow>
                <TableCell colSpan={7} className="text-center py-8 text-muted-foreground text-xs">
                  <Loader2 className="w-5 h-5 animate-spin mx-auto mb-2 text-primary" />
                  Carregando histórico de criativos...
                </TableCell>
              </TableRow>
            ) : jobs.length === 0 ? (
              <TableRow>
                <TableCell colSpan={7} className="text-center py-8 text-muted-foreground text-xs">
                  Nenhum criativo gerado ainda. Use o editor ou automações para gerar.
                </TableCell>
              </TableRow>
            ) : (
              jobs.map((job) => (
                <TableRow key={job.id} className="hover:bg-muted/30 transition-colors">
                  <TableCell>
                    {job.output_url ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={job.output_url}
                        alt="Thumbnail"
                        onClick={() => setSelectedImage(job.output_url || null)}
                        className="w-14 h-14 object-cover rounded-lg border border-border cursor-pointer hover:scale-105 transition-transform"
                      />
                    ) : (
                      <div className="w-14 h-14 rounded-lg bg-muted/60 border border-border flex items-center justify-center text-[10px] text-muted-foreground">
                        N/A
                      </div>
                    )}
                  </TableCell>
                  <TableCell>
                    <div className="flex flex-col">
                      <span className="font-mono text-xs font-semibold text-foreground">
                        {job.template_id?.slice(0, 10)}...
                      </span>
                      <span className="text-[11px] text-muted-foreground">
                        Versão {job.template_version}
                      </span>
                    </div>
                  </TableCell>
                  <TableCell>
                    <div className="flex flex-col">
                      <span className="text-xs font-medium text-foreground">
                        {job.source_type}
                      </span>
                      <span className="text-[11px] text-muted-foreground font-mono">
                        {job.source_id || 'manual'}
                      </span>
                    </div>
                  </TableCell>
                  <TableCell>{getStatusBadge(job.status)}</TableCell>
                  <TableCell>
                    <span className="text-xs font-mono text-muted-foreground">
                      {job.attempts} / {job.max_attempts}
                    </span>
                  </TableCell>
                  <TableCell>
                    <span className="text-xs text-muted-foreground">
                      {job.created_at ? new Date(job.created_at).toLocaleString('pt-BR') : '-'}
                    </span>
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="flex items-center justify-end gap-1.5">
                      {job.output_url && (
                        <Button
                          size="icon"
                          variant="ghost"
                          className="h-8 w-8 text-muted-foreground hover:text-foreground"
                          title="Abrir imagem original"
                          onClick={() => window.open(job.output_url || '', '_blank')}
                        >
                          <ExternalLink className="w-3.5 h-3.5" />
                        </Button>
                      )}
                      {job.output_url && (
                        <Button
                          size="icon"
                          variant="ghost"
                          className="h-8 w-8 text-muted-foreground hover:text-foreground"
                          title="Copiar URL pública"
                          onClick={() => {
                            if (job.output_url) navigator.clipboard.writeText(job.output_url);
                          }}
                        >
                          <Copy className="w-3.5 h-3.5" />
                        </Button>
                      )}
                      {job.output_url && (
                        <Button
                          size="sm"
                          variant="secondary"
                          className="h-8 text-xs gap-1.5"
                          onClick={() => {
                            setShowResendModal(job);
                            setResendFeedback(null);
                          }}
                        >
                          <Send className="w-3 h-3" /> Enviar
                        </Button>
                      )}
                    </div>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      {/* Full Image Preview Modal */}
      {selectedImage && (
        <Dialog open={Boolean(selectedImage)} onOpenChange={() => setSelectedImage(null)}>
          <DialogContent className="max-w-3xl flex flex-col items-center p-4">
            <DialogHeader className="w-full">
              <DialogTitle className="text-base font-semibold">Visualização em Alta Resolução</DialogTitle>
            </DialogHeader>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={selectedImage}
              alt="Visualização do criativo"
              className="max-h-[75vh] w-auto object-contain rounded-xl shadow-2xl border border-border mt-2"
            />
          </DialogContent>
        </Dialog>
      )}

      {/* Resend Modal */}
      {showResendModal && (
        <Dialog open={Boolean(showResendModal)} onOpenChange={() => setShowResendModal(null)}>
          <DialogContent className="max-w-md">
            <DialogHeader>
              <DialogTitle className="text-base font-bold">Enviar Criativo via WhatsApp</DialogTitle>
            </DialogHeader>
            <div className="flex flex-col gap-3 mt-2">
              <label className="text-xs font-semibold text-muted-foreground">
                Número do WhatsApp do Destinatário
              </label>
              <input
                type="text"
                value={resendPhone}
                onChange={(e) => setResendPhone(e.target.value)}
                placeholder="Ex: 5511999999999"
                className="text-xs px-3 py-2 rounded-md bg-background border border-input"
              />
              <p className="text-[11px] text-muted-foreground">
                O criativo será entregue através da conexão de WhatsApp ativa do CRM e registrado no histórico unificado de mensagens.
              </p>

              {resendFeedback?.error && (
                <div className="p-3 bg-destructive/10 border border-destructive/20 text-destructive text-xs rounded-lg flex items-center gap-2">
                  <AlertCircle className="w-4 h-4 shrink-0" />
                  <span>{resendFeedback.error}</span>
                </div>
              )}

              {resendFeedback?.success && (
                <div className="p-3 bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 text-xs rounded-lg flex items-center gap-2">
                  <CheckCircle2 className="w-4 h-4 shrink-0" />
                  <span>{resendFeedback.success}</span>
                </div>
              )}

              <div className="flex justify-end gap-2 mt-3">
                <Button variant="ghost" size="sm" onClick={() => setShowResendModal(null)}>
                  Fechar
                </Button>
                <Button
                  size="sm"
                  onClick={handleResend}
                  disabled={Boolean(resendingId) || !resendPhone.trim()}
                  className="gap-1.5"
                >
                  {resendingId ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Send className="w-3.5 h-3.5" />}
                  Confirmar Envio
                </Button>
              </div>
            </div>
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}
