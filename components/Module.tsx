"use client";

import { ModuleInstance } from "@/lib/types";

interface Props {
  module: ModuleInstance;
  onRemove: (id: string) => void;
  onRename: (id: string, title: string) => void;
}

const TYPE_BADGE: Record<string, { label: string; color: string }> = {
  gmail: { label: "Gmail", color: "bg-red-500/15 text-red-400 border-red-500/30" },
  hf: { label: "HuggingFace", color: "bg-yellow-500/15 text-yellow-400 border-yellow-500/30" },
};

export default function Module({ module, onRemove, onRename }: Props) {
  const badge = TYPE_BADGE[module.type];

  return (
    <div className="flex flex-col h-full w-full rounded-lg border border-[var(--border)] bg-[var(--panel)] overflow-hidden">
      <div className="module-drag-handle flex items-center justify-between px-3 py-2 border-b border-[var(--border)] bg-[var(--panel-hover)] select-none">
        <div className="flex items-center gap-2 min-w-0">
          <span className={`text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded border ${badge.color}`}>
            {badge.label}
          </span>
          <input
            className="bg-transparent outline-none text-sm font-medium truncate min-w-0 focus:bg-[var(--bg)] rounded px-1"
            value={module.title}
            onChange={(e) => onRename(module.id, e.target.value)}
            onMouseDown={(e) => e.stopPropagation()}
            onTouchStart={(e) => e.stopPropagation()}
          />
        </div>
        <button
          onClick={() => onRemove(module.id)}
          onMouseDown={(e) => e.stopPropagation()}
          className="text-[var(--muted)] hover:text-red-400 text-lg leading-none px-2 no-drag"
          title="Remove"
        >
          ×
        </button>
      </div>
      <div className="flex-1 overflow-auto p-3 text-sm text-[var(--muted)]">
        <div className="flex items-center justify-center h-full text-xs">
          Módulo {badge.label} — sin conectar todavía
        </div>
      </div>
    </div>
  );
}
