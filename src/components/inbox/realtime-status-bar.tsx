"use client";

import { useEffect, useState } from "react";
import { Activity, Radio, Cpu, ShieldCheck } from "lucide-react";

interface HealthData {
  status: string;
  checks: {
    DATABASE?: string;
    WHATSAPP?: string;
    WEBHOOK?: string;
    AGENT?: string;
    "LAST INBOUND"?: string;
    "LAST OUTBOUND"?: string;
    "PENDING JOBS"?: number;
    "FAILED JOBS"?: number;
  };
  details?: {
    lastInboundMinutes?: number | null;
  };
}

export function RealtimeStatusBar({ isRealtimeConnected }: { isRealtimeConnected: boolean }) {
  const [health, setHealth] = useState<HealthData | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function fetchHealth() {
      try {
        const res = await fetch("/api/health");
        if (res.ok) {
          const data = await res.json();
          if (!cancelled) setHealth(data);
        }
      } catch {
        // non-blocking
      }
    }

    void fetchHealth();
    const interval = setInterval(fetchHealth, 15000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  const webhookOk = health?.checks?.WEBHOOK === "HEALTHY";
  const agentOk = health?.checks?.AGENT === "RUNNING";
  const lastInboundText = health?.checks?.["LAST INBOUND"] || "N/A";
  const pendingJobs = health?.checks?.["PENDING JOBS"] ?? 0;
  const failedJobs = health?.checks?.["FAILED JOBS"] ?? 0;

  return (
    <div className="flex flex-wrap items-center justify-between border-b border-border/40 bg-muted/20 px-3 py-1 text-[11px] text-muted-foreground select-none">
      <div className="flex items-center gap-4">
        {/* Webhook Status */}
        <div className="flex items-center gap-1.5" title="WhatsApp Webhook Intake">
          <Activity className="h-3 w-3 text-emerald-500" />
          <span>Webhook:</span>
          <span className="flex items-center gap-1 font-medium text-foreground">
            <span className={`h-1.5 w-1.5 rounded-full ${webhookOk ? "bg-emerald-500" : "bg-amber-500"}`} />
            {webhookOk ? "HEALTHY" : (health?.checks?.WEBHOOK || "CHECKING")}
          </span>
        </div>

        {/* Realtime WebSocket Status */}
        <div className="flex items-center gap-1.5" title="Supabase Realtime WebSocket Connection">
          <Radio className={`h-3 w-3 ${isRealtimeConnected ? "text-emerald-500 animate-pulse" : "text-amber-500"}`} />
          <span>Realtime:</span>
          <span className="flex items-center gap-1 font-medium text-foreground">
            <span className={`h-1.5 w-1.5 rounded-full ${isRealtimeConnected ? "bg-emerald-500" : "bg-amber-500"}`} />
            {isRealtimeConnected ? "CONNECTED" : "CONNECTING"}
          </span>
        </div>

        {/* Agent Status */}
        <div className="flex items-center gap-1.5" title="AI Agent Auto-Reply">
          <Cpu className="h-3 w-3 text-emerald-500" />
          <span>Agent:</span>
          <span className="flex items-center gap-1 font-medium text-foreground">
            <span className={`h-1.5 w-1.5 rounded-full ${agentOk ? "bg-emerald-500" : "bg-amber-500"}`} />
            {agentOk ? "HEALTHY" : (health?.checks?.AGENT || "CONFIGURED")}
          </span>
        </div>
      </div>

      <div className="flex items-center gap-4">
        {/* Last Inbound */}
        <div className="flex items-center gap-1">
          <span>Inbound:</span>
          <span className="font-medium text-foreground">{lastInboundText}</span>
        </div>

        {/* Pending / Failed */}
        <div className="flex items-center gap-2">
          <span>Pending: <strong className="text-foreground">{pendingJobs}</strong></span>
          <span>Failed: <strong className={failedJobs > 0 ? "text-destructive font-bold" : "text-foreground"}>{failedJobs}</strong></span>
        </div>
      </div>
    </div>
  );
}
