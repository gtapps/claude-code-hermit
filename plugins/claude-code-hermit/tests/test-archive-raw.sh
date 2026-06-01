#!/usr/bin/env bash
# Tests for archive-raw.js — retention, skip diagnostics, -latest pinning, .json support, filename-date fallback.
# Usage: bash tests/test-archive-raw.sh
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/lib.sh"

echo "=== archive-raw.js ==="
echo ""

ARCHIVE="$REPO_ROOT/scripts/archive-raw.js"
# archive-raw.js uses Date.now() directly; to control "now" we manipulate file dates via filenames/frontmatter.
# We use dates well in the past (2020) to guarantee they're expired under any retention window.
PAST="2020-01-01"
RECENT="2099-12-31"

# -------------------------------------------------------
# Helper: make a minimal hermit state dir with raw/ and config.json
# -------------------------------------------------------
make_hermit() {
  local dir
  dir="$(mktemp -d)"
  mkdir -p "$dir/.claude-code-hermit/raw"
  mkdir -p "$dir/.claude-code-hermit/compiled"
  cat > "$dir/.claude-code-hermit/config.json" <<'EOF'
{"knowledge":{"raw_retention_days":14}}
EOF
  echo "$dir"
}

# -------------------------------------------------------
# 1. Empty raw/ — nothing to archive
# -------------------------------------------------------
workdir="$(make_hermit)"
out="$(cd "$workdir" && node "$ARCHIVE" .claude-code-hermit 2>&1)"
run_test "empty raw/: nothing to archive message" bash -c "echo '$out' | grep -q 'nothing to archive'"
cleanup

# -------------------------------------------------------
# 2. Expired dated .md with frontmatter → archived
# -------------------------------------------------------
workdir="$(make_hermit)"
cat > "$workdir/.claude-code-hermit/raw/note-${PAST}.md" <<EOF
---
title: Old note
type: input
created: ${PAST}T00:00:00Z
tags: []
---
body
EOF
out="$(cd "$workdir" && node "$ARCHIVE" .claude-code-hermit 2>&1)"
run_test "md frontmatter: archived (output says 1 archived)" bash -c "echo '$out' | grep -qE '^archive-raw: 1 archived, 0 retained, 0 skipped, 0 pinned'"
run_test "md frontmatter: file moved to .archive/" bash -c \
  "[ -f '$workdir/.claude-code-hermit/raw/.archive/note-${PAST}.md' ] && [ ! -f '$workdir/.claude-code-hermit/raw/note-${PAST}.md' ]"
cleanup

# -------------------------------------------------------
# 3. Expired dated .json with YYYY-MM-DD in filename, no frontmatter → archived via filename fallback
# -------------------------------------------------------
workdir="$(make_hermit)"
echo '{"entities":[]}' > "$workdir/.claude-code-hermit/raw/snapshot-ha-context-${PAST}.json"
out="$(cd "$workdir" && node "$ARCHIVE" .claude-code-hermit 2>&1)"
run_test "json filename-date: archived (output says 1 archived)" bash -c "echo '$out' | grep -qE '^archive-raw: 1 archived, 0 retained, 0 skipped, 0 pinned'"
run_test "json filename-date: file moved to .archive/" bash -c \
  "[ -f '$workdir/.claude-code-hermit/raw/.archive/snapshot-ha-context-${PAST}.json' ] && [ ! -f '$workdir/.claude-code-hermit/raw/snapshot-ha-context-${PAST}.json' ]"
cleanup

