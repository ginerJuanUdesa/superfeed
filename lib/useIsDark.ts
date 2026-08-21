import { useEffect, useState } from "react";

/**
 * Resolve the effective theme. Honors an explicit `data-theme` override on
 * <html> (set by SettingsModal); otherwise falls back to the OS preference.
 */
function resolve(): boolean {
  if (typeof document === "undefined") return false;
  const forced = document.documentElement.getAttribute("data-theme");
  if (forced === "dark") return true;
  if (forced === "light") return false;
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

export function useIsDark(): boolean {
  const [dark, setDark] = useState<boolean>(resolve);

  useEffect(() => {
    const update = () => setDark(resolve());

    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    mq.addEventListener("change", update);

    const mo = new MutationObserver(update);
    mo.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });

    return () => {
      mq.removeEventListener("change", update);
      mo.disconnect();
    };
  }, []);

  return dark;
}
