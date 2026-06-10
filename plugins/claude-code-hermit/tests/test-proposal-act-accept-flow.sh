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

# Falsification gate: must run before any session transition (guards against the
# orphaned-step regression where session-state branches jumped straight to (e)).
run_test "falsification gate present in 'Start implementing now'" \
  grep -qF "Falsification gate (runs first" "$SKILL"

run_test "falsification gate emits REJECT/PROCEED verdict" \
  bash -c "grep -qF 'REJECT' \"$SKILL\" && grep -qF 'PROCEED' \"$SKILL\""

# Quality-gate (e.5) tier-branched + NEXT-TASK template assertions.
# Guards against losing the tier branching, judge invocation, or NEXT-TASK gating.
run_test "step (e.5) references quality_gate.tier (not enabled)" \
  grep -qF "quality_gate.tier" "$SKILL"

run_test "step (e.5) invokes claude-code-hermit:quality-gate-judge in balanced branch" \
  grep -qF "claude-code-hermit:quality-gate-judge" "$SKILL"

run_test "step (e.5) has explicit budget branch (skip)" \
  bash -c "grep -qE 'budget.*(skip|never)' \"$SKILL\""

run_test "step (e.5) has explicit quality branch (always run /claude-code-hermit:simplify)" \
  bash -c "grep -qE 'quality.*(invoke|run).*/claude-code-hermit:simplify|/claude-code-hermit:simplify.*quality' \"$SKILL\""

run_test "NEXT-TASK.md gating references tier != budget" \
  bash -c "grep -qE 'tier.*budget|budget.*tier' \"$SKILL\""

run_test "/claude-code-hermit:simplify focus argument pattern preserved" \
  grep -qF "/claude-code-hermit:simplify focus on PROP-NNN implementation" "$SKILL"

run_test "NEXT-TASK template /claude-code-hermit:simplify bullet present" \
  grep -qF "Run /claude-code-hermit:simplify on the touched files" "$SKILL"

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

# Step 3c: success_signal capture and validation.
# Guards that the step exists, references eval-success-signal.js, and never blocks accept.
run_test "step 3c: success_signal step present" \
  grep -qF "3c." "$SKILL"

run_test "step 3c: references eval-success-signal.js" \
  grep -qF "eval-success-signal.js" "$SKILL"

run_test "step 3c: never blocks accept" \
  grep -qF "Never block accept" "$SKILL"

run_test "step 3c: warns on invalid predicate (logs to SHELL.md Findings)" \
  bash -c "grep -qF 'success_signal ignored' \"$SKILL\""

# PROPOSAL.md.template: success_signal field present.
TEMPLATE="$REPO_ROOT/state-templates/PROPOSAL.md.template"

run_test "PROPOSAL.md.template: success_signal frontmatter key present" \
  grep -qF "success_signal:" "$TEMPLATE"

run_test "PROPOSAL.md.template: Success Signal section present" \
  grep -qF "## Success Signal" "$TEMPLATE"

print_results
