#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

if [ ! -d node_modules ]; then
  echo "[superfeed] installing deps…"
  npm install
fi

exec npx next dev --webpack --hostname 0.0.0.0 --port 3000
