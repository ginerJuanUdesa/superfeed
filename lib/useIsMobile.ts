import { useEffect, useState } from "react";

/**
 * True when the viewport is phone-sized. Uses a media query so it updates
 * live on rotation / window resize (dev tools). SSR renders as `false` and
 * corrects on first client paint.
 */
export function useIsMobile(): boolean {
  const [mobile, setMobile] = useState<boolean>(false);

  useEffect(() => {
    const mq = window.matchMedia("(max-width: 767px)");
    const update = () => setMobile(mq.matches);
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, []);

  return mobile;
}
