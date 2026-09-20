import type { QuickReply } from "@/types";

/**
 * Checks whether a dropped or selected file is an audio or an .enc audio file.
 */
export function isAudioOrEncFile(file: File): boolean {
  if (!file) return false;
  if (file.type.startsWith("audio/")) return true;
  const name = file.name.toLowerCase();
  return /\.(enc|opus\.enc|ogg\.enc|ogg|opus|mp3|wav|m4a|aac|weba|webm)$/i.test(name);
}

/**
 * Generates a user-friendly title for a saved audio file.
 */
export function cleanAudioTitle(filename: string): string {
  if (!filename) return `Áudio ZapPlus ${new Date().toLocaleDateString("pt-BR")}`;

  // Remove common extensions
  let clean = filename
    .replace(/\.(enc|opus\.enc|ogg\.enc|ogg|opus|mp3|wav|m4a|aac|weba|webm)$/i, "")
    .trim();

  // If the filename is an internal WhatsApp CDN hash/ID (e.g. 814853687_1099835449120493_... or file(1))
  if (/^\d+_\d+_\d+(_n)?$/i.test(clean) || /^file(\s*\(\d+\))?$/i.test(clean)) {
    const time = new Date().toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
    return `Áudio ZapPlus (${time})`;
  }

  // Replace underscores and dashes with spaces
  clean = clean.replace(/[_-]+/g, " ").trim();
  return clean || `Áudio ZapPlus ${new Date().toLocaleDateString("pt-BR")}`;
}

/**
 * Inspects binary magic bytes to determine the underlying audio MIME type, extension,
 * and exact duration if container headers (e.g. OGG granule) are present.
 */
export function inspectAudioBytes(bytes: Uint8Array): {
  mime: string;
  extension: string;
  duration?: number;
} {
  const len = bytes.length;

  // 1. OGG (OggS)
  if (len >= 4 && bytes[0] === 0x4f && bytes[1] === 0x67 && bytes[2] === 0x67 && bytes[3] === 0x53) {
    let duration: number | undefined;
    // Find last OggS page to read Opus granule position
    for (let i = len - 4; i >= 0; i--) {
      if (bytes[i] === 0x4f && bytes[i + 1] === 0x67 && bytes[i + 2] === 0x67 && bytes[i + 3] === 0x53) {
        if (i + 14 <= len) {
          // Granule is 8 bytes LE at offset i + 6
          const view = new DataView(bytes.buffer, bytes.byteOffset + i + 6, 8);
          const granule = Number(view.getBigUint64(0, true));
          if (granule > 0 && granule < 1e12) {
            // Standard Opus sample rate in Ogg is 48000 Hz
            duration = Math.max(1, Math.round(granule / 48000));
          }
        }
        break;
      }
    }
    return {
      mime: "audio/ogg",
      extension: "ogg",
      duration,
    };
  }

  // 2. MP3 (ID3 tag or MPEG sync frames)
  if (
    (len >= 3 && bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33) ||
    (len >= 2 && bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0)
  ) {
    return {
      mime: "audio/mpeg",
      extension: "mp3",
    };
  }

  // 3. WAV (RIFF .... WAVE)
  if (len >= 12 && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46) {
    return {
      mime: "audio/wav",
      extension: "wav",
    };
  }

  // 4. M4A / AAC (....ftyp)
  if (len >= 8 && bytes[4] === 0x66 && bytes[5] === 0x74 && bytes[6] === 0x79 && bytes[7] === 0x70) {
    return {
      mime: "audio/mp4",
      extension: "m4a",
    };
  }

  // Fallback default for unknown/enc files
  return {
    mime: "audio/ogg",
    extension: "ogg",
  };
}

/**
 * Calculates audio duration safely using AudioContext (browser), falling back
 * to HTML5 Audio and finally file-size bitrate heuristics.
 * Guaranteed never to return 0 or NaN.
 */
export async function computeAudioDuration(file: File | Blob): Promise<number> {
  // 1. Try decoding with AudioContext
  if (typeof window !== "undefined" && (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)) {
    try {
      const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      const ctx = new AudioCtx();
      const buffer = await file.slice(0, Math.min(file.size, 2097152)).arrayBuffer();
      const audioBuffer = await ctx.decodeAudioData(buffer);
      await ctx.close();
      if (audioBuffer && audioBuffer.duration > 0 && isFinite(audioBuffer.duration)) {
        return Math.max(1, Math.round(audioBuffer.duration));
      }
    } catch {
      // Decode audio data failed (e.g. unknown MIME or enc header), continue to next fallback
    }
  }

  // 2. Try inspecting Ogg granule directly from binary
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const inspected = inspectAudioBytes(bytes);
    if (inspected.duration && inspected.duration > 0) {
      return inspected.duration;
    }
  } catch {
    // ArrayBuffer inspection failed
  }

  // 3. Try standard HTML5 Audio element
  try {
    const url = URL.createObjectURL(file);
    const audio = new Audio(url);
    const duration = await new Promise<number>((resolve) => {
      const cleanup = () => {
        URL.revokeObjectURL(url);
        audio.removeEventListener("loadedmetadata", onMeta);
        audio.removeEventListener("error", onError);
      };
      const onMeta = () => {
        const dur = audio.duration;
        cleanup();
        resolve(dur && isFinite(dur) ? Math.round(dur) : 0);
      };
      const onError = () => {
        cleanup();
        resolve(0);
      };
      audio.addEventListener("loadedmetadata", onMeta);
      audio.addEventListener("error", onError);
      setTimeout(() => {
        cleanup();
        resolve(0);
      }, 1500);
    });

    if (duration > 0) return duration;
  } catch {
    // Audio element fallback failed
  }

  // 4. Safe estimation from file size (typical voice note is ~3.2 KB / sec in Opus @ 24-32kbps)
  const estimated = Math.round(file.size / 3200);
  return Math.min(300, Math.max(3, estimated || 5));
}

export interface UploadAudioQuickReplyOptions {
  title?: string;
  shortcut?: string;
  category?: string;
}

/**
 * Uploads and creates a Quick Reply audio record directly on the server.
 * Handles .enc normalization, WhatsApp message media resolution, duration detection,
 * storage upload, and DB persistence.
 */
export async function uploadAudioQuickReply(
  file: File,
  options?: UploadAudioQuickReplyOptions
): Promise<QuickReply> {
  const formData = new FormData();
  formData.append("file", file);
  if (options?.title) formData.append("title", options.title);
  if (options?.shortcut) formData.append("shortcut", options.shortcut);
  if (options?.category) formData.append("category", options.category);

  const res = await fetch("/api/quick-replies/audio-upload", {
    method: "POST",
    body: formData,
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error || "Falha ao enviar e salvar áudio.");
  }

  return data.quickReply as QuickReply;
}
