import type { ComponentType } from "react";
import type { ModuleInstance } from "@/lib/types";

/** Props every module panel receives from the grid. */
export interface ModuleProps {
  module: ModuleInstance;
  onRemove: (id: string) => void;
  onUpdateConfig: (id: string, config: Record<string, unknown>) => void;
}

/**
 * A module plugs into the dashboard through one of these. Register it in
 * `modules/registry.tsx` and it shows up on the drag rail automatically.
 * See MODULES.md for the full authoring guide.
 */
export interface ModuleDescriptor {
  /** Unique, stable key. Persisted in saved dashboards — never rename it. */
  type: string;
  /** Human name shown in the rail tooltip. */
  label: string;
  /** Title seeded onto a freshly dropped instance. */
  defaultTitle: string;
  /** Config a freshly dropped instance starts with. */
  defaultConfig?: () => Record<string, unknown>;
  /** Glyph rendered on the drag rail (24×24 area). */
  RailIcon: ComponentType;
  /** The panel component. */
  Component: ComponentType<ModuleProps>;
  /** Hide from the mobile carousel (for decorative panels like Media). */
  mobileHidden?: boolean;
}
