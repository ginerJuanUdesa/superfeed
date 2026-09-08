/**
 * Placement engine for dropping a new module onto the grid.
 *
 * Goal (in priority order), all previewed live while the cursor hovers:
 *   1. Try to fit the new module where the mouse is. If there is room, the
 *      NEW module adapts its size to the gap (biggest that fits, down to min).
 *   2. If nothing fits at the anchor, the SURROUNDING modules adapt: the ones
 *      sharing that row shrink horizontally to make room, and the newcomer
 *      slots in at the cursor.
 *   3. If the row can't shrink enough (everyone already at min width), fall
 *      back to appending the module below the content at its default size.
 *
 * This module is pure — it never touches React or the DOM — so the drop
 * behavior can be reasoned about and unit-tested in isolation. `Grid.tsx`
 * calls `computeInsertion` on every drag-over against the ORIGINAL (pre-drag)
 * layout, so moving the cursor to a spot that fits cleanly restores every
 * neighbor to its normal shape.
 */

import type { Layout } from "react-grid-layout";

export interface GridConfig {
  cols: number;
  minW: number;
  minH: number;
  defaultW: number;
  defaultH: number;
}

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** How the newcomer ended up placed — useful for tuning/telemetry, not required. */
export type PlacementMode = "self" | "neighbors" | "append";

export interface Insertion {
  /** Layout of the EXISTING modules in the candidate (neighbors may be moved/resized). */
  layout: Layout[];
  /** Where the new module lands. */
  item: Rect;
  mode: PlacementMode;
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

function overlaps(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

function fitsAt(layout: Layout[], r: Rect, cols: number): boolean {
  if (r.x < 0 || r.y < 0 || r.x + r.w > cols) return false;
  return !layout.some((it) => overlaps(r, it));
}

/** Every allowed (w, h) between min and default, biggest area first so an open
 *  drop lands at the full default size and only shrinks when it has to. */
function candidateSizes(cfg: GridConfig): { w: number; h: number }[] {
  const sizes: { w: number; h: number }[] = [];
  for (let w = cfg.minW; w <= cfg.defaultW; w++) {
    for (let h = cfg.minH; h <= cfg.defaultH; h++) sizes.push({ w, h });
  }
  sizes.sort((a, b) => b.w * b.h - a.w * a.h || b.w - a.w);
  return sizes;
}

function bottom(layout: Layout[]): number {
  return layout.reduce((max, it) => Math.max(max, it.y + it.h), 0);
}

export function computeInsertion(
  base: Layout[],
  wantX: number,
  wantY: number,
  cfg: GridConfig
): Insertion {
  const anchorY = Math.max(0, wantY);

  // 1) The newcomer adapts to a real gap under the cursor. Neighbors untouched.
  for (const { w, h } of candidateSizes(cfg)) {
    const x = clamp(wantX, 0, cfg.cols - w);
    if (fitsAt(base, { x, y: anchorY, w, h }, cfg.cols)) {
      return { layout: base, item: { x, y: anchorY, w, h }, mode: "self" };
    }
  }

  // 2) No gap — the modules in this row shrink to share the columns.
  const shared = shareRow(base, wantX, anchorY, cfg);
  if (shared) return shared;

  // 3) Row can't give — append below the content at the default size.
  const w = clamp(cfg.defaultW, cfg.minW, cfg.cols);
  const x = clamp(wantX, 0, cfg.cols - w);
  return {
    layout: base,
    item: { x, y: bottom(base), w, h: cfg.defaultH },
    mode: "append",
  };
}

/**
 * Fit the newcomer into the row it was dropped on by shrinking that row's
 * modules horizontally, then re-packing the row left-to-right with the newcomer
 * slotted in at the cursor. Returns null if the row can't free enough columns
 * even with everyone at min width.
 */
function shareRow(
  base: Layout[],
  wantX: number,
  anchorY: number,
  cfg: GridConfig
): Insertion | null {
  // The vertical band the newcomer would occupy at its default height.
  const bandTop = anchorY;
  const bandBot = anchorY + cfg.defaultH;
  const inBand = (it: Layout) => it.y < bandBot && it.y + it.h > bandTop;

  const row = base.filter(inBand).sort((a, b) => a.x - b.x);
  const rest = base.filter((it) => !inBand(it));
  if (row.length === 0) return null; // nothing to share with — let caller append

  // Align the newcomer to the row: same top, and tall enough to match it.
  const rowY = Math.min(...row.map((it) => it.y));
  const rowH = Math.max(...row.map((it) => it.h));

  // Try the widest newcomer that the row can accommodate, shrinking down to min.
  for (let newW = cfg.defaultW; newW >= cfg.minW; newW--) {
    const widths = new Map<string, number>(row.map((it) => [String(it.i), it.w]));
    let need = row.reduce((s, it) => s + it.w, 0) + newW - cfg.cols;

    // Shrink the currently-widest module one column at a time until it fits.
    while (need > 0) {
      let widestId: string | null = null;
      let widest = cfg.minW;
      for (const [id, w] of widths) {
        if (w > widest) {
          widest = w;
          widestId = id;
        }
      }
      if (widestId === null) break; // everyone at min — can't free more
      widths.set(widestId, widths.get(widestId)! - 1);
      need--;
    }
    if (need > 0) continue; // this newW didn't fit — try a narrower newcomer

    // Re-pack the row left-to-right, inserting the newcomer at the cursor's slot.
    const insertIdx = row.filter((it) => it.x + it.w / 2 <= wantX).length;
    const packed: Layout[] = [];
    let cx = 0;
    const emit = (it: Layout) => {
      const w = widths.get(String(it.i))!;
      packed.push({ ...it, x: cx, y: it.y, w });
      cx += w;
    };
    for (let i = 0; i < row.length; i++) {
      if (i === insertIdx) cx += newW; // reserve the newcomer's columns
      emit(row[i]);
    }
    const itemX = columnBefore(row, widths, Math.min(insertIdx, row.length));

    return {
      layout: [...rest, ...packed],
      item: { x: itemX, y: rowY, w: newW, h: Math.max(rowH, cfg.minH) },
      mode: "neighbors",
    };
  }

  return null;
}

/** X coordinate the newcomer occupies: the summed widths of the row modules
 *  packed before its insertion index. */
function columnBefore(
  row: Layout[],
  widths: Map<string, number>,
  insertIdx: number
): number {
  let x = 0;
  for (let i = 0; i < insertIdx; i++) x += widths.get(String(row[i].i))!;
  return x;
}
