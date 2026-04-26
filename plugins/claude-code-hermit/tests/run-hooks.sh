#!/usr/bin/env bash
# Hook contract tests for claude-code-hermit.
# Tests every script registered in hooks/hooks.json plus their stop-pipeline sub-stages.
# Usage: bash tests/run-hooks.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/lib.sh"

echo "=== Hook Contract Tests ==="
echo ""

# -------------------------------------------------------
# 1. cost-tracker — empty stdin (fail-open)
# -------------------------------------------------------
workdir="$(setup_workdir)"
cd "$workdir"
run_test "cost-tracker (empty stdin)" bash -c \
  "echo '' | node '$REPO_ROOT/scripts/cost-tracker.js'"
cleanup

# -------------------------------------------------------
# 2. suggest-compact — happy path
# -------------------------------------------------------
workdir="$(setup_workdir)"
cd "$workdir"
run_test "suggest-compact" bash -c \
  "cat '$FIXTURES/stop-hook-input.json' | node '$REPO_ROOT/scripts/suggest-compact.js'"
cleanup

# -------------------------------------------------------
# 3. suggest-compact — empty stdin
# -------------------------------------------------------
workdir="$(setup_workdir)"
cd "$workdir"
run_test "suggest-compact (empty stdin)" bash -c \
  "echo '' | node '$REPO_ROOT/scripts/suggest-compact.js'"
cleanup

# -------------------------------------------------------
# 4. evaluate-session — empty stdin (fail-open)
# -------------------------------------------------------
workdir="$(setup_workdir)"
cd "$workdir"
run_test "evaluate-session (empty stdin)" bash -c \
  "echo '' | AGENT_HOOK_PROFILE=standard node '$REPO_ROOT/scripts/evaluate-session.js'"
cleanup

# -------------------------------------------------------
# 5. run-with-profile — profile matches
# -------------------------------------------------------
workdir="$(setup_workdir)"
cd "$workdir"
run_test "run-with-profile (match)" bash -c \
  "echo '{}' | AGENT_HOOK_PROFILE=standard CLAUDE_PLUGIN_ROOT='$REPO_ROOT' node '$REPO_ROOT/scripts/run-with-profile.js' standard,strict scripts/evaluate-session.js"
cleanup

# -------------------------------------------------------
# 6. run-with-profile — profile does not match
# -------------------------------------------------------
workdir="$(setup_workdir)"
cd "$workdir"
run_test "run-with-profile (no match)" bash -c \
  "echo '{}' | AGENT_HOOK_PROFILE=minimal CLAUDE_PLUGIN_ROOT='$REPO_ROOT' node '$REPO_ROOT/scripts/run-with-profile.js' standard,strict scripts/evaluate-session.js"
cleanup

# -------------------------------------------------------
# 7. session-diff — happy path (needs git repo)
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
# 8. session-diff — empty stdin (needs git repo)
# -------------------------------------------------------
workdir="$(setup_git_workdir)"
cd "$workdir"
run_test "session-diff (empty stdin)" bash -c \
  "echo '' | AGENT_HOOK_PROFILE=standard CLAUDE_PLUGIN_ROOT='$REPO_ROOT' node '$REPO_ROOT/scripts/run-with-profile.js' standard,strict scripts/session-diff.js"
cleanup

# -------------------------------------------------------
# 9. enforce-deny-patterns — blocks dangerous Bash command
# -------------------------------------------------------
workdir="$(setup_workdir)"
cd "$workdir"
run_test "enforce-deny-patterns (block rm -rf)" bash -c \
  "echo '{\"tool_name\":\"Bash\",\"tool_input\":{\"command\":\"rm -rf /\"}}' | CLAUDE_PLUGIN_ROOT='$REPO_ROOT' node '$REPO_ROOT/scripts/enforce-deny-patterns.js' 2>/dev/null; [ \$? -eq 2 ]"
cleanup

