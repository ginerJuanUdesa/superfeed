const SUMMARY_KEY = "unyapper:summaries:v1";
// v2: colors now come from the account's avatar, not from the LLM.
const AUTHOR_COLOR_KEY = "unyapper:authorColors:v2";
const GMAIL_CLASSIFY_KEY = "unyapper:gmailClassify:v1";

/**
 * Bump ONLY when a change would make previously-generated summaries wrong or
 * stylistically off — e.g. the summarize prompt changed, the LLM input shape
 * changed, or the desired output format changed. UI/layout/color/feature work
 * does NOT touch this. On mismatch we wipe the summary store so every card
 * gets re-summarized with the new logic; author colors are unaffected.
 */
const SUMMARY_LOGIC_VERSION = 5;
const SUMMARY_VERSION_KEY = "unyapper:summaries:logicVersion";

type SummaryStore = Record<string, string>;
type ColorStore = Record<string, string>;

export interface GmailClassification {
  summary: string;
  isSpam: boolean;
  /** Security alerts, unusual account activity, urgent warnings the user should notice. */
  isAlert: boolean;
}
type GmailClassifyStore = Record<string, GmailClassification>;

let versionChecked = false;
function ensureVersion() {
  if (versionChecked || typeof window === "undefined") return;
  versionChecked = true;
  try {
    const raw = localStorage.getItem(SUMMARY_VERSION_KEY);
    const stored = raw == null ? null : Number(raw);
    if (stored !== SUMMARY_LOGIC_VERSION) {
      localStorage.removeItem(SUMMARY_KEY);
      localStorage.removeItem(GMAIL_CLASSIFY_KEY);
      localStorage.setItem(SUMMARY_VERSION_KEY, String(SUMMARY_LOGIC_VERSION));
    }
  } catch {
    // ignore
  }
}

function readSummaries(): SummaryStore {
  if (typeof window === "undefined") return {};
  ensureVersion();
  try {
    const raw = localStorage.getItem(SUMMARY_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const out: SummaryStore = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (typeof v === "string") out[k] = v;
      else if (v && typeof v === "object" && "summary" in v) {
        const s = (v as { summary?: unknown }).summary;
        if (typeof s === "string") out[k] = s;
      }
    }
    return out;
  } catch {
    return {};
  }
}

function writeSummaries(store: SummaryStore) {
  try {
    localStorage.setItem(SUMMARY_KEY, JSON.stringify(store));
  } catch {
    // quota
  }
}

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

/**
 * The event flavor is part of the key: a "release" summary describes what
 * the repo IS, while an "update" summary describes what CHANGED in the last
 * commit. Same repo, two different texts — must not share a cache slot.
 */
export function keyFor(kind: string, id: string, isUpdate?: boolean): string {
  return `${kind}:${id}:${isUpdate ? "u" : "r"}`;
}

export function getSummary(key: string): string | undefined {
  return readSummaries()[key];
}

export function setSummary(key: string, value: string) {
  const store = readSummaries();
  store[key] = value;
  writeSummaries(store);
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

function readGmailClassify(): GmailClassifyStore {
  if (typeof window === "undefined") return {};
  ensureVersion();
  try {
    const raw = localStorage.getItem(GMAIL_CLASSIFY_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const out: GmailClassifyStore = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (v && typeof v === "object") {
        const summary = (v as { summary?: unknown }).summary;
        const isSpam = (v as { isSpam?: unknown }).isSpam;
        const isAlert = (v as { isAlert?: unknown }).isAlert;
        if (typeof summary === "string") {
          out[k] = { summary, isSpam: isSpam === true, isAlert: isAlert === true };
        }
      }
    }
    return out;
  } catch {
    return {};
  }
}

function writeGmailClassify(store: GmailClassifyStore) {
  try {
    localStorage.setItem(GMAIL_CLASSIFY_KEY, JSON.stringify(store));
  } catch {
    // quota
  }
}

export function getGmailClassification(id: string): GmailClassification | undefined {
  return readGmailClassify()[id];
}

export function setGmailClassification(id: string, value: GmailClassification) {
  const store = readGmailClassify();
  store[id] = value;
  writeGmailClassify(store);
}

/** Wipe the entire Gmail classification cache — used by the manual regenerate action. */
export function clearAllGmailClassifications() {
  if (typeof window === "undefined") return;
  try {
    localStorage.removeItem(GMAIL_CLASSIFY_KEY);
  } catch {
    // ignore
  }
}
