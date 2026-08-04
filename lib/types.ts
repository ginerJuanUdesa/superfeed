export type ModuleType = "gmail" | "hf";

export type HFKind = "model" | "dataset" | "space" | "paper";

export interface HFConfig {
  authors?: string[];
  /** Which kinds to show as NEW releases. */
  releaseKinds?: HFKind[];
  /** Which kinds to show as UPDATES to existing repos. */
  updateKinds?: HFKind[];
  /** Legacy: pre-split kinds list (used to seed release+update on migration). */
  kinds?: HFKind[];
}

export interface ModuleInstance {
  id: string;
  type: ModuleType;
  title: string;
  config: HFConfig & Record<string, unknown>;
}

export const HF_KINDS: { key: HFKind; label: string }[] = [
  { key: "model", label: "Models" },
  { key: "dataset", label: "Datasets" },
  { key: "space", label: "Spaces" },
  { key: "paper", label: "Papers" },
];

export interface GridPos {
  i: string;
  x: number;
  y: number;
  w: number;
  h: number;
  minW?: number;
  minH?: number;
}
