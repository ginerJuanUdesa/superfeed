"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ModuleInstance } from "@/lib/types";
import { loadSettings } from "./SettingsModal";
import {
  clearAllGmailClassifications,
  getGmailClassification,
  setGmailClassification,
  GmailClassification,
} from "@/lib/summaryCache";
import type { GmailItem } from "@/lib/gmail";

interface Props {
  module: ModuleInstance;
  onRemove: (id: string) => void;
  onUpdateConfig: (id: string, config: Record<string, unknown>) => void;
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

const BATCH_SIZE = 6;

export default function GmailModule({ module, onRemove, onUpdateConfig }: Props) {
  const configuredAccounts = useMemo(() => {
    const s = loadSettings();
    return s.gmailAccounts
      .map((a) => a.label.trim())
      .filter(Boolean);
  }, []);

  const selectedAccounts = useMemo(() => {
    // Opt-out semantics: default (nothing stored) = every configured account
    // is included. Migrate a legacy opt-in `accountLabels` list into its
    // equivalent excluded set so existing modules keep the same visible state.
    const excludedRaw = module.config.excludedAccountLabels as string[] | undefined;
    const legacyIncluded = module.config.accountLabels as string[] | undefined;
    const excluded = new Set(
      excludedRaw ??
        (legacyIncluded
          ? configuredAccounts.filter((l) => !legacyIncluded.includes(l))
          : [])
    );
    return configuredAccounts.filter((l) => !excluded.has(l));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    JSON.stringify(module.config.excludedAccountLabels ?? null),
    JSON.stringify(module.config.accountLabels ?? null),
    JSON.stringify(configuredAccounts),
  ]);

  const [items, setItems] = useState<GmailItem[] | null>(null);
  const [classifications, setClassifications] = useState<Record<string, GmailClassification>>({});
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  // Bumped by the "Regenerate" action to force the classify effect to re-fire
  // without waiting on `items` to change identity.
  const [regenTick, setRegenTick] = useState(0);
  const abortRef = useRef<AbortController | null>(null);

  const regenerate = useCallback(() => {
    clearAllGmailClassifications();
    setClassifications({});
    setRegenTick((t) => t + 1);
  }, []);

  const load = useCallback(async () => {
    const settings = loadSettings();
    if (!settings.gmailClientId || !settings.gmailClientSecret) {
      setError("Set Gmail Client ID and Secret in Settings");
      setItems([]);
      return;
    }
    const accounts = settings.gmailAccounts.filter(
      (a) => selectedAccounts.includes(a.label) && a.refreshToken
    );
    if (!accounts.length) {
      setError(null);
      setItems([]);
      return;
    }

    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/gmail/feed", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          clientId: settings.gmailClientId,
          clientSecret: settings.gmailClientSecret,
          accounts,
          since: settings.startDate || undefined,
        }),
        signal: ctrl.signal,
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      const data = (await res.json()) as { items: GmailItem[] };
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
    return () => abortRef.current?.abort();
  }, [load]);

  // Batched classify: pull cached, send the rest in small clusters.
  useEffect(() => {
    if (!items || items.length === 0) return;
    const settings = loadSettings();

    const cached: Record<string, GmailClassification> = {};
    const pending: GmailItem[] = [];
    for (const it of items) {
      const hit = getGmailClassification(it.id);
      if (hit) cached[it.id] = hit;
      else pending.push(it);
    }
    if (Object.keys(cached).length) setClassifications((prev) => ({ ...prev, ...cached }));
    if (!settings.localLlmUrl || !pending.length) return;

    let cancelled = false;

    async function runBatch(batch: GmailItem[]) {
      try {
        const res = await fetch("/api/gmail/classify", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            items: batch.map((it) => ({
              id: it.id,
              from: it.from,
              fromEmail: it.fromEmail,
              subject: it.subject,
              snippet: it.snippet,
              body: it.body,
              receivedAt: it.receivedAt,
            })),
            llmUrl: settings.localLlmUrl,
            llmModel: settings.localLlmModel || undefined,
          }),
        });
        if (!res.ok) return;
        const data = (await res.json()) as {
          results?: { id: string; summary: string; isSpam: boolean; isAlert?: boolean }[];
        };
        if (cancelled) return;
        const patch: Record<string, GmailClassification> = {};
        for (const r of data.results ?? []) {
          const value: GmailClassification = {
            summary: r.summary,
            isSpam: r.isSpam,
            isAlert: (r as { isAlert?: boolean }).isAlert === true,
          };
          setGmailClassification(r.id, value);
          patch[r.id] = value;
        }
        if (Object.keys(patch).length) {
          setClassifications((prev) => ({ ...prev, ...patch }));
        }
      } catch {
        // ignore
      }
    }

    async function runAll() {
      // Chunk into batches, run 2 batches concurrently.
      const batches: GmailItem[][] = [];
      for (let i = 0; i < pending.length; i += BATCH_SIZE) {
        batches.push(pending.slice(i, i + BATCH_SIZE));
      }
      const CONC = 2;
      let idx = 0;
      async function worker() {
        while (!cancelled && idx < batches.length) {
          const b = batches[idx++];
          await runBatch(b);
        }
      }
      await Promise.all(Array.from({ length: CONC }, () => worker()));
    }
    void runAll();
    return () => {
      cancelled = true;
    };
  }, [items, regenTick]);

  const visibleItems = items;
  const empty = visibleItems && visibleItems.length === 0;

  return (
    <div className="group relative h-full w-full rounded-2xl overflow-hidden cursor-move">
      {/* backdrop layers — same shell as HF module for visual coherence */}
      <div className="absolute inset-0 bg-gradient-to-br from-red-300/25 via-transparent to-blue-400/20 pointer-events-none" />
      <div className="absolute inset-0 bg-white/85 backdrop-blur-md" />
      <div className="absolute inset-0 rounded-2xl ring-1 ring-white/30 pointer-events-none" />
      <div className="absolute inset-0 rounded-2xl shadow-[inset_0_1px_0_rgba(255,255,255,0.5),0_10px_30px_-10px_rgba(0,0,0,0.4)] pointer-events-none" />
      {/* watermark logo */}
      <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src="/logos/gmail.png"
          alt=""
          className="w-[50%] max-w-[220px] h-auto drop-shadow-[0_6px_18px_rgba(234,67,53,0.35)] opacity-25"
          draggable={false}
        />
      </div>

      <div className="relative h-full w-full overflow-y-auto">
        {error && (
          <div className="m-3 px-3 py-2 text-[11px] text-red-700 bg-red-50/95 border border-red-200 rounded-md">
            {error}
          </div>
        )}
        {visibleItems && visibleItems.length > 0 && (
          <ul className="p-2 space-y-2">
            {visibleItems.map((item) => (
              <MailCard
                key={item.id}
                item={item}
                classification={classifications[item.id]}
              />
            ))}
          </ul>
        )}
        {empty && !error && (
          <div className="absolute bottom-2 inset-x-2 text-center text-[10px] text-neutral-500/80">
            {configuredAccounts.length === 0
              ? "No Gmail accounts configured — open Settings"
              : selectedAccounts.length === 0
              ? "No accounts selected — open the menu to pick"
              : "No mail yet."}
          </div>
        )}
      </div>

      {/* burger top-left */}
      <div className="absolute top-2 left-2 opacity-0 group-hover:opacity-100 transition-opacity z-10">
        <BurgerMenu
          configured={configuredAccounts}
          selected={selectedAccounts}
          onChange={(next) => {
            const excluded = configuredAccounts.filter((l) => !next.includes(l));
            const { accountLabels: _drop, ...rest } = module.config;
            void _drop;
            onUpdateConfig(module.id, { ...rest, excludedAccountLabels: excluded });
          }}
          onRegenerate={regenerate}
        />
      </div>

      {loading && (
        <div className="absolute top-2 left-1/2 -translate-x-1/2 text-[9px] uppercase tracking-widest text-neutral-500/70 pulse-glow pointer-events-none">
          loading
        </div>
      )}

      <button
        onClick={(e) => {
          e.stopPropagation();
          onRemove(module.id);
        }}
        onMouseDown={(e) => e.stopPropagation()}
        className="no-drag absolute top-2 right-2 w-6 h-6 rounded-full bg-white/60 backdrop-blur text-neutral-500 hover:text-red-500 hover:bg-white opacity-0 group-hover:opacity-100 transition-all flex items-center justify-center text-base leading-none shadow-sm z-10"
        title="Remove"
      >
        ×
      </button>
    </div>
  );
}

