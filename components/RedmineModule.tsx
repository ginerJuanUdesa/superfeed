"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ModuleInstance } from "@/lib/types";
import { loadSettings } from "./SettingsModal";
import type { RedmineIssue, RedmineProject } from "@/lib/redmine";
import { useIsDark } from "@/lib/useIsDark";
import { useAutoRefresh } from "@/lib/useAutoRefresh";

interface Props {
  module: ModuleInstance;
  onRemove: (id: string) => void;
  onUpdateConfig: (id: string, config: Record<string, unknown>) => void;
}

const REFRESH_MS = 5 * 60 * 1000;
const SUMMARY_CACHE_PREFIX = "redmine-summary:";

/* Classic Redmine palette (light) + a matching dark variant that keeps the
 * blue banner as the identity anchor and darkens the body / borders. */
const R_LIGHT = {
  navBg: "#2a2a2a",
  navText: "#f0f0f0",
  navMuted: "#b8b8b8",
  bannerBg: "#628db6",
  bannerBgHi: "#7ba3ca",
  bannerText: "#ffffff",
  bannerSubtle: "#d8e4ef",
  body: "#ffffff",
  bodyAlt: "#f6f7f8",
  fieldsetBg: "#f6f6f6",
  fieldsetBorder: "#d7d7d7",
  legendText: "#555555",
  text: "#333333",
  muted: "#777777",
  faint: "#999999",
  link: "#169",
  closed: "#999999",
  danger: "#b02020",
  new: "#1a7f2a",
  summaryBg: "#fffde8",
  summaryBorder: "#e8dc8f",
};

const R_DARK = {
  navBg: "#1a1a1a",
  navText: "#f0f0f0",
  navMuted: "#a8a8a8",
  bannerBg: "#3d5a78",
  bannerBgHi: "#4c6f92",
  bannerText: "#ffffff",
  bannerSubtle: "#a8bfd6",
  body: "#1f1f1f",
  bodyAlt: "#262626",
  fieldsetBg: "#2a2a2a",
  fieldsetBorder: "#3c3c3c",
  legendText: "#b0b0b0",
  text: "#e6e6e6",
  muted: "#a0a0a0",
  faint: "#7a7a7a",
  link: "#7ab3f0",
  closed: "#8a8a8a",
  danger: "#f28b82",
  new: "#7fc48a",
  summaryBg: "#3a3416",
  summaryBorder: "#6b5f24",
};

const REDMINE_FONT =
  "Verdana, 'Lucida Grande', Geneva, Arial, Helvetica, sans-serif";

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
  return `${months}mo ago`;
}

interface IssueSummary {
  headline: string;
  statusNote: string;
  bullets: string[];
  updatedAt: string;
  journalCount: number;
}

