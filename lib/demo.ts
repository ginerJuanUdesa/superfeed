/**
 * Demo mode — a fully populated dashboard backed by canned, generic data.
 *
 * Enabled with `DEMO_MODE=1`. When on, every `/api/*` feed route short-circuits
 * to the fixtures below instead of touching a real backend, and `/api/state`
 * serves a pre-seeded board (settings + grid) so the app opens already
 * arranged — no credentials, no external calls, nothing written to `.local`.
 *
 * This is what the README screenshot and any public "try it" run use: it shows
 * the app working end-to-end with placeholder tickets, emails, releases, etc.
 * All content here is intentionally generic.
 */

import type { PersistedState } from "./serverState";
import type { RedmineIssue, RedmineProject, RedmineUser } from "./redmine";
import type { GithubItem } from "./github";
import type { GmailItem } from "./gmail";
import type { CalendarEvent } from "./calendar";
import type { HFItem } from "./hf";
import type { FleetProbeResult, FleetServerResult } from "./fleet";

/** True when the deployment is running as a credential-free demo. */
export function isDemo(): boolean {
  return process.env.DEMO_MODE === "1";
}

/* --- time helpers: keep the feed looking freshly loaded on every request --- */
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
const ahead = (ms: number) => new Date(Date.now() + ms).toISOString();

/** A round monogram avatar as an inline data URI so cards render offline. */
function avatar(bg: string, ch = ""): string {
  const svg =
    `<svg xmlns='http://www.w3.org/2000/svg' width='64' height='64'>` +
    `<rect width='64' height='64' rx='32' fill='${bg}'/>` +
    `<text x='32' y='43' font-family='Arial,sans-serif' font-size='30' font-weight='700' ` +
    `fill='#ffffff' text-anchor='middle'>${ch}</text></svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

/* ------------------------------------------------------------------ Redmine */

export function demoRedmineProjects(): RedmineProject[] {
  return [
    { id: 1, name: "Project Alpha", identifier: "alpha" },
    { id: 2, name: "Project Beta", identifier: "beta" },
  ];
}

export function demoRedmineMembers(): RedmineUser[] {
  return [
    { id: 11, name: "Alex Morgan" },
    { id: 12, name: "Sam Rivera" },
    { id: 13, name: "Jordan Lee" },
  ];
}

export function demoRedmineIssues(): RedmineIssue[] {
  const base = (id: number, over: Partial<RedmineIssue>): RedmineIssue => ({
    id,
    url: `#`,
    subject: `Ticket ${id}`,
    description: "Generic placeholder description for this ticket.",
    projectId: 1,
    projectName: "Project Alpha",
    tracker: "Bug",
    status: "New",
    statusIsClosed: false,
    priority: "Normal",
    priorityId: 2,
    author: "Alex Morgan",
    assignedTo: "Sam Rivera",
    assignedToId: 12,
    createdAt: ago(3 * DAY),
    updatedAt: ago(2 * HOUR),
    flag: "updated",
    ...over,
  });
  return [
    base(1042, {
      subject: "Ticket: checkout page returns 500 under load",
      tracker: "Bug",
      status: "In Progress",
      priority: "Urgente",
      priorityId: 4,
      updatedAt: ago(35 * MIN),
      flag: "updated",
    }),
    base(1041, {
      subject: "Ticket: add pagination to the reports export",
      tracker: "Feature",
      status: "New",
      priority: "Alta",
      priorityId: 3,
      author: "Jordan Lee",
      assignedTo: "Alex Morgan",
      assignedToId: 11,
      createdAt: ago(6 * HOUR),
      updatedAt: ago(6 * HOUR),
      flag: "new",
    }),
    base(1039, {
      subject: "Ticket: intermittent timeout when saving settings",
      projectId: 2,
      projectName: "Project Beta",
      tracker: "Bug",
      status: "Feedback",
      priority: "Normal",
      priorityId: 2,
      assignedTo: "Jordan Lee",
      assignedToId: 13,
      updatedAt: ago(1 * DAY),
    }),
    base(1035, {
      subject: "Ticket: update onboarding copy for new users",
      projectId: 2,
      projectName: "Project Beta",
      tracker: "Support",
      status: "New",
      priority: "Baja",
      priorityId: 1,
      updatedAt: ago(2 * DAY),
    }),
    base(1028, {
      subject: "Ticket: dark mode contrast fails on secondary buttons",
      tracker: "Bug",
      status: "Resolved",
      statusIsClosed: true,
      priority: "Normal",
      priorityId: 2,
      updatedAt: ago(4 * DAY),
    }),
    base(1019, {
      subject: "Ticket: migrate cron jobs to the new scheduler",
      projectId: 2,
      projectName: "Project Beta",
      tracker: "Feature",
      status: "Closed",
      statusIsClosed: true,
      priority: "Alta",
      priorityId: 3,
      updatedAt: ago(9 * DAY),
    }),
  ];
}

