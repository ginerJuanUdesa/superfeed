# superfeed

A self-hosted, modular dashboard that pulls your scattered feeds into one draggable grid.
Each panel is a **module** — Hugging Face activity, Gmail, Google Calendar, GitHub, Redmine, a fleet status board, or a plain image — and every module is a self-contained plugin you can drop in and register in one line.

Version `0.1`.

## What it looks like

A right-hand rail holds one tile per registered module.
Drag a tile onto the canvas to add an instance; drag and resize instances freely; the layout and each module's config are persisted server-side (SQLite under `.local/`) so every device that opens the deployment sees the same board.
On a phone the grid collapses into a full-screen, swipeable carousel.

Modules that summarize (Hugging Face, GitHub PRs, Gmail, Redmine) can call either the Anthropic API or a local OpenAI-compatible LLM — configured in **Settings**, never committed.

## Quick start

### Development

```bash
./scripts/run.sh   # installs deps if needed, then next dev on :3000
```

Open [http://localhost:3000](http://localhost:3000), click the gear to open **Settings**, and fill in the accounts and tokens for the modules you want.

### Docker

```bash
docker network create apps        # one-time, shared external network
docker compose up -d --build
```

Host-side configuration lives in two ignored files:

- `.env.local` — server env such as `REDMINE_URL` / `LOCAL_LLM_API_KEY`.
- `.local/` — the SQLite state volume (settings, grid layout, cached summaries). Persisted across rebuilds.

## Configuration

Everything user-facing is set through the in-app **Settings** modal and stored server-side, not in env:

- **General** — feed start date and light/dark/system theme.
- **Gmail** — one OAuth client (id, secret, refresh token) per account. Calendar reuses the same accounts.
- **Hugging Face / GitHub** — username drives the feed; a token unlocks private activity.
- **LLM** — an Anthropic key or a local OpenAI-compatible URL for summaries.
- **Fleet** — servers (whole machines) and services (host:port) to probe.
- **Backup** — export/import all settings as JSON.

## Layout

```
app/                 Next.js App Router — the shell and every /api/<module>/ route
components/          Grid, Module dispatcher, Settings modal
modules/             One file per module + the registry (see docs/MODULES.md)
lib/                 Shared client + server helpers (settings, db, per-module data layers)
```

## Adding your own module

Modules are the whole point.
A module is a React panel plus an optional server route, wired in through a single descriptor.
See **[docs/MODULES.md](./docs/MODULES.md)** for the full guide and a minimal copy-paste example.

## Built with

Next.js, React, Tailwind, `react-grid-layout`, `better-sqlite3`, and `@phosphor-icons/react`.

## License

[MIT](./LICENSE).
