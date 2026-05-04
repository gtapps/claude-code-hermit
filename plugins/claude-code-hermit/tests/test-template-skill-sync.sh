#!/usr/bin/env bash
# Template-skill sync test.
#
# Asserts every top-level key in state-templates/config.json.template appears
# somewhere in skills/hatch/SKILL.md. Hatch overlays operator choices onto the
# template; if a new field is added to the template but never referenced in
# hatch's text, Quick mode silently drops it from operator configs.
#
# Scope: monorepo-internal only. Verifies that two of OUR shipping files stay
# in sync with each other. Does NOT enforce a schema on operator-owned
# .claude-code-hermit/config.json — operators can add custom keys, remove
# fields, or hand-edit anytime. The test never reads operator state.
#
# Usage: bash tests/test-template-skill-sync.sh
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/lib.sh"

echo "=== Template-Skill Sync Tests ==="
echo ""

TEMPLATE="$REPO_ROOT/state-templates/config.json.template"
SKILL="$REPO_ROOT/skills/hatch/SKILL.md"

run_test "template file exists" test -f "$TEMPLATE"
run_test "skill file exists"    test -f "$SKILL"

# Extract top-level keys from the template using python's json module
# (avoids jq dependency; python3 is already required by run-contracts.py).
mapfile -t TEMPLATE_KEYS < <(
  python3 -c '
import json, sys
with open(sys.argv[1]) as f:
    data = json.load(f)
for k in data.keys():
    print(k)
' "$TEMPLATE"
)

if [ "${#TEMPLATE_KEYS[@]}" -eq 0 ]; then
  echo "  FAIL  could not parse top-level keys from template"
  ((FAILED++)) || true
  failures+=("template parse")
  print_results
  exit 1
fi

# Cache skill content once — avoids N file reads in the loop below.
SKILL_CONTENT=$(< "$SKILL")

# For each top-level key, assert it appears at least once in the skill text.
# We grep for the bare key name — if the skill mentions it (in the overlay
# table, in prose, in code blocks), the key is "known" to hatch.
for key in "${TEMPLATE_KEYS[@]}"; do
  run_test "skill references key '$key' from template" \
    grep -qF "$key" <<< "$SKILL_CONTENT"
done

print_results
