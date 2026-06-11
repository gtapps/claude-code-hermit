#!/usr/bin/env bash
# Regression: reflect-loop contract tests — tooling debrief, vital-signs,
# observations ledger, success-signal push, artifact-cited evidence,
# ephemerality exception. Guards pinned SKILL.md / agent phrases so future
# trims don't silently lose them; also unit-tests the related Node scripts.
#
# Runs from inside plugins/claude-code-hermit/ (REPO_ROOT = that directory).
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=lib.sh
source "$SCRIPT_DIR/lib.sh"

echo "=== reflect-loop tests ==="
echo ""

SESSION_CLOSE="$REPO_ROOT/skills/session-close/SKILL.md"

# ── item 1: session-close tooling debrief ───────────────────────────────────

run_test "session-close: tooling debrief question present" \
  grep -qF "What did I build ad-hoc this session" "$SESSION_CLOSE"

run_test "session-close: re-derivation debrief question present" \
  grep -qF "re-derive or re-discover" "$SESSION_CLOSE"

run_test "session-close: debrief asks for quantified cost" \
  grep -qF "quantified cost" "$SESSION_CLOSE"

run_test "session-close: debrief feeds procedure-capture Lessons" \
  grep -qF "procedure-capture recurs on" "$SESSION_CLOSE"

# ── item 2: weekly-review reflect vital-signs ───────────────────────────────

WEEKLY_REVIEW="$REPO_ROOT/scripts/weekly-review.js"

workdir="$(mktemp -d)"
mkdir -p "$workdir/.claude-code-hermit/sessions"
mkdir -p "$workdir/.claude-code-hermit/state"
mkdir -p "$workdir/.claude"
echo '{"timezone":"UTC"}' > "$workdir/.claude-code-hermit/config.json"

TODAY="$(date -u +%Y-%m-%dT12:00:00+00:00)"
TODAY_TS="$(date -u +%Y-%m-%dT12:00:00Z)"

cat > "$workdir/.claude-code-hermit/sessions/S-001-REPORT.md" << EOF
---
id: S-001
status: completed
date: ${TODAY}
cost_usd: 1.50
tokens: 50000
tags: []
operator_turns: 5
closed_via: operator
---
## Overview
Work.

## Progress Log
- [10:00] reflect (adult) — 2 candidates; verdicts: accept=1 downgrade=0 suppress=1; outcomes: none; suppressed: [cost-spike: no-sessions]
EOF

cat > "$workdir/.claude-code-hermit/sessions/S-002-REPORT.md" << EOF
---
id: S-002
status: completed
date: ${TODAY}
cost_usd: 0.80
tokens: 20000
tags: []
operator_turns: 3
closed_via: operator
---
## Overview
Work.

## Progress Log
- [11:00] reflect (quick, post-routine) — 0 candidates; verdicts: accept=0 downgrade=0 suppress=0; outcomes: none
EOF

cat > "$workdir/.claude-code-hermit/state/proposal-metrics.jsonl" << EOF
{"ts":"${TODAY_TS}","type":"micro-queued","micro_id":"MP-1","tier":1,"question":"q"}
{"ts":"${TODAY_TS}","type":"created","proposal_id":"PROP-001"}
{"ts":"${TODAY_TS}","type":"responded","proposal_id":"PROP-001","action":"accept"}
{"ts":"${TODAY_TS}","type":"micro-resolved","micro_id":"MP-1","action":"approved"}
{"ts":"2020-01-01T12:00:00Z","type":"created","proposal_id":"PROP-OLD"}
EOF

cat > "$workdir/.claude/cost-log.jsonl" << EOF
{"timestamp":"${TODAY_TS}","source":"routine:reflect-cadence","estimated_cost_usd":0.50,"total_tokens":1000}
{"timestamp":"${TODAY_TS}","source":"session","estimated_cost_usd":2.00,"total_tokens":9000}
{"timestamp":"2020-01-01T12:00:00Z","source":"routine:reflect-cadence","estimated_cost_usd":9.99,"total_tokens":1000}
EOF

cd "$workdir" && node "$WEEKLY_REVIEW" .claude-code-hermit >/dev/null 2>&1
review_file="$(find "$workdir/.claude-code-hermit/compiled" -name 'review-weekly-*.md' | head -1)"
cd "$ORIG_DIR"

run_test "weekly-review: reflect_runs counts both phases incl quick" bash -c \
  "grep -q 'reflect_runs: 2' '$review_file'"
