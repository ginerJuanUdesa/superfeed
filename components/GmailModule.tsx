"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ModuleInstance } from "@/lib/types";
import { loadSettings } from "./SettingsModal";
import {
  clearAllGmailClassifications,
  getGmailClassification,
  preloadGmailClassifications,
  setGmailClassification,
  GmailClassification,
} from "@/lib/summaryCache";
import type { GmailItem } from "@/lib/gmail";
import { useIsDark } from "@/lib/useIsDark";
import { useAutoRefresh } from "@/lib/useAutoRefresh";

interface Props {
  module: ModuleInstance;
  onRemove: (id: string) => void;
  onUpdateConfig: (id: string, config: Record<string, unknown>) => void;
}

const REFRESH_MS = 5 * 60 * 1000;

/* Gmail's own light-theme palette, quoted verbatim so the module reads as an
 * embedded slice of mail.google.com. The dark variant mirrors Gmail's own
 * dark theme so the visual quote still holds. */
const G_LIGHT = {
  bg: "#ffffff",
  headerBg: "#f6f8fc",
  border: "#e5e7eb",
  rowHover: "#f2f4f8",
  rowUnread: "#ffffff",
  text: "#202124",
  textMuted: "#5f6368",
  textFaint: "#80868b",
  alertBg: "#fdecea",
  alertText: "#a50e0e",
  spamText: "#9aa0a6",
  accent: "#1a73e8",
};

const G_DARK = {
  bg: "#1f1f1f",
  headerBg: "#2a2a2a",
  border: "#3c3c3c",
  rowHover: "#2b2b2b",
  rowUnread: "#1f1f1f",
  text: "#e8eaed",
  textMuted: "#9aa0a6",
  textFaint: "#7d8286",
  alertBg: "#5c1a1a",
  alertText: "#f28b82",
  spamText: "#6d7175",
  accent: "#8ab4f8",
};

/** Row-status dot palette. Alerts trump unread, unread trumps read.
 *  Same hues in both themes — Gmail's own dots don't change. */
const DOT = {
  alert: "#d93025",
  unread: "#188038",
  read: "#9aa0a6",
};