export function demoRedmineSummary(issueId: number) {
  const map: Record<number, { headline: string; statusNote: string; bullets: string[] }> = {
    1042: {
      headline: "Checkout throws a 500 once concurrent traffic crosses a threshold.",
      statusNote: "Reproduced on staging; a fix is in review and awaits QA sign-off.",
      bullets: ["Only under load", "Points to DB pool exhaustion", "Fix in review", "Needs QA before deploy"],
    },
    1041: {
      headline: "Add pagination so large report exports stop timing out.",
      statusNote: "Newly filed, not yet assigned an implementation approach.",
      bullets: ["Exports over ~10k rows fail", "Wants server-side paging", "No design yet"],
    },
    1039: {
      headline: "Saving settings occasionally times out with no error shown.",
      statusNote: "Waiting on reporter to confirm whether it still happens after the retry patch.",
      bullets: ["Intermittent", "No user-facing error", "Retry patch shipped", "Awaiting confirmation"],
    },
  };
  const s = map[issueId] ?? {
    headline: "Placeholder summary for a generic ticket.",
    statusNote: "Sample status note describing the latest activity on this ticket.",
    bullets: ["Sample fact", "Sample decision", "Sample open question"],
  };
  return { ...s, updatedAt: ago(2 * HOUR), journalCount: 3 };
}

/* ------------------------------------------------------------------- GitHub */

export function demoGithubItems(): GithubItem[] {
  const gh = (login: string, bg: string) => avatar(bg, login[0].toUpperCase());
  return [
    {
      id: "e1",
      kind: "pr",
      action: "opened a pull request in",
      actor: "acme",
      actorAvatar: gh("acme", "#6e40c9"),
      repo: "acme/web-app",
      repoUrl: "#",
      title: "Add rate limiting to the public API",
      number: 482,
      state: "open",
      body: "Introduces a token-bucket limiter in front of the public endpoints, configurable per API key.",
      url: "#",
      createdAt: ago(50 * MIN),
      reviewDecision: "REVIEW_REQUIRED",
    },
    {
      id: "e2",
      kind: "pr",
      action: "merged a pull request in",
      actor: "acme",
      actorAvatar: gh("acme", "#6e40c9"),
      repo: "acme/web-app",
      repoUrl: "#",
      title: "Fix flaky checkout integration test",
      number: 479,
      state: "merged",
      body: "The test raced on the fixture teardown; now awaits the cleanup before asserting.",
      url: "#",
      createdAt: ago(5 * HOUR),
      reviewDecision: "APPROVED",
    },
    {
      id: "e3",
      kind: "release",
      action: "released",
      actor: "acme",
      actorAvatar: gh("acme", "#6e40c9"),
      repo: "acme/cli",
      repoUrl: "#",
      title: "v2.4.0",
      state: null,
      body: "Adds a --json output flag and speeds up the init command by ~40%.",
      url: "#",
      createdAt: ago(1 * DAY),
    },
    {
      id: "e4",
      kind: "issue",
      action: "opened an issue in",
      actor: "acme",
      actorAvatar: gh("acme", "#6e40c9"),
      repo: "acme/docs",
      repoUrl: "#",
      title: "Getting-started guide is out of date",
      number: 91,
      state: "open",
      body: "The install snippet still references the old package name.",
      url: "#",
      createdAt: ago(1 * DAY - 3 * HOUR),
    },
    {
      id: "e5",
      kind: "push",
      action: "pushed to",
      actor: "acme",
      actorAvatar: gh("acme", "#6e40c9"),
      repo: "acme/web-app",
      repoUrl: "#",
      title: "Tidy up config loading and drop dead env vars",
      state: null,
      body: "",
      url: "#",
      createdAt: ago(2 * DAY),
    },
    {
      id: "e6",
      kind: "star",
      action: "starred",
      actor: "acme",
      actorAvatar: gh("acme", "#6e40c9"),
      repo: "opensource/awesome-tui",
      repoUrl: "#",
      title: "opensource/awesome-tui",
      state: null,
      body: "",
      url: "#",
      createdAt: ago(3 * DAY),
    },
  ];
}

