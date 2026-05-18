#!/usr/bin/env bash
# Channel-responder reply-rule contract test.
#
# Asserts that the §0 reply-via-channel contract is present in the
# channel-responder skill, that the hook is registered in hooks.json, and
# that the hook script exists. Prevents silent regressions on future
# SKILL.md rewrites or hooks.json edits.
#
# Usage: bash tests/test-channel-responder-reply-rule.sh
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/lib.sh"

echo "=== Channel-Responder Reply-Rule Contract Tests ==="
echo ""

SKILL="$REPO_ROOT/skills/channel-responder/SKILL.md"
HOOKS="$REPO_ROOT/hooks/hooks.json"
SCRIPT="$REPO_ROOT/scripts/channel-reply-reminder.js"

run_test "skill file exists" test -f "$SKILL"
run_test "skill has §0 heading" grep -qF "## 0." "$SKILL"
run_test "skill §0 names reply via channel" grep -q "Reply via the channel" "$SKILL"
run_test "skill §0 names generic reply tool pattern" grep -q "mcp__plugin_" "$SKILL"
run_test "hooks.json has channel-reply-reminder entry" grep -qF "channel-reply-reminder.js" "$HOOKS"
run_test "channel-reply-reminder.js exists and is non-empty" test -s "$SCRIPT"

print_results
