import { promises as fs } from "fs";
import path from "path";

const STATE_DIR = path.join(process.cwd(), ".local");
const STATE_FILE = path.join(STATE_DIR, "state.json");
const LEGACY_SETTINGS_FILE = path.join(STATE_DIR, "settings.json");

export interface PersistedState {
  settings?: unknown;
  grid?: unknown;
}

async function readJSON(file: string): Promise<unknown | null> {
  try {
    const raw = await fs.readFile(file, "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/** Read the full server-side state. Seeds settings from the legacy
 *  `.local/settings.json` export on first read if `state.json` is missing. */
export async function readState(): Promise<PersistedState> {
  const state = (await readJSON(STATE_FILE)) as PersistedState | null;
  if (state) return state;
  const legacy = await readJSON(LEGACY_SETTINGS_FILE);
  return legacy ? { settings: legacy } : {};
}

/** Merge a partial patch into state on disk, atomic via tmp+rename. */
export async function patchState(patch: PersistedState): Promise<PersistedState> {
  await fs.mkdir(STATE_DIR, { recursive: true });
  const current = await readState();
  const next: PersistedState = {
    settings: patch.settings ?? current.settings,
    grid: patch.grid ?? current.grid,
  };
  const tmp = `${STATE_FILE}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(next, null, 2), "utf8");
  await fs.rename(tmp, STATE_FILE);
  return next;
}
