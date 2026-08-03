"use client";

import { useEffect, useMemo, useState } from "react";
import GridLayout, { Layout, WidthProvider } from "react-grid-layout";
import Module from "./Module";
import { ModuleInstance, ModuleType } from "@/lib/types";

const ResponsiveGrid = WidthProvider(GridLayout);

const STORAGE_KEY = "unyapper:v1";
const COLS = 12;
const ROW_HEIGHT = 60;

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

function defaultLayoutFor(id: string, existing: Layout[]): Layout {
  const maxY = existing.reduce((acc, l) => Math.max(acc, l.y + l.h), 0);
  return { i: id, x: 0, y: maxY, w: 4, h: 5, minW: 2, minH: 3 };
}

export default function Grid() {
  const [modules, setModules] = useState<ModuleInstance[]>([]);
  const [layout, setLayout] = useState<Layout[]>([]);
  const [hydrated, setHydrated] = useState(false);

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

  const addModule = (type: ModuleType) => {
    const id = makeId();
    const title = type === "gmail" ? "Inbox" : "HF feed";
    const newModule: ModuleInstance = { id, type, title, config: {} };
    setModules((prev) => [...prev, newModule]);
    setLayout((prev) => [...prev, defaultLayoutFor(id, prev)]);
  };

  const removeModule = (id: string) => {
    setModules((prev) => prev.filter((m) => m.id !== id));
    setLayout((prev) => prev.filter((l) => l.i !== id));
  };

  const renameModule = (id: string, title: string) => {
    setModules((prev) => prev.map((m) => (m.id === id ? { ...m, title } : m)));
  };

  const onLayoutChange = (next: Layout[]) => {
    setLayout(next);
  };

  const moduleMap = useMemo(() => new Map(modules.map((m) => [m.id, m])), [modules]);

  if (!hydrated) {
    return <div className="p-8 text-[var(--muted)] text-sm">Loading…</div>;
  }

  return (
    <div className="min-h-screen">
      <Toolbar onAdd={addModule} count={modules.length} />
      {modules.length === 0 ? (
        <EmptyState onAdd={addModule} />
      ) : (
        <div className="px-4 pb-8">
          <ResponsiveGrid
            className="layout"
            layout={layout}
            cols={COLS}
            rowHeight={ROW_HEIGHT}
            onLayoutChange={onLayoutChange}
            draggableHandle=".module-drag-handle"
            draggableCancel=".no-drag,input,button"
            compactType="vertical"
            margin={[12, 12]}
          >
            {layout.map((l) => {
              const m = moduleMap.get(l.i);
              if (!m) return null;
              return (
                <div key={l.i}>
                  <Module module={m} onRemove={removeModule} onRename={renameModule} />
                </div>
              );
            })}
          </ResponsiveGrid>
        </div>
      )}
    </div>
  );
}

function Toolbar({ onAdd, count }: { onAdd: (t: ModuleType) => void; count: number }) {
  return (
    <div className="sticky top-0 z-10 flex items-center justify-between px-4 py-3 border-b border-[var(--border)] bg-[var(--bg)]/80 backdrop-blur">
      <div className="flex items-center gap-3">
        <h1 className="text-sm font-semibold tracking-tight">unyapper</h1>
        <span className="text-xs text-[var(--muted)]">{count} module{count === 1 ? "" : "s"}</span>
      </div>
      <div className="flex items-center gap-2">
        <AddButton onClick={() => onAdd("gmail")} color="red">+ Gmail</AddButton>
        <AddButton onClick={() => onAdd("hf")} color="yellow">+ HuggingFace</AddButton>
      </div>
    </div>
  );
}

function AddButton({
  onClick,
  color,
  children,
}: {
  onClick: () => void;
  color: "red" | "yellow";
  children: React.ReactNode;
}) {
  const cls =
    color === "red"
      ? "border-red-500/40 text-red-400 hover:bg-red-500/10"
      : "border-yellow-500/40 text-yellow-400 hover:bg-yellow-500/10";
  return (
    <button
      onClick={onClick}
      className={`text-xs px-2.5 py-1 rounded border ${cls} transition-colors`}
    >
      {children}
    </button>
  );
}

function EmptyState({ onAdd }: { onAdd: (t: ModuleType) => void }) {
  return (
    <div className="flex flex-col items-center justify-center py-32 text-center gap-4">
      <div className="text-[var(--muted)] text-sm">Grid vacía. Agregá un módulo para arrancar.</div>
      <div className="flex gap-2">
        <AddButton onClick={() => onAdd("gmail")} color="red">+ Gmail</AddButton>
        <AddButton onClick={() => onAdd("hf")} color="yellow">+ HuggingFace</AddButton>
      </div>
    </div>
  );
}
