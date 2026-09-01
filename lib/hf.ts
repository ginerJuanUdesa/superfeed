import {
  selectHFItems,
  upsertHFItems,
  selectHFAccounts,
  upsertHFAccounts,
  selectHFItemsByAuthorKind,
  deleteHFItems,
} from "./db";

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
  /** True when the head commit is NOT part of the repo's initial release burst. */
  isUpdate?: boolean;
  /** Deduplicated commit titles after the initial release burst — what changed
   * since the first release. Populated for UPDATE items only. */
  updateCommits?: string[];
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

/** Fetch with one automatic retry on network-level failures (undici's
 *  `TypeError: fetch failed`, timeouts, resets). HF's API is chatty enough
 *  that a single blip during a page-load causes visible "fetch failed"
 *  errors — the retry makes those transparent. Rejects only if BOTH the
 *  original and the retry fail. */
async function fetchWithRetry(
  url: string,
  init: RequestInit,
  timeoutMs = 15_000
): Promise<Response> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return await fetch(url, {
        ...init,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      lastErr = err;
      // Short backoff. Not exponential — a second attempt is usually enough,
      // and dragging the whole request out just makes the module feel slow.
      await new Promise((r) => setTimeout(r, 400));
    }
  }
  throw lastErr;
}

/** Follow `Link: rel="next"` cursor pagination until exhausted. Never
 *  throws — a mid-pagination failure returns whatever pages we already
 *  collected, instead of tanking the whole feed. */
