#!/usr/bin/env bash
# hatch-options.json contract test.
#
# Asserts:
# 1. state-templates/GITIGNORE-APPEND.txt contains the new local-file entries.
# 2. Every consumer of hatch-options.json references the same canonical path
#    AND the "target" field name. Catches regressions like a typo in a path
#    (.claude-code-hermit/state/hatch-options.json) or renaming the field
#    in one consumer without updating the others.
#
# Scope: monorepo-internal. Reads two of OUR shipping files and the
# sibling dev-hermit skill.
#
# Usage: bash tests/test-hatch-options-contract.sh
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/lib.sh"

echo "=== hatch-options.json Contract Tests ==="
echo ""

GITIGNORE_TEMPLATE="$REPO_ROOT/state-templates/GITIGNORE-APPEND.txt"

run_test "GITIGNORE-APPEND.txt exists" test -f "$GITIGNORE_TEMPLATE"
run_test "GITIGNORE-APPEND.txt lists CLAUDE.local.md" \
  grep -qxF "CLAUDE.local.md" "$GITIGNORE_TEMPLATE"
run_test "GITIGNORE-APPEND.txt lists .claude/settings.local.json" \
  grep -qxF ".claude/settings.local.json" "$GITIGNORE_TEMPLATE"

CANONICAL_PATH=".claude-code-hermit/state/hatch-options.json"
TARGET_KEY='"target"'

# Producer + readers in core.
CORE_CONSUMERS=(
  "skills/hatch/SKILL.md"
  "skills/hermit-evolve/SKILL.md"
  "skills/docker-setup/SKILL.md"
  "skills/migrate/SKILL.md"
)

for rel in "${CORE_CONSUMERS[@]}"; do
  f="$REPO_ROOT/$rel"
  run_test "$rel exists" test -f "$f"
  run_test "$rel references $CANONICAL_PATH" \
    grep -qF "$CANONICAL_PATH" "$f"
  run_test "$rel references $TARGET_KEY field" \
    grep -qF "$TARGET_KEY" "$f"
done

# Sibling plugin: dev-hermit's hatch reads the same state file.
DEV_HATCH="$REPO_ROOT/../claude-code-dev-hermit/skills/hatch/SKILL.md"
run_test "dev-hermit:hatch skill exists" test -f "$DEV_HATCH"
run_test "dev-hermit:hatch references $CANONICAL_PATH" \
  grep -qF "$CANONICAL_PATH" "$DEV_HATCH"
run_test "dev-hermit:hatch references $TARGET_KEY field" \
  grep -qF "$TARGET_KEY" "$DEV_HATCH"

print_results
