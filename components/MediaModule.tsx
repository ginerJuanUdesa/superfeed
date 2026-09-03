"use client";

import { useEffect, useRef, useState } from "react";
import { ModuleInstance, MediaConfig } from "@/lib/types";
import { useIsDark } from "@/lib/useIsDark";

interface Props {
  module: ModuleInstance;
  onRemove: (id: string) => void;
  onUpdateConfig: (id: string, config: Record<string, unknown>) => void;
}

/* The whole panel is the media — no header, no chrome. Hover reveals the
 * burger (change/fit) and the × in the top-right, matching the other
 * modules. Files chosen from disk are inlined as data URLs so they survive
 * across sessions without a separate upload endpoint; pasted URLs are used
 * verbatim. */
export default function MediaModule({ module, onRemove, onUpdateConfig }: Props) {
  const cfg = module.config as MediaConfig;
  const src = cfg.src;
  const fit = cfg.fit ?? "cover";
  const isDark = useIsDark();

  const bg = isDark ? "#0d1117" : "#ffffff";
  const border = isDark ? "#30363d" : "#d0d7de";
  const textMuted = isDark ? "#8b949e" : "#59636e";

  const setSrc = (next: string | undefined) => {
    onUpdateConfig(module.id, { ...cfg, src: next });
  };
  const setFit = (next: "cover" | "contain") => {
    onUpdateConfig(module.id, { ...cfg, fit: next });
  };

  return (
    <div
      className="panel group h-full w-full cursor-move relative overflow-hidden"
      style={{ background: bg, border: `1px solid ${border}` }}
    >
      {src ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={src}
          alt=""
          draggable={false}
          className="w-full h-full pointer-events-none select-none"
          style={{ objectFit: fit }}
        />
      ) : (
        <EmptyState onPick={setSrc} textMuted={textMuted} border={border} />
      )}

      <div className="absolute top-1 right-1 opacity-0 group-hover:opacity-100 transition-opacity z-10 flex items-center gap-1">
        <BurgerMenu
          hasMedia={!!src}
          fit={fit}
          onFit={setFit}
          onReplace={setSrc}
          onClear={() => setSrc(undefined)}
        />
        <button
          onClick={(e) => {
            e.stopPropagation();
            onRemove(module.id);
          }}
          onMouseDown={(e) => e.stopPropagation()}
          className="no-drag w-7 h-7 flex items-center justify-center rounded-md text-lg leading-none"
          style={{ color: "#ffffff", background: "rgba(0,0,0,0.35)" }}
          title="Remove module"
        >
          ×
        </button>
      </div>
    </div>
  );
}

function EmptyState({
  onPick,
  textMuted,
  border,
}: {
  onPick: (src: string) => void;
  textMuted: string;
  border: string;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [url, setUrl] = useState("");

  const onFile = (f: File | undefined) => {
    if (!f) return;
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result;
      if (typeof result === "string") onPick(result);
    };
    reader.readAsDataURL(f);
  };

  return (
    <div
      className="no-drag w-full h-full flex flex-col items-center justify-center gap-3 p-6 text-center"
      style={{ color: textMuted, border: `1px dashed ${border}`, margin: 0 }}
      onMouseDown={(e) => e.stopPropagation()}
      onDragOver={(e) => {
        e.preventDefault();
        e.stopPropagation();
      }}
      onDrop={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onFile(e.dataTransfer.files?.[0]);
      }}
    >
      <div className="text-sm">Drop an image or GIF here</div>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          fileRef.current?.click();
        }}
        onMouseDown={(e) => e.stopPropagation()}
        className="btn btn-ghost h-8 text-xs"
      >
        Choose file…
      </button>
      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        hidden
        onChange={(e) => onFile(e.target.files?.[0])}
      />
      <div className="flex items-center gap-2 w-full max-w-[280px]">
        <input
          type="url"
          placeholder="…or paste a URL"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          onClick={(e) => e.stopPropagation()}
          onMouseDown={(e) => e.stopPropagation()}
          onKeyDown={(e) => {
            if (e.key === "Enter" && url.trim()) onPick(url.trim());
          }}
          className="flex-1 h-8 px-2 rounded-md text-xs"
          style={{ background: "transparent", border: `1px solid ${border}`, color: "inherit" }}
        />
      </div>
    </div>
  );
}

function BurgerMenu({
  hasMedia,
  fit,
  onFit,
  onReplace,
  onClear,
}: {
  hasMedia: boolean;
  fit: "cover" | "contain";
  onFit: (f: "cover" | "contain") => void;
  onReplace: (src: string) => void;
  onClear: () => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const isDark = useIsDark();
  const bg = isDark ? "#161b22" : "#ffffff";
  const border = isDark ? "#30363d" : "#d0d7de";
  const text = isDark ? "#e6edf3" : "#1f2328";
  const textFaint = isDark ? "#6e7681" : "#818b98";

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("mousedown", onClick);
    return () => window.removeEventListener("mousedown", onClick);
  }, [open]);

  const onFile = (f: File | undefined) => {
    if (!f) return;
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result;
      if (typeof result === "string") {
        onReplace(result);
        setOpen(false);
      }
    };
    reader.readAsDataURL(f);
  };

  return (
    <div ref={ref} className="relative no-drag">
      <button
        onClick={(e) => {
          e.stopPropagation();
          setOpen((o) => !o);
        }}
        onMouseDown={(e) => e.stopPropagation()}
        className="w-7 h-7 rounded-md flex flex-col items-center justify-center gap-[3px]"
        style={{ color: "#ffffff", background: "rgba(0,0,0,0.35)" }}
        title="Media options"
      >
        <span className="w-3.5 h-[1.5px] bg-current rounded" />
        <span className="w-3.5 h-[1.5px] bg-current rounded" />
        <span className="w-3.5 h-[1.5px] bg-current rounded" />
      </button>
      {open && (
        <div
          className="absolute top-9 right-0 min-w-[170px] py-1.5 z-20"
          onMouseDown={(e) => e.stopPropagation()}
          onClick={(e) => e.stopPropagation()}
          style={{
            background: bg,
            border: `1px solid ${border}`,
            borderRadius: "var(--radius)",
            boxShadow: "0 24px 48px -20px rgba(0,0,0,0.35)",
            color: text,
          }}
        >
          <div className="px-3 pt-1.5 pb-1 text-[11px] font-medium" style={{ color: textFaint }}>
            Fit
          </div>
          {(["cover", "contain"] as const).map((f) => (
            <label
              key={f}
              className="flex items-center gap-2.5 px-3 py-1.5 text-xs cursor-pointer"
            >
              <input
                type="radio"
                checked={fit === f}
                onChange={() => onFit(f)}
              />
              {f === "cover" ? "Cover (fill, crop)" : "Contain (fit whole)"}
            </label>
          ))}
          <div className="my-1 h-px" style={{ background: border }} />
          <button
            className="w-full text-left px-3 py-1.5 text-xs"
            onClick={() => fileRef.current?.click()}
          >
            Replace…
          </button>
          {hasMedia && (
            <button
              className="w-full text-left px-3 py-1.5 text-xs"
              style={{ color: "#cf222e" }}
              onClick={() => {
                onClear();
                setOpen(false);
              }}
            >
              Clear
            </button>
          )}
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            hidden
            onChange={(e) => onFile(e.target.files?.[0])}
          />
        </div>
      )}
    </div>
  );
}
