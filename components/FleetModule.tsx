"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ModuleInstance } from "@/lib/types";
import { loadSettings } from "./SettingsModal";
import { useAutoRefresh } from "@/lib/useAutoRefresh";
import { useIsDark } from "@/lib/useIsDark";
import { SETTINGS_CHANGED_EVENT } from "@/lib/clientState";
import type { FleetProbeResult, FleetServerResult } from "@/lib/fleet";

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
  sectionBg: "#f9fafb",
  text: "#111827",
  textMuted: "#6b7280",
  textFaint: "#9ca3af",
  accent: "#2563eb",
};
const F_DARK = {
  bg: "#0f1115",
  headerBg: "#151821",
  border: "#232733",
  sectionBg: "#12151d",
  text: "#e4e7ee",
  textMuted: "#9aa4b8",
  textFaint: "#6b7385",
  accent: "#60a5fa",
};

const DOT = { up: "#22c55e", down: "#ef4444" };

export default function FleetModule({ module, onRemove }: Props) {
  const F = useIsDark() ? F_DARK : F_LIGHT;
  // Read from the settings cache on every render (cheap: an in-memory map).
  // A settings edit dispatches SETTINGS_CHANGED_EVENT, which triggers a
  // re-render below and re-probes immediately — no wait for the next tick.
  const initial = loadSettings();
  const [endpoints, setEndpoints] = useState(initial.fleetEndpoints ?? []);
  const [servers, setServers] = useState(initial.fleetServers ?? []);
  const [serviceResults, setServiceResults] = useState<FleetProbeResult[] | null>(null);
  const [serverResults, setServerResults] = useState<FleetServerResult[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const check = useCallback(async () => {
    if (endpoints.length === 0 && servers.length === 0) {
      setServiceResults([]);
      setServerResults([]);
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
        body: JSON.stringify({ endpoints, servers }),
        signal: ctrl.signal,
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      const data = (await res.json()) as {
        results: FleetProbeResult[];
        servers: FleetServerResult[];
      };
      setServiceResults(data.results);
      setServerResults(data.servers);
    } catch (err) {
      if ((err as Error).name === "AbortError") return;
      setError((err as Error).message);
      return false;
    } finally {
      setLoading(false);
    }
  }, [endpoints, servers]);

  useAutoRefresh(check, { intervalMs: REFRESH_MS });

  // React to Settings → Save immediately: refresh the local lists and kick
  // a probe so the module reflects the new endpoints/servers without a
  // page reload.
  useEffect(() => {
    const onChange = () => {
      const s = loadSettings();
      setEndpoints(s.fleetEndpoints ?? []);
      setServers(s.fleetServers ?? []);
    };
    window.addEventListener(SETTINGS_CHANGED_EVENT, onChange);
    return () => window.removeEventListener(SETTINGS_CHANGED_EVENT, onChange);
  }, []);

  // Re-probe when the endpoint/server lists change. Skip the very first
  // render — useAutoRefresh already fires the initial probe, and we don't
  // want two racing calls on mount.
  const initialRef = useRef(true);
  useEffect(() => {
    if (initialRef.current) {
      initialRef.current = false;
      return;
    }
    void check();
  }, [check]);

  const svcUp = serviceResults?.filter((r) => r.reachable).length ?? 0;
  const srvUp = serverResults?.filter((r) => r.up).length ?? 0;
  const totalUp = svcUp + srvUp;
  const total = (serviceResults?.length ?? 0) + (serverResults?.length ?? 0);
  const empty = endpoints.length === 0 && servers.length === 0;

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
          {total > 0 ? `${totalUp}/${total} up` : empty ? "no targets" : "checking…"}
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
        {empty && !error && (
          <div
            className="absolute inset-x-3 top-3 text-center text-xs"
            style={{ color: F.textFaint }}
          >
            No servers or services configured. Open Settings → Fleet.
          </div>
        )}

        {serverResults && serverResults.length > 0 && (
          <Section title="Servers" F={F}>
            <ul>
              {serverResults.map((r, i) => (
                <ServerRow
                  key={`${r.label}-${r.host}`}
                  result={r}
                  isLast={i === serverResults.length - 1}
                  F={F}
                />
              ))}
            </ul>
          </Section>
        )}

        {serviceResults && serviceResults.length > 0 && (
          <Section title="Services" F={F}>
            <ul>
              {serviceResults.map((r, i) => (
                <EndpointRow
                  key={`${r.label}-${r.host}-${r.port}`}
                  result={r}
                  isLast={i === serviceResults.length - 1}
                  F={F}
                />
              ))}
            </ul>
          </Section>
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

function Section({
  title,
  F,
  children,
}: {
  title: string;
  F: typeof F_LIGHT;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div
        className="px-3 py-1 text-[10px] uppercase tracking-wider font-medium"
        style={{
          color: F.textFaint,
          background: F.sectionBg,
          borderTop: `1px solid ${F.border}`,
          borderBottom: `1px solid ${F.border}`,
        }}
      >
        {title}
      </div>
      {children}
    </div>
  );
}

function ServerRow({
  result,
  isLast,
  F,
}: {
  result: FleetServerResult;
  isLast: boolean;
  F: typeof F_LIGHT;
}) {
  const dot = result.up ? DOT.up : DOT.down;
  const title = result.up
    ? result.openPorts.length > 0
      ? `up — ports open: ${result.openPorts.join(", ")}`
      : "up — host answered but every probed port is closed"
    : "unreachable on every probed port (timeout)";
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
        title={result.host}
      >
        {result.host}
      </span>
      <span
        className="text-[12px] mono shrink-0 tabular-nums"
        style={{
          color: result.up ? F.textMuted : DOT.down,
          minWidth: 52,
          textAlign: "right",
        }}
      >
        {result.up ? `${result.latencyMs}ms` : "down"}
      </span>
    </li>
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
        style={{
          color: result.reachable ? F.textMuted : DOT.down,
          minWidth: 52,
          textAlign: "right",
        }}
      >
        {result.reachable ? `${result.latencyMs}ms` : "down"}
      </span>
    </li>
  );
}
