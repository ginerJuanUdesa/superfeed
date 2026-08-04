"use client";

/**
 * Dominant color of a profile picture, computed in-browser with canvas.
 * HF's avatar CDN sends `access-control-allow-origin: *`, so the canvas
 * stays untainted and getImageData works.
 */

const SIZE = 40;

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("image load failed"));
    img.src = url;
  });
}

function toHex(r: number, g: number, b: number): string {
  const h = (n: number) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, "0");
  return `#${h(r)}${h(g)}${h(b)}`;
}

/** Keep the bar dark enough for white text and light enough to read as a color. */
function clampLightness(r: number, g: number, b: number): [number, number, number] {
  const max = Math.max(r, g, b) / 255;
  const min = Math.min(r, g, b) / 255;
  const l = (max + min) / 2;
  const target = Math.max(0.22, Math.min(0.68, l));
  if (target === l) return [r, g, b];
  if (target < l) {
    const k = target / l; // l > target >= 0.22, so no divide-by-zero
    return [r * k, g * k, b * k];
  }
  // lighten toward white by the same proportion of remaining headroom
  const k = (target - l) / (1 - l);
  return [r + (255 - r) * k, g + (255 - g) * k, b + (255 - b) * k];
}

/**
 * Bucket pixels into a coarse RGB grid, pick the heaviest bucket, then average
 * the real pixels inside it. Weighting favors saturated mid-tones so a logo on
 * a white card wins over the white card itself.
 */
export async function dominantColorFromImage(url: string): Promise<string | null> {
  let img: HTMLImageElement;
  try {
    img = await loadImage(url);
  } catch {
    return null;
  }

  const canvas = document.createElement("canvas");
  canvas.width = SIZE;
  canvas.height = SIZE;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;
  ctx.drawImage(img, 0, 0, SIZE, SIZE);

  let data: Uint8ClampedArray;
  try {
    data = ctx.getImageData(0, 0, SIZE, SIZE).data;
  } catch {
    return null; // tainted canvas
  }

  const buckets = new Map<number, { w: number; r: number; g: number; b: number; n: number }>();
  for (let i = 0; i < data.length; i += 4) {
    const a = data[i + 3] / 255;
    if (a < 0.5) continue;
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];

    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const sat = max === 0 ? 0 : (max - min) / max;
    const lum = (max + min) / 510;
    // near-white and near-black are backgrounds far more often than identity
    const extreme = lum > 0.93 || lum < 0.07 ? 0.04 : 1;
    const w = a * (0.2 + sat) * extreme;

    const key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
    const acc = buckets.get(key) ?? { w: 0, r: 0, g: 0, b: 0, n: 0 };
    acc.w += w;
    acc.r += r;
    acc.g += g;
    acc.b += b;
    acc.n += 1;
    buckets.set(key, acc);
  }

  let best: { w: number; r: number; g: number; b: number; n: number } | null = null;
  for (const acc of buckets.values()) if (!best || acc.w > best.w) best = acc;
  if (!best || !best.n) return null;

  const [r, g, b] = clampLightness(best.r / best.n, best.g / best.n, best.b / best.n);
  return toHex(r, g, b);
}
