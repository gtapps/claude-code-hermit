#!/usr/bin/env bash
# Tests for archive-compiled.js — rotates old compiled artifacts.
# Usage: bash tests/test-archive-compiled.sh
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/lib.sh"

echo "=== archive-compiled.js ==="
echo ""

ARCHIVE="$REPO_ROOT/scripts/archive-compiled.js"

# Helper: write a minimal compiled artifact with given type, created date, and optional tags.
write_artifact() {
  local dir="$1" name="$2" type="$3" created="$4" tags="${5:-}"
  local tags_line=""
  [ -n "$tags" ] && tags_line=$'\n'"tags: [$tags]"
  printf -- "---\ntype: %s\ncreated: %s%s\n---\nBody content.\n" \
    "$type" "$created" "$tags_line" > "$dir/$name"
}

# -------------------------------------------------------
# 1. Basic rotation: 3 artifacts of the same type → 1 archived (oldest), 2 retained
# -------------------------------------------------------
workdir="$(mktemp -d)"
mkdir -p "$workdir/.claude-code-hermit/compiled"
d="$workdir/.claude-code-hermit/compiled"
write_artifact "$d" "review-2025-W01.md" "review" "2025-01-05T00:00:00.000Z"
write_artifact "$d" "review-2025-W02.md" "review" "2025-01-12T00:00:00.000Z"
write_artifact "$d" "review-2025-W03.md" "review" "2025-01-19T00:00:00.000Z"

out="$(node "$ARCHIVE" "$workdir/.claude-code-hermit")"
run_test "rotation: oldest archived" bash -c "[ -f '$d/.archive/review-2025-W01.md' ]"
run_test "rotation: W02 retained" bash -c "[ -f '$d/review-2025-W02.md' ]"
run_test "rotation: W03 retained" bash -c "[ -f '$d/review-2025-W03.md' ]"
run_test "rotation: 1 archived in output" bash -c "echo '$out' | grep -qF '1 archived'"
run_test "rotation: 2 retained in output" bash -c "echo '$out' | grep -qF '2 retained'"
rm -rf "$workdir"

# -------------------------------------------------------
# 2. Foundational exemption: foundational artifact is never archived
# -------------------------------------------------------
workdir="$(mktemp -d)"
mkdir -p "$workdir/.claude-code-hermit/compiled"
d="$workdir/.claude-code-hermit/compiled"
write_artifact "$d" "review-2025-W01.md" "review" "2025-01-05T00:00:00.000Z"
write_artifact "$d" "review-2025-W02.md" "review" "2025-01-12T00:00:00.000Z"
# Oldest date but tagged foundational — must not be archived
write_artifact "$d" "review-old-foundational.md" "review" "2024-01-01T00:00:00.000Z" "foundational"

out="$(node "$ARCHIVE" "$workdir/.claude-code-hermit")"
run_test "foundational: not archived" bash -c "[ -f '$d/review-old-foundational.md' ]"
run_test "foundational: .archive/ not created (nothing else to archive)" \
  bash -c "[ ! -d '$d/.archive' ] || [ \$(ls '$d/.archive/' 2>/dev/null | wc -l) -eq 0 ]"
run_test "foundational: 0 archived in output" bash -c "echo '$out' | grep -qF '0 archived'"
rm -rf "$workdir"

# -------------------------------------------------------
# 3. Skipped: artifact missing type or created → left in place, counted as skipped
# -------------------------------------------------------
workdir="$(mktemp -d)"
mkdir -p "$workdir/.claude-code-hermit/compiled"
d="$workdir/.claude-code-hermit/compiled"
# Missing type
printf -- "---\ncreated: 2025-01-05T00:00:00.000Z\n---\nBody.\n" > "$d/no-type.md"
# Missing created
printf -- "---\ntype: note\n---\nBody.\n" > "$d/no-created.md"

out="$(node "$ARCHIVE" "$workdir/.claude-code-hermit")"
run_test "skipped: no-type.md left in place" bash -c "[ -f '$d/no-type.md' ]"
run_test "skipped: no-created.md left in place" bash -c "[ -f '$d/no-created.md' ]"
run_test "skipped: 2 skipped in output" bash -c "echo '$out' | grep -qF '2 skipped'"
rm -rf "$workdir"

# -------------------------------------------------------
# 4. Fail-open: no state dir → exit 0
# -------------------------------------------------------
workdir="$(mktemp -d)"
node "$ARCHIVE" "$workdir/nonexistent" >/dev/null 2>&1
ec=$?
run_test "fail-open: exit 0 with no state dir" bash -c "[ $ec -eq 0 ]"
rm -rf "$workdir"

# -------------------------------------------------------
# Summary
# -------------------------------------------------------
print_results
