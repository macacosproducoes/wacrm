'use client';

import { useState, useMemo } from 'react';
import { createClient } from '@/lib/supabase/client';
import { toast } from 'sonner';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Loader2, PencilLine, CheckCircle2, Sparkles } from 'lucide-react';

interface RenameTemplateModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  selectedContactIds: string[];
  accountId: string | null;
  onSuccess: () => void;
}

export function RenameTemplateModal({
  open,
  onOpenChange,
  selectedContactIds,
  accountId,
  onSuccess,
}: RenameTemplateModalProps) {
  const supabase = createClient();

  const [baseName, setBaseName] = useState('Lead Disparo');
  const [startNumber, setStartNumber] = useState(1);
  const [scope, setScope] = useState<'selected' | 'tag_disparo' | 'all'>('selected');
  const [saving, setSaving] = useState(false);

  // Live preview of first 3 names
  const previewNames = useMemo(() => {
    const clean = baseName.trim() || 'Nome';
    const s = Math.max(1, startNumber);
    return [`${clean} ${s}`, `${clean} ${s + 1}`, `${clean} ${s + 2}`];
  }, [baseName, startNumber]);

  async function handleExecute() {
    if (!accountId) {
      toast.error('Conta não identificada.');
      return;
    }
    const cleanName = baseName.trim();
    if (!cleanName) {
      toast.error('Digite um modelo de nome para continuar.');
      return;
    }

    setSaving(true);
    try {
      let targetContacts: { id: string }[] = [];

      if (scope === 'selected') {
        if (selectedContactIds.length === 0) {
          toast.error('Nenhum contato selecionado.');
          setSaving(false);
          return;
        }
        const { data, error } = await supabase
          .from('contacts')
          .select('id, created_at')
          .in('id', selectedContactIds)
          .order('created_at', { ascending: true });
        if (error) throw error;
        targetContacts = data ?? [];
      } else if (scope === 'tag_disparo') {
        const { data: tag } = await supabase
          .from('tags')
          .select('id')
          .eq('account_id', accountId)
          .ilike('name', 'leads disparo')
          .maybeSingle();

        if (!tag) {
          toast.error('Etiqueta "leads disparo" não encontrada.');
          setSaving(false);
          return;
        }

        const { data: ctData, error: ctErr } = await supabase
          .from('contact_tags')
          .select('contact_id')
          .eq('tag_id', tag.id);
        if (ctErr) throw ctErr;

        const cIds = (ctData ?? []).map((ct) => ct.contact_id);
        if (cIds.length === 0) {
          toast.error('Nenhum contato com a etiqueta "leads disparo".');
          setSaving(false);
          return;
        }

        const { data, error } = await supabase
          .from('contacts')
          .select('id, created_at')
          .in('id', cIds)
          .order('created_at', { ascending: true });
        if (error) throw error;
        targetContacts = data ?? [];
      } else {
        const { data, error } = await supabase
          .from('contacts')
          .select('id, created_at')
          .eq('account_id', accountId)
          .order('created_at', { ascending: true });
        if (error) throw error;
        targetContacts = data ?? [];
      }

      if (targetContacts.length === 0) {
        toast.info('Nenhum contato encontrado para renomear.');
        setSaving(false);
        return;
      }

      const chunkSize = 50;
      const s = Math.max(1, startNumber);

      for (let i = 0; i < targetContacts.length; i += chunkSize) {
        const chunk = targetContacts.slice(i, i + chunkSize);
        await Promise.all(
          chunk.map((c, idx) => {
            const num = s + i + idx;
            const updatedName = `${cleanName} ${num}`;
            return supabase.from('contacts').update({ name: updatedName }).eq('id', c.id);
          })
        );
      }

      toast.success(
        `Sucesso: ${targetContacts.length} contatos renomeados como "${cleanName} ${s}" em diante!`
      );
      onOpenChange(false);
      onSuccess();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Erro ao renomear contatos.';
      toast.error(msg);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(v) => !saving && onOpenChange(v)}>
      <DialogContent className="sm:max-w-[500px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <PencilLine className="size-5 text-blue-600 dark:text-blue-400" />
            Renomear contatos em sequência (Template)
          </DialogTitle>
          <DialogDescription>
            Organize os nomes dos seus contatos com um padrão sequencial para facilitar a visualização e os disparos.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          {/* Target Scope */}
          <div className="space-y-1.5">
            <label className="text-xs font-semibold text-foreground">Aplicar para quais contatos:</label>
            <div className="grid grid-cols-1 gap-2 text-xs">
              <label className="flex items-center gap-2.5 p-2 rounded-lg border cursor-pointer hover:bg-muted/40 transition-colors">
                <input
                  type="radio"
                  name="scope"
                  checked={scope === 'selected'}
                  onChange={() => setScope('selected')}
                  className="accent-primary"
                />
                <span className="font-medium text-foreground">
                  Contatos selecionados atualmente ({selectedContactIds.length})
                </span>
              </label>

              <label className="flex items-center gap-2.5 p-2 rounded-lg border cursor-pointer hover:bg-muted/40 transition-colors">
                <input
                  type="radio"
                  name="scope"
                  checked={scope === 'tag_disparo'}
                  onChange={() => setScope('tag_disparo')}
                  className="accent-primary"
                />
                <span className="font-medium text-foreground">
                  Todos os contatos com a etiqueta &quot;leads disparo&quot;
                </span>
              </label>

              <label className="flex items-center gap-2.5 p-2 rounded-lg border cursor-pointer hover:bg-muted/40 transition-colors">
                <input
                  type="radio"
                  name="scope"
                  checked={scope === 'all'}
                  onChange={() => setScope('all')}
                  className="accent-primary"
                />
                <span className="font-medium text-foreground">
                  Todos os contatos da minha conta
                </span>
              </label>
            </div>
          </div>

          {/* Template Configuration */}
          <div className="grid grid-cols-3 gap-2">
            <div className="col-span-2 space-y-1">
              <label className="text-xs font-medium text-foreground">Modelo de Nome:</label>
              <Input
                value={baseName}
                onChange={(e) => setBaseName(e.target.value)}
                placeholder="Ex: Lead Disparo"
                className="text-xs font-medium h-9"
                disabled={saving}
              />
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium text-foreground">Número inicial:</label>
              <Input
                type="number"
                min={1}
                value={startNumber}
                onChange={(e) => setStartNumber(Math.max(1, parseInt(e.target.value) || 1))}
                className="text-xs text-center font-mono h-9"
                disabled={saving}
              />
            </div>
          </div>

          {/* Live Preview */}
          <div className="rounded-lg border bg-muted/30 p-3 space-y-1.5">
            <div className="flex items-center gap-1.5 text-xs font-semibold text-foreground">
              <Sparkles className="size-3.5 text-blue-500" />
              <span>Prévia dos nomes gerados:</span>
            </div>
            <div className="flex flex-wrap items-center gap-1.5 text-xs font-mono">
              <span className="px-2 py-0.5 rounded bg-background border text-foreground font-semibold">
                {previewNames[0]}
              </span>
              <span className="text-muted-foreground">→</span>
              <span className="px-2 py-0.5 rounded bg-background border text-foreground font-semibold">
                {previewNames[1]}
              </span>
              <span className="text-muted-foreground">→</span>
              <span className="px-2 py-0.5 rounded bg-background border text-foreground font-semibold">
                {previewNames[2]}
              </span>
              <span className="text-muted-foreground">...</span>
            </div>
          </div>
        </div>

        <DialogFooter className="gap-2">
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={saving}
          >
            Cancelar
          </Button>
          <Button
            onClick={handleExecute}
            disabled={saving || !baseName.trim()}
            className="bg-blue-600 text-white hover:bg-blue-700"
          >
            {saving ? (
              <>
                <Loader2 className="size-4 mr-2 animate-spin" />
                Renomeando...
              </>
            ) : (
              <>
                <CheckCircle2 className="size-4 mr-2" />
                Salvar novos nomes
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
