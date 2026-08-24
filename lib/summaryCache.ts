/**
 * Client-side view of the server-side summary/classification stores.
 *
 * Historically these lived in localStorage, which meant every browser and
 * every device re-summarized the world from scratch. They now live in the
 * SQLite DB behind `/api/summaries` and `/api/gmail-classifications`, so a
 * summary produced on one device is visible on the next one.
 *
 * The in-memory maps here are a fast read cache. Modules call `preload…`
 * once on mount to hydrate from the server. `getSummary`/`getGmailClassification`
 * stay synchronous so render code doesn't need to await. Writes update the
 * cache and fire a debounced POST to the server.
 *
 * A one-shot migration on first preload uploads any leftover localStorage
 * entries so users don't lose the summaries they'd already generated.
 */

const LEGACY_SUMMARY_KEY = "unyapper:summaries:v1";
const LEGACY_GMAIL_CLASSIFY_KEY = "unyapper:gmailClassify:v1";
const LEGACY_MIGRATED_FLAG = "unyapper:migratedToServer:v1";
const AUTHOR_COLOR_KEY = "unyapper:authorColors:v2";

export interface GmailClassification {
  summary: string;
  isSpam: boolean;
  /** Security alerts, unusual account activity, urgent warnings the user should notice. */
  isAlert: boolean;
}

type ColorStore = Record<string, string>;

const summaryMem = new Map<string, string>();
const gmailMem = new Map<string, GmailClassification>();

let summariesLoaded = false;
let summariesLoading: Promise<void> | null = null;
let gmailLoaded = false;
let gmailLoading: Promise<void> | null = null;

/** The event flavor is part of the key: "release" describes what the repo IS,
 *  "update" describes what CHANGED in the last commit. Same repo, two texts. */
export function keyFor(kind: string, id: string, isUpdate?: boolean): string {
  return `${kind}:${id}:${isUpdate ? "u" : "r"}`;
}

// --- HF summaries ---------------------------------------------------------

export async function preloadSummaries(): Promise<void> {
  if (summariesLoaded) return;
  if (summariesLoading) return summariesLoading;
  summariesLoading = (async () => {
    try {
      const res = await fetch("/api/summaries", { cache: "no-store" });
      if (res.ok) {
        const data = (await res.json()) as { summaries?: Record<string, string> };
        for (const [k, v] of Object.entries(data.summaries ?? {})) {
          summaryMem.set(k, v);
        }
      }
    } catch {
      // offline is fine; we just render without cached summaries
    }
    await migrateLocalSummariesOnce();
    summariesLoaded = true;
  })();
  return summariesLoading;
}

export function getSummary(key: string): string | undefined {
  return summaryMem.get(key);
}

let summaryFlushTimer: ReturnType<typeof setTimeout> | null = null;
const summaryDirty = new Map<string, string>();

export function setSummary(key: string, value: string) {
  summaryMem.set(key, value);
  summaryDirty.set(key, value);
  scheduleSummaryFlush();
}

function scheduleSummaryFlush() {
  if (summaryFlushTimer) return;
  // Small debounce so a burst of summarizer completions coalesces into one
  // POST instead of one-per-item.
  summaryFlushTimer = setTimeout(flushSummaries, 500);
}

async function flushSummaries() {
  summaryFlushTimer = null;
  if (summaryDirty.size === 0) return;
  const batch = Object.fromEntries(summaryDirty);
  summaryDirty.clear();
  try {
    await fetch("/api/summaries", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ summaries: batch }),
    });
  } catch {
    // On failure, put the entries back so the next flush retries them.
    for (const [k, v] of Object.entries(batch)) summaryDirty.set(k, v);
  }
}

// --- Gmail classifications ------------------------------------------------

export async function preloadGmailClassifications(): Promise<void> {
  if (gmailLoaded) return;
  if (gmailLoading) return gmailLoading;
  gmailLoading = (async () => {
    try {
      const res = await fetch("/api/gmail-classifications", { cache: "no-store" });
      if (res.ok) {
        const data = (await res.json()) as {
          classifications?: Record<string, GmailClassification>;
        };
        for (const [k, v] of Object.entries(data.classifications ?? {})) {
          gmailMem.set(k, v);
        }
      }
    } catch {
      // ignore
    }
    await migrateLocalGmailOnce();
    gmailLoaded = true;
  })();
  return gmailLoading;
}

