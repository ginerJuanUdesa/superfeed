"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ModuleInstance } from "@/lib/types";
import { loadSettings } from "./SettingsModal";
import type { CalendarEvent } from "@/lib/calendar";

interface Props {
  module: ModuleInstance;
  onRemove: (id: string) => void;
  onUpdateConfig: (id: string, config: Record<string, unknown>) => void;
}

const REFRESH_MS = 5 * 60 * 1000;

/* Dark-panel palette — tokens are the app's own so this module lives inside
 * the dashboard's theme, not calendar.google.com's white one. The celeste is
 * from the reference frame Juan supplied. */
const C = {
  bg: "var(--surface)",
  headerBg: "var(--surface-hi)",
  border: "var(--border)",
  text: "var(--text)",
  textMuted: "var(--text-muted)",
  textFaint: "var(--text-faint)",
  accent: "var(--accent)",
};

/** Sky-blue pastel used as the base event color. Two variants:
 *  - solid fill for regular events (dark text on pastel bg)
 *  - outline for pinned events (celeste border + text, transparent fill) */
const CELESTE = {
  fill: "#4a90e2",
  fillText: "#ffffff",
  outline: "#6ea8e8",
};

/** A pinned event is one whose summary carries a 📍. Google Calendar has no
 *  "pinned" flag — Juan encodes importance directly in the title. */
function isPinned(ev: CalendarEvent): boolean {
  return ev.summary.includes("📍");
}

/** Group key that reads like Google Calendar's day headers ("Today", "Tomorrow", "Wed, Aug 6"). */
function dayKey(iso: string): { key: string; label: string } {
  const d = new Date(iso);
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const target = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const diffDays = Math.round((target.getTime() - today.getTime()) / 86400000);
  const key = target.toISOString().slice(0, 10);
  let label: string;
  if (diffDays === 0) label = "Today";
  else if (diffDays === 1) label = "Tomorrow";
  else if (diffDays > 0 && diffDays < 7)
    label = d.toLocaleDateString(undefined, { weekday: "long" });
  else
    label = d.toLocaleDateString(undefined, {
      weekday: "short",
      day: "numeric",
      month: "short",
    });
  return { key, label };
}

function fmtTime(ev: CalendarEvent): string {
  if (ev.allDay) return "All day";
  const tf: Intl.DateTimeFormatOptions = {
    hour: "numeric",
    minute: "2-digit",
    hour12: false,
  };
  const s = new Date(ev.start).toLocaleTimeString(undefined, tf);
  const e = new Date(ev.end).toLocaleTimeString(undefined, tf);
  return `${s}–${e}`;
}

