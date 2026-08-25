/**
 * Redmine REST client. Talks to the Bitnami-packaged Redmine at
 * `${REDMINE_URL}` (subpath `/redmine` is already baked into the URL).
 * All calls go server-side — the API key never touches the browser.
 */

const BASE = (process.env.REDMINE_URL ?? "").replace(/\/+$/, "");
const KEY = process.env.REDMINE_API_KEY ?? "";

export interface RedmineProject {
  id: number;
  name: string;
  identifier: string;
}

export type RedmineFlag = "new" | "updated";

export interface RedmineIssue {
  id: number;
  url: string;
  subject: string;
  description: string;
  projectId: number;
  projectName: string;
  tracker: string;
  status: string;
  statusIsClosed: boolean;
  priority: string;
  /** Numeric id; higher = more severe. Sort key for the feed. */
  priorityId: number | null;
  author: string;
  assignedTo: string;
  assignedToId: number | null;
  createdAt: string;
  updatedAt: string;
  /** "new" if created within the since-window, otherwise "updated". */
  flag: RedmineFlag;
}

export interface RedmineUser {
  id: number;
  name: string;
}

interface RawIssue {
  id: number;
  subject: string;
  description?: string;
  project?: { id: number; name: string };
  tracker?: { name: string };
  status?: { name: string; is_closed?: boolean };
  priority?: { id?: number; name: string };
  author?: { name: string };
  assigned_to?: { id?: number; name: string };
  created_on: string;
  updated_on: string;
  journals?: RawJournal[];
}

interface RawJournal {
  id: number;
  user?: { name: string };
  notes?: string;
  created_on: string;
  details?: {
    property?: string;
    name?: string;
    old_value?: string | null;
    new_value?: string | null;
  }[];
}

export interface RedmineJournal {
  id: number;
  author: string;
  createdAt: string;
  notes: string;
  changes: { field: string; from: string; to: string }[];
}

export interface RedmineIssueDetail extends RedmineIssue {
  fullDescription: string;
  journals: RedmineJournal[];
}

interface RawProject {
  id: number;
  name: string;
  identifier: string;
  status?: number;
}

function assertConfigured() {
  if (!BASE || !KEY) {
    throw new Error(
      "Redmine not configured: set REDMINE_URL and REDMINE_API_KEY in .env.local"
    );
  }
}

