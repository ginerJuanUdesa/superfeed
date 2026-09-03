"use client";

import { useEffect, useRef, useState } from "react";
import { useIsDark } from "@/lib/useIsDark";
import type { ModuleDescriptor, ModuleProps } from "./types";

interface MediaConfig {
  /** Data URL (from a picked file) or an http(s) URL. */
  src?: string;
  /** How the image fills the module. Defaults to "contain". */
  fit?: "cover" | "contain";
}

/* The whole panel is the media, no header, no chrome. Hover reveals the
 * burger (change/fit) and the × in the top-right, matching the other modules.
 * Files chosen from disk (images or GIFs) are uploaded to the server and stored
 * under .local/uploads (a host-mounted volume, so they survive redeploys); the
 * config only keeps the small /api/media/file/<id> URL. Pasted URLs are used
 * verbatim. Default fit is "contain" so the whole image shows and adapts to the
 * panel regardless of its dimensions. */

/** Upload a picked file to the server, returning its served URL. Throws with a
 *  human-readable message the caller can surface. */
async function uploadMedia(file: File): Promise<string> {
  const body = new FormData();
  body.append("file", file);
  const res = await fetch("/api/media/upload", { method: "POST", body });
  if (!res.ok) {
    let msg = `upload failed (${res.status})`;
    try {
      const j = (await res.json()) as { error?: string };
      if (j.error) msg = j.error;
    } catch {
      /* keep the status message */
    }
    throw new Error(msg);
  }
  const j = (await res.json()) as { url: string };
  return j.url;
}

export default function MediaModule({ module, onRemove, onUpdateConfig }: ModuleProps) {
  const cfg = module.config as MediaConfig;
  const src = cfg.src;
  const fit = cfg.fit ?? "contain";
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
  const [busy, setBusy] = useState(false);

  const onFile = async (f: File | undefined) => {
    if (!f || busy) return;
    setBusy(true);
    try {
      onPick(await uploadMedia(f));
    } catch (err) {
      alert(err instanceof Error ? err.message : "upload failed");
    } finally {
      setBusy(false);
    }
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
      <div className="text-sm">{busy ? "Uploading…" : "Drop an image or GIF here"}</div>
      <button
        type="button"
        disabled={busy}
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

  const onFile = async (f: File | undefined) => {
    if (!f) return;
    try {
      onReplace(await uploadMedia(f));
      setOpen(false);
    } catch (err) {
      alert(err instanceof Error ? err.message : "upload failed");
    }
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

/** Inline "picture frame" glyph for the Media rail tile — no external asset. */
function MediaRailIcon() {
  return (
    <svg width={24} height={24} viewBox="0 0 24 24" className="pointer-events-none" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinejoin="round">
      <rect x="3.5" y="4.5" width="17" height="15" rx="1.6" />
      <circle cx="8.5" cy="9.5" r="1.4" fill="currentColor" stroke="none" />
      <path d="M4 17l4.5-5 3.5 3.5L15 12l5 5" strokeLinecap="round" />
    </svg>
  );
}

export const mediaModule: ModuleDescriptor = {
  type: "media",
  label: "Media (image / GIF)",
  defaultTitle: "Media",
  RailIcon: MediaRailIcon,
  Component: MediaModule,
  mobileHidden: true,
};