# -------------------------------------------------------
# 10. enforce-deny-patterns — allows safe command
# -------------------------------------------------------
workdir="$(setup_workdir)"
cd "$workdir"
run_test "enforce-deny-patterns (allow safe)" bash -c \
  "echo '{\"tool_name\":\"Bash\",\"tool_input\":{\"command\":\"ls -la\"}}' | CLAUDE_PLUGIN_ROOT='$REPO_ROOT' node '$REPO_ROOT/scripts/enforce-deny-patterns.js'"
cleanup

# -------------------------------------------------------
# 11. enforce-deny-patterns — blocks OPERATOR.md edit in always-on
# -------------------------------------------------------
workdir="$(setup_workdir)"
cd "$workdir"
run_test "enforce-deny-patterns (block OPERATOR.md always-on)" bash -c \
  "echo '{\"tool_name\":\"Edit\",\"tool_input\":{\"file_path\":\".claude-code-hermit/OPERATOR.md\"}}' | AGENT_HOOK_PROFILE=strict CLAUDE_PLUGIN_ROOT='$REPO_ROOT' node '$REPO_ROOT/scripts/enforce-deny-patterns.js' 2>/dev/null; [ \$? -eq 2 ]"
run_test "enforce-deny-patterns (allow OPERATOR.md interactive)" bash -c \
  "echo '{\"tool_name\":\"Edit\",\"tool_input\":{\"file_path\":\".claude-code-hermit/OPERATOR.md\"}}' | AGENT_HOOK_PROFILE=standard CLAUDE_PLUGIN_ROOT='$REPO_ROOT' node '$REPO_ROOT/scripts/enforce-deny-patterns.js' 2>/dev/null; [ \$? -eq 0 ]"
cleanup

# -------------------------------------------------------
# 12. enforce-deny-patterns — empty stdin
# -------------------------------------------------------
workdir="$(setup_workdir)"
cd "$workdir"
run_test "enforce-deny-patterns (empty stdin)" bash -c \
  "echo '' | CLAUDE_PLUGIN_ROOT='$REPO_ROOT' node '$REPO_ROOT/scripts/enforce-deny-patterns.js'"
cleanup

# -------------------------------------------------------
# 13. channel-hook — persists dm_channel_id
# -------------------------------------------------------
workdir="$(setup_workdir)"
cd "$workdir"
echo '{"channels":{"discord":{"enabled":true,"dm_channel_id":null}}}' > "$workdir/.claude-code-hermit/config.json"
run_test "channel-hook (persist dm_channel_id)" bash -c \
  "echo '{\"tool_name\":\"mcp__discord__reply\",\"tool_input\":{\"chat_id\":\"123456\"}}' | node '$REPO_ROOT/scripts/channel-hook.js' 2>/dev/null && python3 -c \"import json; c=json.load(open('$workdir/.claude-code-hermit/config.json')); assert c['channels']['discord']['dm_channel_id']=='123456', c\""
cleanup

# -------------------------------------------------------
# 14. channel-hook — skips unconfigured channel
# -------------------------------------------------------
workdir="$(setup_workdir)"
cd "$workdir"
echo '{"channels":{}}' > "$workdir/.claude-code-hermit/config.json"
run_test "channel-hook (skip unconfigured)" bash -c \
  "echo '{\"tool_name\":\"mcp__discord__reply\",\"tool_input\":{\"chat_id\":\"123456\"}}' | node '$REPO_ROOT/scripts/channel-hook.js' 2>/dev/null && python3 -c \"import json; c=json.load(open('$workdir/.claude-code-hermit/config.json')); assert 'discord' not in c['channels'], c\""
cleanup

# -------------------------------------------------------
# 15. channel-hook — writes channel-activity.json
# -------------------------------------------------------
workdir="$(setup_workdir)"
cd "$workdir"
echo '{"channels":{"discord":{"enabled":true}}}' > "$workdir/.claude-code-hermit/config.json"
run_test "channel-hook (activity file)" bash -c \
  "echo '{\"tool_name\":\"mcp__discord__reply\",\"tool_input\":{\"chat_id\":\"999\"}}' | node '$REPO_ROOT/scripts/channel-hook.js' 2>/dev/null && python3 -c \"import json; a=json.load(open('$workdir/.claude-code-hermit/state/channel-activity.json')); assert 'last_reply_at' in a['discord'], a\""
