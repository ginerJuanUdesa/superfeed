"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import GridLayout, { Layout, WidthProvider } from "react-grid-layout";
import { GearSix, SquaresFour } from "@phosphor-icons/react";
import Module from "./Module";
import SettingsModal from "./SettingsModal";
import { applyThemeMode, loadSettings } from "@/lib/settings";
import { ModuleInstance, ModuleType } from "@/lib/types";
import { MODULES, getModule } from "@/modules/registry";
import type { ModuleDescriptor } from "@/modules/types";
import { flushPending, getCachedGrid, hydrate, saveGrid } from "@/lib/clientState";
import { useIsMobile } from "@/lib/useIsMobile";

const ResponsiveGrid = WidthProvider(GridLayout);

const COLS = 12;
const MARGIN = 12;
const ROW_HEIGHT = 60;
const DEFAULT_W = 4;
const DEFAULT_H = 5;
const MIN_W = 2;
const MIN_H = 3;

/**
 * Find a slot for a new module without displacing anything.
 *
 * Priority is LOCATION first, SIZE second: if the drop anchor sits in a
 * pocket, we shrink the module to whatever fits at that anchor (largest
 * area wins), instead of drifting away to place it at full size elsewhere.
 * Only when nothing at all fits at the anchor do we search outward, and as a
 * last resort we drop below the bottom of the layout — guaranteed empty.
 */
function findFreeSlot(
  layout: Layout[],
  wantX: number,
  wantY: number
): { x: number; y: number; w: number; h: number } {
  const occ: boolean[][] = [];
  const mark = (x: number, y: number, w: number, h: number) => {
    for (let yy = y; yy < y + h; yy++) {
      if (!occ[yy]) occ[yy] = new Array(COLS).fill(false);
      for (let xx = x; xx < Math.min(x + w, COLS); xx++) occ[yy][xx] = true;
    }
  };
  const fits = (x: number, y: number, w: number, h: number) => {
    if (x < 0 || x + w > COLS || y < 0) return false;
    for (let yy = y; yy < y + h; yy++) {
      const row = occ[yy];
      if (!row) continue;
      for (let xx = x; xx < x + w; xx++) if (row[xx]) return false;
    }
    return true;
  };
  let maxRow = 0;
  for (const it of layout) {
    mark(it.x, it.y, it.w, it.h);
    if (it.y + it.h > maxRow) maxRow = it.y + it.h;
  }

  const anchorY = Math.max(0, wantY);

  // Enumerate every allowed (w, h) once, sorted by area DESC so the biggest
  // shape that fits at the drop anchor wins.
  const sizes: { w: number; h: number }[] = [];
  for (let w = MIN_W; w <= DEFAULT_W; w++) {
    for (let h = MIN_H; h <= DEFAULT_H; h++) {
      sizes.push({ w, h });
    }
  }
  sizes.sort((a, b) => b.w * b.h - a.w * a.h || b.w - a.w);

  // Step 1: fit at the drop anchor. Nudge x left just enough for wider sizes
  // to stay inside the grid so the user's row intent still wins.
  for (const { w, h } of sizes) {
    const x = Math.max(0, Math.min(COLS - w, wantX));
    if (fits(x, anchorY, w, h)) return { x, y: anchorY, w, h };
  }

  // Step 2: nothing fits at the anchor — search outward from (wantX, anchorY),
  // scanning right/left across each row, then row by row downward.
  for (const { w, h } of sizes) {
    const startX = Math.max(0, Math.min(COLS - w, wantX));
    for (let dy = 0; dy < maxRow + 1; dy++) {
      const y = anchorY + dy;
      for (let x = startX; x <= COLS - w; x++) if (fits(x, y, w, h)) return { x, y, w, h };
      for (let x = 0; x < startX; x++) if (fits(x, y, w, h)) return { x, y, w, h };
    }
  }

  return { x: 0, y: maxRow, w: DEFAULT_W, h: DEFAULT_H };
}

interface PersistedState {
  modules: ModuleInstance[];
  layout: Layout[];
}

function loadState(): PersistedState {
  const raw = getCachedGrid<PersistedState | null>();
  if (!raw) return { modules: [], layout: [] };
  return {
    modules: raw.modules ?? [],
    layout: raw.layout ?? [],
  };
}

function saveState(state: PersistedState) {
  saveGrid(state);
}

function makeId() {
  return `m_${Math.random().toString(36).slice(2, 9)}`;
}

