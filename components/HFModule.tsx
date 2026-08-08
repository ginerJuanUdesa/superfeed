"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Article,
  Cube,
  Database,
  Rocket,
} from "@phosphor-icons/react";
import { HF_KINDS, HFKind, ModuleInstance } from "@/lib/types";
import { loadSettings } from "./SettingsModal";
import { getSummary, keyFor, setSummary } from "@/lib/summaryCache";
import type { HFItem } from "@/lib/hf";

// Aligned with the HF feed's server cache TTL — polling faster just re-serves cached items.
const REFRESH_MS = 5 * 60 * 1000;

interface Props {
  module: ModuleInstance;
  onRemove: (id: string) => void;
  onUpdateConfig: (id: string, config: Record<string, unknown>) => void;
}

/* HuggingFace's own palette — quoted verbatim so the module reads like an
 * embedded piece of huggingface.co instead of a bespoke card. These are held
 * constant across the app's light/dark themes on purpose: HF is dark on its
 * own site and the visual reference is the whole point of this restyle. */
const HF = {
  bg: "#0b0f19",
  headerBg: "#0f1420",
  border: "#1c2331",
  cardBg: "#141926",
  cardBorder: "#232a3b",
  iconBg: "#1e2534",
  text: "#e4e7ee",
  textMuted: "#9aa4b8",
  textFaint: "#6b7385",
  accent: "#ffb000", // HF's yellow — used sparingly for the kind chip
};

const KIND_LABEL: Record<HFKind, string> = {
  model: "model",
  dataset: "dataset",
  space: "space",
  paper: "paper",
};

function KindIcon({ kind, size = 16 }: { kind: HFKind; size?: number }) {
  const color = HF.textMuted;
  if (kind === "dataset") return <Database size={size} color={color} weight="regular" />;
  if (kind === "space") return <Rocket size={size} color={color} weight="regular" />;
  if (kind === "paper") return <Article size={size} color={color} weight="regular" />;
  return <Cube size={size} color={color} weight="regular" />;
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
    const id = window.setInterval(() => void load(), REFRESH_MS);
    return () => {
      window.clearInterval(id);
      abortRef.current?.abort();
    };
  }, [load]);

  useEffect(() => {
    if (!items || items.length === 0) return;
    const settings = loadSettings();

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
    <div
      className="panel group h-full w-full cursor-move flex flex-col"
      style={{ background: HF.bg, border: `1px solid ${HF.border}` }}
    >
      <div
        className="panel-header shrink-0"
        style={{
          background: HF.headerBg,
          borderBottom: `1px solid ${HF.border}`,
          color: HF.textMuted,
        }}
      >
        <span
          className="panel-header-tag"
          style={{ color: HF.text }}
        >
          Hugging Face
        </span>
        <span
          className="panel-header-meta mono"
          style={{ color: HF.textFaint }}
        >
          {visibleItems ? String(visibleItems.length).padStart(2, "0") : "00"} items
        </span>
        {loading && (
          <span
            className="panel-header-meta mono ml-auto"
            style={{ color: HF.accent }}
          >
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
          <ul className="px-3 py-3 space-y-4">
            {visibleItems.map((item) => {
              const k = keyFor(item.kind, item.id, item.isUpdate);
              const summary = summaries[k];
              const fallback = item.isUpdate
                ? item.lastCommit ?? item.description
                : item.description ?? item.lastCommit;
              const subline = summary ?? fallback;
              const verb = item.isUpdate ? "updated" : "released";
              return (
                <li key={k}>
                  <a
                    href={item.url}
                    target="_blank"
                    rel="noreferrer noopener"
                    className="block"
                    draggable={false}
                  >
                    {/* HF's feed row header: avatar + author verb kind · time */}
                    <div
                      className="flex items-center gap-1.5 mb-1.5 text-[11px] min-w-0"
                      style={{ color: HF.textMuted }}
                    >
                      {item.avatarUrl ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          src={item.avatarUrl}
                          alt=""
                          className="w-4 h-4 rounded-full object-cover shrink-0"
                          draggable={false}
                        />
                      ) : (
                        <span
                          className="w-4 h-4 rounded-full shrink-0"
                          style={{ background: HF.iconBg }}
                        />
                      )}
                      <span
                        className="font-semibold truncate"
                        style={{ color: HF.text }}
                      >
                        {item.author}
                      </span>
                      <span className="truncate">
                        {KIND_LABEL[item.kind]} {verb}
                        {item.isUpdate && item.lastCommitBy && (
                          <>
                            {" "}
                            by{" "}
                            <span style={{ color: HF.text }}>
                              {item.lastCommitBy}
                            </span>
                          </>
                        )}
                      </span>
                      <span
                        className="ml-auto shrink-0"
                        style={{ color: HF.textFaint }}
                      >
                        {relativeTime(item.lastModified)}
                      </span>
                    </div>

                    {/* HF's repo card: icon tile + title + subline */}
                    <div
                      className="flex items-start gap-2.5 px-3 py-2.5 rounded-lg transition-colors group-hover/hf:border-[#2f374a]"
                      style={{
                        background: HF.cardBg,
                        border: `1px solid ${HF.cardBorder}`,
                      }}
                    >
                      {item.avatarUrl ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          src={item.avatarUrl}
                          alt=""
                          className="w-8 h-8 rounded-md object-cover shrink-0"
                          style={{ background: HF.iconBg }}
                          draggable={false}
                        />
                      ) : (
                        <div
                          className="w-8 h-8 rounded-md flex items-center justify-center shrink-0"
                          style={{ background: HF.iconBg }}
                        >
                          <KindIcon kind={item.kind} />
                        </div>
                      )}
                      <div className="min-w-0 flex-1">
                        <div
                          className="text-sm font-semibold truncate"
                          style={{ color: HF.text }}
                        >
                          {item.author}/{item.name}
                        </div>
                        {subline ? (
                          <div
                            className="text-[11px] mt-0.5 leading-snug line-clamp-2"
                            style={{ color: HF.textMuted }}
                          >
                            {subline}
                          </div>
                        ) : (
                          <div
                            className="text-[11px] mt-0.5 italic"
                            style={{ color: HF.textFaint }}
                          >
                            summarizing…
                          </div>
                        )}
                      </div>
                    </div>
                  </a>
                </li>
              );
            })}
          </ul>
        )}
        {empty && !error && (
          <div
            className="absolute bottom-3 inset-x-3 text-center text-xs"
            style={{ color: HF.textFaint }}
          >
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
          className="no-drag w-7 h-7 flex items-center justify-center rounded-md transition-colors text-lg leading-none"
          style={{ color: HF.textMuted }}
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
        className="w-7 h-7 rounded-md flex flex-col items-center justify-center gap-[3px] transition-colors"
        style={{ color: HF.textMuted }}
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
            background: HF.headerBg,
            border: `1px solid ${HF.border}`,
            borderRadius: "var(--radius)",
            boxShadow: "0 24px 48px -20px rgba(0,0,0,0.85)",
            color: HF.text,
          }}
        >
          <KindSection title="Releases" selected={releaseKinds} onChange={onChangeReleases} />
          <div className="my-1 h-px" style={{ background: HF.border }} />
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
      <div
        className="px-3 pt-1.5 pb-1 text-[11px] font-medium"
        style={{ color: HF.textFaint }}
      >
        {title}
      </div>
      {HF_KINDS.map(({ key, label }) => {
        const checked = selected.includes(key);
        return (
          <label
            key={key}
            className="flex items-center gap-2.5 px-3 py-1.5 text-xs cursor-pointer"
            style={{ color: HF.text }}
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