function relativeTime(iso: string): string {
  const then = Date.parse(iso);
  if (!then) return "";
  const now = new Date();
  const d = new Date(then);
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  if (sameDay) {
    return d.toLocaleTimeString(undefined, {
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
  }
  const sameYear = d.getFullYear() === now.getFullYear();
  if (sameYear) {
    return d.toLocaleDateString(undefined, { day: "2-digit", month: "short" });
  }
  return d.toLocaleDateString(undefined, { day: "2-digit", month: "short", year: "2-digit" });
}

const BATCH_SIZE = 6;

export default function GmailModule({ module, onRemove, onUpdateConfig }: Props) {
  const G = useIsDark() ? G_DARK : G_LIGHT;
  const configuredAccounts = useMemo(() => {
    const s = loadSettings();
    return s.gmailAccounts.map((a) => a.label.trim()).filter(Boolean);
  }, []);

  const selectedAccounts = useMemo(() => {
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
  const [regenTick, setRegenTick] = useState(0);
  const abortRef = useRef<AbortController | null>(null);

  const regenerate = useCallback(() => {
    void clearAllGmailClassifications();
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
      return false;
    } finally {
      setLoading(false);
    }
  }, [selectedAccounts]);

  useAutoRefresh(load, { intervalMs: REFRESH_MS });
  useEffect(() => () => abortRef.current?.abort(), []);

  useEffect(() => {
    if (!items || items.length === 0) return;
    const settings = loadSettings();

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

    async function runAll(pending: GmailItem[]) {
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

    // Hydrate from the server-side classification store first — otherwise a
    // fresh device would treat everything as pending and re-classify the
    // whole inbox.
    void (async () => {
      await preloadGmailClassifications();
      if (cancelled) return;

      const cached: Record<string, GmailClassification> = {};
      const pending: GmailItem[] = [];
      for (const it of items) {
        const hit = getGmailClassification(it.id);
        if (hit) cached[it.id] = hit;
        else pending.push(it);
      }
      if (Object.keys(cached).length)
        setClassifications((prev) => ({ ...prev, ...cached }));
      if (!settings.localLlmUrl || !pending.length) return;
      await runAll(pending);
    })();
    return () => {
      cancelled = true;
    };
  }, [items, regenTick]);

  // Retry classification periodically. If the LLM was down when items arrived
  // (or the URL was empty), a bump here re-runs the classify effect. Only
  // ticks while there are still un-classified items.
  useEffect(() => {
    if (!items || items.length === 0) return;
    const id = window.setInterval(() => {
      const pending = items.some((it) => !getGmailClassification(it.id));
      if (pending) setRegenTick((t) => t + 1);
    }, 30_000);
    return () => window.clearInterval(id);
  }, [items]);

  const visibleItems = items;
  const empty = visibleItems && visibleItems.length === 0;

  return (
    <div
      className="panel group h-full w-full cursor-move flex flex-col"
      style={{ background: G.bg, border: `1px solid ${G.border}` }}
    >
      <div
        className="panel-header shrink-0"
        style={{
          background: G.headerBg,
          borderBottom: `1px solid ${G.border}`,
          color: G.textMuted,
        }}
      >
        <span className="panel-header-tag" style={{ color: G.text }}>
          Gmail
        </span>
        <span className="panel-header-meta mono" style={{ color: G.textFaint }}>
          {visibleItems ? String(visibleItems.length).padStart(2, "0") : "00"} messages
        </span>
        {loading && (
          <span
            className="panel-header-meta mono ml-auto"
            style={{ color: G.accent }}
          >
            loading
          </span>
        )}
      </div>

      <div className="relative flex-1 min-h-0 overflow-y-auto" style={{ background: G.bg }}>
        {error && (
          <div
            className="m-3 px-3 py-2 text-xs rounded-md"
            style={{
              color: G.alertText,
              background: G.alertBg,
              border: `1px solid ${G.alertText}22`,
            }}
          >
            {error}
          </div>
        )}
        {visibleItems && visibleItems.length > 0 && (
          <ul>
            {visibleItems.map((item, i) => (
              <MailRow
                key={item.id}
                item={item}
                classification={classifications[item.id]}
                isLast={i === visibleItems.length - 1}
              />
            ))}
          </ul>
        )}
        {empty && !error && (
          <div
            className="absolute bottom-3 inset-x-3 text-center text-xs"
            style={{ color: G.textFaint }}
          >
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
          className="no-drag w-7 h-7 flex items-center justify-center rounded-md transition-colors text-lg leading-none"
          style={{ color: G.textMuted }}
          title="Remove module"
        >
          ×
        </button>
      </div>
    </div>
  );
}

function MailRow({
  item,
  classification,
  isLast,
}: {
  item: GmailItem;
  classification?: GmailClassification;
  isLast: boolean;
}) {
  const G = useIsDark() ? G_DARK : G_LIGHT;
  const isSpam = classification?.isSpam ?? false;
  const isAlert = classification?.isAlert ?? false;

  const rowBg = isAlert ? G.alertBg : G.rowUnread;
  const senderColor = isSpam ? G.spamText : isAlert ? G.alertText : G.text;
  const subjectColor = isSpam ? G.spamText : isAlert ? G.alertText : G.text;
  const snippetColor = isSpam ? G.spamText : G.textMuted;
  const timeColor = isSpam ? G.spamText : isAlert ? G.alertText : G.textMuted;

  const dotColor = isAlert
    ? DOT.alert
    : item.isUnread
    ? DOT.unread
    : DOT.read;
  const dotTitle = isAlert
    ? `alert · ${item.account}`
    : item.isUnread
    ? `unread · ${item.account}`
    : `read · ${item.account}`;

  // `/mail/u/{email}/` 404s when Chrome isn't already signed into that account.
  // `?authuser={email}` makes Google resolve the right session (or prompt to switch).
  const href = item.accountEmail
    ? `https://mail.google.com/mail/?authuser=${encodeURIComponent(item.accountEmail)}#all/${item.id}`
    : `https://mail.google.com/mail/u/0/#all/${item.id}`;

  const summary = classification?.summary;
  const snippetText = summary ?? item.snippet ?? "";

  return (
    <li>
      <a
        href={href}
        target="_blank"
        rel="noreferrer noopener"
        className="block px-3 py-1.5 min-w-0 transition-colors gmail-row"
        draggable={false}
        style={{
          background: rowBg,
          borderBottom: isLast ? "none" : `1px solid ${G.border}`,
          color: G.text,
        }}
      >
        {/* line 1: dot + sender + subject + time */}
        <div className="flex items-center gap-2 min-w-0">
          <span
            className="w-1.5 h-1.5 rounded-full shrink-0"
            style={{ background: dotColor }}
            title={dotTitle}
          />
          <span
            className="text-[13px] font-semibold shrink-0 truncate"
            style={{ color: senderColor, width: "24%", minWidth: 90, maxWidth: 200 }}
          >
            {item.from || item.fromEmail}
          </span>
          <span
            className="text-[13px] truncate flex-1 min-w-0 font-medium"
            style={{ color: subjectColor }}
          >
            {item.subject}
          </span>
          <span
            className="text-[12px] shrink-0 mono"
            style={{ color: timeColor }}
          >
            {relativeTime(item.receivedAt)}
          </span>
        </div>
        {/* line 2: summary/snippet, indented under the sender column so the
             dot stays as the row's left anchor. Raw snippet renders italic
             so it's visually distinct from LLM summaries. */}
        {snippetText && (
          <div
            className={`text-[12px] leading-snug line-clamp-2 mt-0.5 pl-[14px]${
              summary ? "" : " italic opacity-70"
            }`}
            style={{ color: snippetColor }}
          >
            {snippetText}
          </div>
        )}
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
  const G = useIsDark() ? G_DARK : G_LIGHT;
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
        style={{ color: G.textMuted }}
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
            background: G.bg,
            border: `1px solid ${G.border}`,
            borderRadius: "var(--radius)",
            boxShadow: "0 24px 48px -20px rgba(0,0,0,0.25)",
            color: G.text,
          }}
        >
          <div
            className="px-3 pt-1.5 pb-1 text-[11px] font-medium"
            style={{ color: G.textFaint }}
          >
            Accounts
          </div>
          {configured.length === 0 ? (
            <div className="px-3 py-1 text-xs italic" style={{ color: G.textFaint }}>
              None configured
            </div>
          ) : (
            configured.map((label) => {
              const checked = selected.includes(label);
              return (
                <label
                  key={label}
                  className="flex items-center gap-2.5 px-3 py-1.5 text-xs cursor-pointer hover:bg-[#f2f4f8]"
                  style={{ color: G.text }}
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
          <div className="my-1 h-px" style={{ background: G.border }} />
          <button
            type="button"
            onClick={() => {
              onRegenerate();
              setOpen(false);
            }}
            className="w-full text-left px-3 py-1.5 text-xs hover:bg-[#f2f4f8]"
            style={{ color: G.textMuted }}
          >
            Regenerate all
          </button>
        </div>
      )}
    </div>
  );
}
