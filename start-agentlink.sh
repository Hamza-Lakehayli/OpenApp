#!/usr/bin/env bash
# macOS / Linux launcher: cd to the app, install once if needed, run.
cd "$(dirname "$0")/client" || exit 1

if ! command -v npm >/dev/null 2>&1; then
  echo "npm was not found. Install Node.js from https://nodejs.org first."
  exit 1
fi

if [ ! -d node_modules ]; then
  echo "First run - installing dependencies (one time)..."
  npm install --no-audit --no-fund
fi

npm run agentlink