async function get<T>(path: string, timeoutMs = 15_000): Promise<T> {
  assertConfigured();
  const url = `${BASE}${path}`;
  const res = await fetch(url, {
    headers: { "X-Redmine-API-Key": KEY, Accept: "application/json" },
    signal: AbortSignal.timeout(timeoutMs),
    cache: "no-store",
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Redmine ${path} → ${res.status}: ${text.slice(0, 200)}`);
  }
  return (await res.json()) as T;
}

/** Every active project the API key can see. Paged transparently. */
export async function listProjects(): Promise<RedmineProject[]> {
  const out: RedmineProject[] = [];
  let offset = 0;
  const limit = 100;
  for (let page = 0; page < 20; page++) {
    const data = await get<{ projects: RawProject[]; total_count?: number }>(
      `/projects.json?limit=${limit}&offset=${offset}`
    );
    const chunk = (data.projects ?? [])
      .filter((p) => p.status === undefined || p.status === 1)
      .map((p) => ({ id: p.id, name: p.name, identifier: p.identifier }));
    out.push(...chunk);
    if (chunk.length < limit) break;
    offset += limit;
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

/**
 * Fetch issues from the given projects that were touched on/after `since`.
 * "new" = created in-window; "updated" = updated in-window but created earlier.
 * Returns issues sorted newest-first by updated_on.
 */
export async function listIssues(opts: {
  projectIds: number[];
  since?: string;
  maxPerProject?: number;
  /** When present and non-empty, only return open issues assigned to one of these user IDs. */
  assigneeIds?: number[];
}): Promise<RedmineIssue[]> {
  const { projectIds, since, maxPerProject = 25, assigneeIds } = opts;
  const sinceIso = since ? toRedmineDate(since) : null;
  const filterByAssignee = !!assigneeIds && assigneeIds.length > 0;

  // Two shapes: fan out per project (current behaviour, whole-project feed)
  // or per user (all open tickets assigned to that user, optionally scoped
  // by project_id when both dimensions are selected → intersection).
  // Nothing selected on either dimension → empty feed.
  if (!filterByAssignee) {
    if (!projectIds.length) return [];
    return perProjectFeed(projectIds, sinceIso, maxPerProject);
  }
  return perAssigneeFeed(assigneeIds!, projectIds, sinceIso, maxPerProject);
}

function rawToIssue(raw: RawIssue, sinceIso: string | null): RedmineIssue {
  const created = raw.created_on;
  const updated = raw.updated_on;
  const isNew = sinceIso ? created >= sinceIso : created === updated;
  return {
    id: raw.id,
    url: `${BASE}/issues/${raw.id}`,
    subject: raw.subject,
    description: (raw.description ?? "").slice(0, 500),
    projectId: raw.project?.id ?? 0,
    projectName: raw.project?.name ?? "",
    tracker: raw.tracker?.name ?? "",
    status: raw.status?.name ?? "",
    statusIsClosed: !!raw.status?.is_closed,
    priority: raw.priority?.name ?? "",
    priorityId: raw.priority?.id ?? null,
    author: raw.author?.name ?? "",
    assignedTo: raw.assigned_to?.name ?? "",
    assignedToId: raw.assigned_to?.id ?? null,
    createdAt: created,
    updatedAt: updated,
    flag: isNew ? "new" : "updated",
  };
}

async function perProjectFeed(
  projectIds: number[],
  sinceIso: string | null,
  maxPerProject: number
): Promise<RedmineIssue[]> {
  const perProject = await Promise.all(
    projectIds.map(async (pid) => {
      try {
        const q = new URLSearchParams({
          project_id: String(pid),
          status_id: "*",
          sort: "updated_on:desc",
          limit: String(maxPerProject),
        });
        if (sinceIso) q.set("updated_on", `>=${sinceIso}`);
        const data = await get<{ issues: RawIssue[] }>(`/issues.json?${q.toString()}`);
        return (data.issues ?? []).map((raw) => rawToIssue(raw, sinceIso));
      } catch (err) {
        console.error(`redmine project ${pid} failed:`, err);
        return [] as RedmineIssue[];
      }
    })
  );
  return perProject.flat().sort(bySeverityThenRecency);
}

async function perAssigneeFeed(
  assigneeIds: number[],
  projectIds: number[],
  sinceIso: string | null,
  maxPerAssignee: number
): Promise<RedmineIssue[]> {
  const projectSet = projectIds.length ? new Set(projectIds) : null;
  // When a project is ALSO selected the since window still applies (project
  // feeds are inherently time-scoped); when only users are selected the goal
  // is "everything the user has on their plate right now", so ignore since.
  const applySince = !!sinceIso && projectSet !== null;
  const perUser = await Promise.all(
    assigneeIds.map(async (uid) => {
      try {
        const q = new URLSearchParams({
          assigned_to_id: String(uid),
          status_id: "open",
          sort: "priority:desc,updated_on:desc",
          limit: String(maxPerAssignee),
        });
        if (applySince) q.set("updated_on", `>=${sinceIso}`);
        const data = await get<{ issues: RawIssue[] }>(`/issues.json?${q.toString()}`);
        const items = (data.issues ?? []).map((raw) => rawToIssue(raw, sinceIso));
        // Intersection with projects (when both dimensions are picked) is
        // enforced client-side — Redmine's /issues.json accepts one project_id
        // at a time, so we'd otherwise fan out N × M requests.
        return projectSet
          ? items.filter((it) => projectSet.has(it.projectId))
          : items;
      } catch (err) {
        console.error(`redmine assignee ${uid} failed:`, err);
        return [] as RedmineIssue[];
      }
    })
  );
  // The same ticket can come back via multiple assignees only in theory (one
  // ticket → one assignee), but dedupe defensively in case of shared groups.
  const seen = new Map<number, RedmineIssue>();
  for (const it of perUser.flat()) {
    if (!seen.has(it.id)) seen.set(it.id, it);
  }
  return [...seen.values()].sort(bySeverityThenRecency);
}

/** Descending priority id (higher = more severe), tie-broken by newest update. */
function bySeverityThenRecency(a: RedmineIssue, b: RedmineIssue): number {
  return (
    (b.priorityId ?? 0) - (a.priorityId ?? 0) ||
    Date.parse(b.updatedAt) - Date.parse(a.updatedAt)
  );
}

/**
 * Union of members across the given projects, deduped by user ID.
 * Uses /projects/{id}/memberships.json which our (non-admin) API key can read,
 * unlike /users.json which requires admin. Groups (memberships without a user)
 * are skipped. Failing projects are logged and left out silently so one broken
 * membership call doesn't wipe the whole list.
 */
export async function listMembersUnion(
  projectIds: number[]
): Promise<RedmineUser[]> {
  if (!projectIds.length) return [];
  const seen = new Map<number, string>();
  await Promise.all(
    projectIds.map(async (pid) => {
      try {
        let offset = 0;
        const limit = 100;
        for (let page = 0; page < 20; page++) {
          const data = await get<{
            memberships: {
              user?: { id: number; name: string };
            }[];
          }>(`/projects/${pid}/memberships.json?limit=${limit}&offset=${offset}`);
          const chunk = data.memberships ?? [];
          for (const m of chunk) {
            if (m.user && !seen.has(m.user.id)) seen.set(m.user.id, m.user.name);
          }
          if (chunk.length < limit) break;
          offset += limit;
        }
      } catch (err) {
        console.error(`redmine memberships ${pid} failed:`, err);
      }
    })
  );
  return [...seen.entries()]
    .map(([id, name]) => ({ id, name }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Every user reachable via this API key — union across every project the key
 * can list. Cached for ALL_MEMBERS_TTL_MS so a page full of Redmine modules
 * doesn't fan out N × M membership calls on every mount. Cache is process-
 * local (fine — a restart just refreshes it once).
 */
const ALL_MEMBERS_TTL_MS = 10 * 60 * 1000;
let allMembersCache: { at: number; users: RedmineUser[] } | null = null;
let allMembersInflight: Promise<RedmineUser[]> | null = null;

export async function listAllVisibleMembers(): Promise<RedmineUser[]> {
  const now = Date.now();
  if (allMembersCache && now - allMembersCache.at < ALL_MEMBERS_TTL_MS) {
    return allMembersCache.users;
  }
  if (allMembersInflight) return allMembersInflight;
  allMembersInflight = (async () => {
    const projects = await listProjects();
    const users = await listMembersUnion(projects.map((p) => p.id));
    allMembersCache = { at: Date.now(), users };
    return users;
  })().finally(() => {
    allMembersInflight = null;
  });
  return allMembersInflight;
}

/** Fetch a single issue with its full journal (notes + field changes). */
export async function getIssueDetail(id: number): Promise<RedmineIssueDetail> {
  const data = await get<{ issue: RawIssue }>(
    `/issues/${id}.json?include=journals`
  );
  const raw = data.issue;
  const created = raw.created_on;
  const updated = raw.updated_on;
  const base: RedmineIssue = {
    id: raw.id,
    url: `${BASE}/issues/${raw.id}`,
    subject: raw.subject,
    description: (raw.description ?? "").slice(0, 500),
    projectId: raw.project?.id ?? 0,
    projectName: raw.project?.name ?? "",
    tracker: raw.tracker?.name ?? "",
    status: raw.status?.name ?? "",
    statusIsClosed: !!raw.status?.is_closed,
    priority: raw.priority?.name ?? "",
    priorityId: raw.priority?.id ?? null,
    author: raw.author?.name ?? "",
    assignedTo: raw.assigned_to?.name ?? "",
    assignedToId: raw.assigned_to?.id ?? null,
    createdAt: created,
    updatedAt: updated,
    flag: created === updated ? "new" : "updated",
  };
  const journals: RedmineJournal[] = (raw.journals ?? []).map((j) => ({
    id: j.id,
    author: j.user?.name ?? "",
    createdAt: j.created_on,
    notes: (j.notes ?? "").trim(),
    changes: (j.details ?? [])
      .filter((d) => d.property !== "attachment")
      .map((d) => ({
        field: d.name ?? d.property ?? "",
        from: (d.old_value ?? "") + "",
        to: (d.new_value ?? "") + "",
      })),
  }));
  return { ...base, fullDescription: raw.description ?? "", journals };
}

function toRedmineDate(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
