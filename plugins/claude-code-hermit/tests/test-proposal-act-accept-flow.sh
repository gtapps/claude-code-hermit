#!/usr/bin/env bash
# Regression: proposal-act Accept Flow lists all three implementation options.
#
# Guards against losing any branch or the description tweak in a future edit.
# Runs from inside plugins/claude-code-hermit/ (REPO_ROOT = that directory).
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=lib.sh
source "$SCRIPT_DIR/lib.sh"

echo "=== proposal-act accept flow tests ==="
echo ""

SKILL="$REPO_ROOT/skills/proposal-act/SKILL.md"

run_test "skill file exists" test -f "$SKILL"

# All three options present in the Accept Flow body.
run_test "'Start implementing now' option present" \
  grep -qF "Start implementing now" "$SKILL"

run_test "'Start implementing now' marked as default" \
  grep -qF "default, typical answer" "$SKILL"

run_test "'Create a session task' option present" \
  grep -qF "Create a session task" "$SKILL"

run_test "'I'll handle it manually' option present" \
  grep -qF "I'll handle it manually" "$SKILL"

# Frontmatter description specifically (between the opening --- and the second ---).
FRONTMATTER="$(awk '/^---$/{c++; next} c==1' "$SKILL")"
run_test "frontmatter description mentions 'start implementing now'" \
  bash -c 'echo "$1" | grep -q "^description:.*start implementing now"' -- "$FRONTMATTER"

print_results
