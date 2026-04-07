#!/usr/bin/env bash
# Hook contract tests for claude-code-hermit.
# Runs each hook script with fixture input and asserts exit code 0.
# Usage: bash tests/run-hooks.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
FIXTURES="$SCRIPT_DIR/fixtures"
ORIG_DIR="$(pwd)"

PASSED=0
FAILED=0
failures=()

run_test() {
  local name="$1"
  shift
  if "$@" >/dev/null 2>&1; then
    echo "  PASS  $name"
    ((PASSED++)) || true
  else
    local code=$?
    echo "  FAIL  $name (exit $code)"
    ((FAILED++)) || true
    failures+=("$name")
  fi
}

# Create a temp workdir with the file structure hooks expect.
# Hooks resolve paths relative to cwd.
setup_workdir() {
  local workdir
  workdir="$(mktemp -d)"
  mkdir -p "$workdir/.claude-code-hermit/sessions"
  mkdir -p "$workdir/.claude-code-hermit/state"
  mkdir -p "$workdir/.claude"
  cp "$FIXTURES/shell-session.md" "$workdir/.claude-code-hermit/sessions/SHELL.md"
  echo "$workdir"
}

# Same as setup_workdir but with a git repo (needed by session-diff).
setup_git_workdir() {
  local workdir
  workdir="$(setup_workdir)"
  (
    cd "$workdir"
    git init -q
    git -c user.name="test" -c user.email="test@test" -c commit.gpgsign=false commit -q --allow-empty -m "init"
    # Stage the existing files
    git add -A
    git -c user.name="test" -c user.email="test@test" -c commit.gpgsign=false commit -q -m "add fixtures"
    # Create a new file and stage it so git diff --name-status HEAD finds it
    echo "new" > newfile.txt
    git add newfile.txt
  )
  echo "$workdir"
}

cleanup() {
  cd "$ORIG_DIR"
  if [ -n "${workdir:-}" ] && [ -d "${workdir:-}" ]; then
    rm -rf "$workdir"
  fi
}

echo "=== Hook Contract Tests ==="
echo ""

# -------------------------------------------------------
# 1. cost-tracker — happy path
# -------------------------------------------------------
workdir="$(setup_workdir)"
cd "$workdir"
transcript="$workdir/.claude/transcript.jsonl"
cp "$FIXTURES/transcript.jsonl" "$transcript"
hook_input="$(sed "s|__TRANSCRIPT_PATH__|$transcript|" "$FIXTURES/stop-hook-input.json")"
run_test "cost-tracker" bash -c \
  "echo '$hook_input' | node '$REPO_ROOT/scripts/cost-tracker.js'"
# Post-test: verify cost-log.jsonl was created with valid JSON
run_test "cost-tracker output" bash -c \
  "[ -f '$workdir/.claude/cost-log.jsonl' ] && head -1 '$workdir/.claude/cost-log.jsonl' | python3 -m json.tool >/dev/null 2>&1"
cleanup

# -------------------------------------------------------
# 2. cost-tracker — empty stdin
# -------------------------------------------------------
workdir="$(setup_workdir)"
cd "$workdir"
run_test "cost-tracker (empty stdin)" bash -c \
  "echo '' | node '$REPO_ROOT/scripts/cost-tracker.js'"
cleanup

# -------------------------------------------------------
# 3. suggest-compact — happy path
# -------------------------------------------------------
workdir="$(setup_workdir)"
cd "$workdir"
run_test "suggest-compact" bash -c \
  "cat '$FIXTURES/stop-hook-input.json' | node '$REPO_ROOT/scripts/suggest-compact.js'"
cleanup

# -------------------------------------------------------
# 4. suggest-compact — empty stdin
# -------------------------------------------------------
workdir="$(setup_workdir)"
cd "$workdir"
run_test "suggest-compact (empty stdin)" bash -c \
  "echo '' | node '$REPO_ROOT/scripts/suggest-compact.js'"
cleanup

# -------------------------------------------------------
# 5. evaluate-session — standard profile, happy path
# -------------------------------------------------------
workdir="$(setup_workdir)"
cd "$workdir"
run_test "evaluate-session (standard)" bash -c \
  "echo '{}' | AGENT_HOOK_PROFILE=standard node '$REPO_ROOT/scripts/evaluate-session.js'"
cleanup

# -------------------------------------------------------
# 6. evaluate-session — minimal profile (should skip)
# -------------------------------------------------------
workdir="$(setup_workdir)"
cd "$workdir"
run_test "evaluate-session (minimal skip)" bash -c \
  "echo '{}' | AGENT_HOOK_PROFILE=minimal node '$REPO_ROOT/scripts/evaluate-session.js'"
cleanup