export default function RedmineModule({ module, onRemove, onUpdateConfig }: Props) {
  const R = useIsDark() ? R_DARK : R_LIGHT;
  const selectedProjectIds = useMemo(
    () => (module.config.projectIds as number[] | undefined) ?? [],
    [module.config.projectIds]
  );
  const selectedKey = useMemo(
    () => JSON.stringify([...selectedProjectIds].sort()),
    [selectedProjectIds]
  );

  const [items, setItems] = useState<RedmineIssue[] | null>(null);
  const [projects, setProjects] = useState<RedmineProject[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  const loadProjects = useCallback(async () => {
    try {
      const res = await fetch("/api/redmine/projects");
      if (!res.ok) return;
      const data = (await res.json()) as { projects: RedmineProject[] };
      setProjects(data.projects);
    } catch {
      // best-effort
    }
  }, []);

  const load = useCallback(async () => {
    if (!selectedProjectIds.length) {
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
      const settings = loadSettings();
      const res = await fetch("/api/redmine/feed", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          projectIds: selectedProjectIds,
          since: settings.startDate || undefined,
        }),
        signal: ctrl.signal,
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      const data = (await res.json()) as { items: RedmineIssue[] };
      setItems(data.items);
    } catch (err) {
      if ((err as Error).name === "AbortError") return;
      setError((err as Error).message);
      setItems([]);
      return false;
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedKey]);

  useEffect(() => {
    void loadProjects();
  }, [loadProjects]);

  useAutoRefresh(load, { intervalMs: REFRESH_MS });
  useEffect(() => () => abortRef.current?.abort(), []);

  const sortedItems = useMemo(() => {
    if (!items) return null;
    return [...items].sort(
      (a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt)
    );
  }, [items]);

  const noneSelected = selectedProjectIds.length === 0;

  return (
    <div
      className="panel group h-full w-full cursor-move flex flex-col overflow-hidden"
      style={{
        background: R.body,
        border: `1px solid ${R.fieldsetBorder}`,
        fontFamily: REDMINE_FONT,
        color: R.text,
      }}
    >
      {/* blue banner */}
      <div
        className="shrink-0 flex items-center justify-between px-2.5 gap-2 min-w-0"
        style={{
          background: `linear-gradient(to bottom, ${R.bannerBgHi}, ${R.bannerBg})`,
          color: R.bannerText,
          height: 38,
          borderBottom: `1px solid #4a6f8f`,
        }}
      >
        <div
          className="font-bold truncate"
          style={{
            fontSize: 17,
            textShadow: "0 1px 0 rgba(0,0,0,0.2)",
            fontStyle: "italic",
          }}
        >
          Redmine
        </div>
      </div>

      {/* body */}
      <div className="relative flex-1 min-h-0 overflow-y-auto overflow-x-hidden px-2 py-2">
        {error && (
          <div
            className="mb-2 px-2 py-1.5 text-[11px] break-words"
            style={{
              color: R.danger,
              background: "#fbe3e4",
              border: `1px solid ${R.danger}66`,
            }}
          >
            {error}
          </div>
        )}

        {loading && !items && (
          <div className="text-[11px]" style={{ color: R.muted }}>
            Loading…
          </div>
        )}

        {items && items.length === 0 && !error && (
          <div className="text-[11px]" style={{ color: R.muted }}>
            {noneSelected
              ? "No projects selected — open the menu (top-right) to pick projects."
              : "No issues in the current window."}
          </div>
        )}

        {sortedItems && sortedItems.length > 0 && (
          <ul>
            {sortedItems.map((it) => (
              <IssueCard key={`${it.projectId}-${it.id}`} item={it} />
            ))}
          </ul>
        )}
      </div>

      <div className="absolute top-0.5 right-1 opacity-0 group-hover:opacity-100 transition-opacity z-10 flex items-center gap-1">
        <ProjectMenu
          projects={projects}
          selected={selectedProjectIds}
          onChange={(next) =>
            onUpdateConfig(module.id, { ...module.config, projectIds: next })
          }
          onRetryProjects={loadProjects}
        />
        <button
          onClick={(e) => {
            e.stopPropagation();
            onRemove(module.id);
          }}
          onMouseDown={(e) => e.stopPropagation()}
          className="no-drag w-5 h-5 flex items-center justify-center text-sm leading-none"
          style={{
            color: R.navText,
            background: "rgba(255,255,255,0.15)",
            border: `1px solid rgba(255,255,255,0.25)`,
          }}
          title="Remove module"
        >
          ×
        </button>
      </div>
    </div>
  );
}

function IssueCard({ item }: { item: RedmineIssue }) {
  const R = useIsDark() ? R_DARK : R_LIGHT;
  const isNew = item.flag === "new";
  const cacheKey = `${SUMMARY_CACHE_PREFIX}${item.id}:${item.updatedAt}`;
  const [summary, setSummary] = useState<IssueSummary | null>(null);
  const [sumErr, setSumErr] = useState<string | null>(null);
  const [sumLoading, setSumLoading] = useState(false);
  const fetchedRef = useRef(false);

  const fetchSummary = useCallback(async () => {
    if (fetchedRef.current) return;
    fetchedRef.current = true;
    const settings = loadSettings();
    if (!settings.localLlmUrl) {
      setSumErr("no LLM configured");
      return;
    }
    setSumLoading(true);
    setSumErr(null);
    try {
      const res = await fetch("/api/redmine/summarize", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          issueId: item.id,
          llmUrl: settings.localLlmUrl,
          llmModel: settings.localLlmModel || undefined,
        }),
      });
      const body = (await res.json()) as
        | (IssueSummary & { error?: never })
        | { error: string };
      if (!res.ok || "error" in body) {
        throw new Error(("error" in body && body.error) || `HTTP ${res.status}`);
      }
      setSummary(body);
      try {
        localStorage.setItem(cacheKey, JSON.stringify(body));
      } catch {
        // localStorage may be full — non-fatal
      }
    } catch (err) {
      setSumErr((err as Error).message);
      fetchedRef.current = false; // allow retry
    } finally {
      setSumLoading(false);
    }
  }, [cacheKey, item.id]);

  // Load cache and only fetch on a real miss. Two separate effects (one to
  // read cache, one to fetch on null-summary) used to race on the first
  // render: the fetch effect saw summary=null before the cache-read effect
  // had a chance to set it, and every reload re-called the LLM.
  useEffect(() => {
    try {
      const raw = localStorage.getItem(cacheKey);
      if (raw) {
        setSummary(JSON.parse(raw) as IssueSummary);
        return;
      }
    } catch {
      // ignore
    }
    void fetchSummary();
  }, [cacheKey, fetchSummary]);

  const subjectColor = item.statusIsClosed ? R.closed : R.link;
  const summaryText = summary?.headline ?? "";

  return (
    <li>
      <a
        href={item.url}
        target="_blank"
        rel="noreferrer noopener"
        className="no-drag block px-2 py-1.5 min-w-0"
        draggable={false}
        onMouseDown={(e) => e.stopPropagation()}
        style={{
          background: R.body,
          borderBottom: `1px solid ${R.fieldsetBorder}`,
          color: R.text,
        }}
      >
        {/* line 1: #id + subject + [NEW] + time */}
        <div className="flex items-baseline gap-1.5 min-w-0 text-[12px] leading-snug">
          <span className="shrink-0 mono" style={{ color: R.muted }}>
            #{item.id}
          </span>
          <span
            className="min-w-0 truncate font-medium flex-1"
            style={{
              color: subjectColor,
              textDecoration: item.statusIsClosed ? "line-through" : "none",
            }}
          >
            {item.subject}
          </span>
          {isNew && (
            <span
              className="shrink-0 px-1"
              style={{
                color: R.new,
                border: `1px solid ${R.new}55`,
                fontSize: 9,
                fontWeight: "bold",
              }}
            >
              NEW
            </span>
          )}
          <span className="shrink-0 mono text-[11px]" style={{ color: R.faint }}>
            {relativeTime(item.updatedAt)}
          </span>
        </div>

        {/* line 2: author */}
        {item.author && (
          <div
            className="text-[11px] mt-0.5 pl-[14px] truncate"
            style={{ color: R.muted }}
          >
            {item.author}
          </div>
        )}

        {/* line 3: summary (or its loading/error state) */}
        {summaryText ? (
          <div
            className="text-[11.5px] leading-snug line-clamp-2 mt-0.5 pl-[14px]"
            style={{ color: R.text }}
          >
            {summaryText}
          </div>
        ) : sumErr ? (
          <div
            className="text-[11px] mt-0.5 pl-[14px] flex items-center gap-1.5 flex-wrap"
          >
            <span style={{ color: R.danger }} className="break-words">
              {sumErr}
            </span>
            <button
              className="no-drag hover:underline"
              style={{ color: R.link }}
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                fetchedRef.current = false;
                void fetchSummary();
              }}
              onMouseDown={(e) => e.stopPropagation()}
            >
              retry
            </button>
          </div>
        ) : sumLoading ? (
          <div
            className="text-[11px] mt-0.5 pl-[14px] italic"
            style={{ color: R.faint }}
          >
            summarizing…
          </div>
        ) : null}
      </a>
    </li>
  );
}

