#!/usr/bin/env bash
# Tests for archive-raw.js — raw artifact archival and skip diagnostics.
# Usage: bash tests/test-archive-raw.sh
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/lib.sh"

echo "=== archive-raw.js ==="
echo ""

SCRIPT="$REPO_ROOT/scripts/archive-raw.js"
created_old="$(date -u -d '30 days ago' '+%Y-%m-%d' 2>/dev/null || date -u -v-30d '+%Y-%m-%d')"

# -------------------------------------------------------
# 1. Empty raw/ — nothing to archive
# -------------------------------------------------------
workdir="$(mktemp -d)"
mkdir -p "$workdir/.claude-code-hermit/raw"
out="$(node "$SCRIPT" "$workdir/.claude-code-hermit")"
run_test "empty raw/: nothing to archive message" bash -c "echo '$out' | grep -q 'nothing to archive'"
cleanup

# -------------------------------------------------------
# 2. Valid expired unreferenced file — archived
# -------------------------------------------------------
workdir="$(mktemp -d)"
mkdir -p "$workdir/.claude-code-hermit/raw"
mkdir -p "$workdir/.claude-code-hermit/compiled"
# created 30 days ago (past default 14-day retention)
cat > "$workdir/.claude-code-hermit/raw/old-note.md" <<EOF
---
created: $created_old
type: input
---
Old content.
EOF
out="$(node "$SCRIPT" "$workdir/.claude-code-hermit")"
run_test "valid expired: 1 archived" bash -c "echo '$out' | grep -qF '1 archived'"
run_test "valid expired: 0 skipped" bash -c "echo '$out' | grep -qF '0 skipped'"
run_test "valid expired: file moved to .archive/" bash -c \
  "[ -f '$workdir/.claude-code-hermit/raw/.archive/old-note.md' ]"
run_test "valid expired: file no longer in raw/" bash -c \
  "[ ! -f '$workdir/.claude-code-hermit/raw/old-note.md' ]"
cleanup

# -------------------------------------------------------
# 3. File with no created: key — skipped with named reason
# -------------------------------------------------------
workdir="$(mktemp -d)"
mkdir -p "$workdir/.claude-code-hermit/raw"
cat > "$workdir/.claude-code-hermit/raw/no-date.md" <<'EOF'
---
type: input
---
Missing created field.
EOF
out="$(node "$SCRIPT" "$workdir/.claude-code-hermit")"
run_test "missing created: 1 skipped" bash -c "echo '$out' | grep -qF '1 skipped'"
run_test "missing created: named in output" bash -c "echo '$out' | grep -qF 'no-date.md'"
run_test "missing created: reason text" bash -c "echo '$out' | grep -q 'missing created'"
run_test "missing created: file stays in raw/" bash -c \
  "[ -f '$workdir/.claude-code-hermit/raw/no-date.md' ]"
cleanup

# -------------------------------------------------------
# 4. File with malformed created: value — skipped with named reason
# -------------------------------------------------------
workdir="$(mktemp -d)"
mkdir -p "$workdir/.claude-code-hermit/raw"
cat > "$workdir/.claude-code-hermit/raw/bad-date.md" <<'EOF'
---
created: not-a-date
type: input
---
Bad date value.
EOF
out="$(node "$SCRIPT" "$workdir/.claude-code-hermit")"
run_test "malformed created: 1 skipped" bash -c "echo '$out' | grep -qF '1 skipped'"
run_test "malformed created: named in output" bash -c "echo '$out' | grep -qF 'bad-date.md'"
run_test "malformed created: unparseable reason" bash -c "echo '$out' | grep -q 'unparseable'"
cleanup

# -------------------------------------------------------
# 5. Referenced file — retained even if past retention
# -------------------------------------------------------
workdir="$(mktemp -d)"
mkdir -p "$workdir/.claude-code-hermit/raw"
mkdir -p "$workdir/.claude-code-hermit/compiled"
cat > "$workdir/.claude-code-hermit/raw/referenced.md" <<EOF
---
created: $created_old
type: input
---
Referenced content.
EOF
cat > "$workdir/.claude-code-hermit/compiled/briefing.md" <<'EOF'
---
type: note
---
See referenced.md for context.
EOF
out="$(node "$SCRIPT" "$workdir/.claude-code-hermit")"
run_test "referenced: 1 retained" bash -c "echo '$out' | grep -qF '1 retained'"
run_test "referenced: 0 archived" bash -c "echo '$out' | grep -qF '0 archived'"
run_test "referenced: file stays in raw/" bash -c \
  "[ -f '$workdir/.claude-code-hermit/raw/referenced.md' ]"
cleanup

# -------------------------------------------------------
# 6. Mixed bag: valid+expired, missing-created, malformed-created, referenced
#    Summary counts and per-file skip lines all present
# -------------------------------------------------------
workdir="$(mktemp -d)"
mkdir -p "$workdir/.claude-code-hermit/raw"
mkdir -p "$workdir/.claude-code-hermit/compiled"

cat > "$workdir/.claude-code-hermit/raw/archivable.md" <<EOF
---
created: $created_old
type: input
---
Archivable.
EOF
cat > "$workdir/.claude-code-hermit/raw/no-created.md" <<'EOF'
---
type: input
---
No created.
EOF
cat > "$workdir/.claude-code-hermit/raw/bad-created.md" <<'EOF'
---
created: oops
type: input
---
Bad.
EOF
cat > "$workdir/.claude-code-hermit/raw/kept.md" <<EOF
---
created: $created_old
type: input
---
Kept.
EOF
cat > "$workdir/.claude-code-hermit/compiled/ref.md" <<'EOF'
---
type: note
---
kept.md is referenced here.
EOF

out="$(node "$SCRIPT" "$workdir/.claude-code-hermit")"
run_test "mixed: 1 archived" bash -c "echo '$out' | grep -qF '1 archived'"
run_test "mixed: 1 retained" bash -c "echo '$out' | grep -qF '1 retained'"
run_test "mixed: 2 skipped" bash -c "echo '$out' | grep -qF '2 skipped'"
run_test "mixed: no-created.md named" bash -c "echo '$out' | grep -qF 'no-created.md'"
run_test "mixed: bad-created.md named" bash -c "echo '$out' | grep -qF 'bad-created.md'"
cleanup

# -------------------------------------------------------
# 7. Exit code is always 0 (fail-open)
# -------------------------------------------------------
workdir="$(mktemp -d)"
node "$SCRIPT" "$workdir/nonexistent-hermit" >/dev/null 2>&1
ec=$?
run_test "fail-open: exit 0 with missing state dir" bash -c "[ $ec -eq 0 ]"
cleanup

# -------------------------------------------------------
# Summary
# -------------------------------------------------------
print_results
