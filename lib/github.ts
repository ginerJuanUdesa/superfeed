export type GithubItemKind =
  | "pr"
  | "issue"
  | "release"
  | "push"
  | "create"
  | "star"
  | "fork"
  | "comment"
  | "other";

export type GithubItemState = "open" | "closed" | "merged" | "draft" | null;

export interface GithubItem {
  /** Event id from the GH API — stable per event, safe to key on. */
  id: string;
  kind: GithubItemKind;
  /** Human-readable action, e.g. "contributed to", "opened", "released". */
  action: string;
  actor: string;
  actorAvatar: string;
  /** owner/repo — kept as one string so it renders like GH's own feed. */
  repo: string;
  repoUrl: string;
  /** Primary title of the referenced thing (PR/issue title, release name, commit msg). */
  title: string;
  /** Optional #N reference. Rendered inline next to the title. */
  number?: number;
  /** State chip content ("Merged", "Open", "Closed", "Draft"). */
  state: GithubItemState;
  /** Description body — first paragraph of PR/issue body, release notes. */
  body: string;
  /** Landing url for the primary thing. */
  url: string;
  createdAt: string;
}

const GH_BASE = "https://api.github.com";

function headers(token?: string): Record<string, string> {
  const h: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (token) h.Authorization = `Bearer ${token}`;
  return h;
}

interface RawEvent {
  id: string;
  type: string;
  actor: { login: string; avatar_url: string };
  repo: { name: string };
  payload: Record<string, unknown>;
  created_at: string;
}

/** First paragraph of a markdown body — GH feed cards show a preview, not the
 *  whole thing. Strips leading whitespace and clips at the first blank line. */
function firstParagraph(md: string, max = 320): string {
  if (!md) return "";
  const trimmed = md.trim();
  const blank = trimmed.indexOf("\n\n");
  const chunk = blank === -1 ? trimmed : trimmed.slice(0, blank);
  const oneline = chunk.replace(/\s+/g, " ").trim();
  return oneline.length > max ? `${oneline.slice(0, max - 1)}…` : oneline;
}

function repoUrl(repo: string): string {
  return `https://github.com/${repo}`;
}

