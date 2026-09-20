"use client";

import {
  useState,
  useRef,
  useCallback,
  useEffect,
  useMemo,
  KeyboardEvent,
} from "react";
import {
  Send,
  LayoutTemplate,
  Paperclip,
  Image as ImageIcon,
  Video,
  FileText,
  Mic,
  Square,
  X,
  Loader2,
  Sparkles,
  Plus,
  MessageSquareDashed,
  Zap,
  Check,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { GatedButton } from "@/components/ui/gated-button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useCan } from "@/hooks/use-can";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import {
  uploadAccountMedia,
  deleteAccountMedia,
  MEDIA_MAX_BYTES_BY_KIND,
} from "@/lib/storage/upload-media";
import { ReplyQuote } from "./reply-quote";
import { useTranslations } from "next-intl";
import {
  InteractiveBuilder,
  blankButtonsPayload,
} from "@/components/interactive/interactive-builder";
import { validateInteractivePayload } from "@/lib/whatsapp/interactive";
import type { InteractiveMessagePayload, QuickReply } from "@/types";
import { QuickReplyPicker } from "./quick-reply-picker";
import { SlashCommandMenu } from "./slash-command-menu";
import { replaceQuickReplyVariables, type VariableContext } from "@/lib/inbox/quick-reply-variables";

/** Media content types an agent can send from the composer. */
export type ComposerMediaKind = "image" | "video" | "document" | "audio";

/** Supabase Storage bucket holding agent-sent chat attachments (migration 023). */
export const CHAT_MEDIA_BUCKET = "chat-media";

/** Meta caps media captions at 1024 chars. Enforced here and in the send route. */
export const MEDIA_CAPTION_MAX = 1024;

/** Hard cap on a single voice recording so it can't blow the upload/
 *  transcode limits — auto-stops the recorder when reached. */
const MAX_RECORDING_SECONDS = 5 * 60;

export interface SendMediaPayload {
  kind: ComposerMediaKind;
  /** Public chat-media URL Meta fetches at send time. */
  mediaUrl: string;
  /** Storage object path — lets the caller GC the object if the send fails. */
  path: string;
  /** Optional caption (image/video/document only). */
  caption?: string;
  /** Original file name — surfaced to the recipient for documents. */
  filename?: string;
  replyToId?: string;
}

interface ReplyDraft {
  /** Internal UUID of the message being replied to — sent back through onSend. */
  id: string;
  authorLabel: string;
  preview: string;
}

const PICKER_ACCEPT: Record<"image" | "video" | "document", string> = {
  image: "image/png,image/jpeg,image/webp",
  video: "video/mp4,video/3gpp",
  document:
    "application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-powerpoint,application/vnd.openxmlformats-officedocument.presentationml.presentation,text/plain",
};

interface MediaDraft {
  kind: ComposerMediaKind;
  mediaUrl: string;
  /** Storage path — used to GC the object if the draft is discarded. */
  path: string;
  filename: string;
  caption: string;
  isUploading?: boolean;
  uploadError?: string | null;
  file?: File;
}

export interface InsertedTextPayload {
  text: string;
  id: number;
}

export interface ExternalAudioActionPayload {
  qr: QuickReply;
  simulate: boolean;
  id: number;
}

interface MessageComposerProps {
  conversationId: string;
  sessionExpired: boolean;
  onSend: (text: string, replyToId?: string) => void;
  onSendMedia: (payload: SendMediaPayload) => void;
  onSendInteractive: (payload: InteractiveMessagePayload, replyToId?: string) => void;
  onOpenTemplates: () => void;
  replyTo?: ReplyDraft | null;
  onClearReply?: () => void;
  isUazApi?: boolean;
  contactName?: string;
  contactPhone?: string;
  insertedTextPayload?: InsertedTextPayload | null;
  externalAudioAction?: ExternalAudioActionPayload | null;
}

function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

/** Worker that encodes mic input to Ogg/Opus entirely in the browser
 *  (vendored from opus-recorder into /public). Recording client-side in a
 *  Meta-accepted format means no server ffmpeg / transcode step. */
const OPUS_ENCODER_PATH = "/opus/encoderWorker.min.js";

interface SimulatingAudioState {
  qr: QuickReply;
  remainingSeconds: number;
  totalSeconds: number;
}