export default function Grid() {
  const [modules, setModules] = useState<ModuleInstance[]>([]);
  const [layout, setLayout] = useState<Layout[]>([]);
  const [hydrated, setHydrated] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [previewSlot, setPreviewSlot] = useState<{
    x: number;
    y: number;
    w: number;
    h: number;
  } | null>(null);
  const pendingTypeRef = useRef<ModuleType | null>(null);
  const movedRef = useRef(false);
  const dropzoneRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    hydrate().then(() => {
      if (cancelled) return;
      const s = loadState();
      setModules(s.modules);
      setLayout(s.layout);
      // Apply the persisted theme choice on first paint so the shell doesn't
      // flash the default dark palette when the user has picked light or system.
      applyThemeMode(loadSettings().themeMode);
      setHydrated(true);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    // saveState → saveGrid already debounces server writes (250 ms) and
    // coalesces bursts. No extra timer here, so a checkbox tick is one
    // hop away from being on the wire.
    saveState({ modules, layout });
  }, [modules, layout, hydrated]);

  // Guarantee: any pending write must land, even if the user closes the
  // tab (or switches away on mobile) inside the debounce window. Uses
  // fetch({ keepalive: true }) so the browser delivers the request after
  // the page is gone.
  useEffect(() => {
    if (!hydrated) return;
    const onLeaving = () => flushPending();
    const onVis = () => { if (document.visibilityState === "hidden") flushPending(); };
    window.addEventListener("pagehide", onLeaving);
    document.addEventListener("visibilitychange", onVis);
    return () => {
      window.removeEventListener("pagehide", onLeaving);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [hydrated]);

  const removeModule = (id: string) => {
    setModules((prev) => prev.filter((m) => m.id !== id));
    setLayout((prev) => prev.filter((l) => l.i !== id));
  };

  const updateConfig = (id: string, config: Record<string, unknown>) => {
    setModules((prev) => prev.map((m) => (m.id === id ? { ...m, config } : m)));
  };

  // A drag that actually moved must not turn into a click on the card underneath.
  const onDragStart = () => {
    movedRef.current = false;
    // Kill text selection across the whole document while the drag is live —
    // scoping user-select:none to just the dragged item isn't enough because
    // the cursor sweeps over other cards' text mid-drag.
    document.body.classList.add("superfeed-dragging");
  };
  const onDrag = () => {
    movedRef.current = true;
  };
  const onDragStop = () => {
    document.body.classList.remove("superfeed-dragging");
    // Flush after the render → effect → saveGrid chain triggered by the
    // final onLayoutChange has run, so we send the FINAL layout, not the
    // one that was pending before this drag. setTimeout(0) queues after
    // React commits and the save effect fires.
    window.setTimeout(() => flushPending(), 0);
    if (!movedRef.current) return;
    movedRef.current = false;
    const swallow = (e: MouseEvent) => {
      e.stopPropagation();
      e.preventDefault();
    };
    window.addEventListener("click", swallow, { capture: true, once: true });
    // if no click follows (e.g. drag ended outside), drop the listener
    window.setTimeout(() => window.removeEventListener("click", swallow, true), 400);
  };

  const onLayoutChange = (next: Layout[]) => {
    setLayout(next);
  };

  const wantCoordsFromEvent = (e: React.DragEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const relX = e.clientX - rect.left;
    const relY = e.clientY - rect.top;
    const colW = (rect.width - MARGIN * (COLS - 1)) / COLS;
    return {
      wantX: Math.max(0, Math.floor(relX / (colW + MARGIN))),
      wantY: Math.max(0, Math.floor(relY / (ROW_HEIGHT + MARGIN))),
    };
  };

  const onDragOverDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    if (!pendingTypeRef.current) return;
    const { wantX, wantY } = wantCoordsFromEvent(e);
    const slot = findFreeSlot(layout, wantX, wantY);
    setPreviewSlot((prev) =>
      prev && prev.x === slot.x && prev.y === slot.y && prev.w === slot.w && prev.h === slot.h
        ? prev
        : slot
    );
  };

  const onDragLeaveDrop = (e: React.DragEvent<HTMLDivElement>) => {
    // Only clear when the drag leaves the container itself, not when it crosses
    // into a child element.
    if (dropzoneRef.current && e.relatedTarget instanceof Node) {
      if (dropzoneRef.current.contains(e.relatedTarget)) return;
    }
    setPreviewSlot(null);
  };

  const onNativeDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    const type = pendingTypeRef.current;
    if (!type) {
      setPreviewSlot(null);
      return;
    }
    const { wantX, wantY } = wantCoordsFromEvent(e);
    const descriptor = getModule(type);
    if (!descriptor) return;
    const id = makeId();
    const title = descriptor.defaultTitle;
    const config = descriptor.defaultConfig?.() ?? {};
    setModules((prev) => [...prev, { id, type, title, config }]);
    setLayout((prev) => {
      const slot = findFreeSlot(prev, wantX, wantY);
      return [
        ...prev,
        { i: id, x: slot.x, y: slot.y, w: slot.w, h: slot.h, minW: MIN_W, minH: MIN_H },
      ];
    });
    pendingTypeRef.current = null;
    setPreviewSlot(null);
  };

  const moduleMap = useMemo(() => new Map(modules.map((m) => [m.id, m])), [modules]);

  const isMobile = useIsMobile();

  if (!hydrated) {
    return (
      <div className="p-8 text-[var(--text-faint)] text-sm mono">
        loading
      </div>
    );
  }

  if (isMobile) {
    // Some panels opt out of the phone carousel (e.g. decorative Media).
    const mobileModules = modules.filter((m) => !getModule(m.type)?.mobileHidden);
    const mobileIds = new Set(mobileModules.map((m) => m.id));
    const mobileLayout = layout.filter((l) => mobileIds.has(l.i));
    return (
      <MobileCarousel
        modules={mobileModules}
        layout={mobileLayout}
        onUpdateConfig={updateConfig}
      />
    );
  }

  return (
    <div className="min-h-screen">
      <Toolbar
        onDragStart={(t) => (pendingTypeRef.current = t)}
        onOpenSettings={() => setSettingsOpen(true)}
      />
      <SettingsModal open={settingsOpen} onClose={() => setSettingsOpen(false)} />
      <div
        ref={dropzoneRef}
        className="p-4 pr-16 sm:p-6 sm:pr-16 min-h-screen relative"
        onDragOver={onDragOverDrop}
        onDragLeave={onDragLeaveDrop}
        onDrop={onNativeDrop}
      >
        <div className="relative">
          <ResponsiveGrid
            className="layout"
            layout={layout}
            cols={COLS}
            rowHeight={ROW_HEIGHT}
            onLayoutChange={onLayoutChange}
            onDragStart={onDragStart}
            onDrag={onDrag}
            onDragStop={onDragStop}
            onResizeStart={onDragStart}
            onResizeStop={onDragStop}
            draggableCancel=".no-drag,input,button"
            compactType={null}
            preventCollision={true}
            margin={[MARGIN, MARGIN]}
            containerPadding={[0, 0]}
            resizeHandles={["se", "sw"]}
          >
            {layout.map((l) => {
              const m = moduleMap.get(l.i);
              if (!m) return null;
              return (
                <div key={l.i}>
                  <Module module={m} onRemove={removeModule} onUpdateConfig={updateConfig} />
                </div>
              );
            })}
          </ResponsiveGrid>
          {previewSlot && <DropGhost slot={previewSlot} />}
        </div>
        {modules.length === 0 && <EmptyHint />}
      </div>
    </div>
  );
}