export function demoGithubPRs(): GithubItem[] {
  return demoGithubItems().filter((i) => i.kind === "pr" && i.state === "open");
}

/* -------------------------------------------------------------------- Gmail */

export function demoGmailItems(): GmailItem[] {
  const mk = (over: Partial<GmailItem> & { id: string }): GmailItem => ({
    account: "personal",
    accountEmail: "you@example.com",
    from: "Sender Name",
    fromEmail: "sender@example.com",
    subject: "Subject line",
    snippet: "Short preview of the message body goes here…",
    body: "Full placeholder body text for this sample email.",
    receivedAt: ago(2 * HOUR),
    isUnread: false,
    ...over,
  });
  return [
    mk({
      id: "g1",
      from: "Security",
      fromEmail: "no-reply@accounts.example.com",
      subject: "New sign-in on a new device",
      snippet: "We noticed a new sign-in to your account from a new device. Was this you?",
      receivedAt: ago(40 * MIN),
      isUnread: true,
    }),
    mk({
      id: "g2",
      from: "Alex Morgan",
      fromEmail: "alex@example.com",
      subject: "Re: Q3 planning notes",
      snippet: "Thanks for sending these over. One question on the second milestone…",
      receivedAt: ago(3 * HOUR),
      isUnread: true,
    }),
    mk({
      id: "g3",
      from: "Billing",
      fromEmail: "billing@example.com",
      subject: "Your receipt for this month",
      snippet: "Thanks for your payment. Here is the receipt for your records.",
      receivedAt: ago(1 * DAY),
    }),
    mk({
      id: "g4",
      from: "The Weekly Digest",
      fromEmail: "news@newsletter.example.com",
      subject: "This week in tech: 10 things you missed",
      snippet: "Our hand-picked roundup of the week's biggest stories, straight to your inbox.",
      receivedAt: ago(1 * DAY - 5 * HOUR),
    }),
    mk({
      id: "g5",
      from: "Sam Rivera",
      fromEmail: "sam@example.com",
      subject: "Lunch next week?",
      snippet: "Are you around on Thursday? Would be great to catch up over lunch.",
      receivedAt: ago(2 * DAY),
    }),
  ];
}

export function demoGmailClassifications(items: { id: string }[]) {
  const table: Record<string, { summary: string; isSpam: boolean; isAlert: boolean }> = {
    g1: { summary: "Security notice about a new sign-in on an unrecognized device.", isSpam: false, isAlert: true },
    g2: { summary: "Colleague replies to planning notes with a question about milestone two.", isSpam: false, isAlert: false },
    g3: { summary: "Monthly payment receipt for your records.", isSpam: false, isAlert: false },
    g4: { summary: "Weekly newsletter roundup of tech stories.", isSpam: true, isAlert: false },
    g5: { summary: "A friend asks whether you are free for lunch on Thursday.", isSpam: false, isAlert: false },
  };
  return {
    results: items.map((it) => ({
      id: it.id,
      summary: table[it.id]?.summary ?? "Sample one-line summary of this email.",
      isSpam: table[it.id]?.isSpam ?? false,
      isAlert: table[it.id]?.isAlert ?? false,
    })),
  };
}

