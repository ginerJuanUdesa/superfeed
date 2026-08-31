"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ModuleInstance } from "@/lib/types";
import { loadSettings } from "./SettingsModal";
import type { RedmineIssue, RedmineProject, RedmineUser } from "@/lib/redmine";
import { useIsDark } from "@/lib/useIsDark";
import { useAutoRefresh } from "@/lib/useAutoRefresh";

interface Props {
  module: ModuleInstance;
  onRemove: (id: string) => void;
  onUpdateConfig: (id: string, config: Record<string, unknown>) => void;
}

const REFRESH_MS = 5 * 60 * 1000;
const SUMMARY_CACHE_PREFIX = "redmine-summary:";

/* Each IssueCard used to fire its own summarize the moment it mounted, so a
 * feed of 30 tickets hit the local LLM with 30 concurrent requests. That
 * backend processes ~one at a time, so they all just queued past the 120s
 * timeout and every card showed "timeout". This is a tiny global gate (shared
 * across every card and every Redmine module on the page) that lets only a few
 * summaries run at once; the rest wait their turn instead of piling on. */
const SUMMARY_MAX_CONCURRENT = 2;
let summaryActive = 0;
const summaryQueue: (() => void)[] = [];
function acquireSummarySlot(): Promise<() => void> {
  return new Promise((resolve) => {
    const start = () => {
      summaryActive++;
      resolve(() => {
        summaryActive--;
        summaryQueue.shift()?.();
      });
    };
    if (summaryActive < SUMMARY_MAX_CONCURRENT) start();
    else summaryQueue.push(start);
  });
}

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

/* Severity dot by Redmine priority id. All five levels get a color (a bare
 * card would read as "no priority set" instead of Normal). Inmediata is
 * called out with a larger dot and a soft halo since it's the "drop what
 * you're doing" tier and needs to survive a scroll. */