cleanup

# -------------------------------------------------------
# 16. channel-hook — plugin_ prefix (channel plugin format)
# -------------------------------------------------------
workdir="$(setup_workdir)"
cd "$workdir"
echo '{"channels":{"discord":{"enabled":true,"dm_channel_id":null}}}' > "$workdir/.claude-code-hermit/config.json"
run_test "channel-hook (plugin_ prefix)" bash -c \
  "echo '{\"tool_name\":\"plugin_discord_discord_reply\",\"tool_input\":{\"chat_id\":\"789\"}}' | node '$REPO_ROOT/scripts/channel-hook.js' 2>/dev/null && python3 -c \"import json; c=json.load(open('$workdir/.claude-code-hermit/config.json')); assert c['channels']['discord']['dm_channel_id']=='789', c\""
cleanup

# -------------------------------------------------------
# 17. channel-hook — empty stdin
# -------------------------------------------------------
workdir="$(setup_workdir)"
cd "$workdir"
run_test "channel-hook (empty stdin)" bash -c \
  "echo '' | node '$REPO_ROOT/scripts/channel-hook.js'"
cleanup

# -------------------------------------------------------
# 17b. channel-hook — iMessage persists dm_channel_id
# -------------------------------------------------------
workdir="$(setup_workdir)"
cd "$workdir"
echo '{"channels":{"imessage":{"enabled":true,"dm_channel_id":null}}}' > "$workdir/.claude-code-hermit/config.json"
run_test "channel-hook (iMessage persist dm_channel_id)" bash -c \
  "echo '{\"tool_name\":\"mcp__imessage__reply\",\"tool_input\":{\"chat_id\":\"+15550001234\"}}' | node '$REPO_ROOT/scripts/channel-hook.js' 2>/dev/null && python3 -c \"import json; c=json.load(open('$workdir/.claude-code-hermit/config.json')); assert c['channels']['imessage']['dm_channel_id']=='+15550001234', c\""
cleanup

# -------------------------------------------------------
# 18. validate-config — valid config passes
# -------------------------------------------------------
workdir="$(setup_workdir)"
cd "$workdir"
cat > "$workdir/.claude-code-hermit/config.json" << 'CFGEOF'
{"agent_name":null,"language":null,"timezone":null,"escalation":"balanced","channels":{},"env":{},"heartbeat":{"enabled":true,"active_hours":{"start":"08:00","end":"23:00"}},"routines":[{"id":"test","schedule":"0 4 * * *","skill":"x:y","enabled":true}]}
CFGEOF
run_test "validate-config (valid)" bash -c \
  "echo '{\"tool_name\":\"Edit\",\"tool_input\":{\"file_path\":\"$workdir/.claude-code-hermit/config.json\"}}' | node '$REPO_ROOT/scripts/validate-config.js'"
cleanup

# -------------------------------------------------------
# 19. validate-config — invalid config fails
# -------------------------------------------------------
workdir="$(setup_workdir)"
cd "$workdir"
echo '{"agent_name":null}' > "$workdir/.claude-code-hermit/config.json"
run_test "validate-config (invalid)" bash -c \
  "echo '{\"tool_name\":\"Edit\",\"tool_input\":{\"file_path\":\"$workdir/.claude-code-hermit/config.json\"}}' | node '$REPO_ROOT/scripts/validate-config.js' 2>/dev/null; [ \$? -eq 2 ]"
cleanup

# -------------------------------------------------------
# 20. validate-config — skips non-config files
# -------------------------------------------------------
workdir="$(setup_workdir)"
cd "$workdir"
run_test "validate-config (skip non-config)" bash -c \
  "echo '{\"tool_name\":\"Edit\",\"tool_input\":{\"file_path\":\"/some/other/file.js\"}}' | node '$REPO_ROOT/scripts/validate-config.js'"
cleanup

# -------------------------------------------------------
# 21. validate-config — empty stdin
# -------------------------------------------------------
workdir="$(setup_workdir)"
cd "$workdir"
run_test "validate-config (empty stdin)" bash -c \
  "echo '' | node '$REPO_ROOT/scripts/validate-config.js'"
