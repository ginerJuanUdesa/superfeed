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
      setError(
        `Missing OAuth client for: ${missing.map((m) => m.label).join(", ")}`
      );
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
          accounts: accounts.map((a) => ({
            label: a.label,
            refreshToken: a.refreshToken,
            clientId: a.clientId,
            clientSecret: a.clientSecret,
          })),
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
    <div className="panel group h-full w-full cursor-move flex flex-col">
      <div className="panel-header shrink-0">
        <span className="panel-header-tag">Gmail</span>
        <span className="panel-header-meta mono">
          {visibleItems ? String(visibleItems.length).padStart(2, "0") : "00"} messages
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
          <div className="absolute bottom-3 inset-x-3 text-center text-xs text-[var(--text-faint)]">
            {configuredAccounts.length === 0
              ? "No Gmail accounts configured. Open Settings."
              : selectedAccounts.length === 0
              ? "No accounts selected. Open the menu to pick some."
              : "No mail yet."}
          </div>
        )}
      </div>

      <div className="absolute top-1 right-1 opacity-0 group-hover:opacity-100 transition-opacity z-10 flex items-center gap-1">
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
  // chip sits on the flap; keep it on a light surface so the flap colors read
  const chipStyle: React.CSSProperties =
    kind === "alert"
      ? { backgroundColor: "#ffffff", color: "#b91c1c" }
      : kind === "spam"
      ? { backgroundColor: "#e5e7eb", color: "#374151" }
      : { backgroundColor: "#ffffff", color: "#111827" };
  const label = kind === "alert" ? "alert" : kind === "spam" ? "spam" : "mail";
  // Summary color inside the dark body — one accent per state, still legible.
  const summaryColor =
    kind === "alert"
      ? "#f28b8b"
      : kind === "spam"
      ? "var(--text-faint)"
      : "var(--text-muted)";

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
        <div className="px-3.5 pt-2 pb-2.5">
          <div className="flex items-baseline gap-2 min-w-0">
            <span className="text-sm font-medium text-[var(--text)] leading-tight truncate">
              {item.subject}
            </span>
            <span className="text-[10px] text-[var(--text-faint)] shrink-0 mono">
              {relativeTime(item.receivedAt)}
            </span>
          </div>
          {summary ? (
            <div
              className={`mt-1.5 text-xs leading-snug ${kind === "alert" ? "font-medium" : ""}`}
              style={{ color: summaryColor }}
            >
              {summary}
            </div>
          ) : item.snippet ? (
            <div className="mt-1.5 text-xs text-[var(--text-faint)] line-clamp-2 leading-snug italic">
              {item.snippet}
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
          <div className="px-3 pt-1.5 pb-1 text-[11px] text-[var(--text-faint)] font-medium">
            Accounts
          </div>
          {configured.length === 0 ? (
            <div className="px-3 py-1 text-xs text-[var(--text-faint)] italic">
              None configured
            </div>
          ) : (
            configured.map((label) => {
              const checked = selected.includes(label);
              return (
                <label
                  key={label}
                  className="flex items-center gap-2.5 px-3 py-1.5 text-xs text-[var(--text)] hover:bg-[var(--surface-max)] cursor-pointer"
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() => toggle(label)}
                    className="accent-[var(--accent)]"
                  />
                  <span className="truncate">{label}</span>
                </label>
              );
            })
          )}
          <div className="my-1 h-px bg-[var(--border)]" />
          <button
            type="button"
            onClick={() => {
              onRegenerate();
              setOpen(false);
            }}
            className="w-full text-left px-3 py-1.5 text-xs text-[var(--text-muted)] hover:text-[var(--text)] hover:bg-[var(--surface-max)]"
          >
            Regenerate all
          </button>
        </div>
      )}
    </div>
  );
}