const SEVERITY_COLORS: Record<number, { light: string; dark: string }> = {
  5: { light: "#e70a0a", dark: "#ff3838" }, // Inmediata (saturated red)
  4: { light: "#d63030", dark: "#ff6b6b" }, // Urgente (red)
  3: { light: "#f76707", dark: "#ff922b" }, // Alta (naranja)
  2: { light: "#4dabf7", dark: "#74c0fc" }, // Normal (celeste)
  1: { light: "#adb5bd", dark: "#868e96" }, // Baja (gris)
};
function severityColor(id: number | null, dark: boolean): string | null {
  if (id == null) return null;
  const entry = SEVERITY_COLORS[id];
  return entry ? (dark ? entry.dark : entry.light) : null;
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
  const selectedUserIds = useMemo(
    () => (module.config.userIds as number[] | undefined) ?? [],
    [module.config.userIds]
  );
  const selectedKey = useMemo(
    () =>
      JSON.stringify({
        p: [...selectedProjectIds].sort(),
        u: [...selectedUserIds].sort(),
      }),
    [selectedProjectIds, selectedUserIds]
  );

  const [items, setItems] = useState<RedmineIssue[] | null>(null);
  const [projects, setProjects] = useState<RedmineProject[] | null>(null);
  const [users, setUsers] = useState<RedmineUser[] | null>(null);
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

  const loadUsers = useCallback(async () => {
    try {
      const res = await fetch("/api/redmine/members");
      if (!res.ok) return;
      const data = (await res.json()) as { users: RedmineUser[] };
      setUsers(data.users);
    } catch {
      // best-effort
    }
  }, []);

  const load = useCallback(async () => {
    if (!selectedProjectIds.length && !selectedUserIds.length) {
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
          assigneeIds: selectedUserIds.length ? selectedUserIds : undefined,
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

  useEffect(() => {
    void loadUsers();
  }, [loadUsers]);

  useAutoRefresh(load, { intervalMs: REFRESH_MS });
  useEffect(() => () => abortRef.current?.abort(), []);

  // Open tickets lead, sorted by severity then recency (the working queue).
  // Closed ones drop below a "Cerrados" divider, most-recently-closed first —
  // priority is meaningless once a ticket is done.
  const openItems = useMemo(() => {
    if (!items) return null;
    return items
      .filter((it) => !it.statusIsClosed)
      .sort(
        (a, b) =>
          (b.priorityId ?? 0) - (a.priorityId ?? 0) ||
          Date.parse(b.updatedAt) - Date.parse(a.updatedAt)
      );
  }, [items]);
  const closedItems = useMemo(() => {
    if (!items) return null;
    return items
      .filter((it) => it.statusIsClosed)
      .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  }, [items]);

  const noneSelected =
    selectedProjectIds.length === 0 && selectedUserIds.length === 0;

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
              ? "Nothing selected — open the menu (top-right) and pick projects or users."
              : "No issues in the current window."}
          </div>
        )}

        {((openItems && openItems.length > 0) ||
          (closedItems && closedItems.length > 0)) && (
          <ul>
            {openItems?.map((it) => (
              <IssueCard key={`${it.projectId}-${it.id}`} item={it} />
            ))}
            {closedItems && closedItems.length > 0 && (
              <li aria-hidden>
                <div
                  className="px-2 py-1 text-[11px] font-bold uppercase"
                  style={{
                    color: R.closed,
                    background: R.bodyAlt,
                    borderTop: `1px solid ${R.fieldsetBorder}`,
                    borderBottom: `1px solid ${R.fieldsetBorder}`,
                    letterSpacing: "0.06em",
                  }}
                >
                  Cerrados
                </div>
              </li>
            )}
            {closedItems?.map((it) => (
              <IssueCard key={`${it.projectId}-${it.id}`} item={it} />
            ))}
          </ul>
        )}
      </div>

      <div className="absolute top-0.5 right-1 opacity-0 group-hover:opacity-100 transition-opacity z-10 flex items-center gap-1">
        <FilterMenu
          projects={projects}
          users={users}
          selectedProjects={selectedProjectIds}
          selectedUsers={selectedUserIds}
          onChangeProjects={(next) =>
            onUpdateConfig(module.id, { ...module.config, projectIds: next })
          }
          onChangeUsers={(next) =>
            onUpdateConfig(module.id, { ...module.config, userIds: next })
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
  const dark = useIsDark();
  const R = dark ? R_DARK : R_LIGHT;
  const isNew = item.flag === "new";
  const sevColor = severityColor(item.priorityId, dark);
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
    // Wait for a slot before touching the network so 30 cards don't stampede
    // the single-threaded local LLM (which just makes them all time out).
    const release = await acquireSummarySlot();
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
      release();
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
        className="no-drag block py-2 px-2 min-w-0"
        draggable={false}
        onMouseDown={(e) => e.stopPropagation()}
        title={item.priority ? `Priority: ${item.priority}` : undefined}
        style={{
          background: R.body,
          borderBottom: `1px solid ${R.fieldsetBorder}`,
          color: R.text,
        }}
      >
        {/* line 1: [severity dot] + #id + subject + [NEW] + time */}
        <div className="flex items-center gap-1.5 min-w-0 text-[14px] leading-snug">
          {sevColor && (
            <span
              aria-hidden
              className="shrink-0 rounded-full"
              style={{
                width: item.priorityId === 5 ? 10 : 8,
                height: item.priorityId === 5 ? 10 : 8,
                background: sevColor,
                boxShadow:
                  item.priorityId === 5 ? `0 0 0 3px ${sevColor}33` : undefined,
              }}
            />
          )}
          <span className="shrink-0 mono text-[12px]" style={{ color: R.muted }}>
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
                fontSize: 10,
                fontWeight: "bold",
              }}
            >
              NEW
            </span>
          )}
          <span className="shrink-0 mono text-[12px]" style={{ color: R.faint }}>
            {relativeTime(item.updatedAt)}
          </span>
        </div>

        {/* line 2: author */}
        {item.author && (
          <div
            className="text-[12px] mt-0.5 pl-[22px] truncate"
            style={{ color: R.muted }}
          >
            {item.author}
          </div>
        )}

        {/* line 3: summary (or its loading/error state) */}
        {summaryText ? (
          <div
            className="text-[13px] leading-snug line-clamp-2 mt-1 pl-[22px]"
            style={{ color: R.text }}
          >
            {summaryText}
          </div>
        ) : sumErr ? (
          <div
            className="text-[12px] mt-1 pl-[22px] flex items-center gap-1.5 flex-wrap"
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
            className="text-[12px] mt-1 pl-[22px] italic"
            style={{ color: R.faint }}
          >
            summarizing…
          </div>
        ) : null}
      </a>
    </li>
  );
}

