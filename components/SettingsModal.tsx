"use client";

import { useEffect, useState } from "react";

const STORAGE_KEY = "unyapper:settings:v1";
const LEGACY_KEY = "unyapper:credentials:v1";

export interface Settings {
  startDate: string;
  gmailClientId: string;
  gmailClientSecret: string;
  gmailRefreshToken: string;
  hfUsername: string;
  hfToken: string;
  anthropicApiKey: string;
  localLlmUrl: string;
  localLlmModel: string;
}

const EMPTY: Settings = {
  startDate: "",
  gmailClientId: "",
  gmailClientSecret: "",
  gmailRefreshToken: "",
  hfUsername: "",
  hfToken: "",
  anthropicApiKey: "",
  localLlmUrl: "",
  localLlmModel: "",
};

function todayISO() {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function loadSettings(): Settings {
  if (typeof window === "undefined") return EMPTY;
  try {
    const raw =
      localStorage.getItem(STORAGE_KEY) ?? localStorage.getItem(LEGACY_KEY);
    if (!raw) return EMPTY;
    return { ...EMPTY, ...JSON.parse(raw) };
  } catch {
    return EMPTY;
  }
}

function saveSettings(s: Settings) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
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

  if (!open) return null;

  const set = <K extends keyof Settings>(key: K, value: Settings[K]) => {
    setSettings((prev) => ({ ...prev, [key]: value }));
    setDirty(true);
  };

  const save = () => {
    saveSettings(settings);
    setDirty(false);
    onClose();
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="w-full max-w-lg mx-4 rounded-2xl border border-white/15 bg-[rgba(20,18,40,0.95)] shadow-[0_20px_60px_-10px_rgba(80,50,200,0.6)] overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-3 border-b border-white/10">
          <h2 className="text-sm font-semibold bg-gradient-to-r from-violet-300 via-indigo-200 to-sky-300 bg-clip-text text-transparent">
            Settings
          </h2>
          <button
            onClick={onClose}
            className="text-white/50 hover:text-white text-xl leading-none px-1"
          >
            ×
          </button>
        </div>

        <div className="px-5 py-4 max-h-[70vh] overflow-y-auto space-y-6">
          <Section title="General" hint="Start collecting and summarizing from this date onwards">
            <DateField
              label="Start date"
              value={settings.startDate}
              onChange={(v) => set("startDate", v)}
            />
          </Section>

          <Section title="Gmail" hint="Google OAuth — Client ID / Secret / Refresh Token">
            <Field label="Client ID" value={settings.gmailClientId} onChange={(v) => set("gmailClientId", v)} />
            <Field label="Client Secret" value={settings.gmailClientSecret} onChange={(v) => set("gmailClientSecret", v)} secret />
            <Field label="Refresh Token" value={settings.gmailRefreshToken} onChange={(v) => set("gmailRefreshToken", v)} secret />
          </Section>

          <Section title="HuggingFace" hint="Your username drives the feed; token only for private repos">
            <Field label="Username" value={settings.hfUsername} onChange={(v) => set("hfUsername", v)} placeholder="e.g. ginerjuan" />
            <Field label="HF Token" value={settings.hfToken} onChange={(v) => set("hfToken", v)} secret />
          </Section>

          <Section title="LLM" hint="Pick one: Anthropic or a local LLM exposed over HTTP (OpenAI-compatible)">
            <Field label="Anthropic API Key" value={settings.anthropicApiKey} onChange={(v) => set("anthropicApiKey", v)} secret />
            <Field label="Local LLM URL" value={settings.localLlmUrl} onChange={(v) => set("localLlmUrl", v)} placeholder="http://host:port/v1/chat/completions" />
            <Field label="Local LLM Model" value={settings.localLlmModel} onChange={(v) => set("localLlmModel", v)} placeholder="model name reported by the server" />
          </Section>
        </div>

        <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-white/10 bg-black/20">
          <button
            onClick={onClose}
            className="text-xs px-3 py-1.5 rounded border border-white/15 text-white/70 hover:bg-white/5"
          >
            Cancel
          </button>
          <button
            onClick={save}
            disabled={!dirty}
            className="text-xs px-3 py-1.5 rounded border border-violet-400/50 bg-violet-500/20 text-violet-100 hover:bg-violet-500/30 disabled:opacity-40 disabled:cursor-not-allowed"
          >
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
      <div className="flex items-baseline justify-between mb-2">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-white/80">{title}</h3>
        <span className="text-[10px] text-white/40">{hint}</span>
      </div>
      <div className="space-y-2">{children}</div>
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
      <span className="text-[11px] text-white/50 block mb-1">{label}</span>
      <input
        type="date"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full px-2.5 py-1.5 text-xs bg-black/30 border border-white/10 rounded focus:border-violet-400/50 focus:outline-none text-white [color-scheme:dark]"
      />
    </label>
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
      <span className="text-[11px] text-white/50 block mb-1">{label}</span>
      <div className="relative">
        <input
          type={secret && !reveal ? "password" : "text"}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          className="w-full px-2.5 py-1.5 pr-14 text-xs bg-black/30 border border-white/10 rounded focus:border-violet-400/50 focus:outline-none text-white placeholder-white/25"
          autoComplete="off"
          spellCheck={false}
        />
        {secret && (
          <button
            type="button"
            onClick={() => setReveal((r) => !r)}
            className="absolute right-1 top-1 text-[10px] text-white/40 hover:text-white/80 px-2 py-1"
          >
            {reveal ? "hide" : "show"}
          </button>
        )}
      </div>
    </label>
  );
}
