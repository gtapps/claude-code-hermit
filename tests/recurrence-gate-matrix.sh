#!/usr/bin/env bash
# Static consistency test: verifies that every recurrence gate file contains
# the plugin-check / operator-request bypass phrases and that each gate
# documents the canonical suppress codes it can emit.
#
# What this catches: the ROP-001 class of bug where a bypass is added to one
# gate file but not the others.

set -uo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"

GATE_FILES=(
  "$REPO_DIR/agents/reflection-judge.md"
  "$REPO_DIR/agents/proposal-triage.md"
  "$REPO_DIR/skills/proposal-create/SKILL.md"
)

rc=0

# ── 1. Exception coverage ────────────────────────────────────────────────────
echo "=== Recurrence gate: exception coverage ==="

for file in "${GATE_FILES[@]}"; do
  label="$(basename "$(dirname "$file")")/$(basename "$file")"

  if ! grep -q "plugin-check" "$file"; then
    echo "FAIL [$label]: missing 'plugin-check' bypass phrase"
    rc=1
  fi

  if ! grep -q "operator-request" "$file"; then
    echo "FAIL [$label]: missing 'operator-request' bypass phrase"
    rc=1
  fi
done

# proposal-triage must also document the current-session upstream-trust rule
triage="$REPO_DIR/agents/proposal-triage.md"
if ! grep -q "current-session" "$triage"; then
  echo "FAIL [agents/proposal-triage.md]: missing 'current-session' upstream-trust phrase"
  rc=1
fi

# ── 2. Canonical suppress code vocabulary ───────────────────────────────────
echo "=== Recurrence gate: canonical suppress code vocabulary ==="

# reflection-judge owns the session-evidence codes
judge="$REPO_DIR/agents/reflection-judge.md"
for code in no-evidence no-sessions; do
  if ! grep -q "$code" "$judge"; then
    echo "FAIL [agents/reflection-judge.md]: canonical suppress code '$code' not documented"
    rc=1
  fi
done

# proposal-triage owns the three-condition codes
for code in weak-recurrence weak-consequence not-actionable; do
  if ! grep -q "$code" "$triage"; then
    echo "FAIL [agents/proposal-triage.md]: canonical suppress code '$code' not documented"
    rc=1
  fi
done

if [[ $rc -eq 0 ]]; then
  echo "PASS: all recurrence gate checks passed"
fi

exit $rc
