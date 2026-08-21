import { useEffect, useRef } from "react";

/**
 * Auto-refresh loop with error-aware backoff.
 *
 *  - Calls `load()` on mount, then every `intervalMs` on success.
 *  - On error (load throws or returns false), retries after `errorMs`
 *    instead of waiting a full interval — so a network blip resolves on
 *    its own without the user reloading the page.
 *  - Extra triggers: window focus, tab visibility, and the `online` event
 *    all force an immediate load. Coming back to the tab after a Wi-Fi
 *    drop should always show fresh data.
 *
 * `load` receives a flag indicating whether the last call errored, so it
 * can differentiate a foreground retry from a scheduled tick if needed.
 * The return value is used to decide backoff: throw or return false to
 * mean "still broken, keep the fast retry"; return true / undefined to
 * mean "success, resume the normal cadence."
 */
export function useAutoRefresh(
  load: () => Promise<unknown> | unknown,
  opts: { intervalMs: number; errorMs?: number } = { intervalMs: 60_000 }
) {
  const loadRef = useRef(load);
  loadRef.current = load;

  const { intervalMs, errorMs = 20_000 } = opts;

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const schedule = (delay: number) => {
      if (cancelled) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(run, delay);
    };

    async function run() {
      if (cancelled) return;
      let ok = true;
      try {
        const r = await loadRef.current();
        if (r === false) ok = false;
      } catch {
        ok = false;
      }
      if (cancelled) return;
      schedule(ok ? intervalMs : errorMs);
    }

    // initial fire
    void run();

    const forceReload = () => {
      if (document.visibilityState === "hidden") return;
      schedule(0);
    };
    const onVis = () => {
      if (document.visibilityState === "visible") schedule(0);
    };
    const onOnline = () => schedule(0);

    window.addEventListener("focus", forceReload);
    document.addEventListener("visibilitychange", onVis);
    window.addEventListener("online", onOnline);

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      window.removeEventListener("focus", forceReload);
      document.removeEventListener("visibilitychange", onVis);
      window.removeEventListener("online", onOnline);
    };
  }, [intervalMs, errorMs]);
}
