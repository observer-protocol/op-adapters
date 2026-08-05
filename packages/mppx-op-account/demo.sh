#!/usr/bin/env bash
# demo.sh — single-window, self-narrating launch demo for the Loom (mppx engine).
# A screen recording of this script alone IS the video. Captions are full
# sentences: the story is understandable with the audio off.
#
#   cd ~/Desktop/OP_AT/mppx-op-account && ./demo.sh
#
# First run does a one-time sandbox warm (build + fixtures). Run it once, then
# record the second run. Set DEMO_PAUSE to change pacing (default 2.5s).
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SANDBOX="$REPO/.demo-sandbox"
PAUSE="${DEMO_PAUSE:-2.5}"
PKG="@observer-protocol/mppx-op-account"
REPO_URL="github.com/observer-protocol/mppx-op-account"

cyan=$'\033[1;36m'; green=$'\033[1;32m'; red=$'\033[1;31m'; dim=$'\033[2m'; bold=$'\033[1m'; rst=$'\033[0m'

banner() { # $1 = caption (full sentences)
  printf '\n%s' "$cyan"
  printf '┌──────────────────────────────────────────────────────────────────────┐\n'
  printf '%s\n' "$1" | fold -s -w 70 | while IFS= read -r line || [ -n "$line" ]; do printf '│ %s%-70s%s │\n' "$bold" "$line" "$cyan"; done
  printf '└──────────────────────────────────────────────────────────────────────┘%s\n' "$rst"
  sleep "$PAUSE"
}
cmd() { printf '%s$ %s%s\n' "$dim" "$1" "$rst"; }
beat_pause() { sleep "$PAUSE"; }

setup() {
  printf '%sOne-time warm: build + fixtures…%s\n' "$dim" "$rst"
  ( cd "$REPO" && npm run build >/dev/null 2>&1 && node test/fixtures/gen.mjs >/dev/null 2>&1 )
  mkdir -p "$SANDBOX"; touch "$SANDBOX/.ready"
  printf '%sReady.%s\n\n' "$dim" "$rst"
}
[ -f "$SANDBOX/.ready" ] || setup

clear 2>/dev/null || true

# ── Beat 1 ──────────────────────────────────────────────────────────────────
banner "Observer Protocol x MPP / Tempo: the same signed-mandate enforcement, now as a drop-in viem account for mppx. Published today on npm as $PKG. The second engine: only the decoder changed."

# ── Beat 2 ──────────────────────────────────────────────────────────────────
banner "A real agent opens an MPP session by depositing into the on-chain escrow. Its signed mandate allows up to 100 USDC. It tries to escrow 150. We decode the real Tempo escrow call, check the mandate, and the wallet key is never reached."
cmd "tempo.session.manager({ account, maxDeposit: '150' })   # over the 100 USDC mandate"
( cd "$REPO" && node demo/scenes.mjs over )
beat_pause

# ── Beat 3 ──────────────────────────────────────────────────────────────────
banner "The same agent, within its mandate: escrow 50 USDC. The account verifies the credential and the amount, allows it, and the real viem key returns signature bytes."
cmd "tempo.session.manager({ account, maxDeposit: '50' })"
( cd "$REPO" && node demo/scenes.mjs under )
beat_pause

# ── Beat 4 ──────────────────────────────────────────────────────────────────
banner "Inside a session, payments are off-chain vouchers, each authorizing a higher cumulative total. The agent signs a 70-USDC voucher, then tries to roll back to 50. Monotonicity is enforced at the signer: the rollback is denied."
cmd "account.signTypedData(voucher 70)  then  voucher 50  # rollback"
( cd "$REPO" && node demo/scenes.mjs voucher )
beat_pause

# ── Beat 5 ──────────────────────────────────────────────────────────────────
banner "None of this is mocked. Live-fire runs the real mppx escrow ABI and a real viem signer through the account; allow paths sign, deny paths fail closed."
cmd "npm run livefire"
( cd "$REPO" && node harness/live-fire.mjs 2>&1 | tail -3 | sed "s/.*/${green}&${rst}/" )
beat_pause

# ── Beat 6 ──────────────────────────────────────────────────────────────────
banner "Try it in two minutes: npm run livefire. Repo: $REPO_URL. Package: $PKG. Composes with mppx unchanged, no core change. The binding layer is contested; the enforcement locus is not."