# -------------------------------------------------------
# 4. -latest.md and -latest.json → pinned, never archived even when old
# -------------------------------------------------------
workdir="$(make_hermit)"
cat > "$workdir/.claude-code-hermit/raw/patterns-latest.md" <<EOF
---
title: Latest patterns
type: analysis
created: ${PAST}T00:00:00Z
tags: []
---
body
EOF
echo '{"entities":[]}' > "$workdir/.claude-code-hermit/raw/snapshot-ha-normalized-latest.json"
out="$(cd "$workdir" && node "$ARCHIVE" .claude-code-hermit 2>&1)"
run_test "latest alias: output says 0 archived" bash -c "echo '$out' | grep -qE '^archive-raw: 0 archived'"
run_test "latest alias: pinned count = 2" bash -c "echo '$out' | grep -qE '2 pinned'"
run_test "latest alias: patterns-latest.md still in raw/" bash -c \
  "[ -f '$workdir/.claude-code-hermit/raw/patterns-latest.md' ]"
run_test "latest alias: snapshot-ha-normalized-latest.json still in raw/" bash -c \
  "[ -f '$workdir/.claude-code-hermit/raw/snapshot-ha-normalized-latest.json' ]"
cleanup

# -------------------------------------------------------
# 5. File with no created: key and no date in filename → skipped with named reason
# -------------------------------------------------------
workdir="$(make_hermit)"
cat > "$workdir/.claude-code-hermit/raw/no-date.md" <<'EOF'
---
type: input
---
Missing created field.
EOF
out="$(cd "$workdir" && node "$ARCHIVE" .claude-code-hermit 2>&1)"
run_test "missing created: 1 skipped" bash -c "echo '$out' | grep -qF '1 skipped'"
run_test "missing created: named in output" bash -c "echo '$out' | grep -qF 'no-date.md'"
run_test "missing created: reason text" bash -c "echo '$out' | grep -q 'missing created'"
run_test "missing created: file stays in raw/" bash -c \
  "[ -f '$workdir/.claude-code-hermit/raw/no-date.md' ]"
cleanup

# -------------------------------------------------------
# 6. File with malformed created: value and no date in filename → skipped, unparseable reason
# -------------------------------------------------------
workdir="$(make_hermit)"
cat > "$workdir/.claude-code-hermit/raw/bad-date.md" <<'EOF'
---
created: not-a-date
type: input
---
Bad date value.
EOF
out="$(cd "$workdir" && node "$ARCHIVE" .claude-code-hermit 2>&1)"
run_test "malformed created: 1 skipped" bash -c "echo '$out' | grep -qF '1 skipped'"
run_test "malformed created: named in output" bash -c "echo '$out' | grep -qF 'bad-date.md'"
run_test "malformed created: unparseable reason" bash -c "echo '$out' | grep -q 'unparseable'"
cleanup

# -------------------------------------------------------
# 7. .json with no date in filename and no frontmatter → skipped
# -------------------------------------------------------
workdir="$(make_hermit)"
echo '{"state":"unknown"}' > "$workdir/.claude-code-hermit/raw/nodatefile.json"
out="$(cd "$workdir" && node "$ARCHIVE" .claude-code-hermit 2>&1)"
run_test "json no-date: output says 1 skipped" bash -c "echo '$out' | grep -qE '^archive-raw: 0 archived, 0 retained, 1 skipped'"
run_test "json no-date: file still in raw/" bash -c \
  "[ -f '$workdir/.claude-code-hermit/raw/nodatefile.json' ]"
cleanup

# -------------------------------------------------------
# 8. Malformed frontmatter created but valid date in filename → rescued via filename fallback
# -------------------------------------------------------
workdir="$(make_hermit)"
cat > "$workdir/.claude-code-hermit/raw/snapshot-${PAST}.md" <<EOF
---
created: not-a-date
type: input
---
Bad frontmatter date, but filename carries ${PAST}.
EOF
out="$(cd "$workdir" && node "$ARCHIVE" .claude-code-hermit 2>&1)"
run_test "filename rescue: archived despite bad frontmatter" bash -c "echo '$out' | grep -qE '^archive-raw: 1 archived'"
run_test "filename rescue: file moved to .archive/" bash -c \
  "[ -f '$workdir/.claude-code-hermit/raw/.archive/snapshot-${PAST}.md' ]"
cleanup

