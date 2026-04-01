#!/bin/bash
# Quality check script for CLAW for Cloudflare
# Runs deterministic checks against the codebase.
# Exit 0 with warnings (non-blocking). Use --strict to exit 1 on warnings.
#
# Usage: ./tools/quality-check.sh [--strict]

set -uo pipefail
cd "$(dirname "$0")/.."

STRICT=false
for arg in "$@"; do
  [[ "$arg" == "--strict" ]] && STRICT=true
done

OUTPUT=""
log() { OUTPUT+="$1"$'\n'; }

# ─── File Length ───────────────────────────────────────────────────────
log ""
log "=== File Length (max 500 source, 1000 tests) ==="

while IFS= read -r f; do
  lines=$(wc -l < "$f" | tr -d ' ')
  is_test=false
  [[ "$f" == *".test."* || "$f" == *"/test/"* || "$f" == *"test-helpers"* || "$f" == *"__tests__"* ]] && is_test=true

  if [[ "$is_test" == true ]] && (( lines > 1000 )); then
    log "  WARN: $f: $lines lines (test limit: 1000)"
  elif [[ "$is_test" == false ]] && (( lines > 500 )); then
    log "  WARN: $f: $lines lines (source limit: 500)"
  fi
done < <(find packages \( -name '*.ts' -o -name '*.tsx' \) -not -path '*/node_modules/*' -not -path '*/dist/*' -not -name '*.generated.*' -not -path 'packages/agent-core/src/__tests__/agent-loop.test.ts' -not -path 'packages/agent-core/src/__tests__/agent-integration.test.ts')

# ─── Packages Without Tests ───────────────────────────────────────────
log ""
log "=== Packages Without Tests ==="

for pkg in packages/*/; do
  pkg_name=$(basename "$pkg")
  [[ "$pkg_name" == "ai" || "$pkg_name" == "vite-plugin" ]] && continue
  test_count=$(find "$pkg" -name '*.test.*' -not -path '*/node_modules/*' 2>/dev/null | wc -l | tr -d ' ')
  if (( test_count == 0 )); then
    log "  WARN: No tests: $pkg_name"
  fi
done

# ─── Console.log in Library Code ──────────────────────────────────────
log ""
log "=== console.log in Library Code ==="

while IFS= read -r line; do
  log "  WARN: $line"
done < <(grep -rn 'console\.log(' packages/*/src/ --include='*.ts' \
  --exclude-dir=node_modules --exclude-dir=dist \
  --exclude='*.test.*' --exclude-dir=__tests__ --exclude-dir=test-helpers \
  --exclude-dir=test 2>/dev/null | grep -v 'container/server.ts' | head -30)

# ─── Summary ──────────────────────────────────────────────────────────
WARN_COUNT=$(echo "$OUTPUT" | grep -c '  WARN:' || true)

log ""
log "=== Summary ==="
log "  Warnings: $WARN_COUNT"

echo "$OUTPUT"

if [[ "$STRICT" == true ]] && (( WARN_COUNT > 0 )); then
  echo "  STRICT MODE: Failing due to $WARN_COUNT warnings"
  exit 1
fi

exit 0