async function fetchAllPages(
  startUrl: string,
  token: string | undefined,
  maxPages = 10
): Promise<{ user?: string; name?: string; avatarUrl?: string }[]> {
  const out: { user?: string; name?: string; avatarUrl?: string }[] = [];
  let url: string | null = startUrl;
  for (let i = 0; i < maxPages && url; i++) {
    let res: Response;
    try {
      res = await fetchWithRetry(url, { headers: headers(token), cache: "no-store" });
    } catch {
      break;
    }
    if (!res.ok) break;
    try {
      out.push(
        ...((await res.json()) as { user?: string; name?: string; avatarUrl?: string }[])
      );
    } catch {
      break;
    }
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
    const res = await fetchWithRetry(url, { headers: headers(token), cache: "no-store" });
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
  // Don't throw when this comes back empty — the caller UNIONs with the
  // persisted follow set, so a transient HF blip on the follow endpoints
  // shouldn't leave us with zero authors and drop the whole feed.
  return [...merged.values()];
}

async function fetchAuthorItems(
  author: string,
  kind: Exclude<HFKind, "paper">,
  token: string | undefined,
  limit: number
): Promise<HFItem[]> {
  const api = KIND_TO_API[kind];
  const url = `${HF_BASE}/api/${api}?author=${encodeURIComponent(author)}&sort=lastModified&direction=-1&limit=${limit}&full=true`;
  let res: Response;
  try {
    res = await fetchWithRetry(url, { headers: headers(token), cache: "no-store" });
  } catch {
    return [];
  }
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
  const url = `${HF_BASE}/api/${COMMIT_PATH[item.kind]}/${item.id}/commits/main?limit=30`;
  try {
    const res = await fetchWithRetry(url, { headers: headers(token), cache: "no-store" }, 10_000);
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

/* File extensions that ARE the release: model weights and the big binary data
 * artifacts a dataset ships. A repo "releases" when these first land; anything
 * committed afterwards (README/model-card/recipe polish, or a second weight
 * format added months later) is an UPDATE. This is only a secondary signal —
 * any LFS-tracked file counts as an artifact too, so a weight format we didn't
 * enumerate (e.g. NeMo's `.nemo`) is still caught. */
const ARTIFACT_EXT = new Set([
  ".safetensors", ".bin", ".gguf", ".ggml", ".pt", ".pth", ".ckpt", ".onnx",
  ".h5", ".msgpack", ".tflite", ".npz", ".pb", ".params", ".pdparams", ".model",
  ".pkl", ".nemo", ".parquet", ".arrow", // + dataset artifacts
]);

/** Titles for the scaffolding that lands with the initial release (empty repo
 * placeholder, first config/code push, the large-folder weight upload) — not
 * meaningful "what changed" entries for an update card. */
function isReleaseScaffoldTitle(title: string): boolean {
  const t = title.trim().toLowerCase();
  return (
    t === "init" ||
    t === "initial commit" ||
    t.startsWith("add files using upload-large-folder") ||
    t.startsWith("duplicate from")
  );
}

/**
 * When a repo last (re)shipped weights/data — the NEWEST commit that touched an
 * artifact file, read from the tree where every file carries the commit that
 * last modified it. Changing the weights is a release, even for an old model:
 * nvidia/canary-1b-v2 shipping a `.safetensors` a year after its original
 * `.nemo` is a re-release, not a doc update. So the release moment is the most
 * recent artifact touch; when the head commit is well past it, nothing but
 * docs/config has changed since → UPDATE. Any LFS file counts as an artifact
 * (that's how the `.nemo` gets seen). Returns ms, or null when the tree is
 * unreadable or holds no artifacts, in which case the caller falls back to the
 * commit-burst heuristic.
 */
async function fetchLatestArtifactDate(
  item: HFItem,
  token: string | undefined
): Promise<number | null> {
  if (item.kind === "paper") return null;
  const url = `${HF_BASE}/api/${COMMIT_PATH[item.kind]}/${item.id}/tree/main?recursive=true&expand=true`;
  try {
    const res = await fetchWithRetry(url, { headers: headers(token), cache: "no-store" }, 12_000);
    if (!res.ok) return null;
    const raw = (await res.json()) as Array<{
      type?: string;
      path?: string;
      lfs?: unknown;
      lastCommit?: { date?: string };
    }>;
    if (!Array.isArray(raw)) return null;
    const artifactDates: number[] = [];
    for (const e of raw) {
      if (e?.type !== "file") continue;
      const ts = e.lastCommit?.date ? Date.parse(e.lastCommit.date) : NaN;
      if (!Number.isFinite(ts)) continue;
      const path = (e.path ?? "").toLowerCase();
      const dot = path.lastIndexOf(".");
      const ext = dot >= 0 ? path.slice(dot) : "";
      if (ARTIFACT_EXT.has(ext) || e.lfs != null) artifactDates.push(ts);
    }
    return artifactDates.length ? Math.max(...artifactDates) : null;
  } catch {
    return null;
  }
}

async function fetchAuthorPapers(author: string, token: string | undefined): Promise<HFItem[]> {
  const url = `${HF_BASE}/api/users/${encodeURIComponent(author)}/papers`;
  let res: Response;
  try {
    res = await fetchWithRetry(url, { headers: headers(token), cache: "no-store" });
  } catch {
    return [];
  }
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
/** Per-cacheKey timestamp of the last HF sweep that ran. In-memory is fine
 *  because on restart we just re-sweep; the durable state is the DB. */
const lastSweepAt = new Map<string, number>();

export async function fetchFeed(opts: {
  user: string;
  kinds: HFKind[];
  since?: string;
  perAuthorLimit?: number;
  token?: string;
  maxItems?: number;
  /** Cursor for infinite scroll: return items strictly older than this ms. */
  beforeMs?: number;
  /** Force a sweep now, even if the last one was recent. */
  fresh?: boolean;
}): Promise<HFItem[]> {
  const { user, kinds, since, maxItems = 80, fresh, beforeMs } = opts;
  const sinceMs = since ? Date.parse(since) : 0;

  // Paginated reads (beforeMs is set) skip the sweep — they're serving a
  // cursor into what the DB already has, and re-sweeping on scroll would be
  // both expensive and pointless.
  const key = `v12|${user}|${[...kinds].sort().join(",")}|${since ?? ""}`;
  const shouldSweep =
    !beforeMs && (fresh || Date.now() - (lastSweepAt.get(key) ?? 0) >= FEED_TTL_MS);
  if (shouldSweep) {
    try {
      await runSweep(opts);
    } catch {
      // The sweep is best-effort — even if HF is totally down, we can still
      // return whatever is already in the DB below.
    }
    lastSweepAt.set(key, Date.now());
  }

  // Response ALWAYS comes from the DB — a single sweep never decides what
  // the user sees. Anything ever discovered stays available across refreshes.
  const rows = selectHFItems({
    kinds,
    sinceMs: sinceMs || undefined,
    beforeMs: beforeMs || undefined,
    limit: maxItems,
  });
  return rows.map((r) => JSON.parse(r.itemJson) as HFItem);
}

async function runSweep(opts: Parameters<typeof fetchFeed>[0]): Promise<void> {
  const { user, kinds, since, perAuthorLimit = 30, token, maxItems = 80 } = opts;

  // Author set = whatever HF returns now UNION with what we've persisted
  // before. That way one flaky /following response can't leave the sweep
  // with zero authors.
  const following = await fetchFollowing(user, token);
  const avatars = new Map<string, string | undefined>();
  for (const a of following) if (!avatars.has(a.name)) avatars.set(a.name, a.avatarUrl);
  for (const persisted of selectHFAccounts()) {
    if (!avatars.has(persisted.name)) {
      avatars.set(persisted.name, persisted.avatarUrl ?? undefined);
    }
  }
  const authors = [...avatars.keys()];
  if (!authors.length) return;

  // Persist the merged follow set so the next sweep survives an /following outage.
  upsertHFAccounts(
    [...avatars.entries()].map(([name, avatarUrl]) => ({ name, avatarUrl }))
  );

  interface SweepResult {
    author: string;
    kind: HFKind;
    items: HFItem[];
    /** Only set for non-paper kinds — signals whether the response filled
     *  the perAuthorLimit window. Drives the pruner's conservative logic. */
    windowFull?: boolean;
  }
  const tasks: (() => Promise<SweepResult>)[] = [];
  for (const author of authors) {
    for (const kind of kinds) {
      if (kind === "paper") {
        tasks.push(async () => ({
          author,
          kind,
          items: await fetchAuthorPapers(author, token),
        }));
      } else {
        tasks.push(async () => {
          const items = await fetchAuthorItems(author, kind, token, perAuthorLimit);
          return { author, kind, items, windowFull: items.length >= perAuthorLimit };
        });
      }
    }
  }

  const results = await pool(tasks, 12);
  const flat = results.flatMap((r) => r?.items ?? []);

  // Reconcile with the DB: for every (author, kind) we just refreshed,
  // detect items that disappeared upstream and delete them so they stop
  // showing up in future reads. See the comment on selectHFItemsByAuthorKind.
  //
  // Papers are per-user profile listings and a single paper can be listed
  // under multiple co-authors we follow — we skip paper pruning here rather
  // than risk deleting a paper that another followed author still lists.
  const toDelete: { kind: string; id: string }[] = [];
  for (const r of results) {
    if (!r || r.kind === "paper") continue;
    const seenIds = new Set(r.items.map((it) => it.id));
    const dbRows = selectHFItemsByAuthorKind(r.author, r.kind);
    if (r.windowFull) {
      // Only prune inside the visible window: anything with lastModified
      // >= min(response.lastModified) should have shown up in the response.
      // If it didn't, it was deleted upstream.
      let minMs = Infinity;
      for (const it of r.items) {
        const t = Date.parse(it.lastModified);
        if (t && t < minMs) minMs = t;
      }
      if (minMs !== Infinity) {
        for (const row of dbRows) {
          if (row.lastModified >= minMs && !seenIds.has(row.id)) {
            toDelete.push({ kind: r.kind, id: row.id });
          }
        }
      }
    } else {
      // Response wasn't full → we saw the author's whole inventory for
      // this kind. Anything in DB that isn't in the response is deleted.
      for (const row of dbRows) {
        if (!seenIds.has(row.id)) toDelete.push({ kind: r.kind, id: row.id });
      }
    }
  }
  if (toDelete.length) deleteHFItems(toDelete);

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
  // …and a tree lookup, to date the release by when its weights/data last landed.
  const releaseDates = await pool(
    items.map((it) => () => fetchLatestArtifactDate(it, token)),
    12
  );

  // Classify RELEASE vs UPDATE by finding the repo's initial-release burst
  // and asking whether the head commit is still inside it.
  //
  // A "burst" is a run of commits with no gap larger than CLUSTER_GAP_MS.
  // The initial burst is the first such run, starting from the oldest commit
  // we can see. If the head commit is inside that first burst, this is still
  // the initial release (READMEs/shards/tokenizer landing over a day or two).
  // Anything after the first >12h gap is an UPDATE, no matter how many
  // subsequent commits cluster together.
  //
  // If our fetched window doesn't reach back to createdAt, the initial burst
  // is off-screen — so the head can't possibly be in it → UPDATE.
  //
  // For UPDATE items we also collect the commit titles that fall after the
  // initial burst (deduplicating consecutive repeats like "Update README.md"
  // × 5) so the UI can show what actually changed instead of the stale repo
  // description.
  // 24h absorbs day-after README polish / arXiv citation adds as part of the
  // initial release; real follow-up updates land days or weeks later.
  const CLUSTER_GAP_MS = 24 * 60 * 60 * 1000;
  const UPDATE_TITLES_CAP = 10;
  const COMMITS_LIMIT = 30;
  items.forEach((it, i) => {
    const list = commits[i] ?? [];
    const head = list[0];
    it.lastCommit = head?.title;
    it.lastCommitBy = head?.by;
    it.avatarUrl = avatars.get(it.author);

    // Preferred signal: a (re)release is when the weights/data were last
    // touched. Changing the weights — including adding a new weight format to
    // an old model — is a release. It's only an UPDATE once the head commit is
    // more than a launch-day window past that last artifact change, i.e.
    // nothing but README/config/recipes has moved since. Fall through to the
    // commit-burst heuristic only when we couldn't read the tree.
    const releaseDate = releaseDates[i];
    const headDate = head ? Date.parse(head.date ?? "") : NaN;
    if (releaseDate != null && Number.isFinite(headDate)) {
      it.isUpdate = headDate - releaseDate > CLUSTER_GAP_MS;
      if (it.isUpdate) {
        const chrono = [...list].reverse(); // oldest → newest
        const titles: string[] = [];
        for (let j = chrono.length - 1; j >= 0; j--) {
          const c = chrono[j];
          if (!(Date.parse(c.date ?? "") > releaseDate)) continue;
          const t = c.title?.trim();
          if (!t) continue;
          // Weights land first via the large-folder uploader, then the initial
          // config/code lands under "init"/"initial commit" a beat later — that
          // scaffolding is part of the release, not a change worth listing.
          if (isReleaseScaffoldTitle(t)) continue;
          if (titles.length && titles[titles.length - 1] === t) continue;
          titles.push(t);
          if (titles.length >= UPDATE_TITLES_CAP) break;
        }
        it.updateCommits = titles;
      }
      return;
    }

    // A repo created via HF's "Duplicate" button gets a synthetic
    // "Duplicate from <source>" commit — it isn't user-authored content,
    // and (crucially) the underlying weights/data ALREADY existed publicly
    // in the source repo. So a private mirror of a public model isn't a
    // NEW release from the follower's POV. Any real commit the user makes
    // after the duplicate is a genuine edit → UPDATE.
    const isDupScaffold = (t: string | undefined) =>
      (t?.trim().toLowerCase() ?? "").startsWith("duplicate from");

    if (list.length === 0) {
      it.isUpdate = false;
      return;
    }
    if (list.length === 1) {
      // A lone "Duplicate from" is a re-hosting, not a release. Anything
      // else that stands alone is the repo's actual first commit → release.
      it.isUpdate = isDupScaffold(list[0].title);
      return;
    }

    // Commits arrive newest-first; walk chronologically to find the end of
    // the initial burst (index in `chrono` of the last commit still inside it).
    // HF auto-creates an "initial commit" (empty placeholder) at repo creation
    // time — the real release lands days later. Skip that placeholder when it's
    // isolated from the rest, so the burst starts at the real first push.
    const chrono = [...list].reverse();
    let burstStart = 0;
    if (
      chrono.length >= 2 &&
      chrono[0].title?.trim().toLowerCase() === "initial commit"
    ) {
      const first = Date.parse(chrono[0].date ?? "");
      const second = Date.parse(chrono[1].date ?? "");
      if (
        Number.isFinite(first) &&
        Number.isFinite(second) &&
        second - first > CLUSTER_GAP_MS
      ) {
        burstStart = 1;
      }
    }

    // If the (post-"initial commit") first commit is a "Duplicate from"
    // scaffold, treat the initial burst as empty — the release moment
    // belongs to the source repo, not to this mirror. Every real user
    // commit becomes an update.
    if (chrono.length > burstStart && isDupScaffold(chrono[burstStart].title)) {
      const postDupCommits = chrono.slice(burstStart + 1);
      const titles: string[] = [];
      for (let j = postDupCommits.length - 1; j >= 0; j--) {
        const t = postDupCommits[j].title?.trim();
        if (!t) continue;
        if (titles.length && titles[titles.length - 1] === t) continue;
        titles.push(t);
        if (titles.length >= UPDATE_TITLES_CAP) break;
      }
      it.isUpdate = true;
      it.updateCommits = titles;
      return;
    }
    let initialBurstEnd = burstStart;
    for (let j = burstStart + 1; j < chrono.length; j++) {
      const prev = Date.parse(chrono[j - 1].date ?? "");
      const cur = Date.parse(chrono[j].date ?? "");
      if (!Number.isFinite(prev) || !Number.isFinite(cur)) break;
      if (cur - prev > CLUSTER_GAP_MS) break;
      initialBurstEnd = j;
    }

    // Only check "initial burst off-screen" when we hit the fetch limit —
    // if we got fewer commits than we asked for, we have the entire history
    // and the oldest fetched commit IS the repo's very first commit (even
    // when it's dated well after createdAt — authors sometimes create the
    // repo and start pushing days later).
    const oldestDate = Date.parse(chrono[0].date ?? "");
    const createdDate = it.createdAt ? Date.parse(it.createdAt) : NaN;
    const initialBurstOffscreen =
      list.length >= COMMITS_LIMIT &&
      Number.isFinite(oldestDate) &&
      Number.isFinite(createdDate) &&
      oldestDate - createdDate > CLUSTER_GAP_MS;

    const headInInitialBurst =
      !initialBurstOffscreen && initialBurstEnd === chrono.length - 1;
    it.isUpdate = !headInInitialBurst;

    if (it.isUpdate) {
      // Commits after the initial burst, newest-first, deduped for consecutive
      // identical titles. If the initial burst is off-screen, everything we
      // fetched is post-release.
      const postBurst = initialBurstOffscreen
        ? chrono
        : chrono.slice(initialBurstEnd + 1);
      const titles: string[] = [];
      for (let j = postBurst.length - 1; j >= 0; j--) {
        const t = postBurst[j].title?.trim();
        if (!t) continue;
        if (titles.length && titles[titles.length - 1] === t) continue;
        titles.push(t);
        if (titles.length >= UPDATE_TITLES_CAP) break;
      }
      it.updateCommits = titles;
    }
  });

  // Persist everything we successfully classified. `upsertHFItems` merges
  // by (kind, id): if this sweep failed to fetch author X, X's items simply
  // don't appear in `items` and their existing DB rows are untouched.
  upsertHFItems(
    items.map((it) => ({
      kind: it.kind,
      id: it.id,
      lastModified: Date.parse(it.lastModified) || 0,
      isUpdate: !!it.isUpdate,
      itemJson: JSON.stringify(it),
    }))
  );
}
