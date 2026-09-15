"use client";

import { useEffect, useState, useCallback } from "react";
import { toast } from "sonner";
import {
  Tag,
  Plus,
  FolderOpen,
  Palette,
  Check,
  Layers,
  Sparkles,
  Search,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { QuickRepliesManager } from "@/components/settings/quick-replies-manager";
import type { QuickReplyCategory } from "@/lib/inbox/categories";

const PRESET_COLORS = [
  "#EAB308",
  "#3B82F6",
  "#8B5CF6",
  "#10B981",
  "#F59E0B",
  "#06B6D4",
  "#6366F1",
  "#EC4899",
  "#EF4444",
  "#14B8A6",
  "#84CC16",
  "#64748B",
  "#A855F7",
  "#0EA5E9",
  "#F97316",
  "#94A3B8",
];

export function CentralLibraryTab() {
  const [categories, setCategories] = useState<QuickReplyCategory[]>([]);
  const [loadingCats, setLoadingCats] = useState(false);
  const [createModalOpen, setCreateModalOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [catName, setCatName] = useState("");
  const [catDesc, setCatDesc] = useState("");
  const [catColor, setCatColor] = useState("#3B82F6");
  const [catIcon, setCatIcon] = useState("Tag");

  const loadCategories = useCallback(async () => {
    setLoadingCats(true);
    try {
      const res = await fetch("/api/quick-replies/categories");
      if (res.ok) {
        const data = await res.json();
        setCategories(data.data || []);
      }
    } catch (err) {
      console.error("Failed to load categories", err);
    } finally {
      setLoadingCats(false);
    }
  }, []);

  useEffect(() => {
    loadCategories();
  }, [loadCategories]);

  async function handleCreateCategory() {
    if (!catName.trim()) {
      toast.error("O nome da categoria é obrigatório");
      return;
    }

    setCreating(true);
    try {
      const res = await fetch("/api/quick-replies/categories", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: catName.trim(),
          description: catDesc.trim() || null,
          color: catColor,
          icon: catIcon,
        }),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || "Erro ao salvar categoria");
      }

      toast.success("Categoria criada com sucesso!");
      setCreateModalOpen(false);
      setCatName("");
      setCatDesc("");
      loadCategories();
    } catch (err: any) {
      toast.error(err.message || "Erro ao criar categoria");
    } finally {
      setCreating(false);
    }
  }

  return (
    <div className="space-y-8">
      {/* Seção de Categorias */}
      <div className="rounded-2xl border border-border bg-card p-5 space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div>
            <h3 className="text-base font-semibold text-foreground flex items-center gap-2">
              <FolderOpen className="h-5 w-5 text-primary" />
              Categorias de Mensagens
            </h3>
            <p className="text-xs text-muted-foreground mt-0.5">
              Organize suas respostas rápidas e automações por categoria temática.
            </p>
          </div>
          <Button
            size="sm"
            variant="outline"
            onClick={() => setCreateModalOpen(true)}
            className="gap-1.5 text-xs h-8"
          >
            <Plus className="h-3.5 w-3.5" />
            Nova Categoria
          </Button>
        </div>

        {/* Categories Pills Grid */}
        <div className="flex flex-wrap gap-2 pt-1">
          {categories.map((cat) => (
            <div
              key={cat.id || cat.name}
              className="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg border border-border/80 bg-background/60 text-xs text-foreground transition-all hover:border-border"
            >
              <span
                className="w-2.5 h-2.5 rounded-full shrink-0"
                style={{ backgroundColor: cat.color || "#94a3b8" }}
              />
              <span className="font-medium">{cat.name}</span>
              {!cat.is_system && (
                <span className="text-[10px] text-muted-foreground bg-muted px-1.5 py-0.2 rounded">
                  Personalizada
                </span>
              )}
            </div>
          ))}
        </div>
      </div>

      {/* Gerenciador Central de Respostas (ZapPlus QuickRepliesManager) */}
      <div className="pt-2">
        <QuickRepliesManager />
      </div>

      {/* Modal Criar Categoria */}
      <Dialog open={createModalOpen} onOpenChange={setCreateModalOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Criar Categoria Personalizada</DialogTitle>
          </DialogHeader>

          <div className="space-y-4 py-2">
            <div>
              <label className="text-xs font-medium text-foreground block mb-1">
                Nome da Categoria *
              </label>
              <Input
                placeholder="Ex: Reativação Black Friday"
                value={catName}
                onChange={(e) => setCatName(e.target.value)}
                className="h-9 text-xs"
              />
            </div>

            <div>
              <label className="text-xs font-medium text-foreground block mb-1">
                Descrição (opcional)
              </label>
              <Input
                placeholder="Para que serve essa categoria..."
                value={catDesc}
                onChange={(e) => setCatDesc(e.target.value)}
                className="h-9 text-xs"
              />
            </div>

            <div>
              <label className="text-xs font-medium text-foreground block mb-2">
                Cor de Identificação
              </label>
              <div className="flex flex-wrap gap-2 items-center">
                {PRESET_COLORS.map((col) => (
                  <button
                    key={col}
                    type="button"
                    onClick={() => setCatColor(col)}
                    className="w-7 h-7 rounded-full flex items-center justify-center transition-transform hover:scale-110 relative"
                    style={{ backgroundColor: col }}
                  >
                    {catColor.toLowerCase() === col.toLowerCase() && (
                      <Check className="h-4 w-4 text-white drop-shadow-sm" />
                    )}
                  </button>
                ))}
              </div>
            </div>
          </div>

          <DialogFooter>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setCreateModalOpen(false)}
              disabled={creating}
            >
              Cancelar
            </Button>
            <Button
              size="sm"
              onClick={handleCreateCategory}
              disabled={creating || !catName.trim()}
              className="bg-primary text-primary-foreground"
            >
              {creating ? "Criando..." : "Criar Categoria"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
