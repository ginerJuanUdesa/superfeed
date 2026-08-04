"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import GridLayout, { Layout, WidthProvider } from "react-grid-layout";
import Module from "./Module";
import SettingsModal from "./SettingsModal";
import { HFKind, ModuleInstance, ModuleType } from "@/lib/types";

const ResponsiveGrid = WidthProvider(GridLayout);

const STORAGE_KEY = "unyapper:v1";
const COLS = 12;
const MARGIN = 12;
const ROW_HEIGHT = 60;
const DEFAULT_W = 4;
const DEFAULT_H = 5;

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
  const pendingTypeRef = useRef<ModuleType | null>(null);
  const movedRef = useRef(false);

  useEffect(() => {
    const s = loadState();
    setModules(s.modules);
    setLayout(s.layout);
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

  const onNativeDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    const type = pendingTypeRef.current;
    if (!type) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const relX = e.clientX - rect.left;
    const relY = e.clientY - rect.top;
    const colW = (rect.width - MARGIN * (COLS - 1)) / COLS;
    const x = Math.max(
      0,
      Math.min(COLS - DEFAULT_W, Math.floor(relX / (colW + MARGIN)))
    );
    const y = Math.max(0, Math.floor(relY / (ROW_HEIGHT + MARGIN)));
    const id = makeId();
    const title = type === "gmail" ? "Inbox" : "HF Feed";
    const allKinds = ["model", "dataset", "space", "paper"] as HFKind[];
    const config =
      type === "hf"
        ? { releaseKinds: allKinds, updateKinds: allKinds }
        : {};
    setModules((prev) => [...prev, { id, type, title, config }]);
    setLayout((prev) => [
      ...prev,
      { i: id, x, y, w: DEFAULT_W, h: DEFAULT_H, minW: 2, minH: 3 },
    ]);
    pendingTypeRef.current = null;
  };

  const moduleMap = useMemo(() => new Map(modules.map((m) => [m.id, m])), [modules]);

  if (!hydrated) {
    return <div className="p-8 text-[var(--muted)] text-sm">Loading…</div>;
  }

  return (
    <div className="min-h-screen">
      <Toolbar
        onDragStart={(t) => (pendingTypeRef.current = t)}
        onOpenSettings={() => setSettingsOpen(true)}
      />
      <SettingsModal open={settingsOpen} onClose={() => setSettingsOpen(false)} />
      <div
        className="p-4 sm:p-6 relative min-h-screen"
        onDragOver={(e) => e.preventDefault()}
        onDrop={onNativeDrop}
      >
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
          preventCollision={false}
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
    <div className="toolbar-peek fixed right-0 top-0 bottom-0 w-8 z-50 group">
      <div className="absolute right-0 top-0 bottom-0 flex flex-col items-center gap-6 pt-8 px-4 border-l border-white/8 bg-black/35 backdrop-blur-xl translate-x-full group-hover:translate-x-0 hover:translate-x-0 transition-transform duration-200 ease-out">
        <SettingsButton onClick={onOpenSettings} />
        <DraggableLogo type="gmail" onDragStart={onDragStart} />
        <DraggableLogo type="hf" onDragStart={onDragStart} />
      </div>
    </div>
  );
}

function SettingsButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      title="Settings"
      className="text-white/50 hover:text-white transition-colors hover:scale-110 duration-150 cursor-pointer"
    >
      <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <circle cx="12" cy="12" r="3" />
        <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
      </svg>
    </button>
  );
}

function DraggableLogo({
  type,
  onDragStart,
}: {
  type: ModuleType;
  onDragStart: (t: ModuleType) => void;
}) {
  const label = type === "gmail" ? "Gmail" : "HuggingFace";
  return (
    <div
      className="cursor-grab active:cursor-grabbing select-none hover:scale-110 transition-transform"
      draggable
      unselectable="on"
      onDragStart={(e) => {
        onDragStart(type);
        e.dataTransfer.setData("text/plain", "");
      }}
      title={`Drag to add a ${label} module`}
    >
      {type === "gmail" ? <GmailLogo /> : <HFLogo />}
    </div>
  );
}

function GmailLogo() {
  // eslint-disable-next-line @next/next/no-img-element
  return <img src="/logos/gmail.png" alt="Gmail" width={44} height={36} className="pointer-events-none" draggable={false} />;
}

function HFLogo() {
  // eslint-disable-next-line @next/next/no-img-element
  return <img src="/logos/hf.png" alt="HuggingFace" width={58} height={58} className="pointer-events-none -my-2" draggable={false} />;
}

function EmptyHint() {
  return (
    <div className="absolute inset-0 flex items-center justify-center pointer-events-none px-4">
      <div className="flex flex-col items-center gap-4 text-center float-hint">
        <div className="w-12 h-12 rounded-2xl border border-white/15 bg-white/5 backdrop-blur-md flex items-center justify-center">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="text-white/70" aria-hidden>
            <rect x="3" y="3" width="7" height="7" rx="1.5" />
            <rect x="14" y="3" width="7" height="7" rx="1.5" />
            <rect x="3" y="14" width="7" height="7" rx="1.5" />
            <rect x="14" y="14" width="7" height="7" rx="1.5" />
          </svg>
        </div>
        <div className="space-y-1">
          <div className="text-white/85 text-sm font-medium">Empty grid</div>
          <div className="text-white/45 text-xs">
            Hover the right edge <span className="pulse-glow text-[var(--accent)]">→</span> and drag a logo onto the grid
          </div>
        </div>
      </div>
    </div>
  );
}