run_test "weekly-review: reflect_candidates summed" bash -c \
  "grep -q 'reflect_candidates: 2' '$review_file'"
run_test "weekly-review: reflect_surfaced from in-week metrics only" bash -c \
  "grep -q 'reflect_surfaced: 2' '$review_file'"
run_test "weekly-review: reflect_accepted counts accept + approved" bash -c \
  "grep -q 'reflect_accepted: 2' '$review_file'"
run_test "weekly-review: reflect_cost_usd from routine:reflect sources in-week" bash -c \
  "grep -q 'reflect_cost_usd: 0.50' '$review_file'"
run_test "weekly-review: suppression digest normalized slug:code" bash -c \
  "grep -qF 'suppressed: cost-spike:no-sessions' '$review_file'"
run_test "weekly-review: regression — sessions_count intact" bash -c \
  "grep -q 'sessions_count: 2' '$review_file'"
run_test "weekly-review: regression — self_directed_rate intact" bash -c \
  "grep -q 'self_directed_rate:' '$review_file'"
rm -r "$workdir"

# ── item 3: observations ledger ─────────────────────────────────────────────

REFLECT="$REPO_ROOT/skills/reflect/SKILL.md"
JUDGE="$REPO_ROOT/agents/reflection-judge.md"
HATCH="$REPO_ROOT/skills/hatch/SKILL.md"
PRUNE="$REPO_ROOT/scripts/prune-observations.js"

run_test "reflect: ledger graduation step present" \
  grep -qF "Observations ledger" "$REFLECT"
run_test "reflect: graduation threshold is 2 distinct sessions excl current" \
  grep -qF "≥2 distinct \`session_id\`s, at least one not the current session" "$REFLECT"
run_test "reflect: quick-mode deferrals append to ledger" \
  grep -qF '"source":"quick-deferral"' "$REFLECT"
run_test "reflect: cost spike recorded to ledger not memory" \
  grep -qF '"source":"cost-spike"' "$REFLECT"
run_test "reflect: sub-threshold outcomes append to ledger not memory" \
  grep -qF '"source":"reflect"' "$REFLECT"
run_test "judge: artifact verification section present" \
  grep -qF "Artifact verification" "$JUDGE"
run_test "judge: covered-by-memory exemption for ledger graduates" \
  grep -qF 'never suppressed `covered-by-memory`' "$JUDGE"
run_test "hatch: seeds observations.jsonl" \
  grep -qF "state/observations.jsonl" "$HATCH"

# prune-observations.js behavior
workdir="$(mktemp -d)"
mkdir -p "$workdir/.claude-code-hermit/state"
LEDGER="$workdir/.claude-code-hermit/state/observations.jsonl"
FRESH_TS="$(date -u +%Y-%m-%dT12:00:00Z)"

cat > "$LEDGER" << EOF
{"ts":"${FRESH_TS}","pattern":"fresh-pattern","session_id":"S-010","source":"reflect"}
{"ts":"2020-01-01T00:00:00Z","pattern":"fresh-pattern","session_id":"S-001","source":"reflect"}
{"ts":"2020-01-01T00:00:00Z","pattern":"dead-pattern","session_id":"S-001","source":"reflect"}
not json at all
EOF

run_test "prune-observations: exits 0 and reports counts" bash -c \
  "node '$PRUNE' '$workdir/.claude-code-hermit' | grep -q 'pruned 1, kept 3'"
run_test "prune-observations: fresh entry kept" bash -c \
  "grep -q 'S-010' '$LEDGER'"
run_test "prune-observations: stale entry of fresh pattern kept (recurrence history)" bash -c \
  "grep -q '\"pattern\":\"fresh-pattern\",\"session_id\":\"S-001\"' '$LEDGER'"
run_test "prune-observations: fully stale pattern dropped" bash -c \
  "! grep -q 'dead-pattern' '$LEDGER'"
run_test "prune-observations: unparseable line preserved verbatim" bash -c \
  "grep -qx 'not json at all' '$LEDGER'"
run_test "prune-observations: missing file exits 0" bash -c \
  "node '$PRUNE' '$workdir/nonexistent-dir' | grep -q 'pruned 0, kept 0'"
run_test "prune-observations: no args exits 1" bash -c \
  "! node '$PRUNE' >/dev/null 2>&1"
rm -r "$workdir"

print_results
