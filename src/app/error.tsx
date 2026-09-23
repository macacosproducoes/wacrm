"use client";

import { useEffect } from "react";
import { AlertTriangle, RefreshCw, Home } from "lucide-react";
import { Button } from "@/components/ui/button";

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("[GLOBAL_APP_ERROR]", error);
  }, [error]);

  return (
    <div className="flex min-h-screen flex-col items-center justify-center p-6 text-center bg-background">
      <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-destructive/10 text-destructive mb-4">
        <AlertTriangle className="h-7 w-7" />
      </div>
      <h2 className="text-lg font-bold text-foreground">
        Erro ao carregar a página
      </h2>
      <p className="mt-1 max-w-md text-xs text-muted-foreground leading-relaxed">
        {error?.message || "Ocorreu um erro inesperado ao renderizar esta página."}
      </p>
      {error?.digest && (
        <code className="mt-2 text-[10px] text-muted-foreground/60 bg-muted px-2 py-0.5 rounded font-mono">
          Ref: {error.digest}
        </code>
      )}
      <div className="mt-6 flex items-center gap-3">
        <Button
          onClick={() => {
            if (typeof window !== "undefined") {
              window.location.href = "/dashboard";
            }
          }}
          variant="outline"
          size="sm"
          className="gap-2 cursor-pointer"
        >
          <Home className="h-4 w-4" />
          Ir para Início
        </Button>
        <Button
          onClick={() => reset()}
          size="sm"
          className="gap-2 bg-primary text-primary-foreground hover:bg-primary/90 cursor-pointer"
        >
          <RefreshCw className="h-4 w-4" />
          Recarregar
        </Button>
      </div>
    </div>
  );
}
