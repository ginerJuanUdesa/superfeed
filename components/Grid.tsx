"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import GridLayout, { Layout, WidthProvider } from "react-grid-layout";
import { GearSix, SquaresFour } from "@phosphor-icons/react";
import Module from "./Module";
import SettingsModal, { applyThemeMode, loadSettings } from "./SettingsModal";
import { HFKind, ModuleInstance, ModuleType } from "@/lib/types";

const ResponsiveGrid = WidthProvider(GridLayout);

const STORAGE_KEY = "unyapper:v1";
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
  if (typeof window === "undefined") return { modules: [], layout: [] };
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { modules: [], layout: [] };
    return JSON.parse(raw);
  } catch {
    return { modules: [], layout: [] };
  }
}

function saveState(state: PersistedState) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
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
    const s = loadState();
    setModules(s.modules);
    setLayout(s.layout);
    // Apply the persisted theme choice on first paint so the shell doesn't
    // flash the default dark palette when the user has picked light or system.
    applyThemeMode(loadSettings().themeMode);
    setHydrated(true);
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    saveState({ modules, layout });
  }, [modules, layout, hydrated]);

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
  };
  const onDrag = () => {
    movedRef.current = true;
  };
  const onDragStop = () => {
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
    const id = makeId();
    const title =
      type === "gmail"
        ? "Inbox"
        : type === "calendar"
        ? "Upcoming"
        : type === "github"
        ? "Feed"
        : "HF Feed";
    const allKinds = ["model", "dataset", "space", "paper"] as HFKind[];
    // Both module types default to "everything included": HF gets all four
    // kinds ticked in both columns; Gmail relies on excludedAccountLabels
    // being absent to auto-tick every currently- and future-configured
    // account.
    const config =
      type === "hf"
        ? { releaseKinds: allKinds, updateKinds: allKinds }
        : {};
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

  if (!hydrated) {
    return (
      <div className="p-8 text-[var(--text-faint)] text-sm mono">
        loading
      </div>
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
      <DraggableTile type="hf" onDragStart={onDragStart} />
      <DraggableTile type="gmail" onDragStart={onDragStart} />
      <DraggableTile type="calendar" onDragStart={onDragStart} />
      <DraggableTile type="github" onDragStart={onDragStart} />
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
  type,
  onDragStart,
}: {
  type: ModuleType;
  onDragStart: (t: ModuleType) => void;
}) {
  const label =
    type === "gmail"
      ? "Gmail inbox"
      : type === "calendar"
      ? "Google Calendar"
      : type === "github"
      ? "GitHub feed"
      : "HuggingFace feed";
  return (
    <div
      className="rail-item w-10 h-10 flex items-center justify-center cursor-grab active:cursor-grabbing select-none"
      draggable
      unselectable="on"
      onDragStart={(e) => {
        onDragStart(type);
        e.dataTransfer.setData("text/plain", "");
      }}
      title={`Drag to add a ${label} module`}
    >
      {type === "gmail" ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src="/logos/gmail.png" alt="Gmail" width={24} height={20} className="pointer-events-none" draggable={false} />
      ) : type === "calendar" ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src="/logos/calendar.png" alt="Google Calendar" width={24} height={24} className="pointer-events-none" draggable={false} />
      ) : type === "github" ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src="/logos/github.png" alt="GitHub" width={24} height={24} className="pointer-events-none" style={{ filter: "invert(1)" }} draggable={false} />
      ) : (
        // eslint-disable-next-line @next/next/no-img-element
        <img src="/logos/hf.png" alt="HuggingFace" width={28} height={28} className="pointer-events-none" draggable={false} />
      )}
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
