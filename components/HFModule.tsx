"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { HF_KINDS, HFKind, ModuleInstance } from "@/lib/types";
import { loadSettings } from "./SettingsModal";
import {
  getAuthorColor,
  getSummary,
  keyFor,
  setAuthorColor,
  setSummary,
} from "@/lib/summaryCache";
import { dominantColorFromImage } from "@/lib/avatarColor";
import type { HFItem } from "@/lib/hf";

interface Props {
  module: ModuleInstance;
  onRemove: (id: string) => void;
  onUpdateConfig: (id: string, config: Record<string, unknown>) => void;
}

const KIND_LABEL: Record<HFKind, string> = {
  model: "MODEL",
  dataset: "DATASET",
  space: "SPACE",
  paper: "PAPER",
};

const FALLBACK_COLOR = "#6b7280";

function hexToRgb(hex: string): [number, number, number] {
  const m = hex.replace("#", "").match(/^([0-9a-f]{6})$/i);
  if (!m) return [107, 114, 128];
  return [
    parseInt(m[1].slice(0, 2), 16),
    parseInt(m[1].slice(2, 4), 16),
    parseInt(m[1].slice(4, 6), 16),
  ];
}

function readableOn(hex: string): string {
  const [r, g, b] = hexToRgb(hex);
  // relative luminance
  const l = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return l > 0.62 ? "#111827" : "#ffffff";
}

