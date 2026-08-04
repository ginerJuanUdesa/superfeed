"use client";

import { ModuleInstance } from "@/lib/types";
import HFModule from "./HFModule";

interface Props {
  module: ModuleInstance;
  onRemove: (id: string) => void;
  onUpdateConfig: (id: string, config: Record<string, unknown>) => void;
}

function GmailWatermark() {
  // eslint-disable-next-line @next/next/no-img-element
  return (
    <img
      src="/logos/gmail.png"
      alt=""
      className="w-1/2 max-w-[220px] h-auto drop-shadow-[0_6px_18px_rgba(234,67,53,0.35)] pointer-events-none"
      draggable={false}
    />
  );
}

export default function Module({ module, onRemove, onUpdateConfig }: Props) {
  if (module.type === "hf") {
    return <HFModule module={module} onRemove={onRemove} onUpdateConfig={onUpdateConfig} />;
  }
  // Gmail placeholder — not implemented yet
  return (
    <div className="group relative h-full w-full rounded-2xl overflow-hidden cursor-move">
      <div className="absolute inset-0 bg-gradient-to-br from-red-400/25 via-transparent to-blue-400/20 pointer-events-none" />
      <div className="absolute inset-0 bg-white/85 backdrop-blur-md" />
      <div className="absolute inset-0 rounded-2xl ring-1 ring-white/30 pointer-events-none" />
      <div className="absolute inset-0 rounded-2xl shadow-[inset_0_1px_0_rgba(255,255,255,0.5),0_10px_30px_-10px_rgba(0,0,0,0.4)] pointer-events-none" />
      <div className="relative h-full w-full flex items-center justify-center">
        <GmailWatermark />
      </div>
      <button
        onClick={(e) => {
          e.stopPropagation();
          onRemove(module.id);
        }}
        onMouseDown={(e) => e.stopPropagation()}
        className="no-drag absolute top-2 right-2 w-6 h-6 rounded-full bg-white/60 backdrop-blur text-neutral-500 hover:text-red-500 hover:bg-white opacity-0 group-hover:opacity-100 transition-all flex items-center justify-center text-base leading-none shadow-sm"
        title="Remove"
      >
        ×
      </button>
    </div>
  );
}
