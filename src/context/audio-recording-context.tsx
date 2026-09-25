"use client";

import React, {
  createContext,
  useContext,
  useState,
  useCallback,
  useRef,
  useEffect,
} from "react";
import { toast } from "sonner";
import {
  FloatingAudioRecorder,
  type ActiveAudioRecording,
} from "@/components/inbox/floating-audio-recorder";
import type { QuickReply } from "@/types";

export interface StartAudioRecordingParams {
  conversationId: string;
  recipientName: string;
  recipientPhone?: string;
  qr: QuickReply;
  simulateRecording?: boolean;
  replyToId?: string;
}

interface AudioRecordingContextType {
  recordings: ActiveAudioRecording[];
  startAudioRecording: (params: StartAudioRecordingParams) => Promise<void>;
  cancelRecording: (recordingId: string) => void;
  sendNowRecording: (recordingId: string) => Promise<void>;
}

const AudioRecordingContext = createContext<AudioRecordingContextType | null>(null);

export function useAudioRecording() {
  const ctx = useContext(AudioRecordingContext);
  if (!ctx) {
    throw new Error("useAudioRecording must be used within an AudioRecordingProvider");
  }
  return ctx;
}

export function AudioRecordingProvider({ children }: { children: React.ReactNode }) {
  const [recordings, setRecordings] = useState<ActiveAudioRecording[]>([]);
  const recordingsRef = useRef<ActiveAudioRecording[]>([]);
  recordingsRef.current = recordings;

  const timersRef = useRef<Map<string, NodeJS.Timeout>>(new Map());

  // Cleanup all timers on unmount
  useEffect(() => {
    return () => {
      timersRef.current.forEach((timer) => clearInterval(timer));
      timersRef.current.clear();
    };
  }, []);

  const deliverAudio = useCallback(async (rec: ActiveAudioRecording) => {
    try {
      // Clear presence in WhatsApp
      void fetch("/api/whatsapp/presence", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          conversationId: rec.conversationId,
          presence: "paused",
        }),
      }).catch(() => {});

      const res = await fetch("/api/whatsapp/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          conversation_id: rec.conversationId,
          message_type: "audio",
          media_url: rec.mediaUrl,
          is_ptt: true,
        }),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || `HTTP ${res.status}`);
      }

      toast.success(`🎙️ Áudio "${rec.audioTitle}" enviado com sucesso para ${rec.recipientName}!`);
    } catch (err: any) {
      console.error("[AudioRecordingProvider] Delivery failed:", err);
      toast.error(`Falha ao enviar áudio "${rec.audioTitle}": ${err.message || "Erro de rede"}`);
    }
  }, []);

  const cancelRecording = useCallback((recordingId: string) => {
    const timer = timersRef.current.get(recordingId);
    if (timer) {
      clearInterval(timer);
      timersRef.current.delete(recordingId);
    }

    const rec = recordingsRef.current.find((r) => r.id === recordingId);
    if (rec) {
      void fetch("/api/whatsapp/presence", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          conversationId: rec.conversationId,
          presence: "paused",
        }),
      }).catch(() => {});
    }

    setRecordings((prev) => prev.filter((r) => r.id !== recordingId));
    toast.info("Envio de áudio cancelado.");
  }, []);

  const sendNowRecording = useCallback(
    async (recordingId: string) => {
      const timer = timersRef.current.get(recordingId);
      if (timer) {
        clearInterval(timer);
        timersRef.current.delete(recordingId);
      }

      const rec = recordingsRef.current.find((r) => r.id === recordingId);
      if (!rec) return;

      setRecordings((prev) => prev.filter((r) => r.id !== recordingId));
      await deliverAudio(rec);
    },
    [deliverAudio]
  );

  const startAudioRecording = useCallback(
    async (params: StartAudioRecordingParams) => {
      const {
        conversationId,
        recipientName,
        recipientPhone,
        qr,
        simulateRecording = true,
      } = params;

      if (!qr.media_url) {
        toast.error("Áudio sem URL de mídia.");
        return;
      }

      const durationSec = Math.max(1, Number(qr.media_duration) || 5);

      if (!simulateRecording) {
        // Direct immediate send
        await deliverAudio({
          id: `direct_${Date.now()}`,
          conversationId,
          recipientName,
          recipientPhone,
          audioTitle: qr.title,
          mediaUrl: qr.media_url,
          totalSeconds: durationSec,
          remainingSeconds: 0,
        });
        return;
      }

      const recordingId = `rec_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;

      // 1. Send live WhatsApp presence "recording" to customer
      try {
        void fetch("/api/whatsapp/presence", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            conversationId,
            presence: "recording",
            delayMs: durationSec * 1000,
          }),
        });
      } catch (err) {
        console.error("Presence recording error:", err);
      }

      // 2. Add to active recordings
      const newRec: ActiveAudioRecording = {
        id: recordingId,
        conversationId,
        recipientName,
        recipientPhone,
        audioTitle: qr.title,
        mediaUrl: qr.media_url,
        totalSeconds: durationSec,
        remainingSeconds: durationSec,
      };

      setRecordings((prev) => [...prev, newRec]);

      // 3. Start timer
      const interval = setInterval(() => {
        setRecordings((prev) => {
          const current = prev.find((r) => r.id === recordingId);
          if (!current) {
            clearInterval(interval);
            timersRef.current.delete(recordingId);
            return prev;
          }

          if (current.remainingSeconds <= 1) {
            clearInterval(interval);
            timersRef.current.delete(recordingId);
            // Done! Send to WhatsApp
            void deliverAudio(current);
            return prev.filter((r) => r.id !== recordingId);
          }

          return prev.map((r) =>
            r.id === recordingId ? { ...r, remainingSeconds: r.remainingSeconds - 1 } : r
          );
        });
      }, 1000);

      timersRef.current.set(recordingId, interval);
      toast.info(`🎙️ Gravando áudio para ${recipientName} (${durationSec}s)...`, {
        duration: 3000,
      });
    },
    [deliverAudio]
  );

  return (
    <AudioRecordingContext.Provider
      value={{
        recordings,
        startAudioRecording,
        cancelRecording,
        sendNowRecording,
      }}
    >
      {children}
      <FloatingAudioRecorder
        recordings={recordings}
        onSendNow={sendNowRecording}
        onCancel={cancelRecording}
      />
    </AudioRecordingContext.Provider>
  );
}
