"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ModuleInstance } from "@/lib/types";
import { loadSettings } from "./SettingsModal";
import type { RedmineIssue, RedmineProject } from "@/lib/redmine";

interface Props {
  module: ModuleInstance;
  onRemove: (id: string) => void;
  onUpdateConfig: (id: string, config: Record<string, unknown>) => void;
}

const REFRESH_MS = 5 * 60 * 1000;
const SUMMARY_CACHE_PREFIX = "redmine-summary:";

/* Classic Redmine palette. */
const R = {
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
  const [filter, setFilter] = useState("");
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
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedKey]);

  useEffect(() => {
    void loadProjects();
  }, [loadProjects]);

  useEffect(() => {
    void load();
    const id = window.setInterval(() => void load(), REFRESH_MS);
    return () => {
      window.clearInterval(id);
      abortRef.current?.abort();
    };
  }, [load]);

  const filtered = useMemo(() => {
    if (!items) return null;
    const q = filter.trim().toLowerCase();
    if (!q) return items;
    return items.filter(
      (i) =>
        i.subject.toLowerCase().includes(q) ||
        i.projectName.toLowerCase().includes(q) ||
        String(i.id).includes(q)
    );
  }, [items, filter]);

  const groups = useMemo(() => {
    if (!filtered) return null;
    const byProject = new Map<string, RedmineIssue[]>();
    for (const it of filtered) {
      const key = it.projectName || "—";
      const arr = byProject.get(key);
      if (arr) arr.push(it);
      else byProject.set(key, [it]);
    }
    return [...byProject.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [filtered]);

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
      {/* dark top nav strip */}
      <div
        className="shrink-0 flex items-center justify-between px-2 text-[10px] gap-2 min-w-0"
        style={{
          background: R.navBg,
          color: R.navText,
          height: 20,
          borderBottom: `1px solid #000`,
        }}
      >
        <div className="flex gap-2 min-w-0 truncate">
          <span>Home</span>
          <span>Projects</span>
          <span>Help</span>
        </div>
        <span className="shrink-0" style={{ color: R.navMuted }}>
          claude
        </span>
      </div>

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
        <input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          onMouseDown={(e) => e.stopPropagation()}
          onKeyDown={(e) => e.stopPropagation()}
          placeholder="Search"
          className="no-drag px-1.5 py-[1px] outline-none shrink min-w-0"
          style={{
            background: "#ffffff",
            border: `1px solid #4a6f8f`,
            color: R.text,
            fontFamily: REDMINE_FONT,
            fontSize: 11,
            width: 100,
            height: 20,
          }}
          spellCheck={false}
          autoComplete="off"
        />
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

        {groups?.map(([projectName, list]) => (
          <fieldset
            key={projectName}
            className="mb-2 min-w-0"
            style={{
              background: R.fieldsetBg,
              border: `1px solid ${R.fieldsetBorder}`,
              padding: "4px 6px 6px",
            }}
          >
            <legend
              className="px-1 font-bold truncate max-w-full"
              style={{ color: R.legendText, fontSize: 11 }}
            >
              {projectName}
            </legend>
            <ul className="flex flex-col gap-1">
              {list.map((it) => (
                <IssueCard key={`${it.projectId}-${it.id}`} item={it} />
              ))}
            </ul>
          </fieldset>
        ))}
      </div>

      {/* footer */}
      <div
        className="shrink-0 flex items-center justify-between px-2 text-[10px] gap-2 min-w-0"
        style={{
          background: R.bodyAlt,
          borderTop: `1px solid ${R.fieldsetBorder}`,
          color: R.muted,
          height: 18,
        }}
      >
        <span className="truncate">
          {items ? items.length : 0}i · {selectedProjectIds.length}p
          {loading && items ? " · …" : ""}
        </span>
        <span className="shrink-0" style={{ color: R.faint }}>
          Redmine
        </span>
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
  const isNew = item.flag === "new";
  const cacheKey = `${SUMMARY_CACHE_PREFIX}${item.id}:${item.updatedAt}`;
  const [summary, setSummary] = useState<IssueSummary | null>(null);
  const [sumErr, setSumErr] = useState<string | null>(null);
  const [sumLoading, setSumLoading] = useState(false);
  const [open, setOpen] = useState(false);
  const fetchedRef = useRef(false);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(cacheKey);
      if (raw) setSummary(JSON.parse(raw) as IssueSummary);
    } catch {
      // ignore
    }
  }, [cacheKey]);

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

  useEffect(() => {
    if (summary) return;
    void fetchSummary();
  }, [summary, fetchSummary]);

  const subjectColor = item.statusIsClosed ? R.closed : R.link;

  return (
    <li
      className="min-w-0"
      style={{
        background: R.body,
        border: `1px solid ${R.fieldsetBorder}`,
        padding: "4px 6px 5px",
      }}
    >
      {/* line 1: subject */}
      <div className="flex items-baseline gap-1.5 min-w-0 text-[11.5px] leading-snug">
        <span className="shrink-0" style={{ color: R.muted }}>
          #{item.id}
        </span>
        <a
          href={item.url}
          target="_blank"
          rel="noreferrer noopener"
          className="no-drag hover:underline min-w-0 break-words"
          draggable={false}
          onMouseDown={(e) => e.stopPropagation()}
          style={{
            color: subjectColor,
            textDecoration: item.statusIsClosed ? "line-through" : "none",
            flex: "1 1 auto",
          }}
        >
          {item.subject}
        </a>
        {isNew && (
          <span
            className="shrink-0 px-1"
            style={{
              color: R.new,
              border: `1px solid ${R.new}55`,
              background: "#e8f5ea",
              fontSize: 9,
              fontWeight: "bold",
            }}
          >
            NEW
          </span>
        )}
      </div>

      {/* line 2: meta */}
      <div
        className="flex items-center flex-wrap gap-x-1.5 gap-y-0.5 text-[10px] mt-0.5 min-w-0"
        style={{ color: R.muted }}
      >
        <span>{item.tracker || "Issue"}</span>
        <span style={{ color: R.faint }}>·</span>
        <span style={{ color: item.statusIsClosed ? R.faint : R.text }}>
          {item.status || "—"}
        </span>
        {item.priority && (
          <>
            <span style={{ color: R.faint }}>·</span>
            <span>{item.priority}</span>
          </>
        )}
        {item.assignedTo && (
          <>
            <span style={{ color: R.faint }}>·</span>
            <span className="truncate max-w-[10rem]">{item.assignedTo}</span>
          </>
        )}
        <span className="ml-auto shrink-0" style={{ color: R.faint }}>
          {relativeTime(item.updatedAt)}
        </span>
      </div>

      {/* summary block */}
      <div
        className="mt-1 px-1.5 py-1 text-[10.5px] leading-snug min-w-0"
        style={{
          background: R.summaryBg,
          border: `1px solid ${R.summaryBorder}`,
          color: R.text,
        }}
      >
        {sumLoading && !summary && (
          <span style={{ color: R.muted }}>Summarizing…</span>
        )}
        {sumErr && !summary && (
          <div className="flex items-center gap-1.5 flex-wrap">
            <span style={{ color: R.danger }} className="break-words">
              {sumErr}
            </span>
            <button
              className="no-drag hover:underline"
              style={{ color: R.link }}
              onClick={(e) => {
                e.stopPropagation();
                fetchedRef.current = false;
                void fetchSummary();
              }}
              onMouseDown={(e) => e.stopPropagation()}
            >
              retry
            </button>
          </div>
        )}
        {summary && (
          <>
            <div className="font-bold break-words">{summary.headline}</div>
            {summary.statusNote && (
              <div className="mt-0.5 break-words" style={{ color: R.text }}>
                <span style={{ color: R.muted }}>Now: </span>
                {summary.statusNote}
              </div>
            )}
            {summary.bullets.length > 0 && (
              <>
                <button
                  className="no-drag mt-0.5 hover:underline"
                  onClick={(e) => {
                    e.stopPropagation();
                    setOpen((o) => !o);
                  }}
                  onMouseDown={(e) => e.stopPropagation()}
                  style={{ color: R.link, fontSize: 10 }}
                >
                  {open ? "hide details" : `show ${summary.bullets.length} details`}
                </button>
                {open && (
                  <ul
                    className="mt-1 pl-3 list-disc space-y-0.5 break-words"
                    style={{ color: R.text }}
                  >
                    {summary.bullets.map((b, i) => (
                      <li key={i}>{b}</li>
                    ))}
                  </ul>
                )}
              </>
            )}
            {summary.journalCount > 0 && (
              <div className="mt-0.5" style={{ color: R.faint, fontSize: 9 }}>
                based on description + {summary.journalCount} note
                {summary.journalCount === 1 ? "" : "s"}
              </div>
            )}
          </>
        )}
      </div>
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
