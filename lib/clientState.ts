/**
 * Client-side cache of the server-persisted state.
 *
 * The whole app used to read/write user settings and the dashboard grid via
 * `localStorage` — per-browser, per-origin, invisible to anyone else. We now
 * persist that state server-side (`.local/state.json`) so every viewer of the
 * same deployment sees the same dashboard.
 *
 * To keep the many existing `loadSettings()` / `loadState()` call sites sync,
 * we hydrate ONCE at the app root before rendering the grid, then serve reads
 * from an in-memory cache. Writes patch the cache and fire-and-forget a
 * debounced PATCH to /api/state.
 */

let cache: { settings?: unknown; grid?: unknown } = {};
let hydrated = false;
let hydratePromise: Promise<void> | null = null;

/** Fetch the server state once; subsequent calls resolve immediately. */
export function hydrate(): Promise<void> {
  if (hydrated) return Promise.resolve();
  if (hydratePromise) return hydratePromise;
  hydratePromise = fetch("/api/state", { cache: "no-store" })
    .then((r) => (r.ok ? r.json() : {}))
    .then((data) => {
      cache = data ?? {};
      hydrated = true;
    })
    .catch(() => {
      cache = {};
      hydrated = true;
    });
  return hydratePromise;
}

export function isHydrated(): boolean {
  return hydrated;
}

export function getCachedSettings<T = unknown>(): T | undefined {
  return cache.settings as T | undefined;
}

export function getCachedGrid<T = unknown>(): T | undefined {
  return cache.grid as T | undefined;
}

/**
 * Push a partial patch to the server, debounced. Multiple rapid writes to
 * different top-level keys coalesce into a single request — the server
 * merges at the top level so this is safe.
 */
let pending: { settings?: unknown; grid?: unknown } = {};
let flushTimer: ReturnType<typeof setTimeout> | null = null;

function sendPatch(body: { settings?: unknown; grid?: unknown }, opts: { keepalive?: boolean } = {}) {
  if (!Object.keys(body).length) return;
  // keepalive lets the request survive tab-close / navigation, which is
  // what makes save-on-leave reliable.
  fetch("/api/state", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    keepalive: opts.keepalive,
  }).catch(() => {
    // Next successful save will re-send the full grid/settings, so a
    // single failed PATCH self-heals.
  });
}

function scheduleFlush(delayMs: number) {
  if (flushTimer) clearTimeout(flushTimer);
  flushTimer = setTimeout(() => {
    const body = pending;
    pending = {};
    flushTimer = null;
    sendPatch(body);
  }, delayMs);
}

/**
 * Fire any pending writes right now, synchronously enqueued as a
 * keepalive fetch so the browser will deliver it even if the tab is
 * closing. Call before unload / on visibility hidden.
 */
export function flushPending() {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  const body = pending;
  pending = {};
  sendPatch(body, { keepalive: true });
}

/** Event modules subscribe to when they need to react to a settings edit
 *  without waiting for the next auto-refresh tick. */
export const SETTINGS_CHANGED_EVENT = "unyapper:settings-changed";

export function saveSettings(settings: unknown) {
  cache.settings = settings;
  pending.settings = settings;
  // Settings changes are user-initiated (Save button) — flush quickly.
  scheduleFlush(50);
  if (typeof window !== "undefined") {
    window.dispatchEvent(new Event(SETTINGS_CHANGED_EVENT));
  }
}

export function saveGrid(grid: unknown) {
  cache.grid = grid;
  pending.grid = grid;
  // Grid layout streams from drag/resize — coalesce, but short enough that
  // a checkbox tick + immediate close still lands via flushPending().
  scheduleFlush(250);
}