function relativeTime(iso: string): string {
  const then = Date.parse(iso);
  if (!then) return "";
  const diff = Date.now() - then;
  const mins = Math.round(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.round(days / 30);
  if (months < 12) return `${months}mo ago`;
  const years = Math.round(months / 12);
  return `${years}y ago`;
}

export default function HFModule({ module, onRemove, onUpdateConfig }: Props) {
  // Legacy configs stored a single `kinds` list; seed both event columns from it.
  // Memoize on the serialized value so a fresh `[]` fallback each render
  // doesn't cascade into new array identities → useCallback/useEffect loop.
  const { releaseKinds, updateKinds, anyKinds } = useMemo(() => {
    const legacy = (module.config.kinds as HFKind[] | undefined) ?? [];
    const rk = (module.config.releaseKinds as HFKind[] | undefined) ?? legacy;
    const uk = (module.config.updateKinds as HFKind[] | undefined) ?? legacy;
    return {
      releaseKinds: rk,
      updateKinds: uk,
      anyKinds: Array.from(new Set([...rk, ...uk])),
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    JSON.stringify(module.config.kinds ?? null),
    JSON.stringify(module.config.releaseKinds ?? null),
    JSON.stringify(module.config.updateKinds ?? null),
  ]);
  const [items, setItems] = useState<HFItem[] | null>(null);
  const [summaries, setSummaries] = useState<Record<string, string>>({});
  const [authorColors, setAuthorColors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  const load = useCallback(async () => {
    const settings = loadSettings();
    const user = settings.hfUsername.trim();
    if (!user) {
      setError("Set your HF username in Settings");
      setItems([]);
      return;
    }
    if (!anyKinds.length) {
      setItems([]);
      setError(null);
      return;
    }
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/hf/feed", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          user,
          kinds: anyKinds,
          since: settings.startDate || undefined,
          token: settings.hfToken || undefined,
        }),
        signal: ctrl.signal,
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      const data = (await res.json()) as { items: HFItem[] };
      setItems(data.items);
    } catch (err) {
      if ((err as Error).name === "AbortError") return;
      setError((err as Error).message);
      setItems([]);
    } finally {
      setLoading(false);
    }
  }, [anyKinds]);

  useEffect(() => {
    void load();
    return () => abortRef.current?.abort();
  }, [load]);

  // Card color = dominant color of the account's profile picture, per author.
  useEffect(() => {
    if (!items || items.length === 0) return;

    const cached: Record<string, string> = {};
    const todo = new Map<string, string>(); // author -> avatarUrl
    for (const it of items) {
      const hit = getAuthorColor(it.author);
      if (hit) cached[it.author] = hit;
      else if (it.avatarUrl) todo.set(it.author, it.avatarUrl);
    }
    if (Object.keys(cached).length) setAuthorColors((prev) => ({ ...prev, ...cached }));
    if (!todo.size) return;

    let cancelled = false;
    void Promise.all(
      [...todo].map(async ([author, url]) => {
        const color = await dominantColorFromImage(url);
        if (!color || cancelled) return;
        setAuthorColor(author, color);
        setAuthorColors((prev) => ({ ...prev, [author]: color }));
      })
    );
    return () => {
      cancelled = true;
    };
  }, [items]);

  // Fetch missing summaries from LLM.
  useEffect(() => {
    if (!items || items.length === 0) return;
    const settings = loadSettings();

    // Hydrate cached data
    const initSummaries: Record<string, string> = {};
    const pending: HFItem[] = [];
    for (const it of items) {
      const k = keyFor(it.kind, it.id, it.isUpdate);
      const cachedSummary = getSummary(k);
      if (cachedSummary) initSummaries[k] = cachedSummary;
      else pending.push(it);
    }
    if (Object.keys(initSummaries).length)
      setSummaries((prev) => ({ ...prev, ...initSummaries }));

    if (!settings.localLlmUrl || !pending.length) return;

    let cancelled = false;
    const CONC = 6;
    let idx = 0;
    async function worker() {
      while (!cancelled && idx < pending.length) {
        const it = pending[idx++];
        const k = keyFor(it.kind, it.id, it.isUpdate);
        try {
          const res = await fetch("/api/summarize", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              item: it,
              llmUrl: settings.localLlmUrl,
              llmModel: settings.localLlmModel || undefined,
            }),
          });
          if (!res.ok) continue;
          const data = (await res.json()) as { summary?: string };
          const summary = (data.summary || "").trim();
          if (cancelled) return;
          if (summary) {
            setSummary(k, summary);
            setSummaries((prev) => ({ ...prev, [k]: summary }));
          }
        } catch {
          // ignore
        }
      }
    }
    const workers = Array.from({ length: CONC }, () => worker());
    void Promise.all(workers);
    return () => {
      cancelled = true;
    };
  }, [items]);

  const visibleItems = items
    ? items.filter((it) =>
        it.isUpdate
          ? updateKinds.includes(it.kind)
          : releaseKinds.includes(it.kind)
      )
    : null;
  const empty = visibleItems && visibleItems.length === 0;

  return (
    <div className="panel group h-full w-full cursor-move flex flex-col">
      <div className="panel-header shrink-0">
        <span className="panel-header-tag">HuggingFace</span>
        <span className="panel-header-meta mono">
          {visibleItems ? String(visibleItems.length).padStart(2, "0") : "00"} items
        </span>
        {loading && (
          <span className="panel-header-meta mono ml-auto text-[var(--accent)]">
            loading
          </span>
        )}
      </div>

      <div className="relative flex-1 min-h-0 overflow-y-auto">
        {error && (
          <div
            className="m-3 px-3 py-2 text-xs rounded-md"
            style={{
              color: "var(--danger)",
              background: "rgba(216, 91, 91, 0.08)",
              border: "1px solid rgba(216, 91, 91, 0.25)",
            }}
          >
            {error}
          </div>
        )}
        {visibleItems && visibleItems.length > 0 && (
          <ul className="p-2 space-y-2">
            {visibleItems.map((item) => {
              const k = keyFor(item.kind, item.id, item.isUpdate);
              const summary = summaries[k];
              const barColor = authorColors[item.author] ?? FALLBACK_COLOR;
              const barText = readableOn(barColor);
              return (
                <li key={k}>
                  <a
                    href={item.url}
                    target="_blank"
                    rel="noreferrer noopener"
                    className="feed-card block"
                    draggable={false}
                  >
                    <div
                      className="flex items-center gap-2 px-3 py-1.5 min-w-0"
                      style={{ backgroundColor: barColor, color: barText }}
                    >
                      {item.avatarUrl && (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          src={item.avatarUrl}
                          alt=""
                          className="shrink-0 w-5 h-5 rounded-full object-cover"
                          style={{
                            boxShadow: `0 0 0 1px ${barText}`,
                            background: barText,
                          }}
                          draggable={false}
                        />
                      )}
                      <span className="text-[11px] font-semibold truncate">{item.author}</span>
                      <span
                        className="text-[9px] uppercase tracking-[0.14em] font-semibold shrink-0 rounded px-1.5 py-[1px] leading-[1.4]"
                        style={{ background: barText, color: barColor }}
                      >
                        {KIND_LABEL[item.kind]}
                      </span>
                      {item.isUpdate && (
                        <span
                          className="text-[9px] uppercase tracking-[0.14em] font-semibold shrink-0 rounded px-1.5 py-[1px] leading-[1.4]"
                          style={{ background: barText, color: barColor }}
                        >
                          updated
                        </span>
                      )}
                    </div>
                    <div className="px-3.5 pt-1.5 pb-2.5">
                      <div className="flex items-baseline gap-2 min-w-0">
                        <span className="text-sm font-medium text-[var(--text)] leading-tight truncate">
                          {item.name}
                        </span>
                        <span className="text-[10px] text-[var(--text-faint)] shrink-0 mono">
                          {relativeTime(item.lastModified)}
                        </span>
                      </div>
                      {summary ? (
                        <div className="mt-1.5 text-xs text-[var(--text-muted)] leading-snug">
                          {summary}
                        </div>
                      ) : item.lastCommit ? (
                        <div className="mt-1.5 text-xs text-[var(--text-faint)] line-clamp-2 leading-snug italic">
                          {item.lastCommit}
                          {item.lastCommitBy && (
                            <span> · {item.lastCommitBy}</span>
                          )}
                        </div>
                      ) : item.description ? (
                        <div className="mt-1.5 text-xs text-[var(--text-faint)] line-clamp-2 leading-snug italic">
                          {item.description}
                        </div>
                      ) : (
                        <div className="mt-1.5 text-[10px] text-[var(--text-faint)] italic">
                          summarizing…
                        </div>
                      )}
                    </div>
                  </a>
                </li>
              );
            })}
          </ul>
        )}
        {empty && !error && (
          <div className="absolute bottom-3 inset-x-3 text-center text-xs text-[var(--text-faint)]">
            {anyKinds.length === 0
              ? "No kinds selected. Open the menu to pick some."
              : "No matching items yet."}
          </div>
        )}
      </div>

      <div className="absolute top-1 right-1 opacity-0 group-hover:opacity-100 transition-opacity z-10 flex items-center gap-1">
        <BurgerMenu
          releaseKinds={releaseKinds}
          updateKinds={updateKinds}
          onChangeReleases={(next) =>
            onUpdateConfig(module.id, { ...module.config, releaseKinds: next })
          }
          onChangeUpdates={(next) =>
            onUpdateConfig(module.id, { ...module.config, updateKinds: next })
          }
        />
        <button
          onClick={(e) => {
            e.stopPropagation();
            onRemove(module.id);
          }}
          onMouseDown={(e) => e.stopPropagation()}
          className="no-drag w-7 h-7 flex items-center justify-center rounded-md text-[var(--text-muted)] hover:text-[var(--danger)] hover:bg-[var(--surface-max)] transition-colors text-lg leading-none"
          title="Remove module"
        >
          ×
        </button>
      </div>
    </div>
  );
}

