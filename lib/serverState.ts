import { getKV, setKV } from "./db";

export interface PersistedState {
  settings?: unknown;
  grid?: unknown;
}

/** Read the full server-side state from SQLite. Legacy JSON on disk is
 *  imported the first time the DB opens, see `db.ts`. */
export async function readState(): Promise<PersistedState> {
  return {
    settings: getKV<unknown>("settings") ?? undefined,
    grid: getKV<unknown>("grid") ?? undefined,
  };
}

/** Merge a partial patch into state. Each top-level key is its own row, so
 *  concurrent writers on different keys don't stomp each other. */
export async function patchState(patch: PersistedState): Promise<PersistedState> {
  if (patch.settings !== undefined) setKV("settings", patch.settings);
  if (patch.grid !== undefined) setKV("grid", patch.grid);
  return readState();
}
