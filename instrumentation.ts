// Server-side background scheduler.
//
// `register()` is called once per Next.js server instance on boot. We use it to
// run the HF feed sweep on a timer so the feed stays current WITHOUT anyone
// opening the app — a hosted, always-on server should keep pulling on its own.
// Before this, a sweep only ran on a page load, so a release from a followed
// account could be missed entirely if it passed through the fetch window while
// nobody happened to have the app open.

const SWEEP_INTERVAL_MS = 15 * 60 * 1000; // every 15 min
const INITIAL_DELAY_MS = 20 * 1000; // let the server settle after boot

export async function register() {
  // Next calls register() in every runtime; the sweep needs Node (sqlite + fetch).
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  // Guard against a double start (dev HMR, repeated register calls).
  const g = globalThis as unknown as { __sfSweepStarted?: boolean };
  if (g.__sfSweepStarted) return;
  g.__sfSweepStarted = true;

  const { runBackgroundSweep } = await import("./lib/hf");

  let running = false;
  const tick = async () => {
    if (running) return; // don't overlap sweeps
    running = true;
    try {
      await runBackgroundSweep();
    } catch (err) {
      console.error("[hf] background sweep failed:", err);
    } finally {
      running = false;
    }
  };

  setTimeout(tick, INITIAL_DELAY_MS);
  setInterval(tick, SWEEP_INTERVAL_MS);
}
