"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import {
  GitBranch,
  GitCommit,
  GitFork,
  GitMerge,
  GitPullRequest,
  ChatCircle,
  Package,
  Star,
  Warning,
} from "@phosphor-icons/react";
import { ModuleInstance } from "@/lib/types";
import { loadSettings } from "./SettingsModal";
import type { GithubItem, GithubItemKind, GithubItemState } from "@/lib/github";
import { useAutoRefresh } from "@/lib/useAutoRefresh";
import { useIsDark } from "@/lib/useIsDark";

interface Props {
  module: ModuleInstance;
  onRemove: (id: string) => void;
  onUpdateConfig: (id: string, config: Record<string, unknown>) => void;
}

const REFRESH_MS = 5 * 60 * 1000;

/* GitHub palette, quoted verbatim — this module reads as an embedded slice
 * of github.com's feed, dark-dimmed in dark mode and the site's own white
 * light theme in light mode. */
const GH_DARK = {
  bg: "#0d1117",
  headerBg: "#161b22",
  border: "#30363d",
  cardBg: "#161b22",
  cardInnerBg: "#0d1117",
  text: "#e6edf3",
  textMuted: "#8b949e",
  textFaint: "#6e7681",
  link: "#2f81f7",
  merged: { bg: "#8250df", fg: "#ffffff" },
  open: { bg: "#238636", fg: "#ffffff" },
  closed: { bg: "#da3633", fg: "#ffffff" },
  draft: { bg: "#6e7681", fg: "#ffffff" },
  codeBg: "#1f242c",
  codeFg: "#c9d1d9",
};
const GH_LIGHT: typeof GH_DARK = {
  bg: "#ffffff",
  headerBg: "#f6f8fa",
  border: "#d0d7de",
  cardBg: "#ffffff",
  cardInnerBg: "#f6f8fa",
  text: "#1f2328",
  textMuted: "#59636e",
  textFaint: "#818b98",
  link: "#0969da",
  merged: { bg: "#8250df", fg: "#ffffff" },
  open: { bg: "#1a7f37", fg: "#ffffff" },
  closed: { bg: "#cf222e", fg: "#ffffff" },
  draft: { bg: "#57606a", fg: "#ffffff" },
  codeBg: "#f6f8fa",
  codeFg: "#1f2328",
};
function useGHPalette() {
  return useIsDark() ? GH_DARK : GH_LIGHT;
}