# -------------------------------------------------------
# 7. evaluate-session — empty stdin
# -------------------------------------------------------
workdir="$(setup_workdir)"
cd "$workdir"
run_test "evaluate-session (empty stdin)" bash -c \
  "echo '' | AGENT_HOOK_PROFILE=standard node '$REPO_ROOT/scripts/evaluate-session.js'"
cleanup

# -------------------------------------------------------
# 8. run-with-profile — profile matches
# -------------------------------------------------------
workdir="$(setup_workdir)"
cd "$workdir"
run_test "run-with-profile (match)" bash -c \
  "echo '{}' | AGENT_HOOK_PROFILE=standard CLAUDE_PLUGIN_ROOT='$REPO_ROOT' node '$REPO_ROOT/scripts/run-with-profile.js' standard,strict scripts/evaluate-session.js"
cleanup

# -------------------------------------------------------
# 9. run-with-profile — profile does not match
# -------------------------------------------------------
workdir="$(setup_workdir)"
cd "$workdir"
run_test "run-with-profile (no match)" bash -c \
  "echo '{}' | AGENT_HOOK_PROFILE=minimal CLAUDE_PLUGIN_ROOT='$REPO_ROOT' node '$REPO_ROOT/scripts/run-with-profile.js' standard,strict scripts/evaluate-session.js"
cleanup

# -------------------------------------------------------
# 10. session-diff — happy path (needs git repo)
# -------------------------------------------------------
workdir="$(setup_git_workdir)"
cd "$workdir"
run_test "session-diff" bash -c \
  "echo '{}' | AGENT_HOOK_PROFILE=standard CLAUDE_PLUGIN_ROOT='$REPO_ROOT' node '$REPO_ROOT/scripts/run-with-profile.js' standard,strict scripts/session-diff.js"
# Post-test: verify sidecar JSON was written with changed_files
run_test "session-diff sidecar" bash -c \
  "[ -f '$workdir/.claude-code-hermit/state/session-diff.json' ] && python3 -m json.tool '$workdir/.claude-code-hermit/state/session-diff.json' >/dev/null"
cleanup

# -------------------------------------------------------
# 11. session-diff — empty stdin (needs git repo)
# -------------------------------------------------------
workdir="$(setup_git_workdir)"
cd "$workdir"
run_test "session-diff (empty stdin)" bash -c \
  "echo '' | AGENT_HOOK_PROFILE=standard CLAUDE_PLUGIN_ROOT='$REPO_ROOT' node '$REPO_ROOT/scripts/run-with-profile.js' standard,strict scripts/session-diff.js"
cleanup

# -------------------------------------------------------
# 12. check-upgrade.sh
# -------------------------------------------------------
workdir="$(setup_workdir)"
cd "$workdir"
# Create a minimal config.json for check-upgrade to read
echo '{"_hermit_versions":{"claude-code-hermit":"0.0.0"}}' > "$workdir/.claude-code-hermit/config.json"
# Run once, capture output, assert both exit code and content
upgrade_out="$(bash "$REPO_ROOT/scripts/check-upgrade.sh" "$REPO_ROOT" 2>&1)" || true
run_test "check-upgrade.sh" bash -c "[ -n '$upgrade_out' ]"
run_test "check-upgrade output" bash -c "echo '$upgrade_out' | grep -qF -- '---Upgrade Available---'"
cleanup

# -------------------------------------------------------
# 13. enforce-deny-patterns — blocks dangerous Bash command
# -------------------------------------------------------
workdir="$(setup_workdir)"
cd "$workdir"
run_test "enforce-deny-patterns (block rm -rf)" bash -c \
  "echo '{\"tool_name\":\"Bash\",\"tool_input\":{\"command\":\"rm -rf /\"}}' | CLAUDE_PLUGIN_ROOT='$REPO_ROOT' node '$REPO_ROOT/scripts/enforce-deny-patterns.js' 2>/dev/null; [ \$? -eq 2 ]"
cleanup

# -------------------------------------------------------
# 14. enforce-deny-patterns — allows safe command
# -------------------------------------------------------
workdir="$(setup_workdir)"
cd "$workdir"
run_test "enforce-deny-patterns (allow safe)" bash -c \
  "echo '{\"tool_name\":\"Bash\",\"tool_input\":{\"command\":\"ls -la\"}}' | CLAUDE_PLUGIN_ROOT='$REPO_ROOT' node '$REPO_ROOT/scripts/enforce-deny-patterns.js'"
cleanup

# -------------------------------------------------------
# 15. enforce-deny-patterns — blocks OPERATOR.md edit
# -------------------------------------------------------
workdir="$(setup_workdir)"
cd "$workdir"
run_test "enforce-deny-patterns (block OPERATOR.md)" bash -c \
  "echo '{\"tool_name\":\"Edit\",\"tool_input\":{\"file_path\":\".claude-code-hermit/OPERATOR.md\"}}' | CLAUDE_PLUGIN_ROOT='$REPO_ROOT' node '$REPO_ROOT/scripts/enforce-deny-patterns.js' 2>/dev/null; [ \$? -eq 2 ]"