function Toolbar({
  onDragStart,
  onOpenSettings,
}: {
  onDragStart: (t: ModuleType) => void;
  onOpenSettings: () => void;
}) {
  return (
    <div className="rail fixed right-0 top-0 bottom-0 w-14 z-50 flex flex-col items-center py-4 gap-2">
      <RailButton onClick={onOpenSettings} title="Settings">
        <GearSix size={20} weight="regular" />
      </RailButton>
      <div className="w-6 h-px bg-[var(--border)] my-1" />
      {MODULES.map((descriptor) => (
        <DraggableTile key={descriptor.type} descriptor={descriptor} onDragStart={onDragStart} />
      ))}
    </div>
  );
}

function RailButton({
  onClick,
  title,
  children,
}: {
  onClick: () => void;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      className="rail-item w-10 h-10 flex items-center justify-center cursor-pointer"
    >
      {children}
    </button>
  );
}

function DraggableTile({
  descriptor,
  onDragStart,
}: {
  descriptor: ModuleDescriptor;
  onDragStart: (t: ModuleType) => void;
}) {
  const { RailIcon } = descriptor;
  return (
    <div
      className="rail-item w-10 h-10 flex items-center justify-center cursor-grab active:cursor-grabbing select-none"
      draggable
      unselectable="on"
      onDragStart={(e) => {
        onDragStart(descriptor.type);
        e.dataTransfer.setData("text/plain", "");
      }}
      title={`Drag to add a ${descriptor.label} module`}
    >
      <RailIcon />
    </div>
  );
}

