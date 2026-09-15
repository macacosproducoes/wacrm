"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import { Play, Pause, RotateCcw, Volume2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface QuickReplyAudioPlayerProps {
  url: string;
  duration?: number | null;
  className?: string;
  autoPlay?: boolean;
}

function formatTime(seconds: number): string {
  if (isNaN(seconds) || seconds < 0) return "0:00";
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

export function QuickReplyAudioPlayer({
  url,
  duration,
  className,
  autoPlay = false,
}: QuickReplyAudioPlayerProps) {
  const [playing, setPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [audioDuration, setAudioDuration] = useState<number>(duration || 0);
  const [playbackRate, setPlaybackRate] = useState<number>(1);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  useEffect(() => {
    const audio = new Audio(url);
    audioRef.current = audio;
    audio.playbackRate = playbackRate;

    const onLoadedMetadata = () => {
      if (audio.duration && !isNaN(audio.duration) && isFinite(audio.duration)) {
        setAudioDuration(audio.duration);
      }
    };

    const onTimeUpdate = () => {
      setCurrentTime(audio.currentTime);
    };

    const onEnded = () => {
      setPlaying(false);
      setCurrentTime(0);
    };

    audio.addEventListener("loadedmetadata", onLoadedMetadata);
    audio.addEventListener("timeupdate", onTimeUpdate);
    audio.addEventListener("ended", onEnded);

    if (autoPlay) {
      audio.play().then(() => setPlaying(true)).catch(() => {});
    }

    return () => {
      audio.pause();
      audio.removeEventListener("loadedmetadata", onLoadedMetadata);
      audio.removeEventListener("timeupdate", onTimeUpdate);
      audio.removeEventListener("ended", onEnded);
      audioRef.current = null;
    };
  }, [url, autoPlay]);

  const togglePlay = useCallback(() => {
    const audio = audioRef.current;
    if (!audio) return;

    if (playing) {
      audio.pause();
      setPlaying(false);
    } else {
      audio.playbackRate = playbackRate;
      audio
        .play()
        .then(() => setPlaying(true))
        .catch((err) => {
          console.error("Audio playback error:", err);
          setPlaying(false);
        });
    }
  }, [playing, playbackRate]);

  const toggleSpeed = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    const nextRate = playbackRate === 1 ? 1.5 : playbackRate === 1.5 ? 2 : 1;
    setPlaybackRate(nextRate);
    if (audioRef.current) {
      audioRef.current.playbackRate = nextRate;
    }
  }, [playbackRate]);

  const progressPercent = audioDuration > 0 ? (currentTime / audioDuration) * 100 : 0;

  // Waveform bars simulation
  const waveformHeights = [
    30, 45, 75, 90, 60, 40, 80, 100, 70, 50, 65, 85, 95, 60, 45, 70, 90, 80, 55, 35,
    60, 75, 90, 65, 45, 80, 70, 50, 40, 60, 85, 95, 70, 40, 30
  ];

  return (
    <div
      className={cn(
        "flex items-center gap-2.5 rounded-xl border border-emerald-500/20 bg-emerald-500/5 px-3 py-2 text-foreground shadow-2xs transition-colors",
        playing && "border-emerald-500/40 bg-emerald-500/10",
        className
      )}
      onClick={(e) => e.stopPropagation()}
    >
      {/* Play / Pause Button */}
      <Button
        type="button"
        size="icon"
        variant="ghost"
        onClick={togglePlay}
        className="h-8 w-8 shrink-0 rounded-full bg-emerald-500 text-white hover:bg-emerald-600 hover:text-white shadow-xs"
      >
        {playing ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4 ml-0.5" />}
      </Button>

      {/* Waveform & Scrubber */}
      <div className="flex-1 min-w-0">
        <div
          className="relative flex h-6 items-center gap-0.5 cursor-pointer select-none"
          onClick={(e) => {
            const rect = e.currentTarget.getBoundingClientRect();
            const clickX = e.clientX - rect.left;
            const ratio = Math.max(0, Math.min(1, clickX / rect.width));
            if (audioRef.current && audioDuration > 0) {
              audioRef.current.currentTime = ratio * audioDuration;
              setCurrentTime(ratio * audioDuration);
            }
          }}
        >
          {waveformHeights.map((h, i) => {
            const barPercent = (i / waveformHeights.length) * 100;
            const isFilled = barPercent <= progressPercent;
            return (
              <span
                key={i}
                className={cn(
                  "flex-1 rounded-full transition-all duration-100",
                  isFilled ? "bg-emerald-500" : "bg-muted-foreground/30",
                  playing && isFilled && "brightness-110"
                )}
                style={{ height: `${h}%`, minWidth: 2 }}
              />
            );
          })}
        </div>

        {/* Time info */}
        <div className="flex items-center justify-between text-[11px] font-mono text-muted-foreground leading-none mt-1">
          <span>{formatTime(currentTime)}</span>
          <span>{formatTime(audioDuration)}</span>
        </div>
      </div>

      {/* Speed control */}
      <button
        type="button"
        onClick={toggleSpeed}
        className="shrink-0 rounded-md bg-muted px-1.5 py-0.5 text-[10px] font-bold font-mono text-muted-foreground hover:text-foreground hover:bg-muted/80 transition-colors"
        title="Alterar velocidade de reprodução"
      >
        {playbackRate}x
      </button>
    </div>
  );
}
