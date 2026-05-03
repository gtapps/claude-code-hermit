#!/usr/bin/env bash
# Tests for scripts/cron-tz-shift.js — timezone-aware cron shifting.
# Uses HERMIT_CRON_TZ_SHIFT_NOW to pin the reference instant (deterministic).
# Uses TZ= to control the "machine timezone" seen by the Node process.
# Usage: bash tests/cron-tz-shift.test.sh
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
HELPER="$SCRIPT_DIR/../scripts/cron-tz-shift.js"

PASSED=0
FAILED=0
failures=()

# check_stdout <name> <expected-stdout> <TZ> <NOW> <cron> <from-tz>
# Also asserts exit 0 and no WARN on stderr (use check_warn / check_fail for those).
check_stdout() {
  local name="$1" expected="$2" tz="$3" now="$4" cron="$5" fromtz="$6"
  local out stderr_out
  out=$(TZ="$tz" HERMIT_CRON_TZ_SHIFT_NOW="$now" node "$HELPER" "$cron" "$fromtz" 2>/tmp/cron_test_stderr)
  local rc=$?
  stderr_out=$(cat /tmp/cron_test_stderr)
  if [ $rc -ne 0 ]; then
    echo "  FAIL  $name (exit $rc)"
    ((FAILED++)) || true; failures+=("$name"); return
  fi
  if [ "$out" != "$expected" ]; then
    echo "  FAIL  $name (stdout: got '$out', want '$expected')"
    ((FAILED++)) || true; failures+=("$name"); return
  fi
  if [ -n "$stderr_out" ]; then
    echo "  FAIL  $name (unexpected stderr: $stderr_out)"
    ((FAILED++)) || true; failures+=("$name"); return
  fi
  echo "  PASS  $name"
  ((PASSED++)) || true
}

# check_warn <name> <expected-stdout> <stderr-pattern> <TZ> <NOW> <cron> <from-tz>
# Asserts exit 0, stdout matches, and stderr contains the pattern.
check_warn() {
  local name="$1" expected="$2" pattern="$3" tz="$4" now="$5" cron="$6" fromtz="$7"
  local out stderr_out
  out=$(TZ="$tz" HERMIT_CRON_TZ_SHIFT_NOW="$now" node "$HELPER" "$cron" "$fromtz" 2>/tmp/cron_test_stderr)
  local rc=$?
  stderr_out=$(cat /tmp/cron_test_stderr)
  if [ $rc -ne 0 ]; then
    echo "  FAIL  $name (exit $rc, expected 0)"
    ((FAILED++)) || true; failures+=("$name"); return
  fi
  if [ "$out" != "$expected" ]; then
    echo "  FAIL  $name (stdout: got '$out', want '$expected')"
    ((FAILED++)) || true; failures+=("$name"); return
  fi
  if ! echo "$stderr_out" | grep -q "$pattern"; then
    echo "  FAIL  $name (stderr missing '$pattern': got '$stderr_out')"
    ((FAILED++)) || true; failures+=("$name"); return
  fi
  echo "  PASS  $name"
  ((PASSED++)) || true
}

# check_fail <name> <TZ> <NOW> <cron> <from-tz>
# Asserts exit non-zero.
check_fail() {
  local name="$1" tz="$2" now="$3" cron="$4" fromtz="$5"
  TZ="$tz" HERMIT_CRON_TZ_SHIFT_NOW="$now" node "$HELPER" "$cron" "$fromtz" >/dev/null 2>&1
  if [ $? -ne 0 ]; then
    echo "  PASS  $name"
    ((PASSED++)) || true
  else
    echo "  FAIL  $name (expected non-zero exit)"
    ((FAILED++)) || true; failures+=("$name")
  fi
}

echo "=== cron-tz-shift Tests ==="
echo ""

W=2026-01-15T12:00:00Z   # winter reference (Lisbon=UTC+0)
S=2026-07-15T12:00:00Z   # summer reference (Lisbon=UTC+1)

# --- No-shift cases ---
check_stdout "winter no-shift Lisbon→UTC"     "0 4 * * *"  UTC           $W "0 4 * * *"   "Europe/Lisbon"
check_stdout "empty fromTz no-op"             "0 4 * * *"  UTC           $S "0 4 * * *"   ""
check_stdout "same TZ no-op"                  "0 4 * * *"  Europe/Lisbon $S "0 4 * * *"   "Europe/Lisbon"
check_stdout "hour=* passes through"          "*/15 * * * *" UTC         $S "*/15 * * * *" "Europe/Lisbon"

# --- Hour shifts (daily routines) ---
check_stdout "summer 1h shift Lisbon→UTC"     "0 3 * * *"  UTC           $S "0 4 * * *"   "Europe/Lisbon"
check_stdout "summer NY→UTC (-4h)"            "0 13 * * *" UTC           $S "0 9 * * *"   "America/New_York"
check_stdout "winter NY→UTC (-5h)"            "0 14 * * *" UTC           $W "0 9 * * *"   "America/New_York"

# --- Fractional-offset zones ---
check_stdout "Kolkata +5:30 → UTC"            "0 4 * * *"  UTC           $S "30 9 * * *"  "Asia/Kolkata"
check_stdout "Kathmandu +5:45 → UTC"          "0 4 * * *"  UTC           $S "45 9 * * *"  "Asia/Kathmandu"
check_stdout "Adelaide summer +10:30 → UTC"   "30 22 * * *" UTC          $W "0 9 * * *"   "Australia/Adelaide"

# --- DOW shift ---
check_stdout "DOW no wrap (23:00 Sun Lisbon→UTC summer)"  "0 22 * * 0" UTC $S "0 23 * * 0" "Europe/Lisbon"
check_stdout "DOW backward wrap (00:00 Sun Lisbon→UTC summer)" "0 23 * * 6" UTC $S "0 0 * * 0" "Europe/Lisbon"

# --- Multi-hour (list) that allows DOW=* shift ---
check_stdout "multi-hour DOW=* allowed"       "0 11,23 * * *" UTC        $S "0 0,12 * * *" "Europe/Lisbon"

# --- Step patterns that survive shift ---
check_stdout "*/2 step preserved after 1h shift"   "0 1/2 * * *" UTC    $S "0 */2 * * *" "Europe/Lisbon"

# --- Warn: unsupported patterns pass through with WARN ---
check_warn  "DOM-restricted pass-through"  "0 4 1 * *"   "DOM"                  UTC $S "0 4 1 * *"   "Europe/Lisbon"
check_warn  "mixed day-wrap DOW restricted" "0 0,12 * * 0" "mixed day-wrap"     UTC $S "0 0,12 * * 0" "Europe/Lisbon"
check_warn  "step loses structure (*/7 +1h)" "0 */7 * * *" "step pattern"       UTC $S "0 */7 * * *" "Europe/Lisbon"
check_warn  "invalid from-tz"              "0 4 * * *"   "invalid from-tz"      UTC $S "0 4 * * *"   "Atlantic/Atlantis"

# --- Exit non-zero on malformed cron ---
check_fail  "malformed cron (not 5 fields)"  UTC $S "garbage" "Europe/Lisbon"
check_fail  "bad HERMIT_CRON_TZ_SHIFT_NOW"   UTC "not-a-date" "0 4 * * *" "Europe/Lisbon"

echo ""
echo "=== Results: $PASSED passed, $FAILED failed ==="
if [ ${#failures[@]} -gt 0 ]; then
  echo "Failed:"
  for f in "${failures[@]}"; do echo "  - $f"; done
  exit 1
fi