function MailCard({
  item,
  classification,
}: {
  item: GmailItem;
  classification?: GmailClassification;
}) {
  const isSpam = classification?.isSpam ?? false;
  const isAlert = classification?.isAlert ?? false;
  const summary = classification?.summary;

  // Precedence: alert (red) > spam (grey) > normal (multicolor Gmail gradient).
  // Alerts win because a security-alert-shaped spam still deserves the eye's attention.
  const kind: "alert" | "spam" | "normal" = isAlert ? "alert" : isSpam ? "spam" : "normal";

  const flapBg =
    kind === "alert"
      ? "linear-gradient(90deg, #b91c1c 0%, #dc2626 55%, #ef4444 100%)"
      : kind === "spam"
      ? "linear-gradient(90deg, #4b5563, #6b7280)"
      : "linear-gradient(90deg, #ea4335 0%, #fbbc04 45%, #34a853 70%, #4285f4 100%)";
  const flapText = kind === "spam" ? "#f3f4f6" : "#ffffff";
  const chipStyle: React.CSSProperties =
    kind === "alert"
      ? { backgroundColor: "#ffffff", color: "#b91c1c" }
      : kind === "spam"
      ? { backgroundColor: "#ffffff", color: "#4b5563" }
      : { backgroundColor: "#ffffff", color: "#111827" };
  const label = kind === "alert" ? "alert" : kind === "spam" ? "spam" : "mail";

  const href = item.accountEmail
    ? `https://mail.google.com/mail/u/${encodeURIComponent(item.accountEmail)}/#all/${item.id}`
    : `https://mail.google.com/mail/u/0/#all/${item.id}`;

  return (
    <li>
      <a
        href={href}
        target="_blank"
        rel="noreferrer noopener"
        className="envelope group/env block relative transition-transform hover:-translate-y-[1px]"
        draggable={false}
      >
        {/* rectangular top of the envelope flap — colored bar with metadata */}
        <div
          className="flex items-baseline gap-2 px-3.5 py-1.5 min-w-0"
          style={{ background: flapBg, color: flapText }}
        >
          <span className="text-[11px] font-semibold truncate">{item.account}</span>
          <span
            className="text-[9px] uppercase tracking-[0.14em] font-semibold shrink-0 rounded-sm px-1.5 py-[1px] leading-[1.4]"
            style={chipStyle}
          >
            {label}
          </span>
          <span className="text-[10px] font-medium truncate ml-auto opacity-90">
            {item.from}
          </span>
        </div>
        {/* triangular tip of the flap — dips down into the envelope body */}
        <div
          className="w-full h-4"
          style={{
            background: flapBg,
            clipPath: "polygon(0 0, 100% 0, 50% 100%)",
          }}
        />
        {/* envelope body (paper) — sharp corners, subtle grain from module bg */}
        <div className="envelope-body px-3.5 pt-2 pb-2.5">
          <div className="flex items-baseline gap-2 min-w-0">
            <span className="text-sm font-medium text-neutral-900 leading-tight truncate">
              {item.subject}
            </span>
            <span className="text-[10px] text-neutral-400 shrink-0">
              {relativeTime(item.receivedAt)}
            </span>
          </div>
          {summary ? (
            <div
              className={`mt-1.5 text-xs leading-snug ${
                kind === "alert"
                  ? "text-red-700 font-medium"
                  : kind === "spam"
                  ? "text-neutral-500"
                  : "text-neutral-700"
              }`}
            >
              {summary}
            </div>
          ) : item.snippet ? (
            <div className="mt-1.5 text-xs text-neutral-500 line-clamp-2 leading-snug italic">
              {item.snippet}
            </div>
          ) : (
            <div className="mt-1.5 text-[10px] text-neutral-400 italic">
              summarizing…
            </div>
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
  onRegenerate,
}: {
  configured: string[];
  selected: string[];
  onChange: (next: string[]) => void;
  onRegenerate: () => void;
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
        className="w-6 h-6 rounded text-neutral-500 hover:text-neutral-900 hover:bg-neutral-100 flex flex-col items-center justify-center gap-[3px]"
        title="Configure"
      >
        <span className="w-3.5 h-[2px] bg-current rounded" />
        <span className="w-3.5 h-[2px] bg-current rounded" />
        <span className="w-3.5 h-[2px] bg-current rounded" />
      </button>
      {open && (
        <div
          className="absolute top-8 left-0 min-w-[170px] rounded-lg border border-black/10 bg-white shadow-[0_10px_30px_-8px_rgba(0,0,0,0.35)] py-1.5 z-20"
          onMouseDown={(e) => e.stopPropagation()}
          onClick={(e) => e.stopPropagation()}
        >
          <div className="px-3 pt-1.5 pb-1 text-[10px] uppercase tracking-wider text-neutral-400 font-semibold">
            Accounts
          </div>
          {configured.length === 0 ? (
            <div className="px-3 py-1 text-[11px] text-neutral-500 italic">
              None configured
            </div>
          ) : (
            configured.map((label) => {
              const checked = selected.includes(label);
              return (
                <label
                  key={label}
                  className="flex items-center gap-2 px-3 py-1 text-xs text-neutral-800 hover:bg-neutral-100 cursor-pointer"
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() => toggle(label)}
                    className="accent-red-500"
                  />
                  <span className="truncate">{label}</span>
                </label>
              );
            })
          )}
          <div className="mt-1 border-t border-neutral-200/70" />
          <button
            type="button"
            onClick={() => {
              onRegenerate();
              setOpen(false);
            }}
            className="w-full text-left px-3 py-1.5 text-xs text-neutral-700 hover:bg-neutral-100"
          >
            Regenerate all
          </button>
        </div>
      )}
    </div>
  );
}