cleanup

# -------------------------------------------------------
# stop-pipeline tests
# -------------------------------------------------------

# 27. stop-pipeline — happy path: verifies all stages ran and heartbeat written
workdir="$(setup_git_workdir)"
cd "$workdir"
transcript="$workdir/.claude/transcript.jsonl"
cp "$FIXTURES/transcript.jsonl" "$transcript"
hook_input="$(sed "s|__TRANSCRIPT_PATH__|$transcript|" "$FIXTURES/stop-hook-input.json")"
run_test "stop-pipeline" bash -c "
  out=\$(echo '$hook_input' | AGENT_HOOK_PROFILE=standard CLAUDE_PLUGIN_ROOT='$REPO_ROOT' node '$REPO_ROOT/scripts/stop-pipeline.js' 2>&1)
  echo \"\$out\" | grep -q 'cost-tracker' || exit 1
  echo \"\$out\" | grep -q 'session-eval' || exit 1
  [ -f '$workdir/.claude-code-hermit/state/.heartbeat' ] || exit 1
"
cleanup

# 28. stop-pipeline — stdout contract: suggest-compact is sole stdout
workdir="$(setup_workdir)"
cd "$workdir"
transcript="$workdir/.claude/transcript.jsonl"
cp "$FIXTURES/transcript.jsonl" "$transcript"
hook_input="$(sed "s|__TRANSCRIPT_PATH__|$transcript|" "$FIXTURES/stop-hook-input.json")"
run_test "stop-pipeline (stdout contract)" bash -c "
  stdout=\$(echo '$hook_input' | COMPACT_THRESHOLD=1 AGENT_HOOK_PROFILE=standard CLAUDE_PLUGIN_ROOT='$REPO_ROOT' node '$REPO_ROOT/scripts/stop-pipeline.js' 2>/dev/null)
  stderr=\$(echo '$hook_input' | COMPACT_THRESHOLD=1 AGENT_HOOK_PROFILE=standard CLAUDE_PLUGIN_ROOT='$REPO_ROOT' node '$REPO_ROOT/scripts/stop-pipeline.js' 2>&1 >/dev/null)
  if [ -n \"\$stdout\" ]; then
    echo \"\$stdout\" | python3 -m json.tool >/dev/null 2>&1 || exit 1
    echo \"\$stdout\" | python3 -c \"import json,sys; d=json.load(sys.stdin); assert 'additionalContext' in d\" || exit 1
  fi
  echo \"\$stdout\" | grep -q 'cost-tracker' && exit 1
  echo \"\$stdout\" | grep -q 'session-eval' && exit 1
  echo \"\$stderr\" | grep -q 'cost-tracker' || exit 1
"
cleanup

# 29. stop-pipeline — malformed stdin must not crash
workdir="$(setup_workdir)"
cd "$workdir"
run_test "stop-pipeline (malformed stdin)" bash -c "
  err=\$(echo '{broken' | AGENT_HOOK_PROFILE=standard CLAUDE_PLUGIN_ROOT='$REPO_ROOT' node '$REPO_ROOT/scripts/stop-pipeline.js' 2>&1)
  echo \"\$err\" | grep -q 'malformed'
"
cleanup

# -------------------------------------------------------
# session-diff debounce tests (via stop-pipeline)
# -------------------------------------------------------

# 30. session-diff (debounce skip) — fresh sidecar + in_progress → skip
workdir="$(setup_git_workdir)"
cd "$workdir"
echo '{"session_state":"in_progress"}' > "$workdir/.claude-code-hermit/state/runtime.json"
echo '{"changed_files":[],"captured_at":"2026-01-01T00:00:00Z"}' > "$workdir/.claude-code-hermit/state/session-diff.json"
before_mtime="$(stat -c '%Y' "$workdir/.claude-code-hermit/state/session-diff.json" 2>/dev/null || stat -f '%m' "$workdir/.claude-code-hermit/state/session-diff.json")"
sleep 1
echo '{}' | AGENT_HOOK_PROFILE=standard CLAUDE_PLUGIN_ROOT="$REPO_ROOT" node "$REPO_ROOT/scripts/stop-pipeline.js" >/dev/null 2>&1 || true
after_mtime="$(stat -c '%Y' "$workdir/.claude-code-hermit/state/session-diff.json" 2>/dev/null || stat -f '%m' "$workdir/.claude-code-hermit/state/session-diff.json")"
run_test "session-diff (debounce skip)" bash -c "[ '$before_mtime' = '$after_mtime' ]"
cleanup

# 31. session-diff (debounce force on idle) — fresh sidecar + idle → force refresh
workdir="$(setup_git_workdir)"
cd "$workdir"
echo '{"session_state":"idle"}' > "$workdir/.claude-code-hermit/state/runtime.json"
echo '{"changed_files":[],"captured_at":"2026-01-01T00:00:00Z"}' > "$workdir/.claude-code-hermit/state/session-diff.json"
before_mtime="$(stat -c '%Y' "$workdir/.claude-code-hermit/state/session-diff.json" 2>/dev/null || stat -f '%m' "$workdir/.claude-code-hermit/state/session-diff.json")"
sleep 1
echo '{}' | AGENT_HOOK_PROFILE=standard CLAUDE_PLUGIN_ROOT="$REPO_ROOT" node "$REPO_ROOT/scripts/stop-pipeline.js" >/dev/null 2>&1 || true
after_mtime="$(stat -c '%Y' "$workdir/.claude-code-hermit/state/session-diff.json" 2>/dev/null || stat -f '%m' "$workdir/.claude-code-hermit/state/session-diff.json")"
run_test "session-diff (debounce force on idle)" bash -c "[ '$before_mtime' != '$after_mtime' ]"
cleanup

# 32. session-diff (debounce expired) — stale sidecar + in_progress → run
workdir="$(setup_git_workdir)"
cd "$workdir"
echo '{"session_state":"in_progress"}' > "$workdir/.claude-code-hermit/state/runtime.json"
echo '{"changed_files":[],"captured_at":"2020-01-01T00:00:00Z"}' > "$workdir/.claude-code-hermit/state/session-diff.json"
touch -t 202001010000 "$workdir/.claude-code-hermit/state/session-diff.json"
before_mtime="$(stat -c '%Y' "$workdir/.claude-code-hermit/state/session-diff.json" 2>/dev/null || stat -f '%m' "$workdir/.claude-code-hermit/state/session-diff.json")"
echo '{}' | AGENT_HOOK_PROFILE=standard CLAUDE_PLUGIN_ROOT="$REPO_ROOT" node "$REPO_ROOT/scripts/stop-pipeline.js" >/dev/null 2>&1 || true
after_mtime="$(stat -c '%Y' "$workdir/.claude-code-hermit/state/session-diff.json" 2>/dev/null || stat -f '%m' "$workdir/.claude-code-hermit/state/session-diff.json")"
run_test "session-diff (debounce expired)" bash -c "[ '$before_mtime' != '$after_mtime' ]"
cleanup

# -------------------------------------------------------
# startup-context tests
# -------------------------------------------------------

# 33. startup-context — happy path
workdir="$(setup_workdir)"
cd "$workdir"
run_test "startup-context" bash -c \
  "CLAUDE_PLUGIN_ROOT='$REPO_ROOT' node '$REPO_ROOT/scripts/startup-context.js' | grep -qF -- '---Active Session---'"
cleanup

# 34. startup-context — large Progress Log stays under hard cap
workdir="$(setup_workdir)"
cd "$workdir"
python3 -c "
content = open('$FIXTURES/shell-session.md').read()
extra = '\n'.join(f'- [10:{i:02d}] Progress entry {i}' for i in range(150))
print(content.replace('- [10:00] Started test session', extra))
" > "$workdir/.claude-code-hermit/sessions/SHELL.md"
run_test "startup-context (large SHELL.md)" bash -c \
  "out=\$(CLAUDE_PLUGIN_ROOT='$REPO_ROOT' node '$REPO_ROOT/scripts/startup-context.js' 2>/dev/null); [ \${#out} -lt 8000 ]"
cleanup

# 35. startup-context — no session file
workdir="$(setup_workdir)"
cd "$workdir"
rm "$workdir/.claude-code-hermit/sessions/SHELL.md"
run_test "startup-context (no session)" bash -c \
  "CLAUDE_PLUGIN_ROOT='$REPO_ROOT' node '$REPO_ROOT/scripts/startup-context.js' | grep -q 'No active session'"
cleanup

# 36. startup-context — section priority: large OPERATOR.md fills budget, last report is dropped
workdir="$(setup_workdir)"
cd "$workdir"
python3 -c "print('# Operator\n' + ('x' * 80 + '\n') * 22)" > "$workdir/.claude-code-hermit/OPERATOR.md"
python3 -c "
extra = '\n'.join(f'- [10:{i:02d}] Entry {i}' for i in range(200))
print('# Active Session\n\n## Task\nTest\n\n## Progress Log\n' + extra + '\n\n## Blockers\nNone')
" > "$workdir/.claude-code-hermit/sessions/SHELL.md"
mkdir -p "$workdir/.claude-code-hermit/sessions"
echo '# Session Report: S-001\n\n## Overview\nSHOULD_NOT_APPEAR_IN_OUTPUT_IF_CAP_HIT' > "$workdir/.claude-code-hermit/sessions/S-001-REPORT.md"
run_test "startup-context (section priority)" bash -c \
  "out=\$(CLAUDE_PLUGIN_ROOT='$REPO_ROOT' node '$REPO_ROOT/scripts/startup-context.js' 2>/dev/null); echo \"\$out\" | grep -q 'Operator' && [ \${#out} -lt 8000 ]"
cleanup

# -------------------------------------------------------
# generate-summary tests
# -------------------------------------------------------

# 37. generate-summary — skips non-state files
workdir="$(setup_workdir)"
cd "$workdir"
run_test "generate-summary (skip non-state)" bash -c \
  "echo '{\"tool_name\":\"Edit\",\"tool_input\":{\"file_path\":\"README.md\"}}' | node '$REPO_ROOT/scripts/generate-summary.js'"
cleanup

# 38. generate-summary — fires on state/ file, writes state-summary.md
workdir="$(setup_workdir)"
cd "$workdir"
echo '{"alerts":{},"last_digest_date":null,"self_eval":{}}' > "$workdir/.claude-code-hermit/state/alert-state.json"
run_test "generate-summary (writes summary)" bash -c \
  "echo '{\"tool_name\":\"Edit\",\"tool_input\":{\"file_path\":\"$workdir/.claude-code-hermit/state/alert-state.json\"}}' | node '$REPO_ROOT/scripts/generate-summary.js' && [ -f '$workdir/.claude-code-hermit/state/state-summary.md' ]"
cleanup

# 39. generate-summary — empty stdin
workdir="$(setup_workdir)"
cd "$workdir"
run_test "generate-summary (empty stdin)" bash -c \
  "echo '' | node '$REPO_ROOT/scripts/generate-summary.js'"
cleanup

# -------------------------------------------------------
# prompt-context (UserPromptSubmit hook)
# -------------------------------------------------------

# 40. No config — falls back to UTC, emits [Now: ...] line
workdir="$(setup_workdir)"
cd "$workdir"
out="$(echo '' | AGENT_DIR="$workdir/.claude-code-hermit" node "$REPO_ROOT/scripts/prompt-context.js")"
run_test "prompt-context (UTC fallback)" bash -c "echo '$out' | grep -qE '^\[Now: .+ UTC\]'"
cleanup

# 41. Configured TZ — output contains the configured TZ abbreviation
workdir="$(setup_workdir)"
cd "$workdir"
echo '{"timezone":"America/New_York"}' > "$workdir/.claude-code-hermit/config.json"
out="$(echo '' | AGENT_DIR="$workdir/.claude-code-hermit" node "$REPO_ROOT/scripts/prompt-context.js")"
run_test "prompt-context (configured TZ)" bash -c "echo '$out' | grep -qE '^\[Now: .+ (EST|EDT)\]'"
cleanup

# 42. Invalid TZ — emits nothing, exits 0 (fail-open)
workdir="$(setup_workdir)"
cd "$workdir"
echo '{"timezone":"Bogus/Zone"}' > "$workdir/.claude-code-hermit/config.json"
run_test "prompt-context (invalid TZ, exits 0)" \
  bash -c "echo '' | AGENT_DIR='$workdir/.claude-code-hermit' node '$REPO_ROOT/scripts/prompt-context.js'"
run_test "prompt-context (invalid TZ, no [Now:] line)" bash -c \
  "out=\$(echo '' | AGENT_DIR='$workdir/.claude-code-hermit' node '$REPO_ROOT/scripts/prompt-context.js'); [ -z \"\$out\" ]"
cleanup

# 43. Malformed config.json — exits 0 (fail-open)
workdir="$(setup_workdir)"
cd "$workdir"
echo 'not json' > "$workdir/.claude-code-hermit/config.json"
run_test "prompt-context (malformed config, exits 0)" \
  bash -c "echo '' | AGENT_DIR='$workdir/.claude-code-hermit' node '$REPO_ROOT/scripts/prompt-context.js'"
cleanup

# -------------------------------------------------------
# 44. doctor-check — minimal install returns 7 checks, exits 0
# -------------------------------------------------------
workdir="$(setup_workdir)"
cd "$workdir"
mkdir -p "$workdir/.claude-code-hermit/proposals"
cat > "$workdir/.claude-code-hermit/config.json" <<'EOF'
{"agent_name":"test","language":"en","timezone":"UTC","escalation":"balanced","channels":{},"env":{},"heartbeat":{"enabled":true,"active_hours":{"start":"08:00","end":"23:00"}},"routines":[],"idle_budget":"$0.50"}
EOF
run_test "doctor-check (minimal install, 7 checks)" bash -c \
  "node '$REPO_ROOT/scripts/doctor-check.js' '$workdir/.claude-code-hermit' >/dev/null && python3 -c \"import json; r=json.load(open('$workdir/.claude-code-hermit/state/doctor-report.json')); ids=[c['id'] for c in r['checks']]; assert ids==['config','hooks','state','cost','proposals','dependencies','permissions'], ids\""
cleanup

# -------------------------------------------------------
# 45. doctor-check — corrupt state file flags state=fail
# -------------------------------------------------------
workdir="$(setup_workdir)"
cd "$workdir"
mkdir -p "$workdir/.claude-code-hermit/proposals"
cat > "$workdir/.claude-code-hermit/config.json" <<'EOF'
{"agent_name":"t","language":"en","timezone":"UTC","escalation":"balanced","channels":{},"env":{},"heartbeat":{"enabled":true},"routines":[]}
EOF
echo 'not json' > "$workdir/.claude-code-hermit/state/alert-state.json"
run_test "doctor-check (corrupt state → fail)" bash -c \
  "node '$REPO_ROOT/scripts/doctor-check.js' '$workdir/.claude-code-hermit' >/dev/null && python3 -c \"import json; r=json.load(open('$workdir/.claude-code-hermit/state/doctor-report.json')); s=[c for c in r['checks'] if c['id']=='state'][0]; assert s['status']=='fail' and 'alert-state.json' in s['detail'], s\""
cleanup

# -------------------------------------------------------
# 46. doctor-check — missing config → exits 0, config check fails
# -------------------------------------------------------
workdir="$(setup_workdir)"
cd "$workdir"
rm -f "$workdir/.claude-code-hermit/config.json"
run_test "doctor-check (missing config → fail, exits 0)" bash -c \
  "node '$REPO_ROOT/scripts/doctor-check.js' '$workdir/.claude-code-hermit' >/dev/null && python3 -c \"import json; r=json.load(open('$workdir/.claude-code-hermit/state/doctor-report.json')); c=[x for x in r['checks'] if x['id']=='config'][0]; assert c['status']=='fail', c\""
cleanup

# -------------------------------------------------------
# Summary
# -------------------------------------------------------
# Clean up any suggest-compact counter files left in /tmp
rm -rf /tmp/claude-agent-compact-*/counter-test-session-*.txt 2>/dev/null || true

print_results