function FilterMenu({
  projects,
  users,
  selectedProjects,
  selectedUsers,
  onChangeProjects,
  onChangeUsers,
  onRetryProjects,
}: {
  projects: RedmineProject[] | null;
  users: RedmineUser[] | null;
  selectedProjects: number[];
  selectedUsers: number[];
  onChangeProjects: (ids: number[]) => void;
  onChangeUsers: (ids: number[]) => void;
  onRetryProjects: () => void;
}) {
  const R = useIsDark() ? R_DARK : R_LIGHT;
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
        title="Filter"
      >
        <span className="w-2.5 h-[1.5px] bg-current" />
        <span className="w-2.5 h-[1.5px] bg-current" />
        <span className="w-2.5 h-[1.5px] bg-current" />
      </button>
      {open && (
        <div
          className="absolute top-6 right-0 z-20 flex flex-col"
          onMouseDown={(e) => e.stopPropagation()}
          onClick={(e) => e.stopPropagation()}
          style={{
            background: R.body,
            border: `1px solid ${R.fieldsetBorder}`,
            boxShadow: "0 4px 12px rgba(0,0,0,0.15)",
            color: R.text,
            width: 288,
            maxHeight: "80vh",
            fontSize: 11,
          }}
        >
          <FilterColumn
            title="Projects"
            items={projects?.map((p) => ({ id: p.id, name: p.name, tag: p.identifier })) ?? null}
            selected={selectedProjects}
            onChange={onChangeProjects}
            onRetry={onRetryProjects}
            emptyHint="No projects."
          />
          <div style={{ height: 1, background: R.fieldsetBorder }} />
          <FilterColumn
            title="Users"
            items={users?.map((u) => ({ id: u.id, name: u.name })) ?? null}
            selected={selectedUsers}
            onChange={onChangeUsers}
            emptyHint="No members visible to this API key."
            subtitle={
              selectedUsers.length > 0
                ? "only open tickets assigned to these users"
                : undefined
            }
          />
        </div>
      )}
    </div>
  );
}

function FilterColumn({
  title,
  subtitle,
  items,
  selected,
  onChange,
  onRetry,
  emptyHint,
}: {
  title: string;
  subtitle?: string;
  items: { id: number; name: string; tag?: string }[] | null;
  selected: number[];
  onChange: (ids: number[]) => void;
  onRetry?: () => void;
  emptyHint: string;
}) {
  const R = useIsDark() ? R_DARK : R_LIGHT;
  const [filter, setFilter] = useState("");
  const toggle = (id: number) =>
    onChange(
      selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id]
    );
  const visible = useMemo(() => {
    if (!items) return null;
    const q = filter.trim().toLowerCase();
    if (!q) return items;
    return items.filter(
      (it) =>
        it.name.toLowerCase().includes(q) ||
        (it.tag ?? "").toLowerCase().includes(q)
    );
  }, [items, filter]);

  return (
    <div className="flex-1 min-w-0 flex flex-col">
      <div
        className="px-2 py-1.5 font-bold flex items-center gap-2"
        style={{
          background: R.bannerBg,
          color: R.bannerText,
          borderBottom: `1px solid #4a6f8f`,
        }}
      >
        <span>{title}</span>
        <span className="ml-auto font-normal" style={{ color: R.bannerSubtle }}>
          {selected.length} selected
        </span>
      </div>
      {subtitle && (
        <div
          className="px-2 py-1 italic"
          style={{
            color: R.muted,
            background: R.bodyAlt,
            borderBottom: `1px solid ${R.fieldsetBorder}`,
            fontSize: 10,
          }}
        >
          {subtitle}
        </div>
      )}
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
            {onRetry && (
              <button
                className="ml-auto hover:underline"
                style={{ color: R.link }}
                onClick={onRetry}
              >
                retry
              </button>
            )}
          </div>
        )}
        {visible && visible.length === 0 && (
          <div className="px-2 py-1.5" style={{ color: R.muted }}>
            {emptyHint}
          </div>
        )}
        {visible?.map((it, idx) => {
          const checked = selected.includes(it.id);
          return (
            <label
              key={it.id}
              className="flex items-center gap-2 px-2 py-[3px] cursor-pointer"
              style={{
                color: R.text,
                background: idx % 2 === 1 ? R.bodyAlt : R.body,
              }}
            >
              <input
                type="checkbox"
                checked={checked}
                onChange={() => toggle(it.id)}
              />
              <span className="flex-1 truncate">{it.name}</span>
              {it.tag && (
                <span style={{ color: R.faint, fontSize: 10 }}>#{it.tag}</span>
              )}
            </label>
          );
        })}
      </div>
    </div>
  );
}
