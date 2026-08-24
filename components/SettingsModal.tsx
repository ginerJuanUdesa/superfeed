"use client";

import { useEffect, useRef, useState } from "react";
import {
  getCachedSettings,
  saveSettings as pushSettings,
} from "@/lib/clientState";
import type { FleetEndpoint, FleetServer } from "@/lib/fleet";

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

const EMPTY: Settings = {
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

function todayISO() {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * Read the current settings from the in-memory cache. The cache is populated
 * once at app boot via `hydrate()` — before that, callers get EMPTY.
 * Same shape-migration logic as before (legacy shared OAuth client → per-account).
 */
export function loadSettings(): Settings {
  const raw = getCachedSettings<Partial<Settings> | null>();
  if (!raw) return EMPTY;
  const parsed = { ...EMPTY, ...raw } as Settings;
  const sharedId = parsed.gmailClientId ?? "";
  const sharedSecret = parsed.gmailClientSecret ?? "";
  if (!parsed.gmailAccounts?.length && parsed.gmailRefreshToken) {
    parsed.gmailAccounts = [
      {
        label: "primary",
        refreshToken: parsed.gmailRefreshToken,
        clientId: sharedId,
        clientSecret: sharedSecret,
      },
    ];
  }
  parsed.gmailAccounts ??= [];
  parsed.gmailAccounts = parsed.gmailAccounts.map((a) => ({
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

function saveSettings(s: Settings) {
  pushSettings(s);
}

/**
 * Reflect the user's theme preference onto the document root. "system" clears
 * the attribute so CSS `prefers-color-scheme` decides; "light" / "dark" force
 * the palette regardless of OS setting.
 */
export function applyThemeMode(mode: ThemeMode) {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  if (mode === "system") {
    root.removeAttribute("data-theme");
  } else {
    root.setAttribute("data-theme", mode);
  }
}

export default function SettingsModal({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const [settings, setSettings] = useState<Settings>(EMPTY);
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    if (open) {
      const loaded = loadSettings();
      if (!loaded.startDate) loaded.startDate = todayISO();
      setSettings(loaded);
      setDirty(false);
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  // Live preview: as the user clicks Light / Dark / System while the modal is
  // open, the whole page shifts immediately so they can see what they're
  // picking. Must run before the early-return below so hook order is stable.
  useEffect(() => {
    if (!open) return;
    applyThemeMode(settings.themeMode);
  }, [open, settings.themeMode]);

  if (!open) return null;

  const set = <K extends keyof Settings>(key: K, value: Settings[K]) => {
    setSettings((prev) => ({ ...prev, [key]: value }));
    setDirty(true);
  };

  const save = () => {
    saveSettings(settings);
    applyThemeMode(settings.themeMode);
    setDirty(false);
    onClose();
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center px-4"
      style={{ background: "rgba(0, 0, 0, 0.6)" }}
      onClick={onClose}
    >
      <div
        className="w-full max-w-lg overflow-hidden"
        onClick={(e) => e.stopPropagation()}
        style={{
          background: "var(--surface)",
          border: "1px solid var(--border)",
          borderRadius: "var(--radius)",
          boxShadow: "0 40px 80px -20px rgba(0, 0, 0, 0.85)",
        }}
      >
        <div className="flex items-center justify-between px-5 py-3.5 border-b border-[var(--border)]">
          <h2 className="text-base font-semibold text-[var(--text)]">Settings</h2>
          <button
            onClick={onClose}
            className="text-[var(--text-muted)] hover:text-[var(--text)] text-xl leading-none w-7 h-7 flex items-center justify-center rounded-md hover:bg-[var(--surface-max)] transition-colors"
            title="Close"
          >
            ×
          </button>
        </div>

        <div className="px-5 py-5 max-h-[70vh] overflow-y-auto space-y-6">
          <Section title="General" hint="Start date and page theme">
            <DateField
              label="Start date"
              value={settings.startDate}
              onChange={(v) => set("startDate", v)}
            />
            <ThemeField
              value={settings.themeMode}
              onChange={(v) => set("themeMode", v)}
            />
          </Section>

          <Section title="Gmail" hint="One OAuth client per account. All four fields required.">
            <GmailAccountsField
              accounts={settings.gmailAccounts}
              onChange={(v) => set("gmailAccounts", v)}
            />
          </Section>

          <Section title="HuggingFace" hint="Your username drives the feed. Token only for private repos.">
            <Field label="Username" value={settings.hfUsername} onChange={(v) => set("hfUsername", v)} placeholder="e.g. ginerjuan" />
            <Field label="Access token" value={settings.hfToken} onChange={(v) => set("hfToken", v)} secret />
          </Section>

          <Section title="GitHub" hint="Your username drives the received-events feed. PAT with read:user for private activity.">
            <Field label="Username" value={settings.githubUsername} onChange={(v) => set("githubUsername", v)} placeholder="e.g. ginerjuan" />
            <Field label="Personal access token" value={settings.githubToken} onChange={(v) => set("githubToken", v)} secret />
          </Section>

          <Section title="LLM" hint="Pick one: Anthropic key, or a local OpenAI-compatible URL">
            <Field label="Anthropic API key" value={settings.anthropicApiKey} onChange={(v) => set("anthropicApiKey", v)} secret />
            <LlmUrlField value={settings.localLlmUrl} onChange={(v) => set("localLlmUrl", v)} />
            <Field label="Local LLM model" value={settings.localLlmModel} onChange={(v) => set("localLlmModel", v)} placeholder="model name reported by the server" />
          </Section>

          <Section
            title="Fleet"
            hint="Servers = whole machines (probed on common ports to see if they're on). Services = specific host:port checks. A service's host can be a server label — no need to retype the IP."
          >
            <FleetServersField
              servers={settings.fleetServers}
              onChange={(v) => set("fleetServers", v)}
            />
            <FleetEndpointsField
              endpoints={settings.fleetEndpoints}
              onChange={(v) => set("fleetEndpoints", v)}
            />
          </Section>

          <Section title="Backup" hint="Export or import all settings as JSON. Includes secrets — don't share the file.">
            <BackupField
              onExport={() => exportSettings(settings)}
              onImport={(imported) => {
                setSettings(imported);
                setDirty(true);
              }}
            />
          </Section>
        </div>

        <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-[var(--border)]" style={{ background: "var(--surface-hi)" }}>
          <button onClick={onClose} className="btn btn-ghost">
            Cancel
          </button>
          <button onClick={save} disabled={!dirty} className="btn btn-primary">
            Save
          </button>
        </div>
      </div>
    </div>
  );
}

function Section({
  title,
  hint,
  children,
}: {
  title: string;
  hint: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="mb-3">
        <h3 className="text-sm font-semibold text-[var(--text)]">{title}</h3>
        <p className="text-xs text-[var(--text-muted)] mt-0.5">{hint}</p>
      </div>
      <div className="space-y-2.5">{children}</div>
    </div>
  );
}

function DateField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <label className="block">
      <span className="text-xs text-[var(--text-muted)] block mb-1.5">{label}</span>
      <input
        type="date"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="field-input [color-scheme:dark]"
      />
    </label>
  );
}

function ThemeField({
  value,
  onChange,
}: {
  value: ThemeMode;
  onChange: (v: ThemeMode) => void;
}) {
  const options: { key: ThemeMode; label: string }[] = [
    { key: "system", label: "System" },
    { key: "light", label: "Light" },
    { key: "dark", label: "Dark" },
  ];
  return (
    <div>
      <div className="text-xs text-[var(--text-muted)] mb-1.5">Appearance</div>
      <div
        className="inline-flex p-0.5 rounded-md gap-0.5"
        style={{ background: "var(--surface-max)", border: "1px solid var(--border)" }}
      >
        {options.map((opt) => {
          const active = value === opt.key;
          return (
            <button
              key={opt.key}
              type="button"
              onClick={() => onChange(opt.key)}
              className="px-3 py-1 text-xs rounded transition-colors"
              style={{
                background: active ? "var(--surface)" : "transparent",
                color: active ? "var(--text)" : "var(--text-muted)",
                boxShadow: active ? "0 1px 2px rgba(0,0,0,0.25)" : "none",
              }}
            >
              {opt.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function GmailAccountsField({
  accounts,
  onChange,
}: {
  accounts: GmailAccount[];
  onChange: (v: GmailAccount[]) => void;
}) {
  const update = (idx: number, patch: Partial<GmailAccount>) => {
    onChange(accounts.map((a, i) => (i === idx ? { ...a, ...patch } : a)));
  };
  const remove = (idx: number) => onChange(accounts.filter((_, i) => i !== idx));
  const add = () =>
    onChange([
      ...accounts,
      { label: "", refreshToken: "", clientId: "", clientSecret: "" },
    ]);
  return (
    <div className="space-y-2">
      <div className="text-xs text-[var(--text-muted)]">Accounts</div>
      {accounts.length === 0 && (
        <div className="text-xs text-[var(--text-faint)] italic">
          No accounts yet. Add one below.
        </div>
      )}
      {accounts.map((a, i) => (
        <AccountRow
          key={i}
          account={a}
          onChange={(patch) => update(i, patch)}
          onRemove={() => remove(i)}
        />
      ))}
      <button type="button" onClick={add} className="btn btn-ghost h-8 text-xs">
        Add account
      </button>
    </div>
  );
}

function AccountRow({
  account,
  onChange,
  onRemove,
}: {
  account: GmailAccount;
  onChange: (patch: Partial<GmailAccount>) => void;
  onRemove: () => void;
}) {
  const [revealRT, setRevealRT] = useState(false);
  const [revealCS, setRevealCS] = useState(false);
  return (
    <div
      className="space-y-2 p-2.5 rounded-md"
      style={{ background: "var(--surface-hi)", border: "1px solid var(--border)" }}
    >
      <div className="flex items-center gap-2">
        <input
          value={account.label}
          onChange={(e) => onChange({ label: e.target.value })}
          placeholder="label (e.g. work)"
          className="field-input flex-1"
          autoComplete="off"
          spellCheck={false}
        />
        <button
          type="button"
          onClick={onRemove}
          className="text-[var(--text-muted)] hover:text-[var(--danger)] text-lg leading-none w-8 h-8 flex items-center justify-center rounded-md hover:bg-[var(--surface-max)] transition-colors"
          title="Remove account"
        >
          ×
        </button>
      </div>
      <input
        value={account.clientId}
        onChange={(e) => onChange({ clientId: e.target.value })}
        placeholder="client id"
        className="field-input"
        autoComplete="off"
        spellCheck={false}
      />
      <div className="relative">
        <input
          type={revealCS ? "text" : "password"}
          value={account.clientSecret}
          onChange={(e) => onChange({ clientSecret: e.target.value })}
          placeholder="client secret"
          className="field-input pr-14"
          autoComplete="off"
          spellCheck={false}
        />
        <button
          type="button"
          onClick={() => setRevealCS((r) => !r)}
          className="absolute right-2 top-1/2 -translate-y-1/2 text-xs text-[var(--text-muted)] hover:text-[var(--text)]"
        >
          {revealCS ? "hide" : "show"}
        </button>
      </div>
      <div className="relative">
        <input
          type={revealRT ? "text" : "password"}
          value={account.refreshToken}
          onChange={(e) => onChange({ refreshToken: e.target.value })}
          placeholder="refresh token"
          className="field-input pr-14"
          autoComplete="off"
          spellCheck={false}
        />
        <button
          type="button"
          onClick={() => setRevealRT((r) => !r)}
          className="absolute right-2 top-1/2 -translate-y-1/2 text-xs text-[var(--text-muted)] hover:text-[var(--text)]"
        >
          {revealRT ? "hide" : "show"}
        </button>
      </div>
    </div>
  );
}

function exportSettings(s: Settings) {
  const blob = new Blob([JSON.stringify(s, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  a.href = url;
  a.download = `superfeed-settings-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

/** Merge an untrusted JSON blob into a full Settings shape by starting from
 *  EMPTY, layering the blob on top, and re-running loadSettings' migrations
 *  so legacy exports (pre per-account creds, etc.) still land in a valid state. */
function parseImported(raw: string): Settings {
  const parsed = JSON.parse(raw) as Partial<Settings>;
  const base: Settings = { ...EMPTY, ...parsed };
  const sharedId = base.gmailClientId ?? "";
  const sharedSecret = base.gmailClientSecret ?? "";
  if (!base.gmailAccounts?.length && base.gmailRefreshToken) {
    base.gmailAccounts = [
      {
        label: "primary",
        refreshToken: base.gmailRefreshToken,
        clientId: sharedId,
        clientSecret: sharedSecret,
      },
    ];
  }
  base.gmailAccounts ??= [];
  base.gmailAccounts = base.gmailAccounts.map((a) => ({
    label: a.label ?? "",
    refreshToken: a.refreshToken ?? "",
    clientId: a.clientId || sharedId || "",
    clientSecret: a.clientSecret || sharedSecret || "",
  }));
  base.themeMode ??= "system";
  base.fleetEndpoints ??= [];
  base.fleetServers ??= [];
  return base;
}

function BackupField({
  onExport,
  onImport,
}: {
  onExport: () => void;
  onImport: (s: Settings) => void;
}) {
  const [err, setErr] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const pickFile = () => inputRef.current?.click();
  const handleFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ""; // let the same file re-trigger later
    if (!file) return;
    try {
      const text = await file.text();
      const imported = parseImported(text);
      onImport(imported);
      setErr(null);
    } catch (ex) {
      setErr((ex as Error).message || "Invalid file");
    }
  };

  return (
    <div className="space-y-2">
      <div className="flex gap-2">
        <button type="button" onClick={onExport} className="btn btn-ghost h-8 text-xs">
          Export JSON
        </button>
        <button type="button" onClick={pickFile} className="btn btn-ghost h-8 text-xs">
          Import JSON
        </button>
        <input
          ref={inputRef}
          type="file"
          accept="application/json,.json"
          onChange={handleFile}
          className="hidden"
        />
      </div>
      {err && (
        <div className="text-xs" style={{ color: "var(--danger)" }}>
          {err}
        </div>
      )}
      <div className="text-[11px] text-[var(--text-faint)]">
        Importing overwrites the form. Nothing is persisted until you press Save.
      </div>
    </div>
  );
}

function LlmUrlField({
  value,
  onChange,
}: {
  value: string;
  onChange: (v: string) => void;
}) {
  const [status, setStatus] = useState<"idle" | "checking" | "ok" | "down">(
    value ? "checking" : "idle"
  );

  useEffect(() => {
    const url = value.trim();
    if (!url) {
      setStatus("idle");
      return;
    }
    setStatus("checking");
    const ctrl = new AbortController();
    const t = window.setTimeout(async () => {
      try {
        const modelsUrl = url.replace(/\/chat\/completions\/?$/, "/models");
        const res = await fetch(modelsUrl, {
          signal: ctrl.signal,
          cache: "no-store",
        });
        setStatus(res.ok ? "ok" : "down");
      } catch {
        if (!ctrl.signal.aborted) setStatus("down");
      }
    }, 400);
    return () => {
      ctrl.abort();
      window.clearTimeout(t);
    };
  }, [value]);

  const dotColor =
    status === "ok" ? "#22c55e" : status === "checking" ? "#eab308" : "#6b7280";
  const dotTitle =
    status === "ok"
      ? "LLM reachable"
      : status === "checking"
      ? "Checking…"
      : status === "down"
      ? "LLM unreachable"
      : "No URL set";

  return (
    <label className="block">
      <span className="text-xs text-[var(--text-muted)] block mb-1.5">
        Local LLM URL
      </span>
      <div className="relative">
        <input
          type="text"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="http://host:port/v1/chat/completions"
          className="field-input pr-8"
          autoComplete="off"
          spellCheck={false}
        />
        <span
          className="absolute right-3 top-1/2 -translate-y-1/2 w-2.5 h-2.5 rounded-full"
          style={{ background: dotColor, boxShadow: `0 0 6px ${dotColor}80` }}
          title={dotTitle}
        />
      </div>
    </label>
  );
}

function FleetServersField({
  servers,
  onChange,
}: {
  servers: FleetServer[];
  onChange: (v: FleetServer[]) => void;
}) {
  const update = (idx: number, patch: Partial<FleetServer>) => {
    onChange(servers.map((s, i) => (i === idx ? { ...s, ...patch } : s)));
  };
  const remove = (idx: number) => onChange(servers.filter((_, i) => i !== idx));
  const add = () => onChange([...servers, { label: "", host: "" }]);
  return (
    <div className="space-y-2">
      <div className="text-xs text-[var(--text-muted)]">Servers (whole machines)</div>
      {servers.length === 0 && (
        <div className="text-xs text-[var(--text-faint)] italic">
          No servers yet. Add one below.
        </div>
      )}
      {servers.map((s, i) => (
        <div
          key={i}
          className="grid gap-2 p-2 rounded-md"
          style={{
            background: "var(--surface-hi)",
            border: "1px solid var(--border)",
            gridTemplateColumns: "2fr 3fr auto",
          }}
        >
          <input
            value={s.label}
            onChange={(ev) => update(i, { label: ev.target.value })}
            placeholder="label"
            className="field-input min-w-0"
            autoComplete="off"
            spellCheck={false}
          />
          <input
            value={s.host}
            onChange={(ev) => update(i, { host: ev.target.value })}
            placeholder="host or ip"
            className="field-input min-w-0"
            autoComplete="off"
            spellCheck={false}
          />
          <button
            type="button"
            onClick={() => remove(i)}
            className="text-[var(--text-muted)] hover:text-[var(--danger)] text-lg leading-none w-8 h-8 flex items-center justify-center rounded-md hover:bg-[var(--surface-max)] transition-colors shrink-0"
            title="Remove server"
          >
            ×
          </button>
        </div>
      ))}
      <button type="button" onClick={add} className="btn btn-ghost h-8 text-xs">
        Add server
      </button>
    </div>
  );
}

function FleetEndpointsField({
  endpoints,
  onChange,
}: {
  endpoints: FleetEndpoint[];
  onChange: (v: FleetEndpoint[]) => void;
}) {
  const update = (idx: number, patch: Partial<FleetEndpoint>) => {
    onChange(endpoints.map((e, i) => (i === idx ? { ...e, ...patch } : e)));
  };
  const remove = (idx: number) => onChange(endpoints.filter((_, i) => i !== idx));
  const add = () =>
    onChange([...endpoints, { label: "", host: "", port: 80 }]);
  return (
    <div className="space-y-2 pt-3 mt-3 border-t border-[var(--border)]">
      <div className="text-xs text-[var(--text-muted)]">Services (host:port)</div>
      {endpoints.length === 0 && (
        <div className="text-xs text-[var(--text-faint)] italic">
          No endpoints yet. Add one below.
        </div>
      )}
      {endpoints.map((e, i) => (
        // CSS grid instead of flex — .field-input sets width:100%, which
        // fights `flex-[N]` and made the fixed-width port outrank the
        // proportional label/host. A grid template pins the port at 4rem,
        // gives the button auto, and lets label:host share the rest at 2:3.
        <div
          key={i}
          className="grid gap-2 p-2 rounded-md"
          style={{
            background: "var(--surface-hi)",
            border: "1px solid var(--border)",
            gridTemplateColumns: "2fr 3fr 4rem auto",
          }}
        >
          <input
            value={e.label}
            onChange={(ev) => update(i, { label: ev.target.value })}
            placeholder="label"
            className="field-input min-w-0"
            autoComplete="off"
            spellCheck={false}
          />
          <input
            value={e.host}
            onChange={(ev) => update(i, { host: ev.target.value })}
            placeholder="host, ip, or server label"
            className="field-input min-w-0"
            autoComplete="off"
            spellCheck={false}
          />
          <input
            value={e.port || ""}
            onChange={(ev) => {
              const parsed = Number(ev.target.value.trim());
              update(i, {
                port: Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0,
              });
            }}
            placeholder="port"
            inputMode="numeric"
            className="field-input min-w-0"
            autoComplete="off"
            spellCheck={false}
          />
          <button
            type="button"
            onClick={() => remove(i)}
            className="text-[var(--text-muted)] hover:text-[var(--danger)] text-lg leading-none w-8 h-8 flex items-center justify-center rounded-md hover:bg-[var(--surface-max)] transition-colors shrink-0"
            title="Remove endpoint"
          >
            ×
          </button>
        </div>
      ))}
      <button type="button" onClick={add} className="btn btn-ghost h-8 text-xs">
        Add endpoint
      </button>
    </div>
  );
}

function Field({
  label,
  value,
  onChange,
  secret,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  secret?: boolean;
  placeholder?: string;
}) {
  const [reveal, setReveal] = useState(false);
  return (
    <label className="block">
      <span className="text-xs text-[var(--text-muted)] block mb-1.5">{label}</span>
      <div className="relative">
        <input
          type={secret && !reveal ? "password" : "text"}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          className="field-input pr-14"
          autoComplete="off"
          spellCheck={false}
        />
        {secret && (
          <button
            type="button"
            onClick={() => setReveal((r) => !r)}
            className="absolute right-2 top-1/2 -translate-y-1/2 text-xs text-[var(--text-muted)] hover:text-[var(--text)]"
          >
            {reveal ? "hide" : "show"}
          </button>
        )}
      </div>
    </label>
  );
}