export function MessageComposer({
  conversationId,
  sessionExpired,
  onSend,
  onSendMedia,
  onSendInteractive,
  onOpenTemplates,
  replyTo,
  onClearReply,
  isUazApi = true,
  contactName,
  contactPhone,
  insertedTextPayload,
  externalAudioAction,
}: MessageComposerProps) {
  const t = useTranslations("Inbox.composer");

  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [drafting, setDrafting] = useState(false);

  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Interactive-message builder dialog + quick-reply picker.
  const [interactiveOpen, setInteractiveOpen] = useState(false);
  const [interactivePayload, setInteractivePayload] =
    useState<InteractiveMessagePayload>(blankButtonsPayload);
  const [savingQuickReply, setSavingQuickReply] = useState(false);
  const [quickReplyOpen, setQuickReplyOpen] = useState(false);

  // Quick replies list & slash command autocomplete
  const [quickRepliesList, setQuickRepliesList] = useState<QuickReply[]>([]);
  const [showSlashMenu, setShowSlashMenu] = useState(false);
  const [slashFilter, setSlashFilter] = useState("");

  // Simulated voice message ("Gravando áudio...") state
  const [simulatingAudio, setSimulatingAudio] = useState<SimulatingAudioState | null>(null);
  const simulationTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Media attachment state. `draft` holds an uploaded-but-not-yet-sent
  // attachment; `busy` covers the upload/transcode window.
  const [draft, setDraft] = useState<MediaDraft | null>(null);
  const [busy, setBusy] = useState(false);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const videoInputRef = useRef<HTMLInputElement>(null);
  const documentInputRef = useRef<HTMLInputElement>(null);
  const draftRef = useRef<MediaDraft | null>(null);
  const lastTypingPingRef = useRef<number>(0);
  useEffect(() => {
    draftRef.current = draft;
  }, [draft]);

  // Best-effort GC of a staged object the user never sent. Fire-and-forget.
  const removeStaged = useCallback((path: string | undefined) => {
    if (!path) return;
    void deleteAccountMedia(CHAT_MEDIA_BUCKET, path).catch(() => {});
  }, []);

  // Voice recording state. The recorder encodes Ogg/Opus in-browser
  const [recording, setRecording] = useState(false);
  const [recordSeconds, setRecordSeconds] = useState(0);
  const recorderRef = useRef<import("opus-recorder").default | null>(null);
  const cancelledRef = useRef(false);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const canSend = useCan("send-messages");
  const readOnly = !canSend;
  const effectivelyExpired = isUazApi ? false : sessionExpired;
  const inputsDisabled = readOnly || effectivelyExpired;

  const clearTimer = useCallback(() => {
    if (timerRef.current !== null) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  // Variable context for template substitution
  const variableContext: VariableContext = useMemo(
    () => ({
      name: contactName || "Cliente",
      phone: contactPhone || "",
    }),
    [contactName, contactPhone]
  );

  // Load quick replies for slash commands & picker
  const loadQuickRepliesList = useCallback(async () => {
    try {
      const res = await fetch("/api/quick-replies", { cache: "no-store" });
      const data = await res.json().catch(() => ({}));
      if (res.ok && Array.isArray(data.quick_replies)) {
        setQuickRepliesList(data.quick_replies);
      }
    } catch {
      // non-critical
    }
  }, []);

  useEffect(() => {
    void loadQuickRepliesList();
  }, [loadQuickRepliesList]);

  // Clean up on unmount
  useEffect(() => {
    return () => {
      clearTimer();
      if (simulationTimerRef.current) {
        clearInterval(simulationTimerRef.current);
        simulationTimerRef.current = null;
      }
      cancelledRef.current = true;
      void recorderRef.current?.stop().catch(() => {});
      removeStaged(draftRef.current?.path);
    };
  }, [clearTimer, removeStaged]);

  const adjustHeight = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 96)}px`;
  }, []);

  const handleSend = useCallback(async () => {
    const trimmed = text.trim();
    if (!trimmed || sending || effectivelyExpired) return;

    setSending(true);
    try {
      onSend(trimmed, replyTo?.id);
      setText("");
      setShowSlashMenu(false);
      if (textareaRef.current) {
        textareaRef.current.style.height = "auto";
      }
    } finally {
      setSending(false);
    }
  }, [text, sending, effectivelyExpired, onSend, replyTo?.id]);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>) => {
      // If slash command menu is open, it handles ArrowUp, ArrowDown, Enter, Tab
      if (showSlashMenu && ["ArrowUp", "ArrowDown", "Enter", "Tab", "Escape"].includes(e.key)) {
        return;
      }
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        handleSend();
      }
    },
    [handleSend, showSlashMenu]
  );

  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      const val = e.target.value;
      setText(val);
      adjustHeight();

      if (val.trim().length > 0 && conversationId) {
        const now = Date.now();
        if (now - lastTypingPingRef.current > 4000) {
          lastTypingPingRef.current = now;
          void fetch("/api/whatsapp/presence", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              conversationId,
              presence: "composing",
              delayMs: 5000,
            }),
          }).catch(() => {});
        }
      }

      if (val.startsWith("/")) {
        setShowSlashMenu(true);
        setSlashFilter(val);
      } else {
        setShowSlashMenu(false);
      }
    },
    [adjustHeight, conversationId]
  );

  // ---- ZapPlus Simulated Audio with "Gravando áudio..." Presence ---

  const handleSendAudioWithPresence = useCallback(
    async (qr: QuickReply, simulateRecording = true) => {
      if (!qr.media_url) {
        toast.error("Áudio sem URL de mídia.");
        return;
      }

      const durationSec = Math.max(1, Number(qr.media_duration) || 5);

      if (!simulateRecording) {
        // Direct send as native voice message (PTT)
        onSendMedia({
          kind: "audio",
          mediaUrl: qr.media_url,
          path: "",
          filename: qr.title,
          replyToId: replyTo?.id,
        });
        toast.success(`🎙️ Áudio "${qr.title}" enviado!`);
        return;
      }

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

      // 2. Start simulation countdown state in UI
      setSimulatingAudio({
        qr,
        remainingSeconds: durationSec,
        totalSeconds: durationSec,
      });

      if (simulationTimerRef.current) {
        clearInterval(simulationTimerRef.current);
      }

      simulationTimerRef.current = setInterval(() => {
        setSimulatingAudio((prev) => {
          if (!prev) return null;
          if (prev.remainingSeconds <= 1) {
            // Done! Send audio as PTT
            if (simulationTimerRef.current) {
              clearInterval(simulationTimerRef.current);
              simulationTimerRef.current = null;
            }

            // Clear presence
            void fetch("/api/whatsapp/presence", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                conversationId,
                presence: "paused",
              }),
            }).catch(() => {});

            // Send voice message
            onSendMedia({
              kind: "audio",
              mediaUrl: prev.qr.media_url!,
              path: "",
              filename: prev.qr.title,
              replyToId: replyTo?.id,
            });
            toast.success(`🎙️ Áudio "${prev.qr.title}" enviado com sucesso!`);
            return null;
          }

          return {
            ...prev,
            remainingSeconds: prev.remainingSeconds - 1,
          };
        });
      }, 1000);
    },
    [conversationId, onSendMedia, replyTo?.id]
  );

  // External text insertion from Top Bar or shortcuts
  const lastInsertedIdRef = useRef<number>(0);
  useEffect(() => {
    if (insertedTextPayload && insertedTextPayload.id !== lastInsertedIdRef.current) {
      lastInsertedIdRef.current = insertedTextPayload.id;
      setText((prev) => (prev ? `${prev}\n${insertedTextPayload.text}` : insertedTextPayload.text));
      setTimeout(() => {
        if (textareaRef.current) {
          textareaRef.current.focus();
          textareaRef.current.scrollTop = textareaRef.current.scrollHeight;
        }
      }, 50);
    }
  }, [insertedTextPayload]);

  // External audio simulation trigger from Top Bar or Audio Library Modal
  const lastAudioActionIdRef = useRef<number>(0);
  useEffect(() => {
    if (externalAudioAction && externalAudioAction.id !== lastAudioActionIdRef.current) {
      lastAudioActionIdRef.current = externalAudioAction.id;
      void handleSendAudioWithPresence(externalAudioAction.qr, externalAudioAction.simulate);
    }
  }, [externalAudioAction, handleSendAudioWithPresence]);


  const handleCancelSimulation = useCallback(() => {
    if (simulationTimerRef.current) {
      clearInterval(simulationTimerRef.current);
      simulationTimerRef.current = null;
    }
    setSimulatingAudio(null);

    void fetch("/api/whatsapp/presence", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        conversationId,
        presence: "paused",
      }),
    }).catch(() => {});

    toast.info("Envio de áudio cancelado.");
  }, [conversationId]);

  const handleSendNowSimulation = useCallback(() => {
    if (!simulatingAudio) return;
    if (simulationTimerRef.current) {
      clearInterval(simulationTimerRef.current);
      simulationTimerRef.current = null;
    }
    const currentQr = simulatingAudio.qr;
    setSimulatingAudio(null);

    void fetch("/api/whatsapp/presence", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        conversationId,
        presence: "paused",
      }),
    }).catch(() => {});

    onSendMedia({
      kind: "audio",
      mediaUrl: currentQr.media_url!,
      path: "",
      filename: currentQr.title,
      replyToId: replyTo?.id,
    });
    toast.success(`🎙️ Áudio "${currentQr.title}" enviado imediatamente!`);
  }, [simulatingAudio, conversationId, onSendMedia, replyTo?.id]);

  // AI draft reply
  const handleDraft = useCallback(async () => {
    if (drafting) return;
    setDrafting(true);
    try {
      const res = await fetch("/api/ai/draft", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ conversation_id: conversationId }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (data.code === "ai_not_configured") {
          toast.error("AI isn't set up yet — enable it in Settings → AI Assistant.");
        } else {
          toast.error(data.error ?? "Couldn't draft a reply.");
        }
        return;
      }
      const draftText = typeof data.draft === "string" ? data.draft.trim() : "";
      if (!draftText) {
        toast.error("The assistant didn't return a reply.");
        return;
      }
      setText(draftText);
      requestAnimationFrame(() => {
        adjustHeight();
        const el = textareaRef.current;
        if (el) {
          el.focus();
          el.setSelectionRange(el.value.length, el.value.length);
        }
      });
    } catch {
      toast.error("Couldn't reach the AI assistant.");
    } finally {
      setDrafting(false);
    }
  }, [drafting, conversationId, adjustHeight]);

  // Interactive builder
  const openInteractiveBuilder = useCallback(
    (seed?: InteractiveMessagePayload) => {
      setInteractivePayload(seed ?? blankButtonsPayload());
      setInteractiveOpen(true);
    },
    []
  );

  const sendInteractive = useCallback(() => {
    const result = validateInteractivePayload(interactivePayload);
    if (!result.ok) {
      toast.error(result.error);
      return;
    }
    onSendInteractive(interactivePayload, replyTo?.id);
    setInteractiveOpen(false);
    onClearReply?.();
  }, [interactivePayload, onSendInteractive, replyTo?.id, onClearReply]);

  const saveAsQuickReply = useCallback(async () => {
    const result = validateInteractivePayload(interactivePayload);
    if (!result.ok) {
      toast.error(result.error);
      return;
    }
    const title = window.prompt(t("quickReplyNamePrompt"))?.trim();
    if (!title) return;
    setSavingQuickReply(true);
    try {
      const res = await fetch("/api/quick-replies", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title,
          kind: "interactive",
          interactive_payload: interactivePayload,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(data.error ?? t("quickReplySaveError"));
        return;
      }
      toast.success(t("quickReplySaved"));
      void loadQuickRepliesList();
    } catch {
      toast.error(t("quickReplySaveError"));
    } finally {
      setSavingQuickReply(false);
    }
  }, [interactivePayload, t, loadQuickRepliesList]);

  // Pick quick reply from picker
  const handlePickQuickReply = useCallback(
    (qr: QuickReply) => {
      setQuickReplyOpen(false);
      if (qr.kind === "interactive" && qr.interactive_payload) {
        openInteractiveBuilder(qr.interactive_payload);
        return;
      }
      if (qr.kind === "audio") {
        void handleSendAudioWithPresence(qr, true);
        return;
      }
      const raw = qr.content_text ?? "";
      const body = replaceQuickReplyVariables(raw, variableContext);
      setText((prev) =>
        prev && !/\s$/.test(prev) ? `${prev}\n${body}` : `${prev}${body}`
      );
      requestAnimationFrame(() => {
        adjustHeight();
        const el = textareaRef.current;
        if (el) {
          el.focus();
          el.setSelectionRange(el.value.length, el.value.length);
        }
      });
    },
    [openInteractiveBuilder, adjustHeight, handleSendAudioWithPresence, variableContext]
  );

  // Helper to detect media kind and sanitize filename
  const detectMediaKindAndName = useCallback(
    (file: File): { kind: ComposerMediaKind; name: string } => {
      const type = (file.type || "").toLowerCase();
      const name = file.name || "";
      const ext = name.includes(".") ? name.split(".").pop()?.toLowerCase() || "" : "";

      if (
        type.startsWith("image/") ||
        ["png", "jpg", "jpeg", "webp", "gif", "bmp"].includes(ext)
      ) {
        const finalExt =
          ext || type.split("/")[1]?.replace("jpeg", "jpg") || "png";
        const finalName =
          name && name.includes(".") && name !== "image.png"
            ? name
            : `print-${Date.now()}.${finalExt}`;
        return { kind: "image", name: finalName };
      }
      if (
        type.startsWith("video/") ||
        ["mp4", "webm", "mov", "3gp", "mkv"].includes(ext)
      ) {
        return {
          kind: "video",
          name: name || `video-${Date.now()}.${ext || "mp4"}`,
        };
      }
      if (
        type.startsWith("audio/") ||
        ["mp3", "ogg", "wav", "m4a", "opus", "aac", "enc"].includes(ext)
      ) {
        return {
          kind: "audio",
          name: name ? name.replace(/\.enc$/i, ".ogg") : `audio-${Date.now()}.${ext === "enc" ? "ogg" : ext || "ogg"}`,
        };
      }
      return {
        kind: "document",
        name: name || `arquivo-${Date.now()}.${ext || "bin"}`,
      };
    },
    []
  );

  // Background media uploader with client-side direct upload + server-side fallback
  const uploadMediaFile = useCallback(
    async (file: File, kind: ComposerMediaKind) => {
      try {
        let result: { publicUrl: string; path: string };
        try {
          result = await uploadAccountMedia(CHAT_MEDIA_BUCKET, file);
        } catch (clientErr) {
          console.warn(
            "[MediaUpload] Client upload failed, using server fallback:",
            clientErr
          );
          const formData = new FormData();
          formData.append("file", file);
          const res = await fetch("/api/whatsapp/media/upload", {
            method: "POST",
            body: formData,
          });
          const data = await res.json().catch(() => ({}));
          if (!res.ok || !data.publicUrl) {
            throw new Error(data.error || "Falha ao enviar arquivo.");
          }
          result = { publicUrl: data.publicUrl, path: data.path };
        }

        setDraft((prev) => {
          if (!prev || prev.file !== file) return prev;
          return {
            ...prev,
            mediaUrl: result.publicUrl,
            path: result.path,
            isUploading: false,
            uploadError: null,
          };
        });
      } catch (err) {
        const msg =
          err instanceof Error ? err.message : "Falha ao carregar mídia.";
        setDraft((prev) => {
          if (!prev || prev.file !== file) return prev;
          return {
            ...prev,
            isUploading: false,
            uploadError: msg,
          };
        });
        toast.error(msg);
      }
    },
    []
  );

  // File attachments — provides 0ms local preview then triggers background upload
  const stageUpload = useCallback(
    (kind: ComposerMediaKind, file: File) => {
      const max = MEDIA_MAX_BYTES_BY_KIND[kind];
      if (file.size > max) {
        toast.error(
          `Arquivo tem ${(file.size / 1024 / 1024).toFixed(1)} MB — limite para ${kind} é ${Math.round(
            max / 1024 / 1024
          )} MB.`
        );
        return;
      }

      // 1. Instant local preview object URL (shows preview immediately!)
      const localUrl = URL.createObjectURL(file);
      removeStaged(draftRef.current?.path);

      const existingText = text.trim();
      if (existingText) {
        setText("");
      }

      setDraft({
        kind,
        mediaUrl: localUrl,
        path: "",
        filename: file.name,
        caption: existingText || "",
        isUploading: true,
        uploadError: null,
        file,
      });

      // 2. Perform upload in background
      void uploadMediaFile(file, kind);
    },
    [removeStaged, text, uploadMediaFile]
  );

  const handlePicked = useCallback(
    (kind: "image" | "video" | "document", file: File | undefined) => {
      if (file) stageUpload(kind, file);
    },
    [stageUpload]
  );

  // Clipboard & Paste Handling (Ctrl+V prints, screenshots, files)
  const processClipboardData = useCallback(
    (data: DataTransfer | null): boolean => {
      if (!data || inputsDisabled) return false;

      // 1. Check data.items first (handles OS screenshots, Windows Snipping Tool, Print Screen)
      const items = data.items;
      if (items && items.length > 0) {
        for (let i = 0; i < items.length; i++) {
          const item = items[i];
          if (item.kind === "file") {
            const file = item.getAsFile();
            if (file) {
              const { kind, name } = detectMediaKindAndName(file);
              const namedFile = new File([file], name, {
                type:
                  file.type ||
                  (kind === "image"
                    ? "image/png"
                    : "application/octet-stream"),
              });
              stageUpload(kind, namedFile);
              return true;
            }
          }
        }
      }

      // 2. Check data.files (direct pasted files or dragged files)
      const files = data.files;
      if (files && files.length > 0) {
        for (let i = 0; i < files.length; i++) {
          const file = files[i];
          const { kind, name } = detectMediaKindAndName(file);
          const audioType = file.name.toLowerCase().endsWith(".mp3") ? "audio/mpeg" : "audio/ogg";
          const namedFile = new File([file], name, {
            type:
              file.type ||
              (kind === "image" ? "image/png" : kind === "audio" ? audioType : "application/octet-stream"),
          });
          stageUpload(kind, namedFile);
          return true;
        }
      }

      return false;
    },
    [inputsDisabled, detectMediaKindAndName, stageUpload]
  );

  const handlePaste = useCallback(
    (e: React.ClipboardEvent) => {
      const handled = processClipboardData(e.clipboardData);
      if (handled) {
        e.preventDefault();
      }
    },
    [processClipboardData]
  );

  // Global window paste listener when composer is active
  useEffect(() => {
    const handleGlobalPaste = (e: ClipboardEvent) => {
      // Don't steal paste if user is typing in another input or modal
      const target = e.target as HTMLElement | null;
      if (
        target &&
        target !== textareaRef.current &&
        (target.tagName === "INPUT" || target.tagName === "SELECT" || target.isContentEditable)
      ) {
        return;
      }
      const handled = processClipboardData(e.clipboardData);
      if (handled) {
        e.preventDefault();
      }
    };

    window.addEventListener("paste", handleGlobalPaste);
    return () => {
      window.removeEventListener("paste", handleGlobalPaste);
    };
  }, [processClipboardData]);

  // Drag and Drop media onto composer
  const [isDraggingOver, setIsDraggingOver] = useState(false);

  const handleDragOver = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (!inputsDisabled && !busy) {
        setIsDraggingOver(true);
      }
    },
    [inputsDisabled, busy]
  );

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDraggingOver(false);
  }, []);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setIsDraggingOver(false);
      if (inputsDisabled || busy) return;

      const files = e.dataTransfer?.files;
      if (files && files.length > 0) {
        const file = files[0];
        const { kind, name } = detectMediaKindAndName(file);
        const audioType = file.name.toLowerCase().endsWith(".mp3") ? "audio/mpeg" : "audio/ogg";
        const namedFile = new File([file], name, {
          type:
            file.type ||
            (kind === "image" ? "image/png" : kind === "audio" ? audioType : "application/octet-stream"),
        });
        void stageUpload(kind, namedFile);
      }
    },
    [inputsDisabled, busy, detectMediaKindAndName, stageUpload]
  );

  // In-composer live mic recording
  const finalizeRecording = useCallback(
    async (bytes: Uint8Array) => {
      const file = new File([bytes as unknown as BlobPart], `voice-${Date.now()}.ogg`, {
        type: "audio/ogg",
      });
      if (file.size === 0) return;
      if (file.size > MEDIA_MAX_BYTES_BY_KIND.audio) {
        toast.error("Recording is too long (over 16 MB).");
        return;
      }
      setBusy(true);
      try {
        const { publicUrl, path } = await uploadAccountMedia(CHAT_MEDIA_BUCKET, file);
        removeStaged(draftRef.current?.path);
        setDraft({ kind: "audio", mediaUrl: publicUrl, path, filename: file.name, caption: "" });
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Upload failed.");
      } finally {
        setBusy(false);
      }
    },
    [removeStaged]
  );

  const startRecording = useCallback(async () => {
    if (inputsDisabled || busy || recording) return;
    if (!navigator.mediaDevices?.getUserMedia || typeof AudioContext === "undefined") {
      toast.error("Voice recording isn't supported in this browser.");
      return;
    }
    try {
      const { default: Recorder } = await import("opus-recorder");
      const recorder = new Recorder({
        encoderPath: OPUS_ENCODER_PATH,
        numberOfChannels: 1,
        encoderApplication: 2048,
        encoderSampleRate: 48000,
        streamPages: false,
      });
      cancelledRef.current = false;
      recorder.ondataavailable = (bytes) => {
        if (cancelledRef.current) return;
        void finalizeRecording(bytes);
      };
      recorderRef.current = recorder;
      await recorder.start();
      setRecording(true);
      setRecordSeconds(0);
      timerRef.current = setInterval(() => setRecordSeconds((s) => s + 1), 1000);

      // Signal WhatsApp that user is actively recording audio live
      void fetch("/api/whatsapp/presence", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          conversationId,
          presence: "recording",
          delayMs: 30000,
        }),
      }).catch(() => {});
    } catch {
      void recorderRef.current?.stop().catch(() => {});
      recorderRef.current = null;
      toast.error("Microphone access denied or unavailable.");
    }
  }, [inputsDisabled, busy, recording, finalizeRecording, conversationId]);

  const stopRecording = useCallback(() => {
    clearTimer();
    setRecording(false);
    void recorderRef.current?.stop().catch(() => {});

    // Clear live presence
    void fetch("/api/whatsapp/presence", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        conversationId,
        presence: "paused",
      }),
    }).catch(() => {});
  }, [clearTimer, conversationId]);

  const cancelRecording = useCallback(() => {
    cancelledRef.current = true;
    clearTimer();
    setRecording(false);
    void recorderRef.current?.stop().catch(() => {});

    // Clear live presence
    void fetch("/api/whatsapp/presence", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        conversationId,
        presence: "paused",
      }),
    }).catch(() => {});
  }, [clearTimer, conversationId]);

  useEffect(() => {
    if (recording && recordSeconds >= MAX_RECORDING_SECONDS) {
      stopRecording();
    }
  }, [recording, recordSeconds, stopRecording]);

  const sendDraft = useCallback(() => {
    if (!draft || busy) return;
    if (draft.isUploading) {
      toast.info("Aguarde o carregamento da mídia terminar...");
      return;
    }
    if (draft.uploadError) {
      toast.error(draft.uploadError);
      return;
    }
    if (!draft.mediaUrl || draft.mediaUrl.startsWith("blob:")) {
      toast.error("Mídia ainda está sendo enviada ao servidor.");
      return;
    }
    onSendMedia({
      kind: draft.kind,
      mediaUrl: draft.mediaUrl,
      path: draft.path,
      caption: draft.kind === "audio" ? undefined : draft.caption.trim() || undefined,
      filename: draft.kind === "document" ? draft.filename : undefined,
      replyToId: replyTo?.id,
    });
    setDraft(null);
    onClearReply?.();
  }, [draft, busy, onSendMedia, replyTo?.id, onClearReply]);

  const discardDraft = useCallback(() => {
    if (draft?.mediaUrl?.startsWith("blob:")) {
      try {
        URL.revokeObjectURL(draft.mediaUrl);
      } catch {}
    }
    removeStaged(draft?.path);
    setDraft(null);
  }, [draft, removeStaged]);

  const setCaption = useCallback((caption: string) => {
    setDraft((d) => (d ? { ...d, caption } : d));
  }, []);

  return (
    <div
      className={cn(
        "relative border-t border-border bg-card p-3 transition-colors",
        isDraggingOver && "border-dashed border-primary bg-primary/5"
      )}
      onPaste={handlePaste}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {isDraggingOver && (
        <div className="absolute inset-0 z-50 flex items-center justify-center rounded-lg border-2 border-dashed border-primary bg-card/95 backdrop-blur-xs">
          <p className="flex items-center gap-2 text-sm font-medium text-primary">
            <ImageIcon className="h-5 w-5" />
            Solte a imagem ou arquivo aqui para anexar
          </p>
        </div>
      )}
      {/* Floating Slash Command Autocomplete Popover */}
      <SlashCommandMenu
        open={showSlashMenu}
        filterText={slashFilter}
        items={quickRepliesList}
        context={variableContext}
        onSelectText={(interpolated) => {
          setText(interpolated);
          setShowSlashMenu(false);
          requestAnimationFrame(() => {
            adjustHeight();
            textareaRef.current?.focus();
          });
        }}
        onSelectAudio={(qr) => {
          setText("");
          setShowSlashMenu(false);
          void handleSendAudioWithPresence(qr, true);
        }}
        onClose={() => setShowSlashMenu(false)}
      />

      {replyTo && (
        <div className="mb-2">
          <ReplyQuote
            authorLabel={replyTo.authorLabel}
            preview={replyTo.preview}
            onDismiss={onClearReply}
          />
        </div>
      )}

      {!isUazApi && sessionExpired && (
        <div className="mb-2 flex items-center justify-between rounded-lg bg-amber-500/10 px-3 py-2">
          <p className="text-xs text-amber-400">
            {t("sessionExpiredHint")}
          </p>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 text-xs text-amber-400 hover:text-amber-300"
            onClick={onOpenTemplates}
          >
            <LayoutTemplate className="mr-1 h-3 w-3" />
            {t("templates")}
          </Button>
        </div>
      )}

      {/* Hidden file inputs */}
      <input
        ref={imageInputRef}
        type="file"
        accept={PICKER_ACCEPT.image}
        className="hidden"
        onChange={(e) => {
          handlePicked("image", e.target.files?.[0]);
          e.target.value = "";
        }}
      />
      <input
        ref={videoInputRef}
        type="file"
        accept={PICKER_ACCEPT.video}
        className="hidden"
        onChange={(e) => {
          handlePicked("video", e.target.files?.[0]);
          e.target.value = "";
        }}
      />
      <input
        ref={documentInputRef}
        type="file"
        accept={PICKER_ACCEPT.document}
        className="hidden"
        onChange={(e) => {
          handlePicked("document", e.target.files?.[0]);
          e.target.value = "";
        }}
      />

      {/* ZapPlus Realistic "Gravando áudio..." Presence Simulation Bar */}
      {simulatingAudio ? (
        <div className="flex items-center gap-3 rounded-xl border border-emerald-500/40 bg-emerald-500/10 px-4 py-2.5 shadow-sm animate-in fade-in duration-200">
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-emerald-500 text-white shadow-xs">
            <Mic className="h-4 w-4 animate-bounce" />
          </div>

          <div className="flex-1 min-w-0">
            <div className="flex items-center justify-between text-xs">
              <span className="font-semibold text-foreground truncate flex items-center gap-1.5">
                <span>🎙️ Gravando áudio para {contactName || "cliente"}...</span>
                <span className="text-[10px] text-emerald-600 dark:text-emerald-400 font-mono bg-emerald-500/20 px-1.5 py-0.5 rounded">
                  {simulatingAudio.qr.title}
                </span>
              </span>
              <span className="font-mono font-bold text-emerald-600 dark:text-emerald-400">
                {simulatingAudio.remainingSeconds}s restantes
              </span>
            </div>

            {/* Waveform animation */}
            <div className="mt-1.5 flex items-center gap-1 h-3 overflow-hidden">
              {[35, 75, 100, 60, 85, 45, 90, 70, 50, 95, 80, 65, 40, 75, 90, 55, 80, 70, 45, 85, 95, 60].map((h, i) => (
                <span
                  key={i}
                  className="flex-1 bg-emerald-500 rounded-full animate-pulse"
                  style={{
                    height: `${h}%`,
                    animationDelay: `${(i % 6) * 120}ms`,
                    animationDuration: "800ms",
                  }}
                />
              ))}
            </div>
          </div>

          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={handleCancelSimulation}
            className="h-8 text-xs text-muted-foreground hover:text-foreground border-border"
          >
            Cancelar
          </Button>

          <Button
            type="button"
            size="sm"
            onClick={handleSendNowSimulation}
            className="h-8 text-xs bg-emerald-600 hover:bg-emerald-700 text-white font-medium shadow-xs"
          >
            <Send className="mr-1 h-3 w-3" />
            Enviar Agora
          </Button>
        </div>
      ) : draft ? (
        <MediaDraftPreview
          draft={draft}
          busy={busy}
          readOnly={readOnly}
          onCaptionChange={setCaption}
          onDiscard={discardDraft}
          onSend={sendDraft}
          onRetry={() => {
            if (draft.file) {
              setDraft((d) =>
                d ? { ...d, isUploading: true, uploadError: null } : null
              );
              void uploadMediaFile(draft.file, draft.kind);
            }
          }}
          t={t}
        />
      ) : recording ? (
        <div className="flex items-center gap-3 rounded-xl border border-border bg-muted px-4 py-2.5">
          <span className="flex h-2.5 w-2.5 shrink-0 animate-pulse rounded-full bg-red-500" />
          <span className="flex-1 text-sm text-foreground">
            {t("recording", { current: formatDuration(recordSeconds), max: formatDuration(MAX_RECORDING_SECONDS) })}
          </span>
          <button
            type="button"
            onClick={cancelRecording}
            className="rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-card hover:text-foreground"
          >
            {t("cancel")}
          </button>
          <Button
            size="sm"
            onClick={stopRecording}
            className="h-9 w-9 shrink-0 bg-primary p-0 hover:bg-primary/90"
            title={t("stopAndAttach")}
          >
            <Square className="h-4 w-4" />
          </Button>
        </div>
      ) : (
        <div className="flex items-end gap-2">
          {/* Attach menu */}
          <DropdownMenu>
            <DropdownMenuTrigger
              disabled={inputsDisabled || busy}
              title={readOnly ? t("readOnlyTitle") : inputsDisabled ? undefined : t("attachMedia")}
              className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-md p-0 text-muted-foreground hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
            >
              {busy ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Paperclip className="h-4 w-4" />
              )}
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="border-border bg-popover">
              <DropdownMenuItem onClick={() => imageInputRef.current?.click()}>
                <ImageIcon className="mr-2 h-4 w-4" />
                {t("photo")}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => videoInputRef.current?.click()}>
                <Video className="mr-2 h-4 w-4" />
                {t("video")}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => documentInputRef.current?.click()}>
                <FileText className="mr-2 h-4 w-4" />
                {t("document")}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => void startRecording()}>
                <Mic className="mr-2 h-4 w-4" />
                {t("voiceNote")}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>

          {/* ZapPlus Trigger Button */}
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={inputsDisabled}
            title="ZapPlus - Respostas Rápidas & Áudios Gravados"
            onClick={() => {
              void loadQuickRepliesList();
              setQuickReplyOpen(true);
            }}
            className="h-9 px-2.5 text-xs font-semibold text-emerald-600 dark:text-emerald-400 bg-emerald-500/10 hover:bg-emerald-500/20 hover:text-emerald-700 dark:hover:text-emerald-300 rounded-lg flex items-center gap-1.5 shrink-0 transition-colors border border-emerald-500/20"
          >
            <Zap className="h-4 w-4 fill-emerald-500 text-emerald-500" />
            <span className="hidden sm:inline font-mono">ZapPlus</span>
          </Button>

          {/* + menu — interactive messages */}
          <DropdownMenu>
            <DropdownMenuTrigger
              disabled={inputsDisabled}
              title={readOnly ? t("readOnlyTitle") : inputsDisabled ? undefined : t("moreActions")}
              className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-md p-0 text-muted-foreground hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
            >
              <Plus className="h-4 w-4" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="border-border bg-popover">
              <DropdownMenuItem onClick={() => openInteractiveBuilder()}>
                <MessageSquareDashed className="mr-2 h-4 w-4" />
                {t("interactiveMessage")}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => setQuickReplyOpen(true)}>
                <Zap className="mr-2 h-4 w-4" />
                {t("quickReplies")}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>

          <GatedButton
            variant="ghost"
            size="sm"
            canAct={!readOnly}
            gateReason="send messages"
            title={readOnly ? undefined : t("sendTemplate")}
            className="h-9 w-9 shrink-0 p-0 text-muted-foreground hover:text-foreground"
            onClick={onOpenTemplates}
          >
            <LayoutTemplate className="h-4 w-4" />
          </GatedButton>

          <GatedButton
            variant="ghost"
            size="sm"
            canAct={!readOnly}
            gateReason="send messages"
            disabled={drafting}
            title={readOnly ? undefined : t("draftWithAI")}
            className="h-9 w-9 shrink-0 p-0 text-muted-foreground hover:text-primary"
            onClick={handleDraft}
          >
            {drafting ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Sparkles className="h-4 w-4" />
            )}
          </GatedButton>

          <textarea
            ref={textareaRef}
            value={text}
            onChange={handleChange}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            placeholder={
              readOnly
                ? t("readOnlyPlaceholder")
                : effectivelyExpired
                  ? t("sessionExpiredPlaceholder")
                  : "Digite uma mensagem ou cole um print (Ctrl+V)..."
            }
            disabled={effectivelyExpired || readOnly}
            rows={1}
            title={readOnly ? t("readOnlyTitle") : undefined}
            className={cn(
              "flex-1 resize-none rounded-xl border border-border bg-muted px-4 py-2.5 text-sm text-foreground placeholder-muted-foreground outline-none transition-colors focus:border-primary/50",
              (effectivelyExpired || readOnly) && "cursor-not-allowed opacity-50"
            )}
          />

          <GatedButton
            size="sm"
            canAct={!readOnly}
            gateReason="send messages"
            disabled={!text.trim() || effectivelyExpired || sending}
            onClick={handleSend}
            className="h-9 w-9 shrink-0 bg-primary p-0 hover:bg-primary/90 disabled:opacity-40"
          >
            <Send className="h-4 w-4" />
          </GatedButton>
        </div>
      )}

      {!draft && !recording && !simulatingAudio && (
        <div className="mt-1 pl-[7.5rem] pr-2 flex items-center justify-between text-[10px] text-muted-foreground">
          <p>
            Dica: Digite <span className="font-mono text-emerald-500 font-semibold">/</span> para abrir o menu do ZapPlus
          </p>
          <p className="hidden sm:inline-flex items-center gap-1 text-muted-foreground/80">
            Cole print/mídia com <kbd className="rounded bg-muted px-1 py-0.5 font-mono text-[9px] border border-border">Ctrl+V</kbd>
          </p>
        </div>
      )}

      {/* Interactive message builder dialog */}
      <Dialog open={interactiveOpen} onOpenChange={setInteractiveOpen}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>{t("interactiveMessage")}</DialogTitle>
          </DialogHeader>
          <div className="max-h-[70vh] overflow-y-auto">
            <InteractiveBuilder
              value={interactivePayload}
              onChange={setInteractivePayload}
            />
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              disabled={savingQuickReply}
              onClick={saveAsQuickReply}
            >
              {savingQuickReply ? (
                <Loader2 className="mr-1 h-4 w-4 animate-spin" />
              ) : (
                <Zap className="mr-1 h-4 w-4" />
              )}
              {t("saveAsQuickReply")}
            </Button>
            <Button onClick={sendInteractive}>
              <Send className="mr-1 h-4 w-4" />
              {t("send")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ZapPlus Quick Reply Picker */}
      <QuickReplyPicker
        open={quickReplyOpen}
        onOpenChange={setQuickReplyOpen}
        onPick={handlePickQuickReply}
        onSendAudio={handleSendAudioWithPresence}
        onSendTextDirect={(txt) => onSend(txt, replyTo?.id)}
        contactContext={variableContext}
      />
    </div>
  );
}

function MediaDraftPreview({
  draft,
  busy,
  readOnly,
  onCaptionChange,
  onDiscard,
  onSend,
  onRetry,
  t,
}: {
  draft: MediaDraft;
  busy: boolean;
  readOnly: boolean;
  onCaptionChange: (caption: string) => void;
  onDiscard: () => void;
  onSend: () => void;
  onRetry?: () => void;
  t: ReturnType<typeof useTranslations>;
}) {
  const isPendingUpload = Boolean(draft.isUploading || busy);

  return (
    <div className="rounded-xl border border-border bg-muted/40 p-3 shadow-xs">
      <div className="flex items-start gap-3">
        <div className="relative min-w-0 flex-1">
          {draft.kind === "image" && (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={draft.mediaUrl}
              alt={draft.filename}
              className="max-h-48 rounded-lg object-contain bg-background/50 border border-border/50"
            />
          )}
          {draft.kind === "video" && (
            <video src={draft.mediaUrl} controls className="max-h-48 rounded-lg" />
          )}
          {draft.kind === "audio" && (
            <audio src={draft.mediaUrl} controls className="w-full" />
          )}
          {draft.kind === "document" && (
            <div className="flex items-center gap-2 text-sm text-foreground">
              <FileText className="h-5 w-5 shrink-0 text-muted-foreground" />
              <span className="truncate">{draft.filename}</span>
            </div>
          )}

          {draft.isUploading && (
            <div className="absolute top-2 left-2 flex items-center gap-1.5 rounded-full bg-black/80 px-2.5 py-1 text-xs text-white backdrop-blur-xs shadow-md">
              <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" />
              <span>Processando mídia...</span>
            </div>
          )}
        </div>
        <button
          type="button"
          onClick={onDiscard}
          aria-label={t("removeAttachment")}
          className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground cursor-pointer"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      {draft.uploadError && (
        <div className="mt-2 flex items-center justify-between gap-2 rounded-lg bg-destructive/10 px-3 py-1.5 text-xs text-destructive">
          <span className="truncate">{draft.uploadError}</span>
          {onRetry && (
            <button
              type="button"
              onClick={onRetry}
              className="shrink-0 font-medium underline hover:opacity-80 cursor-pointer"
            >
              Tentar novamente
            </button>
          )}
        </div>
      )}

      <div className="mt-2 flex items-end gap-2">
        {draft.kind !== "audio" && (
          <input
            value={draft.caption}
            maxLength={MEDIA_CAPTION_MAX}
            onChange={(e) => onCaptionChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                onSend();
              }
            }}
            placeholder={t("addCaption")}
            disabled={readOnly}
            className="flex-1 rounded-xl border border-border bg-muted px-4 py-2.5 text-sm text-foreground placeholder-muted-foreground outline-none transition-colors focus:border-primary/50"
          />
        )}
        <GatedButton
          size="sm"
          canAct={!readOnly}
          gateReason="send messages"
          disabled={isPendingUpload || Boolean(draft.uploadError)}
          onClick={onSend}
          className={cn(
            "h-9 w-9 shrink-0 bg-primary p-0 hover:bg-primary/90 disabled:opacity-40",
            draft.kind === "audio" && "ml-auto"
          )}
          title={isPendingUpload ? "Carregando mídia..." : "Enviar mídia"}
        >
          {isPendingUpload ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Send className="h-4 w-4" />
          )}
        </GatedButton>
      </div>
    </div>
  );
}
