const SUMMARY_KEY = "unyapper:summaries:v1";
// v2: colors now come from the account's avatar, not from the LLM.
const AUTHOR_COLOR_KEY = "unyapper:authorColors:v2";

type SummaryStore = Record<string, string>;
type ColorStore = Record<string, string>;

function readSummaries(): SummaryStore {
  if (typeof window === "undefined") return {};
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

export function keyFor(kind: string, id: string): string {
  return `${kind}:${id}`;
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
