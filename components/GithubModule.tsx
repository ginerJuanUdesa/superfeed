"use client";

import { useCallback, useEffect, useRef, useState } from "react";
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

interface Props {
  module: ModuleInstance;
  onRemove: (id: string) => void;
  onUpdateConfig: (id: string, config: Record<string, unknown>) => void;
}

/* GitHub's own dark-dimmed palette, quoted verbatim like HF's — this module
 * reads as an embedded slice of github.com's dashboard feed. */
const GH = {
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

export default function GithubModule({ module, onRemove }: Props) {
  const [items, setItems] = useState<GithubItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  const load = useCallback(async () => {
    const settings = loadSettings();
    const user = settings.githubUsername.trim();
    if (!user) {
      setError("Set your GitHub username in Settings");
      setItems([]);
      return;
    }
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/github/feed", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          user,
          token: settings.githubToken || undefined,
          since: settings.startDate || undefined,
        }),
        signal: ctrl.signal,
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      const data = (await res.json()) as { items: GithubItem[] };
      setItems(data.items);
    } catch (err) {
      if ((err as Error).name === "AbortError") return;
      setError((err as Error).message);
      setItems([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    return () => abortRef.current?.abort();
  }, [load]);

  const empty = items && items.length === 0;

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
          Feed
        </span>
        <span className="panel-header-meta mono" style={{ color: GH.textFaint }}>
          {items ? String(items.length).padStart(2, "0") : "00"} events
        </span>
        {loading && (
          <span className="panel-header-meta mono ml-auto" style={{ color: GH.link }}>
            loading
          </span>
        )}
      </div>

      <div className="relative flex-1 min-h-0 overflow-y-auto" style={{ background: GH.bg }}>
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
        {items && items.length > 0 && (
          <ul className="px-3 py-3 space-y-3">
            {items.map((it) => (
              <FeedCard key={it.id} item={it} />
            ))}
          </ul>
        )}
        {empty && !error && (
          <div
            className="absolute bottom-3 inset-x-3 text-center text-xs"
            style={{ color: GH.textFaint }}
          >
            No activity yet.
          </div>
        )}
      </div>

      <div className="absolute top-1 right-1 opacity-0 group-hover:opacity-100 transition-opacity z-10 flex items-center gap-1">
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

function FeedCard({ item }: { item: GithubItem }) {
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
