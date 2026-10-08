#!/usr/bin/env bash
# Naveen Poultry Farm - one-command start for LINUX
# Same behavior as start.bat on Windows: install deps if needed, build the UI
# if needed, then run the single server that serves API + UI on port 3001.
set -euo pipefail
cd "$(dirname "$0")"

if ! command -v node >/dev/null 2>&1; then
    echo "[ERROR] Node.js not found. Install Node 24+ (https://nodejs.org or your distro's nvm) and retry."
    exit 1
fi

if [ ! -d node_modules ]; then
    echo "[setup] Installing dependencies (first run on this machine)..."
    npm install --no-audit --no-fund
fi

if [ ! -d dist ]; then
    echo "[setup] Building the UI (first run)..."
    npm run build:all
fi

echo "[run] Naveen Farm on http://localhost:3001"
exec node server/index.ts