function relativeTime(iso: string): string {
  const then = Date.parse(iso);
  if (!then) return "";
  const diff = Date.now() - then;
  const mins = Math.round(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} minute${mins === 1 ? "" : "s"} ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days} day${days === 1 ? "" : "s"} ago`;
  const months = Math.round(days / 30);
  return `${months} month${months === 1 ? "" : "s"} ago`;
}

function KindIcon({ kind, size = 12 }: { kind: GithubItemKind; size?: number }) {
  const GH = useGHPalette();
  const c = GH.textMuted;
  switch (kind) {
    case "pr":
      return <GitPullRequest size={size} color={c} weight="regular" />;
    case "issue":
      return <Warning size={size} color={c} weight="regular" />;
    case "release":
      return <Package size={size} color={c} weight="regular" />;
    case "push":
      return <GitCommit size={size} color={c} weight="regular" />;
    case "create":
      return <GitBranch size={size} color={c} weight="regular" />;
    case "star":
      return <Star size={size} color={c} weight="regular" />;
    case "fork":
      return <GitFork size={size} color={c} weight="regular" />;
    case "comment":
      return <ChatCircle size={size} color={c} weight="regular" />;
    default:
      return <GitCommit size={size} color={c} weight="regular" />;
  }
}

function StateChip({ state, kind }: { state: GithubItemState; kind: GithubItemKind }) {
  const GH = useGHPalette();
  if (!state) return null;
  const color =
    state === "merged"
      ? GH.merged
      : state === "closed"
      ? GH.closed
      : state === "draft"
      ? GH.draft
      : GH.open;
  const label =
    state === "merged" ? "Merged" : state === "draft" ? "Draft" : state === "closed" ? "Closed" : "Open";
  const Icon =
    state === "merged"
      ? GitMerge
      : kind === "issue"
      ? Warning
      : GitPullRequest;
  return (
    <span
      className="inline-flex items-center gap-1 rounded-full px-2 py-[2px] text-[11px] font-medium"
      style={{ background: `${color.bg}22`, color: color.bg, border: `1px solid ${color.bg}55` }}
    >
      <Icon size={11} color={color.bg} weight="fill" />
      {label}
    </span>
  );
}

export default function GithubModule({ module, onRemove, onUpdateConfig }: Props) {
  const GH = useGHPalette();
  // Feed on by default; PRs opt-in. `undefined` means never-touched → default.
  const showFeed = module.config.showFeed !== false;
  const showPRs = module.config.showPRs === true;
  const [items, setItems] = useState<GithubItem[] | null>(null);
  const [prs, setPrs] = useState<GithubItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  const fetchPage = useCallback(async (nextPage: number, signal: AbortSignal) => {
    const settings = loadSettings();
    const user = settings.githubUsername.trim();
    if (!user) {
      setError("Set your GitHub username in Settings");
      setItems([]);
      setHasMore(false);
      return null;
    }
    const res = await fetch("/api/github/feed", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        user,
        token: settings.githubToken || undefined,
        since: settings.startDate || undefined,
        page: nextPage,
      }),
      signal,
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
      throw new Error(body.error ?? `HTTP ${res.status}`);
    }
    return (await res.json()) as { items: GithubItem[]; hasMore: boolean };
  }, []);

  const fetchPRs = useCallback(async (signal: AbortSignal): Promise<GithubItem[] | null> => {
    const settings = loadSettings();
    const user = settings.githubUsername.trim();
    if (!user) {
      setError("Set your GitHub username in Settings");
      return [];
    }
    const res = await fetch("/api/github/prs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ user, token: settings.githubToken || undefined }),
      signal,
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
      throw new Error(body.error ?? `HTTP ${res.status}`);
    }
    return ((await res.json()) as { items: GithubItem[] }).items;
  }, []);

  const load = useCallback(async () => {
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setLoading(true);
    setError(null);
    try {
      const [prData, feedData] = await Promise.all([
        showPRs ? fetchPRs(ctrl.signal) : Promise.resolve<GithubItem[] | null>(null),
        showFeed ? fetchPage(1, ctrl.signal) : Promise.resolve(null),
      ]);
      setPrs(showPRs ? prData : null);
      setItems(showFeed ? (feedData?.items ?? null) : null);
      setHasMore(showFeed ? (feedData?.hasMore ?? false) : false);
      setPage(1);
    } catch (err) {
      if ((err as Error).name === "AbortError") return;
      setError((err as Error).message);
      setItems([]);
      setPrs([]);
      setHasMore(false);
      return false;
    } finally {
      setLoading(false);
    }
  }, [fetchPage, fetchPRs, showFeed, showPRs]);

  const loadMore = useCallback(async () => {
    if (loadingMore || loading || !hasMore) return;
    const ctrl = new AbortController();
    setLoadingMore(true);
    try {
      const next = page + 1;
      const data = await fetchPage(next, ctrl.signal);
      if (!data) return;
      setItems((prev) => {
        const seen = new Set((prev ?? []).map((it) => it.id));
        const merged = [...(prev ?? [])];
        for (const it of data.items) if (!seen.has(it.id)) merged.push(it);
        return merged;
      });
      setHasMore(data.hasMore);
      setPage(next);
    } catch {
      // silent — user can try scrolling again
    } finally {
      setLoadingMore(false);
    }
  }, [fetchPage, hasMore, loading, loadingMore, page]);

  useAutoRefresh(load, { intervalMs: REFRESH_MS });
  useEffect(() => () => abortRef.current?.abort(), []);

  // Reload immediately when the user flips Feed / Pull requests. useAutoRefresh
  // pins `load` in a ref and never re-fires on identity change, so drive it here.
  const mounted = useRef(false);
  useEffect(() => {
    if (!mounted.current) {
      mounted.current = true;
      return;
    }
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showFeed, showPRs]);

  useEffect(() => {
    const el = sentinelRef.current;
    const root = scrollRef.current;
    if (!el || !root || !hasMore) return;
    const obs = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) void loadMore();
      },
      { root, rootMargin: "200px" }
    );
    obs.observe(el);
    return () => obs.disconnect();
  }, [hasMore, loadMore, items]);

  const prCount = prs?.length ?? 0;
  const feedCount = items?.length ?? 0;
  const totalCount = prCount + feedCount;
  const loaded = (!showPRs || prs !== null) && (!showFeed || items !== null);
  const nothingOn = !showPRs && !showFeed;
  const empty = loaded && totalCount === 0 && !nothingOn;
  const bothOn = showPRs && showFeed;

  return (
    <div
      className="panel group h-full w-full cursor-move flex flex-col"
      style={{ background: GH.bg, border: `1px solid ${GH.border}` }}
    >
      <div
        className="panel-header shrink-0"
        style={{
          background: GH.headerBg,
          borderBottom: `1px solid ${GH.border}`,
          color: GH.textMuted,
        }}
      >
        <span className="panel-header-tag" style={{ color: GH.text }}>
          GitHub
        </span>
        <span className="panel-header-meta mono" style={{ color: GH.textFaint }}>
          {loaded ? String(totalCount).padStart(2, "0") : "00"}{" "}
          {showPRs && !showFeed ? "open PRs" : "events"}
        </span>
        {loading && (
          <span className="panel-header-meta mono ml-auto" style={{ color: GH.link }}>
            loading
          </span>
        )}
      </div>

      <div ref={scrollRef} className="relative flex-1 min-h-0 overflow-y-auto" style={{ background: GH.bg }}>
        {error && (
          <div
            className="m-3 px-3 py-2 text-xs rounded-md"
            style={{
              color: GH.closed.bg,
              background: `${GH.closed.bg}14`,
              border: `1px solid ${GH.closed.bg}55`,
            }}
          >
            {error}
          </div>
        )}
        {showPRs && prCount > 0 && (
          <>
            {bothOn && <SectionLabel>Open pull requests</SectionLabel>}
            <ul className="px-3 pt-3 pb-1 space-y-3">
              {prs!.map((it) => (
                <FeedCard key={it.id} item={it} />
              ))}
            </ul>
          </>
        )}
        {showFeed && feedCount > 0 && (
          <>
            {bothOn && <SectionLabel>Activity</SectionLabel>}
            <ul className="px-3 pt-3 pb-3 space-y-3">
              {items!.map((it) => (
                <FeedCard key={it.id} item={it} />
              ))}
            </ul>
          </>
        )}
        {showFeed && feedCount > 0 && hasMore && (
          <div
            ref={sentinelRef}
            className="py-3 text-center text-[11px] mono"
            style={{ color: GH.textFaint }}
          >
            {loadingMore ? "loading more…" : ""}
          </div>
        )}
        {nothingOn && !error && (
          <div
            className="absolute bottom-3 inset-x-3 text-center text-xs"
            style={{ color: GH.textFaint }}
          >
            Nothing selected. Open the menu (top-right) and pick Feed or Pull requests.
          </div>
        )}
        {empty && !error && (
          <div
            className="absolute bottom-3 inset-x-3 text-center text-xs"
            style={{ color: GH.textFaint }}
          >
            {showPRs && !showFeed ? "No open pull requests." : "No activity yet."}
          </div>
        )}
      </div>

      <div className="absolute top-1 right-1 opacity-0 group-hover:opacity-100 transition-opacity z-10 flex items-center gap-1">
        <ViewMenu
          showFeed={showFeed}
          showPRs={showPRs}
          onChange={(next) => onUpdateConfig(module.id, { ...module.config, ...next })}
        />
        <button
          onClick={(e) => {
            e.stopPropagation();
            onRemove(module.id);
          }}
          onMouseDown={(e) => e.stopPropagation()}
          className="no-drag w-7 h-7 flex items-center justify-center rounded-md transition-colors text-lg leading-none"
          style={{ color: GH.textMuted }}
          title="Remove module"
        >
          ×
        </button>
      </div>
    </div>
  );
}

function SectionLabel({ children }: { children: ReactNode }) {
  const GH = useGHPalette();
  return (
    <div
      className="px-3.5 pt-3 pb-1 text-[11px] font-semibold uppercase tracking-wide"
      style={{ color: GH.textFaint }}
    >
      {children}
    </div>
  );
}

function ViewMenu({
  showFeed,
  showPRs,
  onChange,
}: {
  showFeed: boolean;
  showPRs: boolean;
  onChange: (next: { showFeed?: boolean; showPRs?: boolean }) => void;
}) {
  const GH = useGHPalette();
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

  const rows: { key: "showPRs" | "showFeed"; label: string; checked: boolean }[] = [
    { key: "showPRs", label: "Pull requests", checked: showPRs },
    { key: "showFeed", label: "Feed", checked: showFeed },
  ];

  return (
    <div ref={ref} className="relative no-drag">
      <button
        onClick={(e) => {
          e.stopPropagation();
          setOpen((o) => !o);
        }}
        onMouseDown={(e) => e.stopPropagation()}
        className="w-7 h-7 flex flex-col items-center justify-center gap-[3px] rounded-md"
        style={{ color: GH.textMuted }}
        title="View options"
      >
        <span className="w-3 h-[1.5px] bg-current rounded-full" />
        <span className="w-3 h-[1.5px] bg-current rounded-full" />
        <span className="w-3 h-[1.5px] bg-current rounded-full" />
      </button>
      {open && (
        <div
          className="absolute top-8 right-0 z-20 py-1 rounded-md"
          onMouseDown={(e) => e.stopPropagation()}
          onClick={(e) => e.stopPropagation()}
          style={{
            background: GH.cardBg,
            border: `1px solid ${GH.border}`,
            boxShadow: "0 8px 24px rgba(0,0,0,0.4)",
            width: 176,
          }}
        >
          {rows.map((row) => (
            <label
              key={row.key}
              className="flex items-center gap-2 px-3 py-1.5 cursor-pointer text-[13px]"
              style={{ color: GH.text }}
            >
              <input
                type="checkbox"
                checked={row.checked}
                onChange={(e) => onChange({ [row.key]: e.target.checked })}
                className="accent-current"
                style={{ accentColor: GH.link }}
              />
              {row.label}
            </label>
          ))}
        </div>
      )}
    </div>
  );
}

function FeedCard({ item }: { item: GithubItem }) {
  const GH = useGHPalette();
  const hasHash = typeof item.number === "number";
  return (
    <li>
      <div
        className="rounded-md overflow-hidden"
        style={{ background: GH.cardBg, border: `1px solid ${GH.border}` }}
      >
        {/* Header: actor · action · repo · time */}
        <div className="flex items-start gap-2.5 px-3.5 pt-3">
          <div className="relative shrink-0">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={item.actorAvatar}
              alt=""
              className="w-8 h-8 rounded-full"
              draggable={false}
              style={{ background: GH.cardInnerBg }}
            />
            {/* small kind badge over the avatar corner, GH-style */}
            <span
              className="absolute -bottom-0.5 -right-0.5 w-4 h-4 rounded-full flex items-center justify-center"
              style={{ background: GH.headerBg, border: `1px solid ${GH.border}` }}
            >
              <KindIcon kind={item.kind} size={10} />
            </span>
          </div>
          <div className="min-w-0 flex-1">
            <div className="text-[13px] leading-snug" style={{ color: GH.textMuted }}>
              <a
                href={`https://github.com/${item.actor}`}
                target="_blank"
                rel="noreferrer noopener"
                className="font-semibold hover:underline"
                style={{ color: GH.text }}
              >
                {item.actor}
              </a>{" "}
              {item.action}{" "}
              <a
                href={item.repoUrl}
                target="_blank"
                rel="noreferrer noopener"
                className="font-semibold hover:underline"
                style={{ color: GH.text }}
              >
                {item.repo}
              </a>
            </div>
            <div className="text-[11px] mt-0.5" style={{ color: GH.textFaint }}>
              {relativeTime(item.createdAt)}
            </div>
          </div>
        </div>

        {/* Body: title + state + description */}
        <div className="px-3.5 pt-2.5 pb-3">
          <a
            href={item.url}
            target="_blank"
            rel="noreferrer noopener"
            className="block"
            draggable={false}
          >
            <div
              className="text-[15px] font-semibold leading-tight hover:underline"
              style={{ color: GH.text }}
            >
              {item.title}
              {hasHash && (
                <span style={{ color: GH.textFaint }}>{" "}#{item.number}</span>
              )}
            </div>
          </a>
          {item.state && (
            <div className="mt-2">
              <StateChip state={item.state} kind={item.kind} />
            </div>
          )}
          {item.body && (
            <div
              className="mt-2 text-[13px] leading-snug rounded-md px-3 py-2 line-clamp-3"
              style={{ background: GH.cardInnerBg, color: GH.textMuted, border: `1px solid ${GH.border}` }}
            >
              {item.body}
            </div>
          )}
        </div>
      </div>
    </li>
  );
}