function normalize(ev: RawEvent): GithubItem | null {
  const base = {
    id: ev.id,
    actor: ev.actor.login,
    actorAvatar: ev.actor.avatar_url,
    repo: ev.repo.name,
    repoUrl: repoUrl(ev.repo.name),
    createdAt: ev.created_at,
  };

  const p = ev.payload as {
    action?: string;
    ref?: string;
    ref_type?: string;
    pull_request?: {
      title: string;
      number: number;
      html_url: string;
      body?: string | null;
      merged?: boolean;
      state?: string;
      draft?: boolean;
    };
    issue?: {
      title: string;
      number: number;
      html_url: string;
      body?: string | null;
      state?: string;
    };
    release?: {
      name?: string | null;
      tag_name: string;
      html_url: string;
      body?: string | null;
    };
    commits?: { message: string; sha: string }[];
    comment?: {
      body: string;
      html_url: string;
    };
    forkee?: { full_name: string; html_url: string };
  };

  switch (ev.type) {
    case "PullRequestEvent": {
      const pr = p.pull_request;
      if (!pr) return null;
      const merged = pr.merged;
      const state: GithubItemState = pr.draft
        ? "draft"
        : merged
        ? "merged"
        : pr.state === "closed"
        ? "closed"
        : "open";
      const action =
        p.action === "opened"
          ? "opened a pull request in"
          : p.action === "closed" && merged
          ? "contributed to"
          : p.action === "closed"
          ? "closed a pull request in"
          : p.action === "reopened"
          ? "reopened a pull request in"
          : "updated a pull request in";
      return {
        ...base,
        kind: "pr",
        action,
        title: pr.title,
        number: pr.number,
        state,
        body: firstParagraph(pr.body ?? ""),
        url: pr.html_url,
      };
    }
    case "IssuesEvent": {
      const is = p.issue;
      if (!is) return null;
      const state: GithubItemState = is.state === "closed" ? "closed" : "open";
      const action =
        p.action === "opened"
          ? "opened an issue in"
          : p.action === "closed"
          ? "closed an issue in"
          : p.action === "reopened"
          ? "reopened an issue in"
          : "updated an issue in";
      return {
        ...base,
        kind: "issue",
        action,
        title: is.title,
        number: is.number,
        state,
        body: firstParagraph(is.body ?? ""),
        url: is.html_url,
      };
    }
    case "IssueCommentEvent": {
      const is = p.issue;
      const co = p.comment;
      if (!is || !co) return null;
      return {
        ...base,
        kind: "comment",
        action: "commented on",
        title: is.title,
        number: is.number,
        state: is.state === "closed" ? "closed" : "open",
        body: firstParagraph(co.body),
        url: co.html_url,
      };
    }
    case "ReleaseEvent": {
      const rel = p.release;
      if (!rel || p.action !== "published") return null;
      return {
        ...base,
        kind: "release",
        action: "released",
        title: rel.name?.trim() || rel.tag_name,
        state: null,
        body: firstParagraph(rel.body ?? ""),
        url: rel.html_url,
      };
    }
    case "PushEvent": {
      const commits = p.commits ?? [];
      if (!commits.length) return null;
      const branch = (p.ref ?? "").replace(/^refs\/heads\//, "");
      const first = commits[0].message.split("\n")[0];
      const rest = commits.length - 1;
      return {
        ...base,
        kind: "push",
        action: `pushed to ${branch} in`,
        title: rest > 0 ? `${first} (+${rest} more)` : first,
        state: null,
        body: "",
        url: `https://github.com/${ev.repo.name}/commit/${commits[commits.length - 1].sha}`,
      };
    }
    case "CreateEvent": {
      const rt = p.ref_type ?? "";
      if (rt === "repository") {
        return {
          ...base,
          kind: "create",
          action: "created the repository",
          title: ev.repo.name,
          state: null,
          body: "",
          url: repoUrl(ev.repo.name),
        };
      }
      if (rt === "branch" || rt === "tag") {
        return {
          ...base,
          kind: "create",
          action: `created a ${rt} in`,
          title: p.ref ?? "",
          state: null,
          body: "",
          url: repoUrl(ev.repo.name),
        };
      }
      return null;
    }
    case "WatchEvent": {
      return {
        ...base,
        kind: "star",
        action: "starred",
        title: ev.repo.name,
        state: null,
        body: "",
        url: repoUrl(ev.repo.name),
      };
    }
    case "ForkEvent": {
      const f = p.forkee;
      return {
        ...base,
        kind: "fork",
        action: "forked",
        title: f?.full_name ?? ev.repo.name,
        state: null,
        body: "",
        url: f?.html_url ?? repoUrl(ev.repo.name),
      };
    }
    default:
      return null;
  }
}

const FEED_TTL_MS = 60 * 1000;
const feedCache = new Map<string, { at: number; items: GithubItem[]; hasMore: boolean }>();

export async function fetchFeed(opts: {
  user: string;
  token?: string;
  max?: number;
  since?: string;
  page?: number;
}): Promise<{ items: GithubItem[]; hasMore: boolean }> {
  const { user, token, max = 30, since, page = 1 } = opts;
  const cacheKey = `${user}|${since ?? ""}|${max}|p${page}`;
  const hit = feedCache.get(cacheKey);
  if (hit && Date.now() - hit.at < FEED_TTL_MS) return { items: hit.items, hasMore: hit.hasMore };

  // received_events returns events that would show up on the user's dashboard.
  // Requires a token with `read:user` for the private feed variant, but the
  // public endpoint works with any token or none for public activity.
  // GitHub's events endpoint caps at 10 pages of up to 100 items — we ask
  // for a full page here and let the client stitch pages together for
  // infinite scroll.
  const perPage = Math.min(Math.max(max, 30), 100);
  const url = `${GH_BASE}/users/${encodeURIComponent(user)}/received_events?per_page=${perPage}&page=${page}`;
  const res = await fetch(url, {
    headers: headers(token),
    cache: "no-store",
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`GitHub feed failed (${res.status}): ${text.slice(0, 200)}`);
  }
  const raw = (await res.json()) as RawEvent[];
  const sinceMs = since ? Date.parse(since) : 0;
  // hasMore reflects the raw page, not the normalized/filtered subset — a
  // page can be full of events we can't render, and there's still a next
  // page after it.
  const hasMore = raw.length === perPage && page < 10;

  const items: GithubItem[] = [];
  for (const ev of raw) {
    if (sinceMs && Date.parse(ev.created_at) < sinceMs) continue;
    const norm = normalize(ev);
    if (norm) items.push(norm);
  }

  feedCache.set(cacheKey, { at: Date.now(), items, hasMore });
  return { items, hasMore };
}
