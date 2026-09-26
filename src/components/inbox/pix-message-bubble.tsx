"use client";

import { useState } from "react";
import { Copy, Check, QrCode } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

interface PixMessageBubbleProps {
  payload: {
    type?: string;
    pix_key: string;
    pix_key_type?: string;
    pix_merchant_name?: string;
    sent_at?: string;
    [key: string]: unknown;
  };
  contentText?: string;
  isAgent?: boolean;
}

export function PixMessageBubble({ payload, contentText, isAgent }: PixMessageBubbleProps) {
  const [copied, setCopied] = useState(false);

  const pixKey = payload.pix_key || "";
  const keyType = payload.pix_key_type || "PIX";
  const merchantName = payload.pix_merchant_name || "Pix";

  const handleCopy = () => {
    if (!pixKey) return;
    navigator.clipboard.writeText(pixKey);
    setCopied(true);
    toast.success("Chave PIX copiada para a área de transferência!");
    setTimeout(() => setCopied(false), 2500);
  };

  // If there is intro text preceding the PIX key
  const introText = contentText
    ? contentText.replace(/\[(Chave PIX|PIX Copia e Cola)[^\]]*\]/gi, "").trim()
    : "";

  return (
    <div className="w-full max-w-[280px] space-y-2">
      {introText ? (
        <p className="whitespace-pre-wrap break-words text-sm font-sans leading-relaxed">
          {introText}
        </p>
      ) : null}

      <div className="overflow-hidden rounded-xl border border-emerald-500/30 bg-emerald-500/5 shadow-sm text-foreground">
        {/* WhatsApp Pay / PIX Header */}
        <div className="flex items-center justify-between border-b border-emerald-500/20 bg-emerald-500/10 px-3 py-2">
          <div className="flex items-center gap-1.5">
            <div className="flex h-5 w-5 items-center justify-center rounded-full bg-emerald-600 text-white shadow-xs">
              <QrCode className="h-3 w-3" />
            </div>
            <span className="text-xs font-bold text-emerald-800 dark:text-emerald-300">
              Pagamento PIX
            </span>
          </div>
          <span className="rounded bg-emerald-500/20 px-1.5 py-0.5 text-[9px] font-mono font-bold uppercase text-emerald-700 dark:text-emerald-300">
            {keyType === "COPIA_E_COLA" ? "Copia e Cola" : keyType}
          </span>
        </div>

        {/* PIX Details */}
        <div className="p-3 space-y-1.5">
          <div>
            <span className="text-[10px] font-medium uppercase text-muted-foreground block">
              Recebedor
            </span>
            <span className="text-xs font-semibold text-foreground truncate block">
              {merchantName}
            </span>
          </div>

          <div>
            <span className="text-[10px] font-medium uppercase text-muted-foreground block">
              {keyType === "COPIA_E_COLA" ? "Código Copia e Cola" : "Chave PIX"}
            </span>
            <span className="text-xs font-mono font-medium text-foreground break-all select-all block bg-background/60 p-1.5 rounded border border-border/50">
              {pixKey}
            </span>
          </div>
        </div>

        {/* Native Action Button */}
        <button
          type="button"
          onClick={handleCopy}
          className="flex w-full items-center justify-center gap-1.5 border-t border-emerald-500/20 bg-emerald-600/10 hover:bg-emerald-600/20 py-2.5 text-xs font-semibold text-emerald-700 dark:text-emerald-300 transition-colors cursor-pointer"
        >
          {copied ? (
            <>
              <Check className="h-3.5 w-3.5 text-emerald-600" />
              <span>Chave Copiada!</span>
            </>
          ) : (
            <>
              <Copy className="h-3.5 w-3.5 text-emerald-600" />
              <span>Copiar Chave PIX</span>
            </>
          )}
        </button>
      </div>
    </div>
  );
}