/* ----------------------------------------------------------------- Calendar */

export function demoCalendarEvents(): CalendarEvent[] {
  const ev = (over: Partial<CalendarEvent> & { id: string }): CalendarEvent => ({
    account: "personal",
    accountEmail: "you@example.com",
    summary: "Event",
    location: "",
    start: ahead(2 * HOUR),
    end: ahead(3 * HOUR),
    allDay: false,
    htmlLink: "#",
    ...over,
  });
  return [
    ev({ id: "c1", summary: "Team standup", start: ahead(1 * HOUR), end: ahead(1 * HOUR + 30 * MIN), location: "Meet" }),
    ev({ id: "c2", summary: "Design review", start: ahead(4 * HOUR), end: ahead(5 * HOUR), location: "Room B" }),
    ev({ id: "c3", summary: "1:1 with Alex", start: ahead(1 * DAY), end: ahead(1 * DAY + 30 * MIN) }),
    ev({ id: "c4", summary: "Company all-hands", start: ahead(2 * DAY), end: ahead(2 * DAY + 1 * HOUR), location: "Auditorium" }),
    ev({ id: "c5", summary: "Release day", start: ahead(3 * DAY), end: ahead(4 * DAY), allDay: true }),
  ];
}

/* ---------------------------------------------------------------- Hugging Face */

export function demoHFItems(): HFItem[] {
  const item = (over: Partial<HFItem> & { id: string; name: string; kind: HFItem["kind"] }): HFItem => ({
    author: "acme-ai",
    description: "Generic placeholder description for this repository.",
    url: "#",
    lastModified: ago(1 * DAY),
    releaseDate: ago(1 * DAY),
    createdAt: ago(30 * DAY),
    downloads: 1234,
    likes: 42,
    avatarUrl: avatar("#ff9d00", "A"),
    ...over,
  });
  return [
    item({
      id: "acme-ai/sample-chat-8b",
      name: "sample-chat-8b",
      kind: "model",
      pipeline: "text-generation",
      tags: ["conversational", "8B"],
      description: "An 8B parameter chat model finetuned on a curated instruction set.",
      releaseDate: ago(4 * HOUR),
      lastModified: ago(4 * HOUR),
      likes: 128,
      downloads: 9800,
    }),
    item({
      id: "acme-ai/sample-eval-set",
      name: "sample-eval-set",
      kind: "dataset",
      description: "A 40k-example evaluation set for retrieval-augmented generation.",
      releaseDate: ago(1 * DAY),
      lastModified: ago(1 * DAY),
      likes: 56,
      downloads: 3100,
    }),
    item({
      id: "acme-ai/sample-demo-space",
      name: "sample-demo-space",
      kind: "space",
      description: "Interactive demo for the sample-chat-8b model.",
      releaseDate: ago(2 * DAY),
      lastModified: ago(2 * DAY),
      likes: 21,
    }),
    item({
      id: "acme-ai/sample-vision-model",
      name: "sample-vision-model",
      kind: "model",
      pipeline: "image-classification",
      tags: ["vision"],
      description: "Added GGUF quants for the base checkpoint.",
      isUpdate: true,
      lastCommit: "Add GGUF quants for the 8B variant",
      lastCommitBy: "acme-ai",
      updateCommits: ["Add GGUF quants for the 8B variant", "Update model card benchmarks"],
      releaseDate: ago(3 * DAY),
      lastModified: ago(3 * HOUR),
    }),
  ];
}

