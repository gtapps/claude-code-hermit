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
exit $rc
