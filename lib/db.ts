import Database from "better-sqlite3";
import { existsSync, mkdirSync, readFileSync, renameSync } from "fs";
import path from "path";

/**
 * Shared SQLite store for anything that used to live in `.local/state.json`
 * or in the browser's localStorage. Moving LLM summaries and Gmail
 * classifications server-side lets a second device (e.g. Juan's laptop) reuse
 * work already done on the first one instead of re-summarizing the world.
 *
 * Path stays under `.local/` so the existing Docker volume mount picks it up
 * without any compose change.
 */

const STATE_DIR = path.join(process.cwd(), ".local");
const DB_FILE = path.join(STATE_DIR, "superfeed.db");
const LEGACY_DB_FILE = path.join(STATE_DIR, "unyapper.db");
const LEGACY_STATE_FILE = path.join(STATE_DIR, "state.json");
const LEGACY_SETTINGS_FILE = path.join(STATE_DIR, "settings.json");

/**
 * Bump when the HF summarize prompt or input shape changes so previously-
 * generated summaries would look wrong under the new logic. On mismatch we
 * wipe `hf_summaries` — every card re-summarizes with the new prompt.
 * Gmail classifications are unaffected; they have their own concerns.
 */
const HF_SUMMARY_LOGIC_VERSION = 2;
const HF_SUMMARY_VERSION_KEY = "hf_summary_logic_version";

let dbInstance: Database.Database | null = null;

