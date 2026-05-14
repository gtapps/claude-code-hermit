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

# Quality-gate (e.5) tier-branched + NEXT-TASK template assertions.
# Guards against losing the tier branching, judge invocation, or NEXT-TASK gating.
run_test "step (e.5) references quality_gate.tier (not enabled)" \
  grep -qF "quality_gate.tier" "$SKILL"

run_test "step (e.5) invokes claude-code-hermit:quality-gate-judge in balanced branch" \
  grep -qF "claude-code-hermit:quality-gate-judge" "$SKILL"

run_test "step (e.5) has explicit budget branch (skip)" \
  bash -c "grep -qE 'budget.*(skip|never)' \"$SKILL\""

run_test "step (e.5) has explicit quality branch (always run /simplify)" \
  bash -c "grep -qE 'quality.*(invoke|run).*/simplify|/simplify.*quality' \"$SKILL\""

run_test "NEXT-TASK.md gating references tier != budget" \
  bash -c "grep -qE 'tier.*budget|budget.*tier' \"$SKILL\""

run_test "/simplify focus argument pattern preserved" \
  grep -qF "/simplify focus on PROP-NNN implementation" "$SKILL"

run_test "NEXT-TASK template /simplify bullet present" \
  grep -qF "Run /simplify on the touched files" "$SKILL"

# Quality-gate-judge subagent: file existence + frontmatter.
JUDGE="$REPO_ROOT/agents/quality-gate-judge.md"

run_test "quality-gate-judge subagent file exists" test -f "$JUDGE"

JUDGE_FRONTMATTER="$(awk '/^---$/{c++; next} c==1' "$JUDGE")"

run_test "quality-gate-judge name field" \
  bash -c 'echo "$1" | grep -q "^name: quality-gate-judge"' -- "$JUDGE_FRONTMATTER"

run_test "quality-gate-judge uses haiku model" \
  bash -c 'echo "$1" | grep -q "^model: haiku"' -- "$JUDGE_FRONTMATTER"

# Frontmatter description specifically (between the opening --- and the second ---).
FRONTMATTER="$(awk '/^---$/{c++; next} c==1' "$SKILL")"
run_test "frontmatter description mentions 'start implementing now'" \
  bash -c 'echo "$1" | grep -q "^description:.*start implementing now"' -- "$FRONTMATTER"

print_results