export function getGmailClassification(id: string): GmailClassification | undefined {
  return gmailMem.get(id);
}

let gmailFlushTimer: ReturnType<typeof setTimeout> | null = null;
const gmailDirty = new Map<string, GmailClassification>();

export function setGmailClassification(id: string, value: GmailClassification) {
  gmailMem.set(id, value);
  gmailDirty.set(id, value);
  scheduleGmailFlush();
}

function scheduleGmailFlush() {
  if (gmailFlushTimer) return;
  gmailFlushTimer = setTimeout(flushGmail, 500);
}

async function flushGmail() {
  gmailFlushTimer = null;
  if (gmailDirty.size === 0) return;
  const batch = Object.fromEntries(gmailDirty);
  gmailDirty.clear();
  try {
    await fetch("/api/gmail-classifications", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ classifications: batch }),
    });
  } catch {
    for (const [k, v] of Object.entries(batch)) gmailDirty.set(k, v);
  }
}

/** Server-side wipe + local cache reset. Used by the "Regenerate all" action. */
export async function clearAllGmailClassifications(): Promise<void> {
  gmailMem.clear();
  gmailDirty.clear();
  try {
    await fetch("/api/gmail-classifications", { method: "DELETE" });
  } catch {
    // ignore
  }
}

// --- one-shot localStorage → server migration -----------------------------

async function migrateLocalSummariesOnce() {
  if (typeof window === "undefined") return;
  if (localStorage.getItem(LEGACY_MIGRATED_FLAG) === "done") return;
  try {
    const raw = localStorage.getItem(LEGACY_SUMMARY_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const clean: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (typeof v === "string") clean[k] = v;
      else if (v && typeof v === "object" && "summary" in v) {
        const s = (v as { summary?: unknown }).summary;
        if (typeof s === "string") clean[k] = s;
      }
    }
    if (!Object.keys(clean).length) return;
    const res = await fetch("/api/summaries", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ summaries: clean }),
    });
    if (res.ok) {
      for (const [k, v] of Object.entries(clean)) summaryMem.set(k, v);
      localStorage.removeItem(LEGACY_SUMMARY_KEY);
    }
  } catch {
    // ignore
  }
}

async function migrateLocalGmailOnce() {
  if (typeof window === "undefined") return;
  try {
    const raw = localStorage.getItem(LEGACY_GMAIL_CLASSIFY_KEY);
    if (!raw) {
      // Both stores share the flag — write it only once both are done.
      if (localStorage.getItem(LEGACY_SUMMARY_KEY) == null) {
        localStorage.setItem(LEGACY_MIGRATED_FLAG, "done");
      }
      return;
    }
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const clean: Record<string, GmailClassification> = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (!v || typeof v !== "object") continue;
      const summary = (v as { summary?: unknown }).summary;
      const isSpam = (v as { isSpam?: unknown }).isSpam;
      const isAlert = (v as { isAlert?: unknown }).isAlert;
      if (typeof summary !== "string") continue;
      clean[k] = { summary, isSpam: isSpam === true, isAlert: isAlert === true };
    }
    if (!Object.keys(clean).length) return;
    const res = await fetch("/api/gmail-classifications", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ classifications: clean }),
    });
    if (res.ok) {
      for (const [k, v] of Object.entries(clean)) gmailMem.set(k, v);
      localStorage.removeItem(LEGACY_GMAIL_CLASSIFY_KEY);
      if (localStorage.getItem(LEGACY_SUMMARY_KEY) == null) {
        localStorage.setItem(LEGACY_MIGRATED_FLAG, "done");
      }
    }
  } catch {
    // ignore
  }
}

// --- Author colors (unchanged — cheap, derivable, stays per-device) -------

function readColors(): ColorStore {
  if (typeof window === "undefined") return {};
  try {
    const raw = localStorage.getItem(AUTHOR_COLOR_KEY);
    return raw ? (JSON.parse(raw) as ColorStore) : {};
  } catch {
    return {};
  }
}

function writeColors(store: ColorStore) {
  try {
    localStorage.setItem(AUTHOR_COLOR_KEY, JSON.stringify(store));
  } catch {
    // quota
  }
}

export function getAuthorColor(author: string): string | undefined {
  return readColors()[author];
}

export function setAuthorColor(author: string, color: string) {
  const store = readColors();
  if (store[author] === color) return;
  store[author] = color;
  writeColors(store);
}
