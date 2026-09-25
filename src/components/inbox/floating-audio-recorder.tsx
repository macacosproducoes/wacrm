"use client";

import React from "react";
import { Mic, Send, X } from "lucide-react";
import { Button } from "@/components/ui/button";

export interface ActiveAudioRecording {
  id: string;
  conversationId: string;
  recipientName: string;
  recipientPhone?: string;
  audioTitle: string;
  mediaUrl: string;
  remainingSeconds: number;
  totalSeconds: number;
}

interface FloatingAudioRecorderProps {
  recordings: ActiveAudioRecording[];
  onSendNow: (recordingId: string) => void;
  onCancel: (recordingId: string) => void;
}

export function FloatingAudioRecorder({
  recordings,
  onSendNow,
  onCancel,
}: FloatingAudioRecorderProps) {
  if (!recordings || recordings.length === 0) {
    return null;
  }

  return (
    <div
      aria-label="Fila de gravações de áudio ativas"
      className="fixed top-5 right-5 z-50 flex flex-col gap-3 max-w-sm w-full pointer-events-auto transition-all duration-300"
    >
      {recordings.map((rec) => {
        const progressPercent = Math.max(
          0,
          Math.min(
            100,
            ((rec.totalSeconds - rec.remainingSeconds) / (rec.totalSeconds || 1)) * 100
          )
        );

        const displayName = rec.recipientName?.trim() || rec.recipientPhone || "Lead";

        return (
          <div
            key={rec.id}
            className="rounded-2xl border-2 border-emerald-500/50 bg-background/95 backdrop-blur-md p-4 shadow-2xl transition-all duration-200 animate-in slide-in-from-top-4"
          >
            {/* Header: Destinatário específico */}
            <div className="flex items-start justify-between gap-3">
              <div className="flex items-center gap-2.5 min-w-0">
                <div className="relative flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-emerald-500 text-white shadow-md shadow-emerald-500/20">
                  <Mic className="h-5 w-5 animate-pulse" />
                  <span className="absolute -top-1 -right-1 flex h-3 w-3">
                    <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
                    <span className="relative inline-flex rounded-full h-3 w-3 bg-emerald-500"></span>
                  </span>
                </div>

                <div className="min-w-0">
                  <div className="text-[11px] font-extrabold uppercase tracking-wider text-emerald-600 dark:text-emerald-400 flex items-center gap-1">
                    <span>Gravando áudio para</span>
                  </div>
                  <div
                    className="font-bold text-sm text-foreground truncate max-w-[200px]"
                    title={displayName}
                  >
                    {displayName}
                  </div>
                </div>
              </div>

              <div className="text-right shrink-0">
                <span className="font-mono text-sm font-bold text-emerald-600 dark:text-emerald-400">
                  {rec.remainingSeconds}s
                </span>
                <div className="text-[10px] text-muted-foreground">restantes</div>
              </div>
            </div>

            {/* Audio Title info */}
            <div className="mt-2.5 flex items-center justify-between text-xs rounded-lg bg-muted/60 px-2.5 py-1.5 border border-border/50">
              <span className="truncate font-medium text-foreground max-w-[190px]" title={rec.audioTitle}>
                🎙️ {rec.audioTitle}
              </span>
              <span className="text-[10px] font-mono text-muted-foreground">
                Total: {rec.totalSeconds}s
              </span>
            </div>

            {/* Realistic Audio Waveform animation */}
            <div className="mt-2.5 flex items-center gap-1 h-3.5 overflow-hidden px-1">
              {[35, 75, 100, 60, 85, 45, 90, 70, 50, 95, 80, 65, 40, 75, 90, 55, 80, 70, 45, 85, 95, 60].map((h, i) => (
                <span
                  key={i}
                  className="flex-1 bg-emerald-500 rounded-full animate-pulse"
                  style={{
                    height: `${h}%`,
                    animationDelay: `${(i % 6) * 110}ms`,
                    animationDuration: "750ms",
                  }}
                />
              ))}
            </div>

            {/* Progress bar */}
            <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-muted">
              <div
                className="h-full bg-emerald-500 transition-all duration-1000 ease-linear rounded-full"
                style={{ width: `${progressPercent}%` }}
              />
            </div>

            {/* Actions: Enviar Agora / Cancelar */}
            <div className="mt-3.5 flex items-center justify-end gap-2 pt-1 border-t border-border/60">
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() => onCancel(rec.id)}
                className="h-7 px-2.5 text-xs text-muted-foreground hover:text-rose-500 hover:bg-rose-500/10"
              >
                <X className="mr-1 h-3.5 w-3.5" />
                Cancelar
              </Button>

              <Button
                type="button"
                size="sm"
                onClick={() => onSendNow(rec.id)}
                className="h-7 px-3 text-xs bg-emerald-600 hover:bg-emerald-700 text-white font-semibold shadow-sm gap-1"
              >
                <Send className="h-3 w-3" />
                Enviar Agora
              </Button>
            </div>
          </div>
        );
      })}
    </div>
  );
}
