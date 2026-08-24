import Database from "better-sqlite3";
import { existsSync, mkdirSync, readFileSync } from "fs";
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
const DB_FILE = path.join(STATE_DIR, "unyapper.db");
const LEGACY_STATE_FILE = path.join(STATE_DIR, "state.json");
const LEGACY_SETTINGS_FILE = path.join(STATE_DIR, "settings.json");

let dbInstance: Database.Database | null = null;

function open(): Database.Database {
  if (dbInstance) return dbInstance;
  if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR, { recursive: true });
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
  `);
  dbInstance = db;
  migrateLegacyStateFile(db);
  return db;
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
