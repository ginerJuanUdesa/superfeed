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
import { computeInsertion, type GridConfig } from "@/lib/gridPlacement";
import { useIsMobile } from "@/lib/useIsMobile";

const ResponsiveGrid = WidthProvider(GridLayout);

const COLS = 12;
const MARGIN = 12;
const ROW_HEIGHT = 60;
const DEFAULT_W = 4;
const DEFAULT_H = 5;
const MIN_W = 2;
const MIN_H = 3;

const GRID_CFG: GridConfig = {
  cols: COLS,
  minW: MIN_W,
  minH: MIN_H,
  defaultW: DEFAULT_W,
  defaultH: DEFAULT_H,
};

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
  const pendingTypeRef = useRef<ModuleType | null>(null);
  // The id reserved for the module being dragged in from the rail. It lives in
  // `layout` as a ghost while hovering, then becomes the real instance on drop.
  const pendingIdRef = useRef<string | null>(null);
  // Snapshot of the layout when the rail drag started. Every drag-over recomputes
  // the candidate from THIS, so neighbors return to normal the moment the cursor
  // moves to a spot that fits — and a cancelled drag restores it exactly.
  const originalLayoutRef = useRef<Layout[] | null>(null);
  // True while a live drop-preview is on screen. Suppresses layout persistence
  // and RGL's own onLayoutChange so the preview never leaks to disk or fights us.
  const previewActiveRef = useRef(false);
  // Last hovered grid cell, so we only recompute when it actually changes.
  const lastCellRef = useRef<string | null>(null);
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
    // Never persist a transient drop-preview — only committed layouts.
    if (previewActiveRef.current) return;
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
    // While a drop is being previewed we are the authority on the layout — RGL's
    // own reconciliation must not overwrite the candidate we computed.
    if (previewActiveRef.current) return;
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

  // Restore the pre-drag layout and clear all drag bookkeeping.
  const cancelDrag = () => {
    if (originalLayoutRef.current) setLayout(originalLayoutRef.current);
    previewActiveRef.current = false;
    pendingTypeRef.current = null;
    pendingIdRef.current = null;
    originalLayoutRef.current = null;
    lastCellRef.current = null;
  };

  // Begin a rail drag: reserve an id and snapshot the layout so the preview can
  // be recomputed from a stable base and fully reverted if the drag is aborted.
  const beginRailDrag = (t: ModuleType) => {
    pendingTypeRef.current = t;
    pendingIdRef.current = makeId();
    originalLayoutRef.current = layout;
    previewActiveRef.current = false;
    lastCellRef.current = null;
    // A drag that ends anywhere other than the dropzone (released outside, or
    // cancelled with Esc) fires `dragend` on the source tile but no drop — undo.
    const onEnd = () => {
      window.removeEventListener("dragend", onEnd);
      if (pendingTypeRef.current) cancelDrag();
    };
    window.addEventListener("dragend", onEnd);
  };

  const onDragOverDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    const id = pendingIdRef.current;
    const base = originalLayoutRef.current;
    if (!pendingTypeRef.current || !id || !base) return;
    const { wantX, wantY } = wantCoordsFromEvent(e);
    const cellKey = `${wantX},${wantY}`;
    if (lastCellRef.current === cellKey) return;
    lastCellRef.current = cellKey;
    const ins = computeInsertion(base, wantX, wantY, GRID_CFG);
    const ghost: Layout = { i: id, ...ins.item, minW: MIN_W, minH: MIN_H };
    previewActiveRef.current = true;
    setLayout([...ins.layout, ghost]);
  };

  const onDragLeaveDrop = (e: React.DragEvent<HTMLDivElement>) => {
    // Only react when the drag leaves the container itself, not when it crosses
    // into a child element. The drag is still live, so keep the snapshot/id —
    // just fold the preview back to normal until the cursor returns.
    if (dropzoneRef.current && e.relatedTarget instanceof Node) {
      if (dropzoneRef.current.contains(e.relatedTarget)) return;
    }
    if (originalLayoutRef.current) setLayout(originalLayoutRef.current);
    previewActiveRef.current = false;
    lastCellRef.current = null;
  };

  const onNativeDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    const type = pendingTypeRef.current;
    const id = pendingIdRef.current;
    const base = originalLayoutRef.current;
    const descriptor = type ? getModule(type) : undefined;
    if (!type || !id || !base || !descriptor) {
      cancelDrag();
      return;
    }
    const { wantX, wantY } = wantCoordsFromEvent(e);
    const ins = computeInsertion(base, wantX, wantY, GRID_CFG);
    const title = descriptor.defaultTitle;
    const config = descriptor.defaultConfig?.() ?? {};
    const placed: Layout = { i: id, ...ins.item, minW: MIN_W, minH: MIN_H };
    // Clear preview bookkeeping BEFORE committing so the save effect fires.
    previewActiveRef.current = false;
    pendingTypeRef.current = null;
    pendingIdRef.current = null;
    originalLayoutRef.current = null;
    lastCellRef.current = null;
    setModules((prev) => [...prev, { id, type, title, config }]);
    setLayout([...ins.layout, placed]);
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
        onDragStart={beginRailDrag}
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
              if (!m) {
                // A layout cell with no backing module instance only exists while
                // a module is being dragged in from the rail — render it as a
                // ghost so the live-adapting slot is visible.
                return (
                  <div key={l.i}>
                    <DropGhost />
                  </div>
                );
              }
              return (
                <div key={l.i}>
                  <Module module={m} onRemove={removeModule} onUpdateConfig={updateConfig} />
                </div>
              );
            })}
          </ResponsiveGrid>
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

/** Fills the reserved grid cell while a module is dragged in from the rail. It
 *  rides RGL's own item positioning, so it animates in step with the neighbors
 *  that shift and resize around it. */
function DropGhost() {
  return (
    <div
      className="pointer-events-none w-full h-full"
      style={{
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