cleanup

# -------------------------------------------------------
# 16. enforce-deny-patterns — empty stdin
# -------------------------------------------------------
workdir="$(setup_workdir)"
cd "$workdir"
run_test "enforce-deny-patterns (empty stdin)" bash -c \
  "echo '' | CLAUDE_PLUGIN_ROOT='$REPO_ROOT' node '$REPO_ROOT/scripts/enforce-deny-patterns.js'"
cleanup

# -------------------------------------------------------
# 17. channel-hook — persists dm_channel_id
# -------------------------------------------------------
workdir="$(setup_workdir)"
cd "$workdir"
echo '{"channels":{"discord":{"enabled":true,"dm_channel_id":null}}}' > "$workdir/.claude-code-hermit/config.json"
run_test "channel-hook (persist dm_channel_id)" bash -c \
  "echo '{\"tool_name\":\"mcp__discord__reply\",\"tool_input\":{\"chat_id\":\"123456\"}}' | node '$REPO_ROOT/scripts/channel-hook.js' 2>/dev/null && python3 -c \"import json; c=json.load(open('$workdir/.claude-code-hermit/config.json')); assert c['channels']['discord']['dm_channel_id']=='123456', c\""
cleanup

# -------------------------------------------------------
# 18. channel-hook — skips unconfigured channel
# -------------------------------------------------------
workdir="$(setup_workdir)"
cd "$workdir"
echo '{"channels":{}}' > "$workdir/.claude-code-hermit/config.json"
run_test "channel-hook (skip unconfigured)" bash -c \
  "echo '{\"tool_name\":\"mcp__discord__reply\",\"tool_input\":{\"chat_id\":\"123456\"}}' | node '$REPO_ROOT/scripts/channel-hook.js' 2>/dev/null && python3 -c \"import json; c=json.load(open('$workdir/.claude-code-hermit/config.json')); assert 'discord' not in c['channels'], c\""
cleanup

# -------------------------------------------------------
# 19. channel-hook — writes channel-activity.json
# -------------------------------------------------------
workdir="$(setup_workdir)"
cd "$workdir"
echo '{"channels":{"discord":{"enabled":true}}}' > "$workdir/.claude-code-hermit/config.json"
run_test "channel-hook (activity file)" bash -c \
  "echo '{\"tool_name\":\"mcp__discord__reply\",\"tool_input\":{\"chat_id\":\"999\"}}' | node '$REPO_ROOT/scripts/channel-hook.js' 2>/dev/null && python3 -c \"import json; a=json.load(open('$workdir/.claude-code-hermit/state/channel-activity.json')); assert 'last_reply_at' in a['discord'], a\""
cleanup

# -------------------------------------------------------
# 20. channel-hook — plugin_ prefix (channel plugin format)
# -------------------------------------------------------
workdir="$(setup_workdir)"
cd "$workdir"
echo '{"channels":{"discord":{"enabled":true,"dm_channel_id":null}}}' > "$workdir/.claude-code-hermit/config.json"
run_test "channel-hook (plugin_ prefix)" bash -c \
  "echo '{\"tool_name\":\"plugin_discord_discord_reply\",\"tool_input\":{\"chat_id\":\"789\"}}' | node '$REPO_ROOT/scripts/channel-hook.js' 2>/dev/null && python3 -c \"import json; c=json.load(open('$workdir/.claude-code-hermit/config.json')); assert c['channels']['discord']['dm_channel_id']=='789', c\""
cleanup

# -------------------------------------------------------
# 21. channel-hook — empty stdin
# -------------------------------------------------------
workdir="$(setup_workdir)"
cd "$workdir"
run_test "channel-hook (empty stdin)" bash -c \
  "echo '' | node '$REPO_ROOT/scripts/channel-hook.js'"
cleanup

# -------------------------------------------------------
# 21. validate-config — valid config passes
# -------------------------------------------------------
workdir="$(setup_workdir)"
cd "$workdir"
cat > "$workdir/.claude-code-hermit/config.json" << 'CFGEOF'
{"agent_name":null,"language":null,"timezone":null,"escalation":"balanced","channels":{},"env":{},"heartbeat":{"enabled":true,"active_hours":{"start":"08:00","end":"23:00"}},"routines":[{"id":"test","time":"04:00","skill":"x:y","enabled":true}]}
CFGEOF
run_test "validate-config (valid)" bash -c \
  "echo '{\"tool_name\":\"Edit\",\"tool_input\":{\"file_path\":\"$workdir/.claude-code-hermit/config.json\"}}' | node '$REPO_ROOT/scripts/validate-config.js'"
cleanup

