#!/usr/bin/env bash
# Contract tests for /steer and /done skills (PROP-031, v1.1.0).
# Verifies SKILL.md content invariants — no LLM execution needed.
# Usage: bash tests/test-done-orient-skills.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/lib.sh"

echo "=== /steer and /done skill contract tests ==="
echo ""

STEER="$REPO_ROOT/skills/steer/SKILL.md"
DONE_SKILL="$REPO_ROOT/skills/done/SKILL.md"

# -------------------------------------------------------
# /steer
# -------------------------------------------------------
run_test "/steer SKILL.md exists" test -f "$STEER"
run_test "/steer has 'name: steer' frontmatter" grep -q "^name: steer$" "$STEER"
run_test "/steer takes positional focus text" grep -q "positional.*focus\|focus text" "$STEER"
run_test "/steer describes process-died check" grep -qi "process-died check\|tmux session is NOT alive" "$STEER"
run_test "/steer describes unclean-shutdown check via timestamps" grep -q "shutdown_requested_at\|shutdown_completed_at" "$STEER"
run_test "/steer describes recovery (1)/(2) prompt" grep -q "(1) to drop\|(2) to resume" "$STEER"
run_test "/steer ignores retired fields silently" grep -qi "retired field\|silently" "$STEER"
run_test "/steer daily counter reset" grep -q "last_counter_reset\|counter reset" "$STEER"
run_test "/steer references focus-mgr (not session-mgr)" bash -c \
  "grep -q 'claude-code-hermit:focus-mgr' '$STEER' && ! grep -q 'claude-code-hermit:session-mgr' '$STEER'"

# -------------------------------------------------------
# /done
# -------------------------------------------------------
run_test "/done SKILL.md exists" test -f "$DONE_SKILL"
run_test "/done has 'name: done' frontmatter" grep -q "^name: done$" "$DONE_SKILL"
run_test "/done describes --shutdown flag" grep -q "\\-\\-shutdown" "$DONE_SKILL"
run_test "/done appends to Recent Activity" grep -qi "Recent Activity" "$DONE_SKILL"
run_test "/done clears Focus" grep -qi "Clear .*Focus\|## Focus.*Awaiting next focus" "$DONE_SKILL"
run_test "/done sets session_state idle" grep -q "session_state.*idle" "$DONE_SKILL"
run_test "/done does NOT fire reflect" grep -q "Fire reflect" "$DONE_SKILL"
run_test "/done does NOT generate S-NNN report" grep -q "Generate an S-NNN report" "$DONE_SKILL"
run_test "/done references focus-mgr (not session-mgr)" bash -c \
  "grep -q 'claude-code-hermit:focus-mgr' '$DONE_SKILL' && ! grep -q 'claude-code-hermit:session-mgr' '$DONE_SKILL'"

# -------------------------------------------------------
# Alias shims
# -------------------------------------------------------
SESSION_START="$REPO_ROOT/skills/session-start/SKILL.md"
SESSION_CLOSE="$REPO_ROOT/skills/session-close/SKILL.md"
SESSION="$REPO_ROOT/skills/session/SKILL.md"

run_test "session-start shim invokes /steer" grep -q "claude-code-hermit:steer" "$SESSION_START"
run_test "session-start shim mentions deprecation" grep -qi "renamed\|alias\|backwards-compat" "$SESSION_START"
run_test "session-close shim invokes /done --shutdown" grep -q "claude-code-hermit:done --shutdown" "$SESSION_CLOSE"
run_test "session shim invokes /done" grep -q "claude-code-hermit:done" "$SESSION"

# -------------------------------------------------------
# focus-mgr agent
# -------------------------------------------------------
FOCUS_MGR="$REPO_ROOT/agents/focus-mgr.md"
run_test "focus-mgr agent exists" test -f "$FOCUS_MGR"
run_test "focus-mgr has 'name: focus-mgr' frontmatter" grep -q "^name: focus-mgr$" "$FOCUS_MGR"
run_test "focus-mgr describes Recent Activity write" grep -qi "Recent Activity" "$FOCUS_MGR"
run_test "focus-mgr describes compaction" grep -qi "compact" "$FOCUS_MGR"
run_test "focus-mgr describes migration helper" grep -qi "migration\|v1.1.0" "$FOCUS_MGR"
run_test "session-mgr agent removed" bash -c "[ ! -f '$REPO_ROOT/agents/session-mgr.md' ]"

print_results
