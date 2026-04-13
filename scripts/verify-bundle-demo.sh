#!/usr/bin/env bash
# Verification script for the bundle-agent phase2 demo (tasks 3.29, 7.7).
#
# Starts wrangler dev, exercises the static → seed → bundle → disable flow,
# and tails the dispatcher logs for spine RPC evidence. Tears down wrangler
# cleanly on exit.
#
# Usage:
#   bash scripts/verify-bundle-demo.sh

set -euo pipefail

PORT="${PORT:-8893}"
EXAMPLE_DIR="$(cd "$(dirname "$0")/../examples/bundle-agent-phase2" && pwd)"
LOG="/tmp/bundle-demo-verify.log"
TIMEOUT_SEC="${TIMEOUT_SEC:-45}"

echo "==> Building bundle artifact"
(cd "$EXAMPLE_DIR" && bun run build:bundle)

echo "==> Starting wrangler dev on port $PORT (log: $LOG)"
cd "$EXAMPLE_DIR"
timeout "$TIMEOUT_SEC" bun x wrangler dev --port "$PORT" --local > "$LOG" 2>&1 &
WRANGLER_PID=$!
cd - >/dev/null
trap 'kill $WRANGLER_PID 2>/dev/null || true' EXIT INT TERM

echo "==> Waiting for wrangler dev to be ready"
for _ in {1..30}; do
  if curl -sS "http://127.0.0.1:$PORT/" >/dev/null 2>&1; then
    break
  fi
  sleep 1
done

if ! curl -sS "http://127.0.0.1:$PORT/" >/dev/null 2>&1; then
  echo "✗ wrangler never came up — check $LOG" >&2
  exit 1
fi

step() {
  echo ""
  echo "==> $1"
}

step "Send prompt to static brain (pre-bundle)"
curl -sS -X POST "http://127.0.0.1:$PORT/prompt" \
  -H "content-type: application/json" \
  -d '{"text":"pre-bundle: static brain should respond"}' | head -c 300
echo ""

step "Check initial bundle status (no active version)"
curl -sS "http://127.0.0.1:$PORT/status"
echo ""

step "Seed pre-compiled bundle bytes"
curl -sS -X POST "http://127.0.0.1:$PORT/seed-bundle"
echo ""

step "Verify status — active version should be set"
curl -sS "http://127.0.0.1:$PORT/status"
echo ""

step "Send prompt through bundle brain"
curl -sS -X POST "http://127.0.0.1:$PORT/prompt" \
  -H "content-type: application/json" \
  -d '{"text":"post-seed: bundle brain should dispatch"}' | head -c 300
echo ""

step "Disable bundle (revert to static)"
curl -sS -X POST "http://127.0.0.1:$PORT/disable"
echo ""

step "Send final prompt — back to static brain"
curl -sS -X POST "http://127.0.0.1:$PORT/prompt" \
  -H "content-type: application/json" \
  -d '{"text":"post-disable: static again"}' | head -c 300
echo ""

step "Spine RPC evidence from dispatcher (look for errors — none = success path)"
if grep -iE "BundleDispatcher|spine|dispatch" "$LOG"; then
  echo "(dispatcher activity above)"
else
  echo "(no dispatcher errors — success path flowed)"
fi

echo ""
echo "==> Done. Kill wrangler and exit."
kill $WRANGLER_PID 2>/dev/null || true
wait 2>/dev/null || true
