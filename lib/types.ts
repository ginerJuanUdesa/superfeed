export type ModuleType = "gmail" | "hf";

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