export default function CalendarModule({ module, onRemove, onUpdateConfig }: Props) {
  const configuredAccounts = useMemo(() => {
    const s = loadSettings();
    return s.gmailAccounts.map((a) => a.label.trim()).filter(Boolean);
  }, []);

  const selectedAccounts = useMemo(() => {
    const excludedRaw = module.config.excludedAccountLabels as string[] | undefined;
    const excluded = new Set(excludedRaw ?? []);
    return configuredAccounts.filter((l) => !excluded.has(l));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    JSON.stringify(module.config.excludedAccountLabels ?? null),
    JSON.stringify(configuredAccounts),
  ]);

  const [items, setItems] = useState<CalendarEvent[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  const load = useCallback(async () => {
    const settings = loadSettings();
    const accounts = settings.gmailAccounts.filter(
      (a) => selectedAccounts.includes(a.label) && a.refreshToken
    );
    if (!accounts.length) {
      setError(null);
      setItems([]);
      return;
    }
    const missing = accounts.filter((a) => !a.clientId || !a.clientSecret);
    if (missing.length) {
      setError(`Missing OAuth client for: ${missing.map((m) => m.label).join(", ")}`);
      setItems([]);
      return;
    }

    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/calendar/feed", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          accounts: accounts.map((a) => ({
            label: a.label,
            refreshToken: a.refreshToken,
            clientId: a.clientId,
            clientSecret: a.clientSecret,
          })),
        }),
        signal: ctrl.signal,
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      const data = (await res.json()) as { items: CalendarEvent[] };
      setItems(data.items);
    } catch (err) {
      if ((err as Error).name === "AbortError") return;
      setError((err as Error).message);
      setItems([]);
    } finally {
      setLoading(false);
    }
  }, [selectedAccounts]);

  useEffect(() => {
    void load();
    const id = window.setInterval(() => void load(), REFRESH_MS);
    return () => {
      window.clearInterval(id);
      abortRef.current?.abort();
    };
  }, [load]);

  const grouped = useMemo(() => {
    if (!items) return null;
    const out = new Map<string, { label: string; events: CalendarEvent[] }>();
    for (const ev of items) {
      const { key, label } = dayKey(ev.start);
      const bucket = out.get(key);
      if (bucket) bucket.events.push(ev);
      else out.set(key, { label, events: [ev] });
    }
    return [...out.entries()].map(([key, v]) => ({ key, ...v }));
  }, [items]);

  const empty = items && items.length === 0;

  return (
    <div
      className="panel group h-full w-full cursor-move flex flex-col"
      style={{ background: C.bg, border: `1px solid ${C.border}` }}
    >
      <div
        className="panel-header shrink-0"
        style={{
          background: C.headerBg,
          borderBottom: `1px solid ${C.border}`,
          color: C.textMuted,
        }}
      >
        <span className="panel-header-tag" style={{ color: C.text }}>
          Calendar
        </span>
        <span className="panel-header-meta mono" style={{ color: C.textFaint }}>
          {items ? String(items.length).padStart(2, "0") : "00"} events
        </span>
        {loading && (
          <span
            className="panel-header-meta mono ml-auto"
            style={{ color: C.accent }}
          >
            loading
          </span>
        )}
      </div>

      <div className="relative flex-1 min-h-0 overflow-y-auto" style={{ background: C.bg }}>
        {error && (
          <div
            className="m-3 px-3 py-2 text-xs rounded-md"
            style={{
              color: "#a50e0e",
              background: "#fdecea",
              border: "1px solid #a50e0e22",
            }}
          >
            {error}
          </div>
        )}
        {grouped && grouped.length > 0 && (
          <div className="py-2">
            {grouped.map((group) => (
              <div key={group.key} className="mb-3 last:mb-0">
                <div
                  className="flex items-baseline gap-2 px-3 pb-1.5"
                  style={{ borderBottom: `1px solid ${C.border}` }}
                >
                  <span
                    className="text-[13px] font-medium"
                    style={{ color: C.text }}
                  >
                    {group.label}
                  </span>
                  <span
                    className="text-[11px] mono"
                    style={{ color: C.textFaint }}
                  >
                    {group.events.length}
                  </span>
                </div>
                <ul className="px-2 pt-1.5 space-y-1">
                  {group.events.map((ev) => (
                    <EventBlock key={`${ev.account}:${ev.id}`} ev={ev} />
                  ))}
                </ul>
              </div>
            ))}
          </div>
        )}
        {empty && !error && (
          <div
            className="absolute bottom-3 inset-x-3 text-center text-xs"
            style={{ color: C.textFaint }}
          >
            {configuredAccounts.length === 0
              ? "No accounts configured. Open Settings."
              : selectedAccounts.length === 0
              ? "No accounts selected. Open the menu to pick some."
              : "Nothing scheduled."}
          </div>
        )}
      </div>

      <div className="absolute top-1 right-1 opacity-0 group-hover:opacity-100 transition-opacity z-10 flex items-center gap-1">
        <BurgerMenu
          configured={configuredAccounts}
          selected={selectedAccounts}
          onChange={(next) => {
            const excluded = configuredAccounts.filter((l) => !next.includes(l));
            onUpdateConfig(module.id, {
              ...module.config,
              excludedAccountLabels: excluded,
            });
          }}
        />
        <button
          onClick={(e) => {
            e.stopPropagation();
            onRemove(module.id);
          }}
          onMouseDown={(e) => e.stopPropagation()}
          className="no-drag w-7 h-7 flex items-center justify-center rounded-md transition-colors text-lg leading-none"
          style={{ color: C.textMuted }}
          title="Remove module"
        >
          ×
        </button>
      </div>
    </div>
  );
}

