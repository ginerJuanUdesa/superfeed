# Writing a module

A module is a self-contained panel that shows up on the drag rail.
Adding one takes a single file and a single line in the registry — no changes to the grid, the dispatcher, or the mobile view.

## The contract

Every module exports a `ModuleDescriptor` (see [`modules/types.ts`](../modules/types.ts)):

```ts
export interface ModuleDescriptor {
  type: string;                 // unique, stable key — persisted in saved boards, never rename
  label: string;                // rail tooltip
  defaultTitle: string;         // title seeded onto a freshly dropped instance
  defaultConfig?: () => Record<string, unknown>;
  RailIcon: ComponentType;      // 24×24 glyph for the rail tile
  Component: ComponentType<ModuleProps>;
  mobileHidden?: boolean;       // opt out of the phone carousel
}
```

The panel receives `ModuleProps`:

```ts
interface ModuleProps {
  module: ModuleInstance;                                       // { id, type, title, config }
  onRemove: (id: string) => void;
  onUpdateConfig: (id: string, config: Record<string, unknown>) => void;
}
```

`module.config` is free-form JSON owned entirely by your module.
Read it, and persist changes by calling `onUpdateConfig(module.id, nextConfig)` — the grid saves it server-side for you.

## Minimal example

Create `modules/ClockModule.tsx`:

```tsx
"use client";

import { useEffect, useState } from "react";
import type { ModuleDescriptor, ModuleProps } from "./types";

function ClockModule({ module, onRemove }: ModuleProps) {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);

  return (
    <div className="panel group h-full w-full cursor-move flex items-center justify-center">
      <span className="mono text-2xl">{now.toLocaleTimeString()}</span>
      <button
        onClick={(e) => { e.stopPropagation(); onRemove(module.id); }}
        onMouseDown={(e) => e.stopPropagation()}
        className="no-drag absolute top-1 right-1 opacity-0 group-hover:opacity-100 w-7 h-7"
        title="Remove module"
      >
        ×
      </button>
    </div>
  );
}

function ClockRailIcon() {
  return <span className="text-lg">🕒</span>;
}

export const clockModule: ModuleDescriptor = {
  type: "clock",
  label: "Clock",
  defaultTitle: "Clock",
  RailIcon: ClockRailIcon,
  Component: ClockModule,
};
```

Then register it in [`modules/registry.ts`](../modules/registry.ts):

```ts
import { clockModule } from "./ClockModule";

export const MODULES: ModuleDescriptor[] = [
  // ...existing modules
  clockModule,
];
```

That is the whole wiring.
The tile appears on the rail in registry order, drag-to-add works, and the instance persists.

## Conventions worth matching

- **Panel shell.** Wrap the panel in `className="panel group h-full w-full cursor-move flex flex-col"` and put hover actions (a config menu, the `×`) in an `absolute top-1 right-1 opacity-0 group-hover:opacity-100` cluster. Mark anything clickable inside with `no-drag` and `stopPropagation` so a click doesn't start a grid drag.
- **Theme.** Read the active theme with `useIsDark()` from `@/lib/useIsDark` and keep a light and dark palette. The existing modules deliberately quote each source product's own colors.
- **Refresh.** For polling feeds use `useAutoRefresh(load, { intervalMs })` from `@/lib/useAutoRefresh` — it backs off on error and refreshes on focus/visibility/online.
- **Settings.** Shared user config (tokens, accounts, LLM URL) lives in `@/lib/settings` via `loadSettings()`. Add module-specific fields to the Settings modal only if they are genuinely cross-cutting.

## Server side (optional)

If your module needs a backend, add a route under `app/api/<your-module>/route.ts` and keep its data types and fetch logic in `lib/<your-module>.ts`, mirroring the built-in modules.
The panel then talks to it with a plain `fetch("/api/<your-module>/…")`.
Secrets stay in `.env.local` on the host and are read only in the route, never shipped to the client.
