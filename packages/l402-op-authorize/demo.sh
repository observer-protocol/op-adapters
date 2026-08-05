#!/usr/bin/env bash
# demo.sh — single-window L402 authorization demo (buyer hook + seller wedge).
# A screen recording of this run IS the video. DEMO_PAUSE sets pacing (default 1.4s).
set -uo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$REPO"
[ -f dist/index.mjs ] || npm run build >/dev/null 2>&1
node demo/scenes.mjs