function EventBlock({ ev }: { ev: CalendarEvent }) {
  const pinned = isPinned(ev);
  const href =
    ev.htmlLink ||
    (ev.accountEmail
      ? `https://calendar.google.com/calendar/u/${encodeURIComponent(ev.accountEmail)}/r`
      : "https://calendar.google.com/calendar/r");
  const style: React.CSSProperties = pinned
    ? {
        background: "transparent",
        border: `1.5px solid ${CELESTE.outline}`,
        color: CELESTE.outline,
      }
    : {
        background: CELESTE.fill,
        border: "1.5px solid transparent",
        color: CELESTE.fillText,
      };
  return (
    <li>
      <a
        href={href}
        target="_blank"
        rel="noreferrer noopener"
        draggable={false}
        className="block px-3 py-1.5 rounded-2xl transition-opacity hover:opacity-90"
        style={style}
        title={ev.account}
      >
        <div className="text-[13px] font-medium leading-tight truncate">
          {ev.summary}
        </div>
        <div className="text-[11px] leading-tight mt-0.5 truncate opacity-90">
          {fmtTime(ev)}
          {ev.location && (
            <>
              <span className="opacity-70">, </span>
              {ev.location}
            </>
          )}
        </div>
      </a>
    </li>
  );
}

function BurgerMenu({
  configured,
  selected,
  onChange,
}: {
  configured: string[];
  selected: string[];
  onChange: (next: string[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("mousedown", onClick);
    return () => window.removeEventListener("mousedown", onClick);
  }, [open]);

  const toggle = (label: string) => {
    const next = selected.includes(label)
      ? selected.filter((l) => l !== label)
      : [...selected, label];
    onChange(next);
  };

  return (
    <div ref={ref} className="relative no-drag">
      <button
        onClick={(e) => {
          e.stopPropagation();
          setOpen((o) => !o);
        }}
        onMouseDown={(e) => e.stopPropagation()}
        className="w-7 h-7 rounded-md flex flex-col items-center justify-center gap-[3px] transition-colors"
        style={{ color: C.textMuted }}
        title="Configure module"
      >
        <span className="w-3.5 h-[1.5px] bg-current rounded" />
        <span className="w-3.5 h-[1.5px] bg-current rounded" />
        <span className="w-3.5 h-[1.5px] bg-current rounded" />
      </button>
      {open && (
        <div
          className="absolute top-9 right-0 min-w-[190px] py-1.5 z-20"
          onMouseDown={(e) => e.stopPropagation()}
          onClick={(e) => e.stopPropagation()}
          style={{
            background: C.bg,
            border: `1px solid ${C.border}`,
            borderRadius: "var(--radius)",
            boxShadow: "0 24px 48px -20px rgba(0,0,0,0.25)",
            color: C.text,
          }}
        >
          <div
            className="px-3 pt-1.5 pb-1 text-[11px] font-medium"
            style={{ color: C.textFaint }}
          >
            Accounts
          </div>
          {configured.length === 0 ? (
            <div className="px-3 py-1 text-xs italic" style={{ color: C.textFaint }}>
              None configured
            </div>
          ) : (
            configured.map((label) => {
              const checked = selected.includes(label);
              return (
                <label
                  key={label}
                  className="flex items-center gap-2.5 px-3 py-1.5 text-xs cursor-pointer hover:bg-[#f2f4f8]"
                  style={{ color: C.text }}
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() => toggle(label)}
                  />
                  <span className="truncate">{label}</span>
                </label>
              );
            })
          )}
        </div>
      )}
    </div>
  );
}
