#!/usr/bin/env bash
# Run all test suites and report the combined result.
# Usage: bash tests/run-all.sh
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

rc=0
bash "$SCRIPT_DIR/run-hooks.sh"               || rc=$?
python3 "$SCRIPT_DIR/run-contracts.py"        || rc=$?
bash "$SCRIPT_DIR/run-scripts.sh"             || rc=$?
bash "$SCRIPT_DIR/recurrence-gate-matrix.sh"  || rc=$?
bash "$SCRIPT_DIR/cron-tz-shift.test.sh"      || rc=$?
bash "$SCRIPT_DIR/test-docker-security-templates.sh" || rc=$?
bash "$SCRIPT_DIR/test-template-skill-sync.sh"       || rc=$?
bash "$SCRIPT_DIR/test-archive-shell.sh"             || rc=$?
bash "$SCRIPT_DIR/test-hook-registration-form.sh"   || rc=$?
bash "$SCRIPT_DIR/test-proposal-act-accept-flow.sh"  || rc=$?
exit $rc
