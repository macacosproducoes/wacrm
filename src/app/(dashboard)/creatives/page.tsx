'use client';

import { useState, useEffect, useCallback } from 'react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter } from '@/components/ui/card';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import {
  Palette,
  Plus,
  Copy,
  Archive,
  Eye,
  Edit,
  Sparkles,
  Layers,
  Search,
  Send,
  Loader2,
} from 'lucide-react';
import type { CreativeTemplate, CreativeJob } from '@/lib/creative-engine/types';
import { TemplateModal } from './template-modal';
import { PreviewModal } from './preview-modal';
import { JobsList } from './jobs-list';

export default function CreativesPage() {
  const [activeTab, setActiveTab] = useState<'templates' | 'jobs'>('templates');
  const [templates, setTemplates] = useState<CreativeTemplate[]>([]);
  const [jobs, setJobs] = useState<CreativeJob[]>([]);
  const [loadingTemplates, setLoadingTemplates] = useState(true);
  const [loadingJobs, setLoadingJobs] = useState(false);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<string>('ALL');

  // Modals state
  const [selectedTemplateForEdit, setSelectedTemplateForEdit] = useState<CreativeTemplate | null>(null);
  const [isEditOpen, setIsEditOpen] = useState(false);
  const [selectedTemplateForPreview, setSelectedTemplateForPreview] = useState<CreativeTemplate | null>(null);
  const [isPreviewOpen, setIsPreviewOpen] = useState(false);

  const fetchTemplates = useCallback(async () => {
    setLoadingTemplates(true);
    try {
      const res = await fetch('/api/creatives/templates');
      const data = await res.json();
      if (res.ok && data.templates) {
        setTemplates(data.templates);
      }
    } catch (err) {
      console.error('Error fetching templates:', err);
    } finally {
      setLoadingTemplates(false);
    }
  }, []);

  const fetchJobs = useCallback(async () => {
    setLoadingJobs(true);
    try {
      const res = await fetch('/api/creatives/jobs?limit=50');
      const data = await res.json();
      if (res.ok && data.jobs) {
        setJobs(data.jobs);
      }
    } catch (err) {
      console.error('Error fetching jobs:', err);
    } finally {
      setLoadingJobs(false);
    }
  }, []);

  useEffect(() => {
    void fetchTemplates();
    void fetchJobs();
  }, [fetchTemplates, fetchJobs]);

  const handleDuplicate = async (tpl: CreativeTemplate) => {
    try {
      const res = await fetch(`/api/creatives/templates/${tpl.id}/duplicate`, {
        method: 'POST',
      });
      if (res.ok) {
        await fetchTemplates();
      }
    } catch (err) {
      console.error('Failed to duplicate template:', err);
    }
  };

  const handleArchive = async (tpl: CreativeTemplate) => {
    if (!confirm(`Deseja realmente arquivar o template "${tpl.name}"?`)) return;
    try {
      const res = await fetch(`/api/creatives/templates/${tpl.id}`, {
        method: 'DELETE',
      });
      if (res.ok) {
        await fetchTemplates();
      }
    } catch (err) {
      console.error('Failed to archive template:', err);
    }
  };

  const filteredTemplates = templates.filter((tpl) => {
    const matchesSearch =
      tpl.name.toLowerCase().includes(search.toLowerCase()) ||
      (tpl.description || '').toLowerCase().includes(search.toLowerCase()) ||
      tpl.category.toLowerCase().includes(search.toLowerCase());

    const matchesStatus = statusFilter === 'ALL' || tpl.status === statusFilter;
    return matchesSearch && matchesStatus;
  });

  const totalGenerated = jobs.filter((j) => ['GENERATED', 'READY', 'SENT'].includes(j.status)).length;
  const totalSent = jobs.filter((j) => j.status === 'SENT').length;

  return (
    <div className="flex flex-col gap-6 max-w-7xl mx-auto pb-12">
      {/* Top Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-border/80 pb-5">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-foreground flex items-center gap-2.5">
            <Palette className="w-6 h-6 text-primary" />
            Creative Engine
          </h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            Geração determinística de criativos, layouts parametrizados e entrega automatizada multi-canal.
          </p>
        </div>
        <div className="flex items-center gap-2.5">
          <Button
            onClick={() => {
              setSelectedTemplateForEdit(null);
              setIsEditOpen(true);
            }}
            className="gap-1.5 shadow-sm"
          >
            <Plus className="w-4 h-4" /> Novo Template
          </Button>
        </div>
      </div>

      {/* Metrics Banner */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <div className="p-4 rounded-xl border border-border bg-card/60 flex items-center justify-between">
          <div className="flex flex-col">
            <span className="text-xs font-medium text-muted-foreground">Templates Ativos</span>
            <span className="text-2xl font-bold text-foreground mt-1">
              {templates.filter((t) => t.status === 'ACTIVE').length}
            </span>
          </div>
          <div className="w-10 h-10 rounded-lg bg-primary/10 flex items-center justify-center text-primary">
            <Layers className="w-5 h-5" />
          </div>
        </div>

        <div className="p-4 rounded-xl border border-border bg-card/60 flex items-center justify-between">
          <div className="flex flex-col">
            <span className="text-xs font-medium text-muted-foreground">Criativos Gerados</span>
            <span className="text-2xl font-bold text-foreground mt-1">{totalGenerated}</span>
          </div>
          <div className="w-10 h-10 rounded-lg bg-sky-500/10 flex items-center justify-center text-sky-400">
            <Sparkles className="w-5 h-5" />
          </div>
        </div>

        <div className="p-4 rounded-xl border border-border bg-card/60 flex items-center justify-between">
          <div className="flex flex-col">
            <span className="text-xs font-medium text-muted-foreground">Entregas Concluídas</span>
            <span className="text-2xl font-bold text-foreground mt-1">{totalSent}</span>
          </div>
          <div className="w-10 h-10 rounded-lg bg-emerald-500/10 flex items-center justify-center text-emerald-400">
            <Send className="w-5 h-5" />
          </div>
        </div>
      </div>

      {/* Main Tabs */}
      <Tabs
        value={activeTab}
        onValueChange={(v) => {
          setActiveTab(v as 'templates' | 'jobs');
          if (v === 'jobs') void fetchJobs();
        }}
        className="w-full"
      >
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-border pb-3">
          <TabsList className="grid grid-cols-2 w-full sm:w-auto">
            <TabsTrigger value="templates" className="px-5">
              Templates ({templates.length})
            </TabsTrigger>
            <TabsTrigger value="jobs" className="px-5">
              Histórico de Jobs ({jobs.length})
            </TabsTrigger>
          </TabsList>

          {activeTab === 'templates' && (
            <div className="flex items-center gap-2">
              <div className="relative flex-1 sm:w-64">
                <Search className="w-3.5 h-3.5 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
                <input
                  type="text"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Buscar templates..."
                  className="w-full text-xs pl-8 pr-3 py-1.5 rounded-lg bg-background border border-input focus:outline-none focus:ring-1 focus:ring-primary"
                />
              </div>

              <select
                value={statusFilter}
                onChange={(e) => setStatusFilter(e.target.value)}
                className="text-xs px-2.5 py-1.5 rounded-lg bg-background border border-input focus:outline-none text-muted-foreground"
              >
                <option value="ALL">Todos os status</option>
                <option value="ACTIVE">Ativos</option>
                <option value="DRAFT">Rascunhos</option>
                <option value="ARCHIVED">Arquivados</option>
              </select>
            </div>
          )}
        </div>

        {/* Templates Tab Content */}
        <TabsContent value="templates" className="mt-6">
          {loadingTemplates ? (
            <div className="py-16 flex flex-col items-center justify-center text-muted-foreground">
              <Loader2 className="w-8 h-8 animate-spin text-primary mb-2" />
              <span className="text-sm">Carregando catálogo de templates...</span>
            </div>
          ) : filteredTemplates.length === 0 ? (
            <div className="py-16 text-center border border-dashed border-border rounded-xl p-8 bg-card/20">
              <Palette className="w-10 h-10 text-muted-foreground mx-auto mb-3 opacity-40" />
              <h3 className="text-sm font-semibold text-foreground">Nenhum template encontrado</h3>
              <p className="text-xs text-muted-foreground mt-1 max-w-sm mx-auto">
                Crie seu primeiro template visual com variáveis parametrizáveis para renderização determinística.
              </p>
              <Button
                size="sm"
                onClick={() => {
                  setSelectedTemplateForEdit(null);
                  setIsEditOpen(true);
                }}
                className="mt-4 gap-1.5"
              >
                <Plus className="w-4 h-4" /> Criar Template
              </Button>
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">
              {filteredTemplates.map((tpl) => (
                <Card
                  key={tpl.id}
                  className="group hover:border-primary/50 transition-all duration-200 flex flex-col justify-between overflow-hidden shadow-sm"
                >
                  <CardHeader className="pb-3">
                    <div className="flex items-start justify-between gap-2">
                      <div className="flex items-center gap-2">
                        <Badge
                          variant={
                            tpl.status === 'ACTIVE'
                              ? 'default'
                              : tpl.status === 'DRAFT'
                              ? 'secondary'
                              : 'outline'
                          }
                          className="text-[10px] uppercase font-semibold tracking-wider"
                        >
                          {tpl.status}
                        </Badge>
                        <Badge variant="outline" className="text-[10px] font-mono">
                          v{tpl.version}
                        </Badge>
                      </div>
                      <span className="text-[11px] font-mono text-muted-foreground bg-muted/60 px-2 py-0.5 rounded">
                        {tpl.definition?.width || 1080}×{tpl.definition?.height || 1080}
                      </span>
                    </div>

                    <CardTitle className="text-base font-bold text-foreground mt-2 group-hover:text-primary transition-colors">
                      {tpl.name}
                    </CardTitle>
                    <CardDescription className="text-xs line-clamp-2 mt-1">
                      {tpl.description || 'Sem descrição cadastrada.'}
                    </CardDescription>
                  </CardHeader>

                  <CardContent className="pb-3 pt-0 text-xs text-muted-foreground">
                    <div className="flex items-center justify-between text-[11px] border-t border-border/50 pt-2.5">
                      <span>Categoria: <strong className="text-foreground font-medium">{tpl.category}</strong></span>
                      <span>{tpl.definition?.elements?.length || 0} elementos</span>
                    </div>
                  </CardContent>

                  <CardFooter className="pt-2 pb-3 bg-muted/20 border-t border-border/50 flex items-center justify-between">
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-8 gap-1.5 text-xs"
                      onClick={() => {
                        setSelectedTemplateForPreview(tpl);
                        setIsPreviewOpen(true);
                      }}
                    >
                      <Eye className="w-3.5 h-3.5 text-primary" /> Testar & Preview
                    </Button>

                    <div className="flex items-center gap-1">
                      <Button
                        size="icon"
                        variant="ghost"
                        className="h-8 w-8 text-muted-foreground hover:text-foreground"
                        title="Duplicar"
                        onClick={() => handleDuplicate(tpl)}
                      >
                        <Copy className="w-3.5 h-3.5" />
                      </Button>
                      <Button
                        size="icon"
                        variant="ghost"
                        className="h-8 w-8 text-muted-foreground hover:text-foreground"
                        title="Editar"
                        onClick={() => {
                          setSelectedTemplateForEdit(tpl);
                          setIsEditOpen(true);
                        }}
                      >
                        <Edit className="w-3.5 h-3.5" />
                      </Button>
                      {tpl.status !== 'ARCHIVED' && (
                        <Button
                          size="icon"
                          variant="ghost"
                          className="h-8 w-8 text-muted-foreground hover:text-destructive"
                          title="Arquivar"
                          onClick={() => handleArchive(tpl)}
                        >
                          <Archive className="w-3.5 h-3.5" />
                        </Button>
                      )}
                    </div>
                  </CardFooter>
                </Card>
              ))}
            </div>
          )}
        </TabsContent>

        {/* Jobs History Tab Content */}
        <TabsContent value="jobs" className="mt-6">
          <JobsList jobs={jobs} loading={loadingJobs} onRefresh={fetchJobs} />
        </TabsContent>
      </Tabs>

      {/* Editor Modal */}
      {isEditOpen && (
        <TemplateModal
          template={selectedTemplateForEdit}
          isOpen={isEditOpen}
          onClose={() => setIsEditOpen(false)}
          onSaved={() => {
            void fetchTemplates();
          }}
        />
      )}

      {/* Preview Modal */}
      {isPreviewOpen && (
        <PreviewModal
          template={selectedTemplateForPreview}
          isOpen={isPreviewOpen}
          onClose={() => setIsPreviewOpen(false)}
        />
      )}
    </div>
  );
}