function BurgerMenu({
  releaseKinds,
  updateKinds,
  onChangeReleases,
  onChangeUpdates,
}: {
  releaseKinds: HFKind[];
  updateKinds: HFKind[];
  onChangeReleases: (kinds: HFKind[]) => void;
  onChangeUpdates: (kinds: HFKind[]) => void;
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

  return (
    <div ref={ref} className="relative no-drag">
      <button
        onClick={(e) => {
          e.stopPropagation();
          setOpen((o) => !o);
        }}
        onMouseDown={(e) => e.stopPropagation()}
        className="w-7 h-7 rounded-md text-[var(--text-muted)] hover:text-[var(--text)] hover:bg-[var(--surface-max)] flex flex-col items-center justify-center gap-[3px] transition-colors"
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
            background: "var(--surface-hi)",
            border: "1px solid var(--border)",
            borderRadius: "var(--radius)",
            boxShadow: "0 24px 48px -20px rgba(0,0,0,0.85)",
          }}
        >
          <KindSection title="Releases" selected={releaseKinds} onChange={onChangeReleases} />
          <div className="my-1 h-px bg-[var(--border)]" />
          <KindSection title="Updates" selected={updateKinds} onChange={onChangeUpdates} />
        </div>
      )}
    </div>
  );
}

function KindSection({
  title,
  selected,
  onChange,
}: {
  title: string;
  selected: HFKind[];
  onChange: (kinds: HFKind[]) => void;
}) {
  const toggle = (kind: HFKind) => {
    const next = selected.includes(kind)
      ? selected.filter((k) => k !== kind)
      : [...selected, kind];
    onChange(next);
  };
  return (
    <>
      <div className="px-3 pt-1.5 pb-1 text-[11px] text-[var(--text-faint)] font-medium">
        {title}
      </div>
      {HF_KINDS.map(({ key, label }) => {
        const checked = selected.includes(key);
        return (
          <label
            key={key}
            className="flex items-center gap-2.5 px-3 py-1.5 text-xs text-[var(--text)] hover:bg-[var(--surface-max)] cursor-pointer"
          >
            <input
              type="checkbox"
              checked={checked}
              onChange={() => toggle(key)}
              className="accent-[var(--accent)]"
            />
            <span>{label}</span>
          </label>
        );
      })}
    </>
  );
}
