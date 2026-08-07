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
): Promise<{ name?: string; avatarUrl?: string }[]> {
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

/** Latest commit title for a repo — tells us WHAT changed on an update. */
async function fetchLastCommit(
  item: HFItem,
  token: string | undefined
): Promise<{ title?: string; by?: string }> {
  if (item.kind === "paper") return {};
  const url = `${HF_BASE}/api/${COMMIT_PATH[item.kind]}/${item.id}/commits/main?limit=1`;
  try {
    const res = await fetch(url, {
      headers: headers(token),
      cache: "no-store",
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) return {};
    const raw = (await res.json()) as Array<{
      title?: string;
      authors?: { user?: string }[];
    }>;
    const c = raw[0];
    if (!c) return {};
    return { title: c.title?.trim(), by: c.authors?.[0]?.user };
  } catch {
    return {};
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
}): Promise<HFItem[]> {
  const { user, kinds, since, perAuthorLimit = 10, token, maxItems = 80 } = opts;

  // v6: release/update classified by createdAt vs since + 3d initial-release window.
  const cacheKey = `v6|${user}|${[...kinds].sort().join(",")}|${since ?? ""}`;
  const hit = feedCache.get(cacheKey);
  if (hit && Date.now() - hit.at < FEED_TTL_MS) return hit.items;

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

  // Classify NEW vs UPDATE — approximate what HF's activity feed shows as
  // separate "released" / "updated by X" events. A repo is an UPDATE if EITHER:
  //  - it existed before the user's `since` (pre-existing repo just got a
  //    commit — not new to them), OR
  //  - the last commit landed well after the repo was created (the initial
  //    release window is over, so this touch is a follow-up commit)
  // The 3-day window covers most real initial-release bursts without
  // misclassifying weeks-later maintenance commits like mlabonne's push to
  // LiquidAI/LFM2.5-2.6B ten days after that repo went live.
  const INITIAL_RELEASE_WINDOW_MS = 3 * 24 * 60 * 60 * 1000;
  for (const it of filtered) {
    if (!it.createdAt) {
      it.isUpdate = true;
      continue;
    }
    const created = Date.parse(it.createdAt);
    const modified = Date.parse(it.lastModified);
    const preexisting = sinceMs ? created < sinceMs : false;
    const laterCommit = modified - created > INITIAL_RELEASE_WINDOW_MS;
    it.isUpdate = preexisting || laterCommit;
  }

  filtered.sort((a, b) => Date.parse(b.lastModified) - Date.parse(a.lastModified));
  const dedup = new Map<string, HFItem>();
  for (const it of filtered) {
    const key = `${it.kind}:${it.id}`;
    if (!dedup.has(key)) dedup.set(key, it);
  }
  const items = [...dedup.values()].slice(0, maxItems);

  // Only the items we actually return get a commit lookup.
  const commits = await pool(
    items.map((it) => () => fetchLastCommit(it, token)),
    12
  );
  items.forEach((it, i) => {
    it.lastCommit = commits[i]?.title;
    it.lastCommitBy = commits[i]?.by;
    it.avatarUrl = avatars.get(it.author);
  });

  feedCache.set(cacheKey, { at: Date.now(), items });
  return items;
}