export function demoHFSummary(item: HFItem): { summary: string } {
  const table: Record<string, string> = {
    "acme-ai/sample-chat-8b": "8B chat finetune tuned on a curated instruction set",
    "acme-ai/sample-eval-set": "40k-example RAG evaluation set",
    "acme-ai/sample-demo-space": "interactive demo for the 8B chat model",
    "acme-ai/sample-vision-model": "added GGUF quants for the 8B variant",
  };
  return { summary: table[item.id] ?? "sample release with placeholder capabilities" };
}

/* -------------------------------------------------------------------- Fleet */

export function demoFleet(): { results: FleetProbeResult[]; servers: FleetServerResult[] } {
  const now = ago(0);
  return {
    servers: [
      { label: "gpu-01", host: "10.0.0.10", up: true, latencyMs: 3, openPorts: [22, 443], checkedAt: now },
      { label: "gpu-02", host: "10.0.0.11", up: true, latencyMs: 5, openPorts: [22], checkedAt: now },
      { label: "backup-01", host: "10.0.0.20", up: false, latencyMs: null, openPorts: [], checkedAt: now },
    ],
    results: [
      { label: "web", host: "10.0.0.2", port: 443, status: "up", latencyMs: 8, checkedAt: now },
      { label: "api", host: "10.0.0.2", port: 8080, status: "up", latencyMs: 12, checkedAt: now },
      { label: "db", host: "10.0.0.3", port: 5432, status: "up", latencyMs: 2, checkedAt: now },
      { label: "cache", host: "10.0.0.3", port: 6379, status: "down", latencyMs: null, checkedAt: now, error: "connection refused" },
    ],
  };
}

/* ------------------------------------------------------- seeded board state */

/** The pre-arranged board a demo deployment opens with. */
export function demoState(): PersistedState {
  const settings = {
    startDate: "",
    themeMode: "dark",
    gmailAccounts: [
      { label: "personal", refreshToken: "demo", clientId: "demo", clientSecret: "demo" },
    ],
    hfUsername: "acme-ai",
    hfToken: "",
    githubUsername: "acme",
    githubToken: "demo",
    anthropicApiKey: "",
    localLlmUrl: "http://demo.local/v1/chat/completions",
    localLlmModel: "demo",
    fleetEndpoints: [
      { label: "web", host: "10.0.0.2", port: 443 },
      { label: "api", host: "10.0.0.2", port: 8080 },
      { label: "db", host: "10.0.0.3", port: 5432 },
      { label: "cache", host: "10.0.0.3", port: 6379 },
    ],
    fleetServers: [
      { label: "gpu-01", host: "10.0.0.10" },
      { label: "gpu-02", host: "10.0.0.11" },
      { label: "backup-01", host: "10.0.0.20" },
    ],
  };

  const modules = [
    { id: "d_hf", type: "hf", title: "Hugging Face", config: { kinds: ["model", "dataset", "space", "paper"] } },
    { id: "d_gh", type: "github", title: "GitHub", config: {} },
    { id: "d_gmail", type: "gmail", title: "Inbox", config: {} },
    { id: "d_redmine", type: "redmine", title: "Issues", config: { projectIds: [1, 2] } },
    { id: "d_cal", type: "calendar", title: "Calendar", config: {} },
    { id: "d_fleet", type: "fleet", title: "Fleet", config: {} },
  ];

  const layout = [
    { i: "d_hf", x: 0, y: 0, w: 4, h: 7, minW: 2, minH: 3 },
    { i: "d_gh", x: 4, y: 0, w: 4, h: 7, minW: 2, minH: 3 },
    { i: "d_gmail", x: 8, y: 0, w: 4, h: 7, minW: 2, minH: 3 },
    { i: "d_redmine", x: 0, y: 7, w: 4, h: 7, minW: 2, minH: 3 },
    { i: "d_cal", x: 4, y: 7, w: 4, h: 7, minW: 2, minH: 3 },
    { i: "d_fleet", x: 8, y: 7, w: 4, h: 7, minW: 2, minH: 3 },
  ];

  return { settings, grid: { modules, layout } };
}
