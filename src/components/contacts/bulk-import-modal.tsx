'use client';

import { useState, useMemo } from 'react';
import { createClient } from '@/lib/supabase/client';
import { useAuth } from '@/hooks/use-auth';
import { isUniqueViolation } from '@/lib/contacts/dedupe';
import {
  parseBulkPhoneText,
  type NormalizedPhoneResult,
  type InvalidPhoneResult,
} from '@/lib/contacts/phone-br-normalizer';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Input } from '@/components/ui/input';
import { Progress } from '@/components/ui/progress';
import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  CheckCircle2,
  AlertCircle,
  Copy,
  Database,
  Loader2,
  PhoneCall,
  FileText,
  ArrowRight,
  RotateCcw,
  Sparkles,
  Users,
  Tag,
  Check,
} from 'lucide-react';
import { toast } from 'sonner';

interface ContactWithId extends NormalizedPhoneResult {
  id?: string;
}

interface BulkImportModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onImported: () => void;
}

const DEFAULT_TAG_NAME = 'leads disparo';
const DEFAULT_TAG_COLOR = '#10b981'; // Emerald

export function BulkImportModal({
  open,
  onOpenChange,
  onImported,
}: BulkImportModalProps) {
  const supabase = createClient();
  const { accountId } = useAuth();

  // Step 1: Input text & Tag configuration
  const [rawText, setRawText] = useState('');
  const [tagName, setTagName] = useState(DEFAULT_TAG_NAME);
  const [nameTemplate, setNameTemplate] = useState('Lead Disparo');
  const [startNumber, setStartNumber] = useState(1);
  const [tagExistingInCrm, setTagExistingInCrm] = useState(true);
  const [isValidating, setIsValidating] = useState(false);

  // Step 2: Validation results
  const [hasValidated, setHasValidated] = useState(false);
  const [validToImport, setValidToImport] = useState<NormalizedPhoneResult[]>([]);
  const [alreadyInCrm, setAlreadyInCrm] = useState<ContactWithId[]>([]);
  const [duplicatesInText, setDuplicatesInText] = useState<NormalizedPhoneResult[]>([]);
  const [invalidList, setInvalidList] = useState<InvalidPhoneResult[]>([]);
  const [totalLinesReceived, setTotalLinesReceived] = useState(0);
  const [emptyLinesCount, setEmptyLinesCount] = useState(0);

  // Step 3: Import progress & execution
  const [importing, setImporting] = useState(false);
  const [isTaggingExisting, setIsTaggingExisting] = useState(false);
  const [progress, setProgress] = useState({
    current: 0,
    total: 0,
    percent: 0,
    chunk: 0,
    totalChunks: 0,
  });

  // Step 4: Final Summary
  const [summary, setSummary] = useState<{
    imported: number;
    duplicatesInText: number;
    alreadyInCrm: number;
    taggedCount: number;
    invalid: number;
    failed: number;
  } | null>(null);

  // Real-time line counter
  const detectedLinesCount = useMemo(() => {
    if (!rawText.trim()) return 0;
    const lines = rawText.split(/\r?\n/);
    return lines.filter((l) => l.trim().length > 0).length;
  }, [rawText]);

  function resetState() {
    setRawText('');
    setTagName(DEFAULT_TAG_NAME);
    setNameTemplate('Lead Disparo');
    setStartNumber(1);
    setTagExistingInCrm(true);
    setIsValidating(false);
    setHasValidated(false);
    setValidToImport([]);
    setAlreadyInCrm([]);
    setDuplicatesInText([]);
    setInvalidList([]);
    setTotalLinesReceived(0);
    setEmptyLinesCount(0);
    setImporting(false);
    setIsTaggingExisting(false);
    setProgress({ current: 0, total: 0, percent: 0, chunk: 0, totalChunks: 0 });
    setSummary(null);
  }

  function handleOpenChange(next: boolean) {
    if (!next && !importing) {
      resetState();
    }
    if (!importing) {
      onOpenChange(next);
    }
  }

  // Get or create tag in database
  async function ensureTagId(name: string, userId: string, accId: string): Promise<string | null> {
    const cleanName = name.trim();
    if (!cleanName) return null;

    try {
      const { data: existingTags, error: tagFetchErr } = await supabase
        .from('tags')
        .select('id, name')
        .eq('account_id', accId);

      if (tagFetchErr) {
        console.error('Erro ao buscar tags:', tagFetchErr);
      }

      const match = (existingTags ?? []).find(
        (t) => t.name.trim().toLowerCase() === cleanName.toLowerCase()
      );

      if (match) return match.id;

      // Create new tag
      const { data: createdTag, error: tagCreateErr } = await supabase
        .from('tags')
        .insert({
          user_id: userId,
          account_id: accId,
          name: cleanName,
          color: DEFAULT_TAG_COLOR,
        })
        .select('id')
        .single();

      if (tagCreateErr) {
        console.error('Erro ao criar tag:', tagCreateErr);
        return null;
      }

      return createdTag?.id ?? null;
    } catch (err) {
      console.error('Falha ao garantir tag:', err);
      return null;
    }
  }

  // Assign tag to contacts
  async function assignTagToContactIds(contactIds: string[], tagId: string): Promise<number> {
    if (contactIds.length === 0 || !tagId) return 0;

    const rows = contactIds.map((cid) => ({
      contact_id: cid,
      tag_id: tagId,
    }));

    const chunkSize = 100;
    let assignedCount = 0;

    for (let i = 0; i < rows.length; i += chunkSize) {
      const chunk = rows.slice(i, i + chunkSize);
      const { error } = await supabase.from('contact_tags').upsert(chunk, {
        onConflict: 'contact_id,tag_id',
        ignoreDuplicates: true,
      });

      if (!error) {
        assignedCount += chunk.length;
      } else {
        console.error('Erro ao associar tag:', error);
      }
    }

    return assignedCount;
  }

  // Validate numbers and check CRM database
  async function handleValidate() {
    if (!rawText.trim()) {
      toast.error('Cole pelo menos um número de telefone para validar.');
      return;
    }

    setIsValidating(true);
    try {
      const parsed = parseBulkPhoneText(rawText);
      setTotalLinesReceived(parsed.totalLines);
      setEmptyLinesCount(parsed.emptyLines);
      setDuplicatesInText(parsed.duplicatesInText);
      setInvalidList(parsed.invalidList);

      if (parsed.validList.length === 0) {
        setValidToImport([]);
        setAlreadyInCrm([]);
        setHasValidated(true);
        toast.warning('Nenhum número de telefone válido foi identificado.');
        return;
      }

      // Check existing contacts in Supabase for this account
      if (!accountId) {
        toast.error('Conta não identificada. Faça login novamente.');
        return;
      }

      const { data: existingRows, error } = await supabase
        .from('contacts')
        .select('id, phone_normalized')
        .eq('account_id', accountId);

      if (error) {
        console.error('Erro ao verificar contatos existentes no CRM:', error);
        toast.error('Erro ao consultar banco de dados. Tente novamente.');
        return;
      }

      const existingMap = new Map<string, string>();
      for (const row of existingRows ?? []) {
        if (row.phone_normalized) {
          existingMap.set(row.phone_normalized, row.id);
        }
      }

      const toImport: NormalizedPhoneResult[] = [];
      const inDb: ContactWithId[] = [];

      for (const item of parsed.validList) {
        const digitsOnly = item.normalized.replace(/\D/g, '');
        if (existingMap.has(digitsOnly)) {
          inDb.push({
            ...item,
            id: existingMap.get(digitsOnly),
          });
        } else {
          toImport.push(item);
        }
      }

      setValidToImport(toImport);
      setAlreadyInCrm(inDb);
      setHasValidated(true);

      toast.success(
        `Validação concluída: ${toImport.length} válidos novos, ${inDb.length} já cadastrados, ${parsed.invalidList.length} inválidos.`
      );
    } catch (err: unknown) {
      console.error('Erro na validação:', err);
      toast.error('Falha ao validar os números digitados.');
    } finally {
      setIsValidating(false);
    }
  }

  // Tag only existing contacts directly from the preview
  async function handleTagExistingOnly() {
    const existingWithIds = alreadyInCrm.filter((c) => !!c.id).map((c) => c.id as string);
    if (existingWithIds.length === 0) {
      toast.info('Nenhum contato existente identificado para etiquetar.');
      return;
    }

    setIsTaggingExisting(true);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const user = session?.user;
      if (!user || !accountId) throw new Error('Não autenticado.');

      const tagId = await ensureTagId(tagName, user.id, accountId);
      if (!tagId) throw new Error('Não foi possível criar/encontrar a etiqueta.');

      const count = await assignTagToContactIds(existingWithIds, tagId);
      toast.success(`${count} contatos já existentes foram etiquetados como "${tagName}"!`);
      onImported();
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Falha ao etiquetar contatos existentes.';
      toast.error(msg);
    } finally {
      setIsTaggingExisting(false);
    }
  }

  // Batch import to Supabase and assign tags
  async function handleImport() {
    if (validToImport.length === 0 && (!tagExistingInCrm || alreadyInCrm.length === 0)) {
      toast.info('Não há contatos para importar ou etiquetar.');
      return;
    }

    setImporting(true);
    try {
      const {
        data: { session },
      } = await supabase.auth.getSession();
      const user = session?.user;

      if (!user) throw new Error('Usuário não autenticado.');
      if (!accountId) throw new Error('Conta não encontrada.');

      // 1. Ensure tag exists
      let targetTagId: string | null = null;
      if (tagName.trim()) {
        targetTagId = await ensureTagId(tagName, user.id, accountId);
      }

      let importedCount = 0;
      let dbDuplicatesCount = alreadyInCrm.length;
      let failedCount = 0;
      const createdContactIds: string[] = [];

      const chunkSize = 50;
      const totalChunks = Math.max(1, Math.ceil(validToImport.length / chunkSize));

      setProgress({
        current: 0,
        total: validToImport.length,
        percent: 0,
        chunk: 0,
        totalChunks,
      });

      // 2. Insert new contacts
      for (let i = 0; i < validToImport.length; i += chunkSize) {
        const chunk = validToImport.slice(i, i + chunkSize);
        const currentChunkNum = Math.floor(i / chunkSize) + 1;

        const rows = chunk.map((item, idx) => {
          const globalIdx = i + idx;
          const contactName = nameTemplate.trim()
            ? `${nameTemplate.trim()} ${startNumber + globalIdx}`
            : item.normalized;
          return {
            user_id: user.id,
            account_id: accountId,
            phone: item.normalized,
            name: contactName,
          };
        });

        const { data, error } = await supabase
          .from('contacts')
          .insert(rows)
          .select('id');

        if (error) {
          // Fallback individual
          for (const row of rows) {
            const { data: singleData, error: singleErr } = await supabase
              .from('contacts')
              .insert(row)
              .select('id')
              .single();

            if (!singleErr && singleData) {
              importedCount++;
              createdContactIds.push(singleData.id);
            } else if (isUniqueViolation(singleErr)) {
              dbDuplicatesCount++;
            } else {
              failedCount++;
            }
          }
        } else {
          const inserted = data ?? [];
          importedCount += inserted.length;
          for (const c of inserted) {
            createdContactIds.push(c.id);
          }
        }

        const processed = Math.min(i + chunkSize, validToImport.length);
        setProgress({
          current: processed,
          total: validToImport.length,
          percent: Math.round((processed / (validToImport.length || 1)) * 100),
          chunk: currentChunkNum,
          totalChunks,
        });
      }

      // 3. Assign tag to all newly created contacts
      let totalTagged = 0;
      if (targetTagId) {
        if (createdContactIds.length > 0) {
          const taggedNew = await assignTagToContactIds(createdContactIds, targetTagId);
          totalTagged += taggedNew;
        }

        // 4. Also assign tag to already existing contacts if requested
        if (tagExistingInCrm && alreadyInCrm.length > 0) {
          const existingIds = alreadyInCrm.filter((c) => !!c.id).map((c) => c.id as string);
          if (existingIds.length > 0) {
            const taggedExisting = await assignTagToContactIds(existingIds, targetTagId);
            totalTagged += taggedExisting;
          }
        }
      }

      setSummary({
        imported: importedCount,
        duplicatesInText: duplicatesInText.length,
        alreadyInCrm: dbDuplicatesCount,
        taggedCount: totalTagged,
        invalid: invalidList.length,
        failed: failedCount,
      });

      if (importedCount > 0 || totalTagged > 0) {
        toast.success(
          `Sucesso: ${importedCount} contatos novos salvos e ${totalTagged} etiquetados como "${tagName}"!`
        );
        onImported();
      } else {
        toast.info('Nenhum novo contato precisou ser inserido.');
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Erro durante a importação';
      toast.error(msg);
    } finally {
      setImporting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-2xl max-h-[90vh] flex flex-col p-6 overflow-hidden">
        <DialogHeader className="shrink-0 pb-2">
          <DialogTitle className="flex items-center gap-2 text-xl font-bold">
            <Users className="size-5 text-primary" />
            Importar contatos em massa
          </DialogTitle>
          <DialogDescription>
            Cole uma lista de telefones do Bloco de Notas (um por linha). Todos os números serão
            normalizados com <code>+55</code> e etiquetados como <strong>leads de disparo</strong>.
          </DialogDescription>
        </DialogHeader>

        {/* STEP 4: FINAL SUMMARY SCREEN */}
        {summary ? (
          <div className="flex-1 flex flex-col justify-center items-center py-6 space-y-6">
            <div className="flex items-center justify-center size-16 rounded-full bg-emerald-500/10 text-emerald-500">
              <CheckCircle2 className="size-10" />
            </div>

            <div className="text-center space-y-1">
              <h3 className="text-xl font-semibold">Importação & Etiquetagem Concluídas!</h3>
              <p className="text-sm text-muted-foreground">
                Os contatos foram persistidos e organizados na sua base como <strong>{tagName}</strong>.
              </p>
            </div>

            {/* Metrics cards */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 w-full max-w-lg">
              <div className="p-3 rounded-lg border bg-muted/30 text-center">
                <span className="text-2xl font-bold text-emerald-600 dark:text-emerald-400">
                  {summary.imported}
                </span>
                <p className="text-xs text-muted-foreground mt-0.5">Novos Importados</p>
              </div>
              <div className="p-3 rounded-lg border bg-emerald-500/10 text-center border-emerald-500/30">
                <span className="text-2xl font-bold text-emerald-600 dark:text-emerald-400">
                  {summary.taggedCount}
                </span>
                <p className="text-xs text-muted-foreground mt-0.5">Etiquetados ({tagName})</p>
              </div>
              <div className="p-3 rounded-lg border bg-muted/30 text-center">
                <span className="text-2xl font-bold text-amber-600 dark:text-amber-400">
                  {summary.alreadyInCrm}
                </span>
                <p className="text-xs text-muted-foreground mt-0.5">Já no CRM</p>
              </div>
              <div className="p-3 rounded-lg border bg-muted/30 text-center">
                <span className="text-2xl font-bold text-blue-600 dark:text-blue-400">
                  {summary.duplicatesInText}
                </span>
                <p className="text-xs text-muted-foreground mt-0.5">Repetidos no texto</p>
              </div>
            </div>

            <DialogFooter className="w-full flex justify-end gap-2 pt-4">
              <Button
                variant="outline"
                onClick={() => {
                  resetState();
                }}
              >
                <RotateCcw className="size-4 mr-2" />
                Importar outra lista
              </Button>
              <Button onClick={() => handleOpenChange(false)}>
                Concluir
              </Button>
            </DialogFooter>
          </div>
        ) : (
          <div className="flex-1 flex flex-col overflow-hidden space-y-4">
            {/* STEP 1: TEXTAREA INPUT */}
            {!hasValidated ? (
              <div className="flex-1 flex flex-col space-y-3 overflow-hidden">
                {/* Configuration header: Tag and Name Template */}
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5 p-3 rounded-lg border bg-muted/30 text-xs">
                  {/* Tag config */}
                  <div className="space-y-1">
                    <div className="flex items-center gap-1.5 font-medium text-foreground">
                      <Tag className="size-3.5 text-emerald-600 dark:text-emerald-400" />
                      <span>Etiqueta dos contatos:</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <Input
                        value={tagName}
                        onChange={(e) => setTagName(e.target.value)}
                        placeholder="Nome da etiqueta"
                        className="h-8 text-xs font-medium"
                      />
                      <Badge className="bg-emerald-600 text-white hover:bg-emerald-700 h-7 shrink-0 text-[11px]">
                        Disparo
                      </Badge>
                    </div>
                  </div>

                  {/* Name Template config */}
                  <div className="space-y-1">
                    <div className="flex items-center justify-between font-medium text-foreground">
                      <span className="flex items-center gap-1.5">
                        <Sparkles className="size-3.5 text-blue-500" />
                        <span>Modelo de nome (Template):</span>
                      </span>
                      <span className="text-[10px] text-muted-foreground font-mono">Início: #{startNumber}</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <Input
                        value={nameTemplate}
                        onChange={(e) => setNameTemplate(e.target.value)}
                        placeholder="Ex: Lead Disparo"
                        className="h-8 text-xs font-medium flex-1"
                      />
                      <Input
                        type="number"
                        min={1}
                        value={startNumber}
                        onChange={(e) => setStartNumber(Math.max(1, parseInt(e.target.value) || 1))}
                        className="h-8 w-16 text-xs text-center font-mono"
                        title="Número inicial"
                      />
                    </div>
                    <p className="text-[10px] text-muted-foreground">
                      Salvará: <strong className="text-foreground">{nameTemplate.trim() || 'Nome'} {startNumber}</strong>, <strong className="text-foreground">{nameTemplate.trim() || 'Nome'} {startNumber + 1}</strong>...
                    </p>
                  </div>
                </div>

                <div className="flex items-center justify-between text-xs text-muted-foreground">
                  <span>Cole um número por linha (celular ou fixo):</span>
                  <Badge variant="secondary" className="font-mono text-xs">
                    {detectedLinesCount} {detectedLinesCount === 1 ? 'linha' : 'linhas'} com dados
                  </Badge>
                </div>

                <Textarea
                  placeholder={`11987654321\n(21) 98765-4321\n5531987654321\n+5541987654321\n1133334444`}
                  value={rawText}
                  onChange={(e) => setRawText(e.target.value)}
                  className="flex-1 min-h-[200px] font-mono text-xs leading-relaxed resize-none p-3"
                  disabled={isValidating}
                />

                <div className="text-xs text-muted-foreground bg-muted/40 p-2.5 rounded border flex items-center justify-between">
                  <span>
                    💡 <strong>Leads de Disparo:</strong> Todos os contatos válidos recebem a tag{' '}
                    <code className="text-emerald-600 dark:text-emerald-400 font-semibold">{tagName}</code>{' '}
                    para você disparar campanhas diretamente na aba <strong>Broadcasts</strong>.
                  </span>
                  {rawText && (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setRawText('')}
                      className="text-xs h-7 px-2 text-muted-foreground hover:text-foreground"
                    >
                      Limpar
                    </Button>
                  )}
                </div>
              </div>
            ) : (
              /* STEP 2: PREVIEW AND VALIDATION RESULTS */
              <div className="flex-1 flex flex-col space-y-4 overflow-hidden">
                {/* Tag option banner */}
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 p-2.5 rounded-lg border bg-emerald-500/10 border-emerald-500/30 text-xs">
                  <div className="flex items-center gap-2">
                    <Tag className="size-4 text-emerald-600 dark:text-emerald-400" />
                    <span>
                      Etiqueta ativa: <strong className="text-emerald-600 dark:text-emerald-400">{tagName}</strong>
                    </span>
                  </div>
                  <div className="flex items-center gap-2">
                    <label className="flex items-center gap-1.5 cursor-pointer text-[11px] text-muted-foreground hover:text-foreground">
                      <input
                        type="checkbox"
                        checked={tagExistingInCrm}
                        onChange={(e) => setTagExistingInCrm(e.target.checked)}
                        className="rounded border-border size-3.5 accent-primary"
                      />
                      <span>Aplicar também aos {alreadyInCrm.length} já existentes no CRM</span>
                    </label>
                  </div>
                </div>

                {/* Stats cards */}
                <div className="grid grid-cols-2 sm:grid-cols-5 gap-2 shrink-0">
                  <div className="p-2.5 rounded-lg border bg-muted/20">
                    <p className="text-[11px] text-muted-foreground">Linhas lidas</p>
                    <p className="text-lg font-bold">{totalLinesReceived}</p>
                  </div>
                  <div className="p-2.5 rounded-lg border bg-emerald-500/10 border-emerald-500/20">
                    <p className="text-[11px] text-emerald-600 dark:text-emerald-400 font-medium">
                      Válidos novos
                    </p>
                    <p className="text-lg font-bold text-emerald-600 dark:text-emerald-400">
                      {validToImport.length}
                    </p>
                  </div>
                  <div className="p-2.5 rounded-lg border bg-amber-500/10 border-amber-500/20">
                    <p className="text-[11px] text-amber-600 dark:text-amber-400 font-medium">
                      Já no CRM
                    </p>
                    <p className="text-lg font-bold text-amber-600 dark:text-amber-400">
                      {alreadyInCrm.length}
                    </p>
                  </div>
                  <div className="p-2.5 rounded-lg border bg-blue-500/10 border-blue-500/20">
                    <p className="text-[11px] text-blue-600 dark:text-blue-400 font-medium">
                      Repetidos no texto
                    </p>
                    <p className="text-lg font-bold text-blue-600 dark:text-blue-400">
                      {duplicatesInText.length}
                    </p>
                  </div>
                  <div className="p-2.5 rounded-lg border bg-rose-500/10 border-rose-500/20">
                    <p className="text-[11px] text-rose-600 dark:text-rose-400 font-medium">
                      Inválidos
                    </p>
                    <p className="text-lg font-bold text-rose-600 dark:text-rose-400">
                      {invalidList.length}
                    </p>
                  </div>
                </div>

                {/* Tabs to review preview lists */}
                <Tabs defaultValue="valid" className="flex-1 flex flex-col overflow-hidden">
                  <TabsList className="grid grid-cols-4 w-full h-8 text-xs shrink-0">
                    <TabsTrigger value="valid" className="text-xs">
                      Válidos ({validToImport.length})
                    </TabsTrigger>
                    <TabsTrigger value="alreadyInCrm" className="text-xs">
                      Já no CRM ({alreadyInCrm.length})
                    </TabsTrigger>
                    <TabsTrigger value="invalid" className="text-xs">
                      Inválidos ({invalidList.length})
                    </TabsTrigger>
                    <TabsTrigger value="duplicates" className="text-xs">
                      Repetidos ({duplicatesInText.length})
                    </TabsTrigger>
                  </TabsList>

                  {/* TAB: VÁLIDOS */}
                  <TabsContent value="valid" className="flex-1 mt-2 overflow-hidden">
                    <ScrollArea className="h-[200px] rounded border">
                      {validToImport.length === 0 ? (
                        <div className="p-8 text-center text-sm text-muted-foreground">
                          Nenhum número novo para salvar.
                          {alreadyInCrm.length > 0 && (
                            <div className="mt-2 text-xs text-emerald-600">
                              Os {alreadyInCrm.length} contatos encontrados já estão salvos e podem ser etiquetados como &quot;{tagName}&quot;!
                            </div>
                          )}
                        </div>
                      ) : (
                        <Table>
                          <TableHeader>
                            <TableRow>
                              <TableHead className="w-12 text-center text-xs">#</TableHead>
                              <TableHead className="text-xs">Telefone Normalizado (+55)</TableHead>
                              <TableHead className="text-xs">Etiqueta a Receber</TableHead>
                              <TableHead className="text-xs">Tipo</TableHead>
                            </TableRow>
                          </TableHeader>
                          <TableBody>
                            {validToImport.map((item, idx) => (
                              <TableRow key={idx}>
                                <TableCell className="text-center font-mono text-[11px] text-muted-foreground">
                                  {idx + 1}
                                </TableCell>
                                <TableCell className="font-mono text-xs font-semibold text-emerald-600 dark:text-emerald-400">
                                  {item.normalized}
                                </TableCell>
                                <TableCell>
                                  <Badge className="bg-emerald-500/20 text-emerald-700 dark:text-emerald-300 text-[10px] py-0 border-0">
                                    <Tag className="size-2.5 mr-1 inline" />
                                    {tagName}
                                  </Badge>
                                </TableCell>
                                <TableCell>
                                  <Badge variant="outline" className="text-[10px] py-0">
                                    {item.type === 'mobile' ? 'Celular' : 'Fixo'}
                                  </Badge>
                                </TableCell>
                              </TableRow>
                            ))}
                          </TableBody>
                        </Table>
                      )}
                    </ScrollArea>
                  </TabsContent>

                  {/* TAB: JÁ NO CRM */}
                  <TabsContent value="alreadyInCrm" className="flex-1 mt-2 overflow-hidden">
                    <div className="flex flex-col h-[200px]">
                      {alreadyInCrm.length > 0 && (
                        <div className="flex items-center justify-between p-2 bg-muted/40 border-b text-xs">
                          <span className="text-muted-foreground">
                            {alreadyInCrm.length} contatos já cadastrados no CRM:
                          </span>
                          <Button
                            size="sm"
                            variant="secondary"
                            onClick={handleTagExistingOnly}
                            disabled={isTaggingExisting || alreadyInCrm.length === 0}
                            className="h-6 text-xs text-emerald-700 dark:text-emerald-300 bg-emerald-500/20 hover:bg-emerald-500/30"
                          >
                            {isTaggingExisting ? (
                              <Loader2 className="size-3 animate-spin mr-1" />
                            ) : (
                              <Check className="size-3 mr-1" />
                            )}
                            Etiquetar estes {alreadyInCrm.length} agora como &quot;{tagName}&quot;
                          </Button>
                        </div>
                      )}
                      <ScrollArea className="flex-1 rounded-b border">
                        {alreadyInCrm.length === 0 ? (
                          <div className="p-8 text-center text-sm text-muted-foreground">
                            Nenhum contato da lista existe atualmente no CRM.
                          </div>
                        ) : (
                          <Table>
                            <TableHeader>
                              <TableRow>
                                <TableHead className="w-12 text-center text-xs">#</TableHead>
                                <TableHead className="text-xs">Telefone</TableHead>
                                <TableHead className="text-xs">Status</TableHead>
                                <TableHead className="text-xs">Etiquetagem</TableHead>
                              </TableRow>
                            </TableHeader>
                            <TableBody>
                              {alreadyInCrm.map((item, idx) => (
                                <TableRow key={idx}>
                                  <TableCell className="text-center font-mono text-[11px] text-muted-foreground">
                                    {idx + 1}
                                  </TableCell>
                                  <TableCell className="font-mono text-xs text-amber-600 dark:text-amber-400">
                                    {item.normalized}
                                  </TableCell>
                                  <TableCell>
                                    <Badge variant="outline" className="text-[10px] text-amber-600 border-amber-300">
                                      Já Cadastrado
                                    </Badge>
                                  </TableCell>
                                  <TableCell>
                                    <span className="text-xs text-muted-foreground">
                                      {tagExistingInCrm ? (
                                        <Badge className="bg-emerald-500/10 text-emerald-600 text-[10px] py-0 border border-emerald-500/30">
                                          Receberá &quot;{tagName}&quot;
                                        </Badge>
                                      ) : (
                                        'Não alterar'
                                      )}
                                    </span>
                                  </TableCell>
                                </TableRow>
                              ))}
                            </TableBody>
                          </Table>
                        )}
                      </ScrollArea>
                    </div>
                  </TabsContent>

                  {/* TAB: INVÁLIDOS */}
                  <TabsContent value="invalid" className="flex-1 mt-2 overflow-hidden">
                    <ScrollArea className="h-[200px] rounded border">
                      {invalidList.length === 0 ? (
                        <div className="p-8 text-center text-sm text-muted-foreground">
                          Nenhum número inválido encontrado! Lista 100% limpa.
                        </div>
                      ) : (
                        <Table>
                          <TableHeader>
                            <TableRow>
                              <TableHead className="w-12 text-center text-xs">Linha</TableHead>
                              <TableHead className="text-xs">Texto Informado</TableHead>
                              <TableHead className="text-xs">Motivo da Invalidação</TableHead>
                            </TableRow>
                          </TableHeader>
                          <TableBody>
                            {invalidList.map((item, idx) => (
                              <TableRow key={idx}>
                                <TableCell className="text-center font-mono text-[11px] text-muted-foreground">
                                  {item.lineNumber}
                                </TableCell>
                                <TableCell className="font-mono text-xs text-rose-600 dark:text-rose-400">
                                  {item.raw}
                                </TableCell>
                                <TableCell className="text-xs text-muted-foreground">
                                  {item.reason}
                                </TableCell>
                              </TableRow>
                            ))}
                          </TableBody>
                        </Table>
                      )}
                    </ScrollArea>
                  </TabsContent>

                  {/* TAB: REPETIDOS NO TEXTO */}
                  <TabsContent value="duplicates" className="flex-1 mt-2 overflow-hidden">
                    <ScrollArea className="h-[200px] rounded border">
                      {duplicatesInText.length === 0 ? (
                        <div className="p-8 text-center text-sm text-muted-foreground">
                          Nenhum número repetido dentro da lista colada.
                        </div>
                      ) : (
                        <Table>
                          <TableHeader>
                            <TableRow>
                              <TableHead className="w-12 text-center text-xs">#</TableHead>
                              <TableHead className="text-xs">Telefone Normalizado</TableHead>
                              <TableHead className="text-xs">Original</TableHead>
                              <TableHead className="text-xs">Status</TableHead>
                            </TableRow>
                          </TableHeader>
                          <TableBody>
                            {duplicatesInText.map((item, idx) => (
                              <TableRow key={idx}>
                                <TableCell className="text-center font-mono text-[11px] text-muted-foreground">
                                  {idx + 1}
                                </TableCell>
                                <TableCell className="font-mono text-xs">
                                  {item.normalized}
                                </TableCell>
                                <TableCell className="text-xs text-muted-foreground">
                                  {item.raw}
                                </TableCell>
                                <TableCell>
                                  <Badge variant="outline" className="text-[10px] text-blue-600 border-blue-300">
                                    Duplicado na lista
                                  </Badge>
                                </TableCell>
                              </TableRow>
                            ))}
                          </TableBody>
                        </Table>
                      )}
                    </ScrollArea>
                  </TabsContent>
                </Tabs>

                {/* Progress bar during batch import */}
                {importing && (
                  <div className="space-y-2 p-3 bg-muted/40 rounded-lg border">
                    <div className="flex items-center justify-between text-xs">
                      <span className="flex items-center gap-1.5 font-medium">
                        <Loader2 className="size-3.5 animate-spin text-primary" />
                        Importando e etiquetando lote {progress.chunk} de {progress.totalChunks}...
                      </span>
                      <span className="font-mono text-muted-foreground">
                        {progress.current} / {progress.total} ({progress.percent}%)
                      </span>
                    </div>
                    <Progress value={progress.percent} className="h-2" />
                  </div>
                )}
              </div>
            )}

            {/* ACTION FOOTER */}
            <DialogFooter className="shrink-0 flex items-center justify-between pt-2 border-t mt-2">
              {!hasValidated ? (
                <>
                  <Button
                    variant="ghost"
                    onClick={() => handleOpenChange(false)}
                    disabled={isValidating}
                  >
                    Cancelar
                  </Button>
                  <Button
                    onClick={handleValidate}
                    disabled={isValidating || detectedLinesCount === 0}
                    className="bg-primary text-primary-foreground hover:bg-primary/90"
                  >
                    {isValidating ? (
                      <>
                        <Loader2 className="size-4 animate-spin mr-2" />
                        Validando números...
                      </>
                    ) : (
                      <>
                        <Sparkles className="size-4 mr-2" />
                        Validar números
                      </>
                    )}
                  </Button>
                </>
              ) : (
                <>
                  <Button
                    variant="outline"
                    onClick={() => setHasValidated(false)}
                    disabled={importing}
                  >
                    Editar lista
                  </Button>
                  <Button
                    onClick={handleImport}
                    disabled={
                      importing ||
                      (validToImport.length === 0 && (!tagExistingInCrm || alreadyInCrm.length === 0))
                    }
                    className="bg-primary text-primary-foreground hover:bg-primary/90"
                  >
                    {importing ? (
                      <>
                        <Loader2 className="size-4 animate-spin mr-2" />
                        Processando ({progress.percent}%)...
                      </>
                    ) : (
                      <>
                        <ArrowRight className="size-4 mr-2" />
                        Salvar e Etiquetar ({validToImport.length + (tagExistingInCrm ? alreadyInCrm.length : 0)} contatos)
                      </>
                    )}
                  </Button>
                </>
              )}
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
