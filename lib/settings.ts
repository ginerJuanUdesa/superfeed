import { getCachedSettings } from "./clientState";
import type { FleetEndpoint, FleetServer } from "./fleet";

export interface GmailAccount {
  label: string;
  refreshToken: string;
  clientId: string;
  clientSecret: string;
}

export type ThemeMode = "system" | "light" | "dark";

export interface Settings {
  startDate: string;
  themeMode: ThemeMode;
  gmailAccounts: GmailAccount[];
  /** Legacy: pre-per-account shared OAuth client. Backfilled into accounts. */
  gmailClientId?: string;
  gmailClientSecret?: string;
  /** Legacy: single-account refresh token. Migrated to gmailAccounts[0]. */
  gmailRefreshToken?: string;
  hfUsername: string;
  hfToken: string;
  githubUsername: string;
  githubToken: string;
  anthropicApiKey: string;
  localLlmUrl: string;
  localLlmModel: string;
  fleetEndpoints: FleetEndpoint[];
  fleetServers: FleetServer[];
}

export const EMPTY_SETTINGS: Settings = {
  startDate: "",
  themeMode: "system",
  gmailAccounts: [],
  hfUsername: "",
  hfToken: "",
  githubUsername: "",
  githubToken: "",
  anthropicApiKey: "",
  localLlmUrl: "",
  localLlmModel: "",
  fleetEndpoints: [],
  fleetServers: [],
};

/**
 * Normalize a partial/legacy settings blob into a full Settings shape:
 * fold the legacy shared OAuth client and single refresh token into the
 * per-account array, and default the collection fields. Used both when
 * reading from the cache and when importing a backup file.
 */
export function migrateSettings(raw: Partial<Settings>): Settings {
  const parsed = { ...EMPTY_SETTINGS, ...raw };
  const sharedId = parsed.gmailClientId ?? "";
  const sharedSecret = parsed.gmailClientSecret ?? "";
  if (!parsed.gmailAccounts?.length && parsed.gmailRefreshToken) {
    parsed.gmailAccounts = [
      { label: "primary", refreshToken: parsed.gmailRefreshToken, clientId: sharedId, clientSecret: sharedSecret },
    ];
  }
  parsed.gmailAccounts = (parsed.gmailAccounts ?? []).map((a) => ({
    label: a.label ?? "",
    refreshToken: a.refreshToken ?? "",
    clientId: a.clientId || sharedId || "",
    clientSecret: a.clientSecret || sharedSecret || "",
  }));
  parsed.themeMode ??= "system";
  parsed.fleetEndpoints ??= [];
  parsed.fleetServers ??= [];
  return parsed;
}

/**
 * Read the current settings from the in-memory cache. The cache is populated
 * once at app boot via `hydrate()` — before that, callers get EMPTY_SETTINGS.
 */
export function loadSettings(): Settings {
  const raw = getCachedSettings<Partial<Settings> | null>();
  return raw ? migrateSettings(raw) : EMPTY_SETTINGS;
}

/**
 * Reflect the user's theme preference onto the document root. "system" clears
 * the attribute so CSS `prefers-color-scheme` decides; "light" / "dark" force
 * the palette regardless of OS setting.
 */
export function applyThemeMode(mode: ThemeMode) {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  if (mode === "system") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", mode);
}