function open(): Database.Database {
  if (dbInstance) return dbInstance;
  if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR, { recursive: true });
  // Legacy DB rename (unyapper.db → superfeed.db). Only rename when the new
  // file doesn't exist yet, so a partial run can't clobber the new DB.
  if (!existsSync(DB_FILE) && existsSync(LEGACY_DB_FILE)) {
    renameSync(LEGACY_DB_FILE, DB_FILE);
    for (const ext of ["-wal", "-shm"]) {
      const legacy = LEGACY_DB_FILE + ext;
      if (existsSync(legacy)) renameSync(legacy, DB_FILE + ext);
    }
  }
  const db = new Database(DB_FILE);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS kv_state (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS hf_summaries (
      key        TEXT PRIMARY KEY,
      summary    TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS gmail_classifications (
      id         TEXT PRIMARY KEY,
      summary    TEXT NOT NULL,
      is_spam    INTEGER NOT NULL,
      is_alert   INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    -- Persisted HF feed items. Key insight: a single request may drop
    -- items silently when a per-author sub-fetch fails, so we NEVER let
    -- an in-memory snapshot decide what the user sees. Every item ever
    -- discovered stays here (indexed by kind+id) and the module reads
    -- the union — HF hiccups can no longer make releases "disappear
    -- between refreshes".
    CREATE TABLE IF NOT EXISTS hf_items (
      kind          TEXT NOT NULL,
      id            TEXT NOT NULL,
      last_modified INTEGER NOT NULL,
      -- Effective feed date: when the weights/data actually landed for a
      -- (re)release, or last_modified for an update. This — not last_modified —
      -- is what the card shows and what the feed is ordered/paginated by, so a
      -- release whose head is a trailing doc commit sorts by its real drop.
      sort_ms       INTEGER,
      is_update     INTEGER NOT NULL,
      item_json     TEXT NOT NULL,
      updated_at    INTEGER NOT NULL,
      PRIMARY KEY (kind, id)
    );
    CREATE INDEX IF NOT EXISTS hf_items_last_modified
      ON hf_items (last_modified DESC);
    CREATE INDEX IF NOT EXISTS hf_items_sort_ms
      ON hf_items (sort_ms DESC);
    -- Persisted HF follow set. If /following pagination fails halfway,
    -- we still know which accounts to fan out to on the next sweep.
    CREATE TABLE IF NOT EXISTS hf_accounts (
      name       TEXT PRIMARY KEY,
      avatar_url TEXT,
      updated_at INTEGER NOT NULL
    );
  `);
  dbInstance = db;
  migrateHFSortColumn(db);
  migrateLegacyStateFile(db);
  invalidateHFSummariesIfStale(db);
  return db;
}

/** Add the hf_items.sort_ms column to DBs created before it existed, and seed
 *  it from each row's effective (re)release date — read out of the stored
 *  item_json — so the feed is correctly ordered immediately, without waiting
 *  for the next sweep to re-enrich. Falls back to last_modified. */
function migrateHFSortColumn(db: Database.Database) {
  const cols = db.prepare("PRAGMA table_info(hf_items)").all() as { name: string }[];
  if (cols.some((c) => c.name === "sort_ms")) return;
  db.exec("ALTER TABLE hf_items ADD COLUMN sort_ms INTEGER");
  db.exec("CREATE INDEX IF NOT EXISTS hf_items_sort_ms ON hf_items (sort_ms DESC)");
  const rows = db
    .prepare("SELECT kind, id, last_modified AS lastModified, item_json AS itemJson FROM hf_items")
    .all() as { kind: string; id: string; lastModified: number; itemJson: string }[];
  const upd = db.prepare("UPDATE hf_items SET sort_ms = ? WHERE kind = ? AND id = ?");
  const tx = db.transaction((batch: typeof rows) => {
    for (const r of batch) {
      let sortMs = r.lastModified;
      try {
        const it = JSON.parse(r.itemJson) as {
          isUpdate?: boolean;
          releaseDate?: string;
        };
        if (!it.isUpdate && it.releaseDate) {
          const rel = Date.parse(it.releaseDate);
          if (Number.isFinite(rel)) sortMs = rel;
        }
      } catch {
        // keep last_modified
      }
      upd.run(sortMs, r.kind, r.id);
    }
  });
  tx(rows);
}

/** If the stored summary logic version doesn't match the current one, blow
 *  away every cached HF summary and record the new version. */
function invalidateHFSummariesIfStale(db: Database.Database) {
  const row = db
    .prepare("SELECT value FROM kv_state WHERE key = ?")
    .get(HF_SUMMARY_VERSION_KEY) as { value: string } | undefined;
  const current = row ? Number(JSON.parse(row.value)) : null;
  if (current === HF_SUMMARY_LOGIC_VERSION) return;
  db.prepare("DELETE FROM hf_summaries").run();
  db.prepare(
    `INSERT INTO kv_state (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  ).run(HF_SUMMARY_VERSION_KEY, JSON.stringify(HF_SUMMARY_LOGIC_VERSION));
}

/** One-shot import of `.local/state.json` (or the older `settings.json`) into
 *  `kv_state`. Runs only when the DB has no rows yet; keeps the JSON around
 *  so a rollback is trivial. */
function migrateLegacyStateFile(db: Database.Database) {
  const row = db.prepare("SELECT COUNT(*) AS n FROM kv_state").get() as { n: number };
  if (row.n > 0) return;
  const src = existsSync(LEGACY_STATE_FILE)
    ? LEGACY_STATE_FILE
    : existsSync(LEGACY_SETTINGS_FILE)
    ? LEGACY_SETTINGS_FILE
    : null;
  if (!src) return;
  try {
    const raw = readFileSync(src, "utf8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    // state.json shape: { settings, grid }. Legacy settings.json is the
    // settings object directly.
    const seed =
      src === LEGACY_SETTINGS_FILE
        ? { settings: parsed }
        : parsed;
    const put = db.prepare(
      "INSERT INTO kv_state (key, value) VALUES (@key, @value)"
    );
    const tx = db.transaction((entries: { key: string; value: string }[]) => {
      for (const e of entries) put.run(e);
    });
    tx(
      Object.entries(seed)
        .filter(([, v]) => v !== undefined)
        .map(([key, value]) => ({ key, value: JSON.stringify(value) }))
    );
  } catch {
    // ignore — a corrupt legacy file shouldn't block startup
  }
}

export function getKV<T>(key: string): T | null {
  const row = open()
    .prepare("SELECT value FROM kv_state WHERE key = ?")
    .get(key) as { value: string } | undefined;
  if (!row) return null;
  try {
    return JSON.parse(row.value) as T;
  } catch {
    return null;
  }
}

export function setKV(key: string, value: unknown): void {
  open()
    .prepare(
      `INSERT INTO kv_state (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`
    )
    .run(key, JSON.stringify(value));
}

export function getAllHFSummaries(): Record<string, string> {
  const rows = open()
    .prepare("SELECT key, summary FROM hf_summaries")
    .all() as { key: string; summary: string }[];
  const out: Record<string, string> = {};
  for (const r of rows) out[r.key] = r.summary;
  return out;
}

export function upsertHFSummaries(entries: Record<string, string>): void {
  const stmt = open().prepare(
    `INSERT INTO hf_summaries (key, summary, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET summary = excluded.summary, updated_at = excluded.updated_at`
  );
  const now = Date.now();
  const tx = open().transaction((pairs: [string, string][]) => {
    for (const [k, v] of pairs) stmt.run(k, v, now);
  });
  tx(Object.entries(entries));
}

export interface GmailClassificationRow {
  summary: string;
  isSpam: boolean;
  isAlert: boolean;
}

export function getAllGmailClassifications(): Record<string, GmailClassificationRow> {
  const rows = open()
    .prepare(
      "SELECT id, summary, is_spam AS isSpam, is_alert AS isAlert FROM gmail_classifications"
    )
    .all() as { id: string; summary: string; isSpam: number; isAlert: number }[];
  const out: Record<string, GmailClassificationRow> = {};
  for (const r of rows) {
    out[r.id] = { summary: r.summary, isSpam: !!r.isSpam, isAlert: !!r.isAlert };
  }
  return out;
}

export function upsertGmailClassifications(
  entries: Record<string, GmailClassificationRow>
): void {
  const stmt = open().prepare(
    `INSERT INTO gmail_classifications (id, summary, is_spam, is_alert, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       summary = excluded.summary,
       is_spam = excluded.is_spam,
       is_alert = excluded.is_alert,
       updated_at = excluded.updated_at`
  );
  const now = Date.now();
  const tx = open().transaction(
    (pairs: [string, GmailClassificationRow][]) => {
      for (const [id, v] of pairs) {
        stmt.run(id, v.summary, v.isSpam ? 1 : 0, v.isAlert ? 1 : 0, now);
      }
    }
  );
  tx(Object.entries(entries));
}

export function clearGmailClassifications(): void {
  open().prepare("DELETE FROM gmail_classifications").run();
}

// --- HF items (persistent feed store) -------------------------------------

export interface HFItemRow {
  kind: string;
  id: string;
  lastModified: number;
  isUpdate: boolean;
  itemJson: string;
}

/** Return every DB item for a single (author, kind) — the LIKE 'author/%'
 *  matches HF's `author/name` id convention. Used by the sweep-time pruner
 *  to spot rows that HF no longer serves. */
export function selectHFItemsByAuthorKind(
  author: string,
  kind: string
): { id: string; lastModified: number }[] {
  const rows = open()
    .prepare(
      `SELECT id, last_modified AS lastModified
       FROM hf_items
       WHERE kind = ? AND id LIKE ? || '/%'`
    )
    .all(kind, author) as { id: string; lastModified: number }[];
  return rows;
}

/** Bulk delete by (kind, id) pairs. Silent on missing rows. */
export function deleteHFItems(rows: { kind: string; id: string }[]): void {
  if (rows.length === 0) return;
  const db = open();
  const stmt = db.prepare(`DELETE FROM hf_items WHERE kind = ? AND id = ?`);
  const tx = db.transaction((batch: typeof rows) => {
    for (const r of batch) stmt.run(r.kind, r.id);
  });
  tx(rows);
}

export function upsertHFItems(
  rows: { kind: string; id: string; lastModified: number; sortMs: number; isUpdate: boolean; itemJson: string }[]
): void {
  if (rows.length === 0) return;
  const stmt = open().prepare(
    `INSERT INTO hf_items (kind, id, last_modified, sort_ms, is_update, item_json, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(kind, id) DO UPDATE SET
       last_modified = excluded.last_modified,
       sort_ms       = excluded.sort_ms,
       is_update     = excluded.is_update,
       item_json     = excluded.item_json,
       updated_at    = excluded.updated_at`
  );
  const now = Date.now();
  const tx = open().transaction((batch: typeof rows) => {
    for (const r of batch) {
      stmt.run(r.kind, r.id, r.lastModified, r.sortMs, r.isUpdate ? 1 : 0, r.itemJson, now);
    }
  });
  tx(rows);
}

/** Insert rows only when (kind, id) isn't already stored — never overwrites.
 *  Used to persist the long tail of a sweep (items past the enrichment window)
 *  so a followed repo is never dropped just because noisier accounts outrank it,
 *  while leaving any row a previous sweep already enriched untouched. */
export function insertHFItemsIfAbsent(
  rows: { kind: string; id: string; lastModified: number; sortMs: number; isUpdate: boolean; itemJson: string }[]
): void {
  if (rows.length === 0) return;
  const db = open();
  const stmt = db.prepare(
    `INSERT INTO hf_items (kind, id, last_modified, sort_ms, is_update, item_json, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(kind, id) DO NOTHING`
  );
  const now = Date.now();
  const tx = db.transaction((batch: typeof rows) => {
    for (const r of batch) {
      stmt.run(r.kind, r.id, r.lastModified, r.sortMs, r.isUpdate ? 1 : 0, r.itemJson, now);
    }
  });
  tx(rows);
}

/** Return items filtered by kind and (optional) since-cutoff, newest first. */
export function selectHFItems(opts: {
  kinds: string[];
  sinceMs?: number;
  beforeMs?: number;
  limit: number;
}): HFItemRow[] {
  if (opts.kinds.length === 0) return [];
  const placeholders = opts.kinds.map(() => "?").join(",");
  // Order and paginate by the effective feed date (the real (re)release date
  // for releases, last_modified for updates) so the list matches what each
  // card shows. COALESCE covers rows swept before sort_ms existed.
  const sortExpr = "COALESCE(sort_ms, last_modified)";
  const sinceClause = opts.sinceMs ? `AND ${sortExpr} >= ?` : "";
  const beforeClause = opts.beforeMs ? `AND ${sortExpr} < ?` : "";
  const sql = `
    SELECT kind, id, last_modified AS lastModified, is_update AS isUpdate, item_json AS itemJson
    FROM hf_items
    WHERE kind IN (${placeholders}) ${sinceClause} ${beforeClause}
    ORDER BY ${sortExpr} DESC
    LIMIT ?
  `;
  const params: (string | number)[] = [...opts.kinds];
  if (opts.sinceMs) params.push(opts.sinceMs);
  if (opts.beforeMs) params.push(opts.beforeMs);
  params.push(opts.limit);
  const rows = open().prepare(sql).all(...params) as {
    kind: string;
    id: string;
    lastModified: number;
    isUpdate: number;
    itemJson: string;
  }[];
  return rows.map((r) => ({
    kind: r.kind,
    id: r.id,
    lastModified: r.lastModified,
    isUpdate: !!r.isUpdate,
    itemJson: r.itemJson,
  }));
}

// --- HF accounts (persistent follow set) ---------------------------------

export interface HFAccountRow {
  name: string;
  avatarUrl: string | null;
}

export function upsertHFAccounts(accounts: { name: string; avatarUrl?: string }[]): void {
  if (accounts.length === 0) return;
  const stmt = open().prepare(
    `INSERT INTO hf_accounts (name, avatar_url, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(name) DO UPDATE SET
       avatar_url = COALESCE(excluded.avatar_url, hf_accounts.avatar_url),
       updated_at = excluded.updated_at`
  );
  const now = Date.now();
  const tx = open().transaction((batch: typeof accounts) => {
    for (const a of batch) stmt.run(a.name, a.avatarUrl ?? null, now);
  });
  tx(accounts);
}

export function selectHFAccounts(): HFAccountRow[] {
  return open()
    .prepare("SELECT name, avatar_url AS avatarUrl FROM hf_accounts")
    .all() as HFAccountRow[];
}
