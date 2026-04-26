#!/usr/bin/env bash
# Shared test helpers. Source this file; do not execute directly.
# Sets REPO_ROOT, FIXTURES, ORIG_DIR, and defines run_test / setup_workdir /
# setup_git_workdir / cleanup / print_results.

_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$_LIB_DIR/.." && pwd)"
FIXTURES="$_LIB_DIR/fixtures"
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

setup_workdir() {
  local workdir
  workdir="$(mktemp -d)"
  mkdir -p "$workdir/.claude-code-hermit/sessions"
  mkdir -p "$workdir/.claude-code-hermit/state"
  mkdir -p "$workdir/.claude"
  cp "$FIXTURES/shell-session.md" "$workdir/.claude-code-hermit/sessions/SHELL.md"
  touch "$workdir/.claude-code-hermit/OPERATOR.md"
  echo "$workdir"
}

# Same as setup_workdir but initialises a git repo (needed by session-diff).
setup_git_workdir() {
  local workdir
  workdir="$(setup_workdir)"
  (
    cd "$workdir"
    git init -q
    git -c user.name="test" -c user.email="test@test" -c commit.gpgsign=false commit -q --allow-empty -m "init"
    git add -A
    git -c user.name="test" -c user.email="test@test" -c commit.gpgsign=false commit -q -m "add fixtures"
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

print_results() {
  echo ""
  echo "=== Results: $PASSED passed, $FAILED failed ==="
  if [ ${#failures[@]} -gt 0 ]; then
    echo "Failed:"
    for f in "${failures[@]}"; do
      echo "  - $f"
    done
    exit 1
  fi
}
