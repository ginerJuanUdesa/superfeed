export type ModuleType = "gmail" | "hf" | "calendar" | "github" | "redmine" | "fleet" | "media";

export interface MediaConfig {
  /** Data URL (from a picked file) or an http(s) URL. */
  src?: string;
  /** How the image fills the module. Defaults to "cover". */
  fit?: "cover" | "contain";
}

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

export interface RedmineConfig {
  /** Redmine project ids the module should surface. Opt-in — empty means
   *  "nothing selected yet, prompt the user via the menu". */
  projectIds?: number[];
}

export interface GithubConfig {
  /** Show the received-events activity feed. Defaults to true. */
  showFeed?: boolean;
  /** Show the user's own open pull requests (across all repos). Defaults to false.
   *  When both are on, PRs render first, then the feed. */
  showPRs?: boolean;
}

export interface GmailConfig {
  /** Accounts the user explicitly UNCHECKED in the module. Any configured
   *  account NOT in this list is included. This way freshly-dropped modules
   *  default to all boxes ticked, and adding a new account in Settings
   *  auto-includes it in every existing module. */
  excludedAccountLabels?: string[];
  /** Legacy: previously stored the OPT-IN list. Migrated to excludedAccountLabels at read time. */
  accountLabels?: string[];
}

export interface ModuleInstance {
  id: string;
  type: ModuleType;
  title: string;
  config: HFConfig & GmailConfig & GithubConfig & Record<string, unknown>;
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
