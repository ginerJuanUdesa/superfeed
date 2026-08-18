export type HFKind = "model" | "dataset" | "space" | "paper";

const KIND_TO_API: Record<Exclude<HFKind, "paper">, string> = {
  model: "models",
  dataset: "datasets",
  space: "spaces",
};

export interface HFItem {
  id: string;
  name: string;
  author: string;
  kind: HFKind;
  description: string;
  pipeline?: string;
  tags?: string[];
  url: string;
  lastModified: string;
  downloads?: number;
  likes?: number;
  /** Last commit title — what actually changed in this update. */
  lastCommit?: string;
  /** Who pushed the last commit. */
  lastCommitBy?: string;
  /** True when the repo was created long before it was last touched. */
  isUpdate?: boolean;
  createdAt?: string;
  /** Profile picture of the org/user that owns the repo — drives the card color. */
  avatarUrl?: string;
}

/** A followed account: the namespace releases are published under. */
export interface HFAccount {
  name: string;
  avatarUrl?: string;
}

const HF_BASE = "https://huggingface.co";

function headers(token?: string) {
  const h: Record<string, string> = { Accept: "application/json" };
  if (token) h.Authorization = `Bearer ${token}`;
  return h;
}

/** Follow `Link: rel="next"` cursor pagination until exhausted. */
async function fetchAllPages(
  startUrl: string,
  token: string | undefined,
  maxPages = 10
): Promise<{ user?: string; name?: string; avatarUrl?: string }[]> {
  const out: { user?: string; name?: string; avatarUrl?: string }[] = [];
  let url: string | null = startUrl;
  for (let i = 0; i < maxPages && url; i++) {
    const res: Response = await fetch(url, {
      headers: headers(token),
      cache: "no-store",
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) break;
    out.push(
      ...((await res.json()) as { user?: string; name?: string; avatarUrl?: string }[])
    );
    const link = res.headers.get("link") ?? "";
    const m = link.match(/<([^>]+)>;\s*rel="next"/);
    url = m ? m[1] : null;
  }
  return out;
}

/** Orgs the user is a member of — surfaced through the profile overview. */
async function fetchMemberOrgs(
  user: string,
  token: string | undefined
): Promise<{ user?: string; name?: string; avatarUrl?: string }[]> {
  const url = `${HF_BASE}/api/users/${encodeURIComponent(user)}/overview`;
  try {
    const res = await fetch(url, {
      headers: headers(token),
      cache: "no-store",
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return [];
    const data = (await res.json()) as {
      orgs?: { name?: string; avatarUrl?: string }[];
    };
    return data.orgs ?? [];
  } catch {
    return [];
  }
}

/**
 * Accounts whose activity should surface in the feed. Sources:
 * - `/following` (users you follow)
 * - `/following/orgs` (orgs you follow)
 * - `/overview` orgs of the main user (orgs you're a MEMBER of — includes
 *   private ones with a token)
 * - `/overview` orgs of each followed USER (so a commit by someone you follow
 *   into an org repo — e.g. mlabonne pushing to LiquidAI/... — still surfaces,
 *   which is how HF's own activity feed works)
 */
export async function fetchFollowing(user: string, token?: string): Promise<HFAccount[]> {
  const base = `${HF_BASE}/api/users/${encodeURIComponent(user)}`;
  const [users, followedOrgs, memberOrgs] = await Promise.all([
    fetchAllPages(`${base}/following`, token),
    fetchAllPages(`${base}/following/orgs`, token),
    fetchMemberOrgs(user, token),
  ]);
  const followedUserNames = users.map((r) => r.user ?? r.name ?? "").filter(Boolean);
  const followedUserOrgs = (
    await pool(
      followedUserNames.map((name) => () => fetchMemberOrgs(name, token)),
      12
    )
  ).flat();
  const merged = new Map<string, HFAccount>();
  for (const r of [...users, ...followedOrgs, ...memberOrgs, ...followedUserOrgs]) {
    const name = r.user ?? r.name ?? "";
    if (!name || merged.has(name)) continue;
    merged.set(name, {
      name,
      // default identicons come back as a site-relative path
      avatarUrl: r.avatarUrl?.startsWith("/") ? `${HF_BASE}${r.avatarUrl}` : r.avatarUrl,
    });
  }
  const accounts = [...merged.values()];
  if (!accounts.length) throw new Error(`HF: no follows found for "${user}"`);
  return accounts;
}

async function fetchAuthorItems(
  author: string,
  kind: Exclude<HFKind, "paper">,
  token: string | undefined,
  limit: number
): Promise<HFItem[]> {
  const api = KIND_TO_API[kind];
  const url = `${HF_BASE}/api/${api}?author=${encodeURIComponent(author)}&sort=lastModified&direction=-1&limit=${limit}&full=true`;
  const res = await fetch(url, {
    headers: headers(token),
    cache: "no-store",
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) return [];
  const raw = (await res.json()) as Array<{
    id: string;
    author?: string;
    lastModified?: string;
    createdAt?: string;
    description?: string;
    pipeline_tag?: string;
    tags?: string[];
    downloads?: number;
    likes?: number;
    cardData?: { pipeline_tag?: string };
  }>;
  return raw.map((r) => {
    const [org, name] = r.id.includes("/") ? r.id.split("/", 2) : [r.author ?? author, r.id];
    const created = r.createdAt;
    const modified = r.lastModified ?? new Date(0).toISOString();
    return {
      id: r.id,
      name: name ?? r.id,
      author: org,
      kind,
      description: (r.description ?? "").trim(),
      pipeline: r.pipeline_tag ?? r.cardData?.pipeline_tag,
      tags: r.tags,
      url: `${HF_BASE}/${kind === "space" ? "spaces/" : kind === "dataset" ? "datasets/" : ""}${r.id}`,
      lastModified: modified,
      createdAt: created,
      // classified later by fetchFeed once we know `since`
      isUpdate: false,
      downloads: r.downloads,
      likes: r.likes,
    } satisfies HFItem;
  });
}

const COMMIT_PATH: Record<Exclude<HFKind, "paper">, string> = {
  model: "models",
  dataset: "datasets",
  space: "spaces",
};

interface CommitInfo {
  title?: string;
  by?: string;
  date?: string;
}

/**
 * Fetch recent commits — title/author of the head commit powers the UI, and
 * the timing of previous commits drives release-vs-update classification.
 * We ask for a handful so we can see whether the latest commit is part of an
 * initial-release burst (many commits clustered) or an isolated follow-up.
 */
async function fetchRecentCommits(
  item: HFItem,
  token: string | undefined
): Promise<CommitInfo[]> {
  if (item.kind === "paper") return [];
  const url = `${HF_BASE}/api/${COMMIT_PATH[item.kind]}/${item.id}/commits/main?limit=10`;
  try {
    const res = await fetch(url, {
      headers: headers(token),
      cache: "no-store",
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) return [];
    const raw = (await res.json()) as Array<{
      title?: string;
      date?: string;
      authors?: { user?: string }[];
    }>;
    return raw.map((c) => ({
      title: c.title?.trim(),
      by: c.authors?.[0]?.user,
      date: c.date,
    }));
  } catch {
    return [];
  }
}

async function fetchAuthorPapers(author: string, token: string | undefined): Promise<HFItem[]> {
  const url = `${HF_BASE}/api/users/${encodeURIComponent(author)}/papers`;
  const res = await fetch(url, {
    headers: headers(token),
    cache: "no-store",
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) return [];
  const raw = (await res.json()) as Array<{
    paper: { id: string; title: string; summary?: string; publishedAt?: string };
  }>;
  return raw.map((r) => ({
    id: r.paper.id,
    name: r.paper.title,
    author,
    kind: "paper" as const,
    description: (r.paper.summary ?? "").trim(),
    url: `${HF_BASE}/papers/${r.paper.id}`,
    lastModified: r.paper.publishedAt ?? new Date(0).toISOString(),
  }));
}

/** Run tasks with a bounded number of concurrent executions. */
async function pool<T>(tasks: (() => Promise<T>)[], concurrency: number): Promise<T[]> {
  const out: T[] = new Array(tasks.length);
  let cursor = 0;
  async function worker() {
    while (cursor < tasks.length) {
      const i = cursor++;
      try {
        out[i] = await tasks[i]();
      } catch {
        out[i] = [] as unknown as T;
      }
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, tasks.length) }, () => worker())
  );
  return out;
}

const FEED_TTL_MS = 5 * 60 * 1000;
const feedCache = new Map<string, { at: number; items: HFItem[] }>();

export async function fetchFeed(opts: {
  user: string;
  kinds: HFKind[];
  since?: string;
  perAuthorLimit?: number;
  token?: string;
  maxItems?: number;
  /** Skip the in-memory cache entirely — used on page reload so the user
   * sees fresh data instead of stale items served from the 5-min TTL. */
  fresh?: boolean;
}): Promise<HFItem[]> {
  const { user, kinds, since, perAuthorLimit = 30, token, maxItems = 80, fresh } = opts;

  // v8: commit-gap + repo-age classification (bursts long after createdAt → update).
  const cacheKey = `v8|${user}|${[...kinds].sort().join(",")}|${since ?? ""}`;
  if (!fresh) {
    const hit = feedCache.get(cacheKey);
    if (hit && Date.now() - hit.at < FEED_TTL_MS) return hit.items;
  }

  const following = await fetchFollowing(user, token);
  // name -> avatar, which also dedupes accounts returned by both endpoints
  const avatars = new Map<string, string | undefined>();
  for (const a of following) if (!avatars.has(a.name)) avatars.set(a.name, a.avatarUrl);
  const authors = [...avatars.keys()];
  if (!authors.length) return [];

  const tasks: (() => Promise<HFItem[]>)[] = [];
  for (const author of authors) {
    for (const kind of kinds) {
      if (kind === "paper") {
        tasks.push(() => fetchAuthorPapers(author, token));
      } else {
        tasks.push(() => fetchAuthorItems(author, kind, token, perAuthorLimit));
      }
    }
  }

  const results = await pool(tasks, 12);
  const flat = results.flat();

  const sinceMs = since ? Date.parse(since) : 0;
  const filtered = sinceMs
    ? flat.filter((it) => Date.parse(it.lastModified) >= sinceMs)
    : flat;

  filtered.sort((a, b) => Date.parse(b.lastModified) - Date.parse(a.lastModified));
  const dedup = new Map<string, HFItem>();
  for (const it of filtered) {
    const key = `${it.kind}:${it.id}`;
    if (!dedup.has(key)) dedup.set(key, it);
  }
  const items = [...dedup.values()].slice(0, maxItems);

  // Only the items we actually return get a commit lookup.
  const commits = await pool(
    items.map((it) => () => fetchRecentCommits(it, token)),
    12
  );

  // Classify NEW vs UPDATE from repo age + commit history. Two independent
  // signals; either one is enough to mark UPDATE:
  //   1) Repo age: if the head commit lands well after createdAt, the repo
  //      already exists — it's an update, no matter how the commits cluster.
  //      Catches "same repo, second release" patterns (e.g. inclusionAI/Ling-flash
  //      pushing weights+config+README in one burst weeks after the repo went up).
  //   2) Commit gap: if the head is isolated from the previous commit by
  //      >12h, it's an update (a follow-up push, not part of the initial
  //      upload burst of READMEs/shards/tokenizer files).
  // Only when BOTH say "recent + clustered" do we call it a release.
  const CLUSTER_GAP_MS = 12 * 60 * 60 * 1000;
  const REPO_AGE_MS = 7 * 24 * 60 * 60 * 1000;
  items.forEach((it, i) => {
    const list = commits[i] ?? [];
    const head = list[0];
    it.lastCommit = head?.title;
    it.lastCommitBy = head?.by;
    it.avatarUrl = avatars.get(it.author);

    const headDate = Date.parse(head?.date ?? it.lastModified);
    const createdDate = it.createdAt ? Date.parse(it.createdAt) : NaN;
    if (
      Number.isFinite(headDate) &&
      Number.isFinite(createdDate) &&
      headDate - createdDate > REPO_AGE_MS
    ) {
      it.isUpdate = true;
      return;
    }

    if (list.length < 2) {
      it.isUpdate = false;
      return;
    }
    const prevDate = Date.parse(list[1].date ?? "");
    if (!Number.isFinite(headDate) || !Number.isFinite(prevDate)) {
      it.isUpdate = false;
      return;
    }
    it.isUpdate = headDate - prevDate > CLUSTER_GAP_MS;
  });

  feedCache.set(cacheKey, { at: Date.now(), items });
  return items;
}
