"use client";

import { useEffect } from "react";
import { AlertCircle, RefreshCw, MessageSquare } from "lucide-react";
import { Button } from "@/components/ui/button";

export default function InboxError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("[INBOX_PAGE_ERROR_CAUGHT]", error);
  }, [error]);

  return (
    <div className="flex h-[calc(100vh-8rem)] flex-col items-center justify-center p-6 text-center">
      <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-destructive/10 text-destructive mb-4">
        <AlertCircle className="h-7 w-7" />
      </div>
      <h2 className="text-lg font-semibold text-foreground">
        Erro ao carregar conversa
      </h2>
      <p className="mt-1 max-w-md text-xs text-muted-foreground leading-relaxed">
        {error?.message || "Ocorreu uma falha temporária ao sincronizar esta conversa."}
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
              window.location.href = "/inbox";
            }
          }}
          variant="outline"
          size="sm"
          className="gap-2 cursor-pointer"
        >
          <MessageSquare className="h-4 w-4" />
          Voltar para Todas as Conversas
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
