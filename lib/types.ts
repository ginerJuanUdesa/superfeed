/** A module's key in the registry (see modules/registry.ts). */
export type ModuleType = string;

export type HFKind = "model" | "dataset" | "space" | "paper";

export const HF_KINDS: { key: HFKind; label: string }[] = [
  { key: "model", label: "Models" },
  { key: "dataset", label: "Datasets" },
  { key: "space", label: "Spaces" },
  { key: "paper", label: "Papers" },
];

/** A live module on the dashboard. `config` is module-defined free-form JSON. */
export interface ModuleInstance {
  id: string;
  type: ModuleType;
  title: string;
  config: Record<string, unknown>;
}

export interface GridPos {
  i: string;
  x: number;
  y: number;
  w: number;
  h: number;
  minW?: number;
  minH?: number;
}
