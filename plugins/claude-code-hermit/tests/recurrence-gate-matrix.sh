#!/usr/bin/env bash
# Static consistency test: verifies that every recurrence gate file contains
# the scheduled-check / operator-request bypass phrases and that each gate
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

  if ! grep -q "scheduled-check" "$file"; then
    echo "FAIL [$label]: missing 'scheduled-check' bypass phrase"
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

# proposal-triage status-aware dedup (#159): closed-status branch must demote
# accepted/resolved matches to closest_prop and never to DUPLICATE; the
# "same problem" guard must explicitly reject shared-infrastructure suppression.
if ! grep -q '`accepted` or `resolved`' "$triage"; then
  echo "FAIL [agents/proposal-triage.md]: missing closed-status (accepted/resolved) dedup branch"
  rc=1
fi
if ! grep -q "Shared infrastructure" "$triage"; then
  echo "FAIL [agents/proposal-triage.md]: missing 'Shared infrastructure' same-problem guard"
  rc=1
fi

# ── 3. DOWNGRADE grammar ────────────────────────────────────────────────────
echo "=== Recurrence gate: DOWNGRADE grammar ==="

# Only reflection-judge emits DOWNGRADE; proposal-triage output is CREATE|SUPPRESS|DUPLICATE
if ! grep -q "DOWNGRADE" "$judge"; then
  echo "FAIL [agents/reflection-judge.md]: no DOWNGRADE example in verdict grammar"
  rc=1
fi

# ── 4. Verdict-tag coverage in judge output examples ────────────────────────
echo "=== Recurrence gate: verdict-tag coverage ==="

for tag in "current-session" "scheduled-check" "operator-request"; do
  if ! grep -q "($tag)" "$judge"; then
    echo "FAIL [agents/reflection-judge.md]: no example verdict line with source tag '($tag)'"
    rc=1
  fi
done

# ── 5. External-origin quarantine vocabulary ─────────────────────────────────
echo "=== External-origin quarantine: vocabulary coverage ==="

# reflect is the tagging site — must define external-content and own-work
reflect="$REPO_DIR/skills/reflect/SKILL.md"
if ! grep -q "external-content" "$reflect"; then
  echo "FAIL [skills/reflect/SKILL.md]: missing 'external-content' quarantine vocabulary"
  rc=1
fi

# All gate files must document Evidence Origin / external-content
for file in "${GATE_FILES[@]}"; do
  label="$(basename "$(dirname "$file")")/$(basename "$file")"
  if ! grep -q "external-content" "$file"; then
    echo "FAIL [$label]: missing 'external-content' quarantine vocabulary"
    rc=1
  fi
  if ! grep -q "Evidence Origin" "$file"; then
    echo "FAIL [$label]: missing 'Evidence Origin' field documentation"
    rc=1
  fi
  if [[ "$file" == "$judge" ]] && ! grep -q "quarantine" "$file"; then
    echo "FAIL [agents/reflection-judge.md]: missing 'quarantine' escalation reason in verdict examples"
    rc=1
  fi
done

if [[ $rc -eq 0 ]]; then
  echo "PASS: all recurrence gate checks passed"
fi

exit $rc
