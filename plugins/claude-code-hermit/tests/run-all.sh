#!/usr/bin/env bash
# Run all test suites and report the combined result.
# Usage: bash tests/run-all.sh
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

rc=0
bun test "$SCRIPT_DIR/hooks.contract.test.ts" || rc=$?
python3 "$SCRIPT_DIR/run-contracts.py"        || rc=$?
bash "$SCRIPT_DIR/run-scripts.sh"             || rc=$?
bash "$SCRIPT_DIR/recurrence-gate-matrix.sh"  || rc=$?
bash "$SCRIPT_DIR/cron-tz-shift.test.sh"      || rc=$?
bash "$SCRIPT_DIR/test-docker-security-templates.sh" || rc=$?
bash "$SCRIPT_DIR/test-docker-baseline-content.sh"   || rc=$?
bash "$SCRIPT_DIR/test-template-skill-sync.sh"       || rc=$?
bash "$SCRIPT_DIR/test-hatch-options-contract.sh"    || rc=$?
bash "$SCRIPT_DIR/test-archive-shell.sh"             || rc=$?
bash "$SCRIPT_DIR/test-archive-compiled.sh"         || rc=$?
bash "$SCRIPT_DIR/test-hook-registration-form.sh"          || rc=$?
bash "$SCRIPT_DIR/test-channel-responder-reply-rule.sh"    || rc=$?
bash "$SCRIPT_DIR/test-proposal-act-accept-flow.sh"        || rc=$?
bash "$SCRIPT_DIR/test-simplify-totals-contract.sh"        || rc=$?
bash "$SCRIPT_DIR/test-auto-close.sh"                      || rc=$?
bash "$SCRIPT_DIR/test-evolve-plan.sh"                     || rc=$?
bash "$SCRIPT_DIR/test-archive-raw.sh"                     || rc=$?
bash "$SCRIPT_DIR/test-eval-success-signal.sh"             || rc=$?
bash "$SCRIPT_DIR/test-procedure-capture.sh"               || rc=$?
bash "$SCRIPT_DIR/test-reflect-loop.sh"                    || rc=$?
bash "$SCRIPT_DIR/test-watchdog.sh"                        || rc=$?
exit $rc