function ProjectMenu({
  projects,
  selected,
  onChange,
  onRetryProjects,
}: {
  projects: RedmineProject[] | null;
  selected: number[];
  onChange: (ids: number[]) => void;
  onRetryProjects: () => void;
}) {
  const R = useIsDark() ? R_DARK : R_LIGHT;
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState("");
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("mousedown", onClick);
    return () => window.removeEventListener("mousedown", onClick);
  }, [open]);

  const toggle = (id: number) => {
    onChange(
      selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id]
    );
  };

  const visible = useMemo(() => {
    if (!projects) return null;
    const q = filter.trim().toLowerCase();
    if (!q) return projects;
    return projects.filter(
      (p) =>
        p.name.toLowerCase().includes(q) ||
        p.identifier.toLowerCase().includes(q)
    );
  }, [projects, filter]);

  return (
    <div ref={ref} className="relative no-drag" style={{ fontFamily: REDMINE_FONT }}>
      <button
        onClick={(e) => {
          e.stopPropagation();
          setOpen((o) => !o);
        }}
        onMouseDown={(e) => e.stopPropagation()}
        className="w-5 h-5 flex flex-col items-center justify-center gap-[2px]"
        style={{
          color: R.navText,
          background: "rgba(255,255,255,0.15)",
          border: `1px solid rgba(255,255,255,0.25)`,
        }}
        title="Pick projects"
      >
        <span className="w-2.5 h-[1.5px] bg-current" />
        <span className="w-2.5 h-[1.5px] bg-current" />
        <span className="w-2.5 h-[1.5px] bg-current" />
      </button>
      {open && (
        <div
          className="absolute top-6 right-0 w-72 z-20 flex flex-col"
          onMouseDown={(e) => e.stopPropagation()}
          onClick={(e) => e.stopPropagation()}
          style={{
            background: R.body,
            border: `1px solid ${R.fieldsetBorder}`,
            boxShadow: "0 4px 12px rgba(0,0,0,0.15)",
            color: R.text,
            maxHeight: "60vh",
            fontSize: 11,
          }}
        >
          <div
            className="px-2 py-1.5 font-bold flex items-center gap-2"
            style={{
              background: R.bannerBg,
              color: R.bannerText,
              borderBottom: `1px solid #4a6f8f`,
            }}
          >
            <span>Projects</span>
            <span className="ml-auto font-normal" style={{ color: R.bannerSubtle }}>
              {selected.length} selected
            </span>
          </div>
          <div className="px-2 py-1.5" style={{ borderBottom: `1px solid ${R.fieldsetBorder}` }}>
            <input
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="filter…"
              className="w-full px-1.5 py-[2px] outline-none"
              style={{
                background: R.body,
                border: `1px solid ${R.fieldsetBorder}`,
                color: R.text,
                fontFamily: REDMINE_FONT,
                fontSize: 11,
              }}
              autoComplete="off"
              spellCheck={false}
            />
          </div>
          <div className="flex-1 overflow-y-auto">
            {visible === null && (
              <div className="px-2 py-2 flex items-center gap-2" style={{ color: R.muted }}>
                <span>Loading…</span>
                <button
                  className="ml-auto hover:underline"
                  style={{ color: R.link }}
                  onClick={onRetryProjects}
                >
                  retry
                </button>
              </div>
            )}
            {visible && visible.length === 0 && (
              <div className="px-2 py-1.5" style={{ color: R.muted }}>
                No matches.
              </div>
            )}
            {visible?.map((p, idx) => {
              const checked = selected.includes(p.id);
              return (
                <label
                  key={p.id}
                  className="flex items-center gap-2 px-2 py-[3px] cursor-pointer"
                  style={{
                    color: R.text,
                    background: idx % 2 === 1 ? R.bodyAlt : R.body,
                  }}
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() => toggle(p.id)}
                  />
                  <span className="flex-1 truncate">{p.name}</span>
                  <span style={{ color: R.faint, fontSize: 10 }}>#{p.id}</span>
                </label>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