function DropGhost({ slot }: { slot: { x: number; y: number; w: number; h: number } }) {
  const colPct = 100 / COLS;
  const left = `calc(${slot.x * colPct}% + ${(slot.x * MARGIN) / COLS}px)`;
  const width = `calc(${slot.w * colPct}% - ${((COLS - slot.w) * MARGIN) / COLS}px)`;
  const top = slot.y * (ROW_HEIGHT + MARGIN);
  const height = slot.h * ROW_HEIGHT + (slot.h - 1) * MARGIN;
  return (
    <div
      className="pointer-events-none absolute z-10"
      style={{
        left,
        top,
        width,
        height,
        background: "var(--accent-dim)",
        boxShadow: "inset 0 0 0 1px var(--accent)",
        borderRadius: "var(--radius)",
      }}
    />
  );
}

function EmptyHint() {
  return (
    <div className="absolute inset-0 flex items-center justify-center pointer-events-none px-4">
      <div className="max-w-sm text-center flex flex-col items-center gap-5">
        <div
          className="w-14 h-14 flex items-center justify-center"
          style={{
            background: "var(--surface)",
            border: "1px solid var(--border)",
            borderRadius: "var(--radius)",
            boxShadow: "0 12px 32px -18px rgba(0,0,0,0.7)",
            color: "var(--text-muted)",
          }}
        >
          <SquaresFour size={28} weight="regular" />
        </div>
        <div className="space-y-1.5">
          <div className="text-[var(--text)] text-base font-medium">
            Nothing here yet
          </div>
          <div className="text-[var(--text-muted)] text-sm leading-relaxed">
            Drag a module from the rail on the right onto this canvas.
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * Mobile view: one full-screen module at a time, horizontally swipeable.
 *
 * The desktop `layout` decides the order — modules are read row-first
 * (top-to-bottom, then left-to-right) so what the user sees on the phone
 * mirrors the reading order of their PC dashboard. There is no add /
 * remove / resize on mobile; that's PC-only by design.
 */
function MobileCarousel({
  modules,
  layout,
  onUpdateConfig,
}: {
  modules: ModuleInstance[];
  layout: Layout[];
  onUpdateConfig: (id: string, config: Record<string, unknown>) => void;
}) {
  const ordered = useMemo(() => {
    const pos = new Map(layout.map((l) => [l.i, l]));
    const byReadingOrder = [...modules].sort((a, b) => {
      const la = pos.get(a.id);
      const lb = pos.get(b.id);
      if (!la || !lb) return 0;
      return la.y - lb.y || la.x - lb.x;
    });
    // Group modules of the same type contiguously so swiping between two
    // Gmail (or two Redmine) inboxes doesn't drop you into a different app in
    // the middle. The FIRST occurrence of each type in reading order fixes
    // that type's slot in the carousel, and later modules of that same type
    // slot in right after — everything else keeps its relative order.
    const typeOrder = new Map<string, number>();
    byReadingOrder.forEach((m) => {
      if (!typeOrder.has(m.type)) typeOrder.set(m.type, typeOrder.size);
    });
    return byReadingOrder
      .map((m, i) => ({ m, i }))
      .sort((a, b) => {
        const ta = typeOrder.get(a.m.type) ?? 0;
        const tb = typeOrder.get(b.m.type) ?? 0;
        return ta - tb || a.i - b.i;
      })
      .map((x) => x.m);
  }, [modules, layout]);

  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const [index, setIndex] = useState(0);

  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const onScroll = () => {
      const w = el.clientWidth || 1;
      setIndex(Math.round(el.scrollLeft / w));
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, []);

  if (ordered.length === 0) {
    return (
      <div className="min-h-[100dvh] flex items-center justify-center p-6 text-center text-sm text-[var(--text-muted)]">
        No modules configured. Open the app on your PC to add some.
      </div>
    );
  }

  return (
    <div className="relative h-[100dvh] w-screen overflow-hidden">
      <div
        ref={scrollerRef}
        className="h-full w-full flex overflow-x-auto overflow-y-hidden snap-x snap-mandatory"
        style={{ scrollbarWidth: "none" }}
      >
        {ordered.map((m) => (
          <div
            key={m.id}
            className="w-screen h-full shrink-0 snap-start p-2"
          >
            <Module
              module={m}
              onRemove={() => {}}
              onUpdateConfig={onUpdateConfig}
            />
          </div>
        ))}
      </div>
      <div className="pointer-events-none absolute bottom-2 left-0 right-0 flex justify-center gap-1.5">
        {ordered.map((m, i) => (
          <span
            key={m.id}
            className="w-1.5 h-1.5 rounded-full transition-opacity"
            style={{
              background: "var(--text)",
              opacity: i === index ? 0.9 : 0.25,
            }}
          />
        ))}
      </div>
    </div>
  );
}
