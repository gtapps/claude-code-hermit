#!/usr/bin/env bash
# Backwards-compat tests for PROP-031 (v1.1.0):
# - validate-frontmatter accepts proposals with and without legacy `session:` field
# - runtime.json tolerates retired fields silently when read by hermit scripts
# Usage: bash tests/test-backwards-compat.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/lib.sh"

echo "=== PROP-031 backwards-compat tests ==="
echo ""

# -------------------------------------------------------
# 1. validate-frontmatter accepts legacy proposal with `session: S-005`
# -------------------------------------------------------
workdir="$(setup_workdir)"
cd "$workdir"
mkdir -p .claude-code-hermit/proposals
cat > .claude-code-hermit/proposals/PROP-001-legacy-test-100000.md <<'EOF'
---
id: PROP-001-legacy-test-100000
title: Legacy proposal with session field
status: proposed
source: manual
session: S-005
created: 2026-04-01T12:00:00+00:00
category: improvement
---
# Body
EOF
run_test "validate-frontmatter accepts legacy proposal with session field" bash -c \
  "node '$REPO_ROOT/scripts/validate-frontmatter.js' '$workdir' >/dev/null 2>&1"
cleanup

# -------------------------------------------------------
# 2. validate-frontmatter accepts new-style proposal without `session:` field
# -------------------------------------------------------
workdir="$(setup_workdir)"
cd "$workdir"
mkdir -p .claude-code-hermit/proposals
cat > .claude-code-hermit/proposals/PROP-002-new-style-100001.md <<'EOF'
---
id: PROP-002-new-style-100001
title: New-style proposal without session field
status: proposed
source: manual
created: 2026-05-15T12:00:00+00:00
category: improvement
---
# Body
EOF
run_test "validate-frontmatter accepts new-style proposal without session field" bash -c \
  "node '$REPO_ROOT/scripts/validate-frontmatter.js' '$workdir' >/dev/null 2>&1"
cleanup

# -------------------------------------------------------
# 3. heartbeat-precheck tolerates retired runtime.json fields
# -------------------------------------------------------
workdir="$(setup_workdir)"
cd "$workdir"
# Fixture below contains every field PROP-031 retired:
#   session_state: "dead_process"   → narrowed enum (idle | in_progress | waiting)
#   session_id                      → no S-NNN counter post-v1.1.0
#   transition / transition_target / transition_started_at → archive event retired
#   waiting_reason                  → folded into Focus content / recovery marker
#   last_error                      → unclean shutdown detected via timestamps instead
# Readers must ignore them silently.
cat > .claude-code-hermit/state/runtime.json <<'EOF'
{
  "version": 1,
  "session_state": "dead_process",
  "session_id": "S-027",
  "transition": "archiving",
  "transition_target": "S-027-REPORT.md",
  "transition_started_at": "2026-05-10T20:00:00Z",
  "waiting_reason": "operator_input",
  "last_error": "unclean_shutdown",
  "created_at": "2026-05-10T19:00:00Z",
  "updated_at": "2026-05-10T20:00:00Z",
  "runtime_mode": "tmux",
  "tmux_session": "hermit-test",
  "shutdown_requested_at": null,
  "shutdown_completed_at": null
}
EOF
cat > .claude-code-hermit/HEARTBEAT.md <<'EOF'
# Heartbeat checklist

- Review pending proposals
EOF
cat > .claude-code-hermit/state/alert-state.json <<'EOF'
{"alerts":{},"self_eval":{},"last_digest_date":null,"total_ticks":0}
EOF
echo '{"timezone":"UTC"}' > .claude-code-hermit/config.json
run_test "heartbeat-precheck tolerates retired runtime.json fields" bash -c \
  "node '$REPO_ROOT/scripts/heartbeat-precheck.js' '$workdir/.claude-code-hermit' >/dev/null 2>&1"
cleanup

# -------------------------------------------------------
# 4. reflect-precheck tolerates retired runtime.json fields
# -------------------------------------------------------
workdir="$(setup_workdir)"
cd "$workdir"
cat > .claude-code-hermit/state/runtime.json <<'EOF'
{
  "version": 1,
  "session_state": "dead_process",
  "session_id": "S-027",
  "transition": "archiving",
  "last_error": "unclean_shutdown",
  "last_shell_snapshot_at": null
}
EOF
echo '{"timezone":"UTC"}' > .claude-code-hermit/config.json
today="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
since="$(python3 -c "import datetime; print((datetime.datetime.now(datetime.timezone.utc)-datetime.timedelta(days=30)).strftime('%Y-%m-%dT%H:%M:%SZ'))")"
echo "{\"counters\":{\"total_runs\":1,\"empty_runs\":0,\"last_run_at\":\"$today\",\"since\":\"$since\"}}" \
  > .claude-code-hermit/state/reflection-state.json
mkdir -p .claude-code-hermit/proposals
touch -t 202001010000 .claude-code-hermit/sessions/SHELL.md
run_test "reflect-precheck tolerates retired runtime.json fields" bash -c \
  "node '$REPO_ROOT/scripts/reflect-precheck.js' '$workdir/.claude-code-hermit' '$REPO_ROOT' >/dev/null 2>&1"
cleanup

print_results
