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
  author: string;
  assignedTo: string;
  createdAt: string;
  updatedAt: string;
  /** "new" if created within the since-window, otherwise "updated". */
  flag: RedmineFlag;
}

interface RawIssue {
  id: number;
  subject: string;
  description?: string;
  project?: { id: number; name: string };
  tracker?: { name: string };
  status?: { name: string; is_closed?: boolean };
  priority?: { name: string };
  author?: { name: string };
  assigned_to?: { name: string };
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
}): Promise<RedmineIssue[]> {
  const { projectIds, since, maxPerProject = 25 } = opts;
  if (!projectIds.length) return [];

  const sinceIso = since ? toRedmineDate(since) : null;

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
        return (data.issues ?? []).map((raw): RedmineIssue => {
          const created = raw.created_on;
          const updated = raw.updated_on;
          const isNew = sinceIso ? created >= sinceIso : created === updated;
          return {
            id: raw.id,
            url: `${BASE}/issues/${raw.id}`,
            subject: raw.subject,
            description: (raw.description ?? "").slice(0, 500),
            projectId: raw.project?.id ?? pid,
            projectName: raw.project?.name ?? "",
            tracker: raw.tracker?.name ?? "",
            status: raw.status?.name ?? "",
            statusIsClosed: !!raw.status?.is_closed,
            priority: raw.priority?.name ?? "",
            author: raw.author?.name ?? "",
            assignedTo: raw.assigned_to?.name ?? "",
            createdAt: created,
            updatedAt: updated,
            flag: isNew ? "new" : "updated",
          };
        });
      } catch (err) {
        console.error(`redmine project ${pid} failed:`, err);
        return [] as RedmineIssue[];
      }
    })
  );

  return perProject
    .flat()
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
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
    author: raw.author?.name ?? "",
    assignedTo: raw.assigned_to?.name ?? "",
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