# -------------------------------------------------------
# 9. Recent dated .json (not yet expired) → retained
# -------------------------------------------------------
workdir="$(make_hermit)"
echo '{"entities":[]}' > "$workdir/.claude-code-hermit/raw/snapshot-ha-context-${RECENT}.json"
out="$(cd "$workdir" && node "$ARCHIVE" .claude-code-hermit 2>&1)"
run_test "json recent: output says 1 retained" bash -c "echo '$out' | grep -qE '^archive-raw: 0 archived, 1 retained'"
run_test "json recent: file still in raw/" bash -c \
  "[ -f '$workdir/.claude-code-hermit/raw/snapshot-ha-context-${RECENT}.json' ]"
cleanup

# -------------------------------------------------------
# 10. Expired .json referenced by a compiled/ artifact → retained (safety check)
# -------------------------------------------------------
workdir="$(make_hermit)"
echo '{"entities":[]}' > "$workdir/.claude-code-hermit/raw/snapshot-ha-context-${PAST}.json"
cat > "$workdir/.claude-code-hermit/compiled/briefing-2020-01-05.md" <<'EOF'
---
title: Briefing
type: briefing
---
See snapshot-ha-context-2020-01-01.json for details.
EOF
out="$(cd "$workdir" && node "$ARCHIVE" .claude-code-hermit 2>&1)"
run_test "json compiled-ref safety: output says 1 retained" bash -c "echo '$out' | grep -qE '^archive-raw: 0 archived, 1 retained'"
run_test "json compiled-ref safety: file still in raw/" bash -c \
  "[ -f '$workdir/.claude-code-hermit/raw/snapshot-ha-context-${PAST}.json' ]"
cleanup

# -------------------------------------------------------
# 11. Mixed bag: expired .md (frontmatter) + expired .json (filename) + -latest.json
#     + missing-created skip → 2 archived, 1 skipped, 1 pinned
# -------------------------------------------------------
workdir="$(make_hermit)"
cat > "$workdir/.claude-code-hermit/raw/audit-${PAST}.md" <<EOF
---
title: Audit
type: audit
created: ${PAST}T00:00:00Z
tags: []
---
body
EOF
echo '{"entities":[]}' > "$workdir/.claude-code-hermit/raw/snapshot-ha-history-7d-${PAST}.json"
echo '{"entities":[]}' > "$workdir/.claude-code-hermit/raw/snapshot-ha-normalized-latest.json"
cat > "$workdir/.claude-code-hermit/raw/no-created.md" <<'EOF'
---
type: input
---
No created.
EOF
out="$(cd "$workdir" && node "$ARCHIVE" .claude-code-hermit 2>&1)"
run_test "mixed: output says 2 archived, 0 retained, 1 skipped, 1 pinned" bash -c "echo '$out' | grep -qE '^archive-raw: 2 archived, 0 retained, 1 skipped, 1 pinned'"
run_test "mixed: no-created.md named in skip output" bash -c "echo '$out' | grep -qF 'no-created.md'"
run_test "mixed: -latest.json still in raw/" bash -c \
  "[ -f '$workdir/.claude-code-hermit/raw/snapshot-ha-normalized-latest.json' ]"
run_test "mixed: dated .md moved to .archive/" bash -c \
  "[ -f '$workdir/.claude-code-hermit/raw/.archive/audit-${PAST}.md' ]"
run_test "mixed: dated .json moved to .archive/" bash -c \
  "[ -f '$workdir/.claude-code-hermit/raw/.archive/snapshot-ha-history-7d-${PAST}.json' ]"
cleanup

# -------------------------------------------------------
# 12. Exit code is always 0 (fail-open)
# -------------------------------------------------------
workdir="$(mktemp -d)"
node "$ARCHIVE" "$workdir/nonexistent-hermit" >/dev/null 2>&1
ec=$?
run_test "fail-open: exit 0 with missing state dir" bash -c "[ $ec -eq 0 ]"
cleanup

print_results