# -------------------------------------------------------
# 22. validate-config — invalid config fails
# -------------------------------------------------------
workdir="$(setup_workdir)"
cd "$workdir"
echo '{"agent_name":null}' > "$workdir/.claude-code-hermit/config.json"
run_test "validate-config (invalid)" bash -c \
  "echo '{\"tool_name\":\"Edit\",\"tool_input\":{\"file_path\":\"$workdir/.claude-code-hermit/config.json\"}}' | node '$REPO_ROOT/scripts/validate-config.js' 2>/dev/null; [ \$? -eq 2 ]"
cleanup

# -------------------------------------------------------
# 23. validate-config — skips non-config files
# -------------------------------------------------------
workdir="$(setup_workdir)"
cd "$workdir"
run_test "validate-config (skip non-config)" bash -c \
  "echo '{\"tool_name\":\"Edit\",\"tool_input\":{\"file_path\":\"/some/other/file.js\"}}' | node '$REPO_ROOT/scripts/validate-config.js'"
cleanup

# -------------------------------------------------------
# 24. validate-config — empty stdin
# -------------------------------------------------------
workdir="$(setup_workdir)"
cd "$workdir"
run_test "validate-config (empty stdin)" bash -c \
  "echo '' | node '$REPO_ROOT/scripts/validate-config.js'"
cleanup

# -------------------------------------------------------
# 25. routine-queue-flush — logs missed routines
# -------------------------------------------------------
workdir="$(setup_workdir)"
cd "$workdir"
echo '[{"id":"heartbeat-restart","skill":"x:heartbeat start","queued_since":"2026-04-07T04:00:00Z"}]' > "$workdir/.claude-code-hermit/state/routine-queue.json"
run_test "routine-queue-flush (log missed)" bash -c \
  "echo '{}' | node '$REPO_ROOT/scripts/routine-queue-flush.js' 2>/dev/null && grep -q 'heartbeat-restart' '$workdir/.claude-code-hermit/sessions/SHELL.md'"
cleanup

# -------------------------------------------------------
# 26. routine-queue-flush — empty queue
# -------------------------------------------------------
workdir="$(setup_workdir)"
cd "$workdir"
echo '[]' > "$workdir/.claude-code-hermit/state/routine-queue.json"
run_test "routine-queue-flush (empty queue)" bash -c \
  "echo '{}' | node '$REPO_ROOT/scripts/routine-queue-flush.js'"
cleanup

# -------------------------------------------------------
# 27. routine-queue-flush — no queue file
# -------------------------------------------------------
workdir="$(setup_workdir)"
cd "$workdir"
run_test "routine-queue-flush (no queue file)" bash -c \
  "echo '{}' | node '$REPO_ROOT/scripts/routine-queue-flush.js'"
cleanup

# -------------------------------------------------------
# 28. routine-queue-flush — empty stdin
# -------------------------------------------------------
workdir="$(setup_workdir)"
cd "$workdir"
run_test "routine-queue-flush (empty stdin)" bash -c \
  "echo '' | node '$REPO_ROOT/scripts/routine-queue-flush.js'"
cleanup

# -------------------------------------------------------
# Static file checks
# -------------------------------------------------------

# deny-patterns.json: valid JSON with expected arrays
run_test "deny-patterns.json" bash -c \
  "python3 -c \"import json; d=json.load(open('$REPO_ROOT/state-templates/deny-patterns.json')); assert isinstance(d.get('default'),list) and isinstance(d.get('always_on'),list)\""

# Bin scripts are executable
run_test "bin scripts executable" bash -c \
  "for f in '$REPO_ROOT/state-templates/bin/'*; do [ -x \"\$f\" ] || exit 1; done"

# routine-watcher jq filter: invalid time format produces no match, no crash
run_test "routine-watcher jq filter" bash -c \
  "echo '{\"routines\":[{\"id\":\"test\",\"time\":\"99:99\",\"enabled\":true,\"skill\":\"x:y\"}]}' | jq -r --arg t '08:00' --arg d 'mon' '.routines[]? | select(.enabled==true) | select(.time==\$t) | .id' | wc -l | grep -q '^0$'"

# -------------------------------------------------------
# Summary
# -------------------------------------------------------
echo ""
echo "=== Results: $PASSED passed, $FAILED failed ==="
if [ ${#failures[@]} -gt 0 ]; then
  echo "Failed:"
  for f in "${failures[@]}"; do
    echo "  - $f"
  done
  # Clean suggest-compact counter files left in /tmp (local runs)
  rm -rf /tmp/claude-agent-compact-*/counter-test-session-*.txt 2>/dev/null || true
  exit 1
fi

# Clean suggest-compact counter files left in /tmp (local runs)
rm -rf /tmp/claude-agent-compact-*/counter-test-session-*.txt 2>/dev/null || true
