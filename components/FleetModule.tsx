"use client";

import { useCallback, useMemo, useRef, useState } from "react";
import { ModuleInstance } from "@/lib/types";
import { loadSettings } from "./SettingsModal";
import { useAutoRefresh } from "@/lib/useAutoRefresh";
import { useIsDark } from "@/lib/useIsDark";
import type { FleetProbeResult } from "@/lib/fleet";

interface Props {
  module: ModuleInstance;
  onRemove: (id: string) => void;
  onUpdateConfig: (id: string, config: Record<string, unknown>) => void;
}

// Fleet probes are cheap (a TCP SYN each). Polling faster than this just adds
// noise; slower makes an "is my server down" glance stale.
const REFRESH_MS = 20 * 1000;

const F_LIGHT = {
  bg: "#ffffff",
  headerBg: "#f6f7f9",
  border: "#e5e7eb",
  rowHover: "#f2f4f8",
  text: "#111827",
  textMuted: "#6b7280",
  textFaint: "#9ca3af",
  accent: "#2563eb",
};
const F_DARK = {
  bg: "#0f1115",
  headerBg: "#151821",
  border: "#232733",
  rowHover: "#1a1e29",
  text: "#e4e7ee",
  textMuted: "#9aa4b8",
  textFaint: "#6b7385",
  accent: "#60a5fa",
};

const DOT = { up: "#22c55e", down: "#ef4444", unknown: "#9ca3af" };

export default function FleetModule({ module, onRemove }: Props) {
  const F = useIsDark() ? F_DARK : F_LIGHT;
  const endpoints = useMemo(() => loadSettings().fleetEndpoints ?? [], []);
  const [results, setResults] = useState<FleetProbeResult[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const check = useCallback(async () => {
    if (endpoints.length === 0) {
      setResults([]);
      setError(null);
      return;
    }
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/fleet/check", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ endpoints }),
        signal: ctrl.signal,
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      const data = (await res.json()) as { results: FleetProbeResult[] };
      setResults(data.results);
    } catch (err) {
      if ((err as Error).name === "AbortError") return;
      setError((err as Error).message);
      return false;
    } finally {
      setLoading(false);
    }
  }, [endpoints]);

  useAutoRefresh(check, { intervalMs: REFRESH_MS });

  const upCount = results?.filter((r) => r.reachable).length ?? 0;

  return (
    <div
      className="panel group h-full w-full cursor-move flex flex-col"
      style={{ background: F.bg, border: `1px solid ${F.border}` }}
    >
      <div
        className="panel-header shrink-0"
        style={{
          background: F.headerBg,
          borderBottom: `1px solid ${F.border}`,
          color: F.textMuted,
        }}
      >
        <span className="panel-header-tag" style={{ color: F.text }}>
          Fleet
        </span>
        <span className="panel-header-meta mono" style={{ color: F.textFaint }}>
          {results ? `${upCount}/${results.length} up` : "checking…"}
        </span>
        {loading && (
          <span
            className="panel-header-meta mono ml-auto"
            style={{ color: F.accent }}
          >
            probing
          </span>
        )}
      </div>

      <div className="relative flex-1 min-h-0 overflow-y-auto" style={{ background: F.bg }}>
        {error && (
          <div
            className="m-3 px-3 py-2 text-xs rounded-md"
            style={{
              color: DOT.down,
              background: `${DOT.down}18`,
              border: `1px solid ${DOT.down}44`,
            }}
          >
            {error}
          </div>
        )}
        {endpoints.length === 0 && !error && (
          <div
            className="absolute inset-x-3 top-3 text-center text-xs"
            style={{ color: F.textFaint }}
          >
            No endpoints configured. Open Settings → Fleet.
          </div>
        )}
        {results && results.length > 0 && (
          <ul>
            {results.map((r, i) => (
              <EndpointRow
                key={`${r.label}-${r.host}-${r.port}`}
                result={r}
                isLast={i === results.length - 1}
                F={F}
              />
            ))}
          </ul>
        )}
      </div>

      <div className="absolute top-1 right-1 opacity-0 group-hover:opacity-100 transition-opacity z-10 flex items-center gap-1">
        <button
          onClick={(e) => {
            e.stopPropagation();
            void check();
          }}
          onMouseDown={(e) => e.stopPropagation()}
          className="no-drag w-7 h-7 flex items-center justify-center rounded-md transition-colors text-xs"
          style={{ color: F.textMuted }}
          title="Probe now"
        >
          ↻
        </button>
        <button
          onClick={(e) => {
            e.stopPropagation();
            onRemove(module.id);
          }}
          onMouseDown={(e) => e.stopPropagation()}
          className="no-drag w-7 h-7 flex items-center justify-center rounded-md transition-colors text-lg leading-none"
          style={{ color: F.textMuted }}
          title="Remove module"
        >
          ×
        </button>
      </div>
    </div>
  );
}

function EndpointRow({
  result,
  isLast,
  F,
}: {
  result: FleetProbeResult;
  isLast: boolean;
  F: typeof F_LIGHT;
}) {
  const dot = result.reachable ? DOT.up : DOT.down;
  const title = result.reachable
    ? `reachable in ${result.latencyMs}ms`
    : `unreachable${result.error ? ` — ${result.error}` : ""}`;
  return (
    <li
      className="flex items-center gap-2 px-3 py-1.5 min-w-0"
      style={{
        borderBottom: isLast ? "none" : `1px solid ${F.border}`,
        color: F.text,
      }}
    >
      <span
        className="w-1.5 h-1.5 rounded-full shrink-0"
        style={{ background: dot }}
        title={title}
      />
      <span className="text-[13px] font-semibold truncate flex-1" style={{ color: F.text }}>
        {result.label}
      </span>
      <span
        className="text-[12px] mono truncate shrink-0"
        style={{ color: F.textMuted, maxWidth: "45%" }}
        title={`${result.host}:${result.port}`}
      >
        {result.host}:{result.port}
      </span>
      <span
        className="text-[12px] mono shrink-0 tabular-nums"
        style={{ color: result.reachable ? F.textMuted : DOT.down, minWidth: 52, textAlign: "right" }}
      >
        {result.reachable ? `${result.latencyMs}ms` : "down"}
      </span>
    </li>
  );
}
