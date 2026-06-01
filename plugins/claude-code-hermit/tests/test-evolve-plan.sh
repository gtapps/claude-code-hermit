#!/usr/bin/env bash
# Tests for evolve-plan.js (issue #211): the read-only pre-pass analyzer for
# hermit-evolve. Covers version gap, bounded CHANGELOG slice, deep config-key
# diff, template/bin byte-compare, separator-aware CLAUDE-APPEND diff, the
# no_config vs 0.0.0 distinction, and operator-value preservation.
# Usage: bash tests/test-evolve-plan.sh
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/lib.sh"

echo "=== evolve-plan (#211) ==="
echo ""

EVOLVE_PLAN="$REPO_ROOT/scripts/evolve-plan.js"
MARKER='<!-- claude-code-hermit: Session Discipline -->'

# Build a fake plugin root at $PR with plugin version 1.1.7.
PR="$(mktemp -d)"
mkdir -p "$PR/.claude-plugin" "$PR/state-templates/bin"
printf '{"version":"1.1.7"}\n' > "$PR/.claude-plugin/plugin.json"
cat > "$PR/CHANGELOG.md" <<'EOF'
# Changelog

## [1.1.7] - 2026-05-31
### Fixed
- newest change

### Upgrade Instructions
Run the evolve skill.

## [1.1.6] - 2026-05-28
### Added
- middle change

## [1.1.5] - 2026-05-25
### Added
- oldest change
EOF
cat > "$PR/state-templates/config.json.template" <<'EOF'
{
  "_hermit_versions": {},
  "model": "sonnet",
  "routines": [{"id": "x"}],
  "quality_gate": {"tier": "budget"},
  "heartbeat": {"enabled": true, "waiting_timeout": null}
}
EOF
printf -- '---\n\n%s\n## Session Discipline\n\nbody line\n' "$MARKER" > "$PR/state-templates/CLAUDE-APPEND.md"
printf 'SHELL TEMPLATE V1\n'   > "$PR/state-templates/SHELL.md.template"
printf 'REPORT TEMPLATE\n'     > "$PR/state-templates/SESSION-REPORT.md.template"
printf 'PROPOSAL TEMPLATE\n'   > "$PR/state-templates/PROPOSAL.md.template"
printf '#!/bin/sh\necho run\n' > "$PR/state-templates/bin/hermit-run"

# run_plan <hermit-dir> <hatch-target> <out-file>
run_plan() {
  CLAUDE_PLUGIN_ROOT="$PR" node "$EVOLVE_PLAN" "$1" --hatch-target="$2" > "$3" 2>/dev/null
}

# -------------------------------------------------------
# 1. Version gap + bounded changelog slice
# -------------------------------------------------------
proj="$(mktemp -d)"; mkdir -p "$proj/.claude-code-hermit"
echo '{"_hermit_versions":{"claude-code-hermit":"1.1.6"}}' > "$proj/.claude-code-hermit/config.json"
run_plan "$proj/.claude-code-hermit" local "$proj/plan.json"
run_test "version gap: from 1.1.6 -> to 1.1.7, not up_to_date" python3 -c "
import json
d=json.load(open('$proj/plan.json'))
assert d['from']=='1.1.6', d.get('from')
assert d['to']=='1.1.7', d.get('to')
assert d['up_to_date'] is False, d.get('up_to_date')
assert d['errors']==[], d['errors']
"
run_test "changelog slice: only (1.1.6, 1.1.7], excludes older" python3 -c "
import json
d=json.load(open('$proj/plan.json'))
assert d['changelog_versions']==['1.1.7'], d['changelog_versions']
s=d['changelog_slice']
assert 'newest change' in s and 'Upgrade Instructions' in s, s
assert 'middle change' not in s and 'oldest change' not in s, s
"
rm -rf "$proj"

# -------------------------------------------------------
# 2. Up to date
# -------------------------------------------------------
proj="$(mktemp -d)"; mkdir -p "$proj/.claude-code-hermit"
echo '{"_hermit_versions":{"claude-code-hermit":"1.1.7"}}' > "$proj/.claude-code-hermit/config.json"
run_plan "$proj/.claude-code-hermit" local "$proj/plan.json"
run_test "up_to_date true when config == plugin version" python3 -c "
import json
d=json.load(open('$proj/plan.json'))
assert d['up_to_date'] is True, d.get('up_to_date')
assert d['changelog_versions']==[], d['changelog_versions']
"
rm -rf "$proj"

# -------------------------------------------------------
# 3. New config keys: top-level + nested leaf reported, present omitted
# -------------------------------------------------------
proj="$(mktemp -d)"; mkdir -p "$proj/.claude-code-hermit"
cat > "$proj/.claude-code-hermit/config.json" <<'EOF'
{
  "_hermit_versions": {"claude-code-hermit": "1.1.6"},
  "model": "sonnet",
  "routines": [{"id": "x"}],
  "heartbeat": {"enabled": true}
}
EOF
run_plan "$proj/.claude-code-hermit" local "$proj/plan.json"
run_test "new_config_keys: reports quality_gate + heartbeat.waiting_timeout, omits present" python3 -c "
import json
d=json.load(open('$proj/plan.json'))
keys={k['path']: k['default'] for k in d['new_config_keys']}
assert 'quality_gate' in keys, keys
assert keys['quality_gate']=={'tier':'budget'}, keys['quality_gate']
assert 'heartbeat.waiting_timeout' in keys, keys
assert keys['heartbeat.waiting_timeout'] is None, keys['heartbeat.waiting_timeout']
assert 'model' not in keys, keys
assert 'heartbeat.enabled' not in keys, keys
"
rm -rf "$proj"

# -------------------------------------------------------
# 4. templates_changed / bin_changed: only differing/absent files
# -------------------------------------------------------
proj="$(mktemp -d)"; mkdir -p "$proj/.claude-code-hermit/templates" "$proj/.claude-code-hermit/bin"
echo '{"_hermit_versions":{"claude-code-hermit":"1.1.6"}}' > "$proj/.claude-code-hermit/config.json"
printf 'DIFFERENT CONTENT\n' > "$proj/.claude-code-hermit/templates/SHELL.md.template"
printf 'REPORT TEMPLATE\n'   > "$proj/.claude-code-hermit/templates/SESSION-REPORT.md.template"  # identical
# PROPOSAL.md.template absent -> needs copy
printf '#!/bin/sh\necho CHANGED\n' > "$proj/.claude-code-hermit/bin/hermit-run"  # differs
run_plan "$proj/.claude-code-hermit" local "$proj/plan.json"
run_test "templates/bin changed: detects diff + absent, skips identical" python3 -c "
import json
d=json.load(open('$proj/plan.json'))
t=set(d['templates_changed'])
assert 'SHELL.md.template' in t, t
assert 'PROPOSAL.md.template' in t, t
assert 'SESSION-REPORT.md.template' not in t, t
assert d['bin_changed']==['hermit-run'], d['bin_changed']
"
rm -rf "$proj"

# -------------------------------------------------------
# 5a. CLAUDE-APPEND identical (target has leading ---) -> not changed
# -------------------------------------------------------
proj="$(mktemp -d)"; mkdir -p "$proj/.claude-code-hermit"
echo '{"_hermit_versions":{"claude-code-hermit":"1.1.6"}}' > "$proj/.claude-code-hermit/config.json"
printf '# My Project\n\nstuff\n\n---\n\n%s\n## Session Discipline\n\nbody line\n' "$MARKER" > "$proj/CLAUDE.local.md"
run_plan "$proj/.claude-code-hermit" local "$proj/plan.json"
run_test "CLAUDE-APPEND identical (modulo leading ---) -> changed=false, no old_block" python3 -c "
import json
d=json.load(open('$proj/plan.json'))
assert d['claude_append_changed'] is False, d.get('claude_append_changed')
assert 'claude_append_old_block' not in d, 'should omit old_block when unchanged'
"
rm -rf "$proj"

# -------------------------------------------------------
# 5b. CLAUDE-APPEND different -> changed + exact old_block
# -------------------------------------------------------
proj="$(mktemp -d)"; mkdir -p "$proj/.claude-code-hermit"
echo '{"_hermit_versions":{"claude-code-hermit":"1.1.6"}}' > "$proj/.claude-code-hermit/config.json"
printf '# My Project\n\nstuff\n\n---\n\n%s\n## Session Discipline\n\nOLD body line\n' "$MARKER" > "$proj/CLAUDE.local.md"
run_plan "$proj/.claude-code-hermit" local "$proj/plan.json"
run_test "CLAUDE-APPEND different -> changed=true, old_block is exact marker-onward" python3 -c "
import json
d=json.load(open('$proj/plan.json'))
assert d['claude_append_changed'] is True, d.get('claude_append_changed')
ob=d['claude_append_old_block']
assert ob.startswith('<!-- claude-code-hermit: Session Discipline -->'), repr(ob[:40])
assert 'OLD body line' in ob, ob
# must be an exact substring of the target file (so a targeted Edit will match)
assert ob in open('$proj/CLAUDE.local.md').read(), 'old_block not an exact substring'
"
rm -rf "$proj"

# -------------------------------------------------------
# 5c. CLAUDE-APPEND marker absent -> changed (append case), no old_block
# -------------------------------------------------------
proj="$(mktemp -d)"; mkdir -p "$proj/.claude-code-hermit"
echo '{"_hermit_versions":{"claude-code-hermit":"1.1.6"}}' > "$proj/.claude-code-hermit/config.json"
printf '# My Project\n\nno hermit block here\n' > "$proj/CLAUDE.local.md"
run_plan "$proj/.claude-code-hermit" local "$proj/plan.json"
run_test "CLAUDE-APPEND marker absent -> changed=true (append), no old_block" python3 -c "
import json
d=json.load(open('$proj/plan.json'))
assert d['claude_append_changed'] is True, d.get('claude_append_changed')
assert 'claude_append_old_block' not in d, 'append case must omit old_block'
"
rm -rf "$proj"

# -------------------------------------------------------
# 6. no_config: missing config.json -> errors[no_config], no top-level error key
# -------------------------------------------------------
proj="$(mktemp -d)"; mkdir -p "$proj/.claude-code-hermit"
run_plan "$proj/.claude-code-hermit" local "$proj/plan.json"
run_test "no_config: missing config.json -> errors[no_config], single contract" python3 -c "
import json
d=json.load(open('$proj/plan.json'))
codes=[e['code'] for e in d['errors']]
assert 'no_config' in codes, codes
assert 'error' not in d, 'must not use a top-level error key'
assert 'from' not in d, 'should not report a version when there is no config'
"
rm -rf "$proj"

# -------------------------------------------------------
# 7. malformed config.json -> errors[config_json_invalid], not no_config
# -------------------------------------------------------
proj="$(mktemp -d)"; mkdir -p "$proj/.claude-code-hermit"
printf '{"_hermit_versions":' > "$proj/.claude-code-hermit/config.json"
run_plan "$proj/.claude-code-hermit" local "$proj/plan.json"
run_test "malformed config.json -> errors[config_json_invalid], not no_config" python3 -c "
import json
d=json.load(open('$proj/plan.json'))
codes=[e['code'] for e in d['errors']]
assert 'config_json_invalid' in codes, codes
assert 'no_config' not in codes, codes
assert 'from' not in d, 'should not report a version when config is invalid'
"
rm -rf "$proj"

# -------------------------------------------------------
# 8. missing _hermit_versions only -> from 0.0.0, clean errors
# -------------------------------------------------------
proj="$(mktemp -d)"; mkdir -p "$proj/.claude-code-hermit"
echo '{"model":"sonnet"}' > "$proj/.claude-code-hermit/config.json"
run_plan "$proj/.claude-code-hermit" local "$proj/plan.json"
run_test "missing _hermit_versions -> from 0.0.0, errors empty" python3 -c "
import json
d=json.load(open('$proj/plan.json'))
assert d['from']=='0.0.0', d.get('from')
assert d['errors']==[], d['errors']
"
rm -rf "$proj"

# -------------------------------------------------------
# 9. Operator value preserved: present nested key (non-default) omitted
#    (script-level guard for idempotent Step 9 — never re-lists a set key)
# -------------------------------------------------------
proj="$(mktemp -d)"; mkdir -p "$proj/.claude-code-hermit"
cat > "$proj/.claude-code-hermit/config.json" <<'EOF'
{
  "_hermit_versions": {"claude-code-hermit": "1.1.6"},
  "model": "sonnet",
  "routines": [{"id": "x"}],
  "quality_gate": {"tier": "balanced"},
  "heartbeat": {"enabled": true, "waiting_timeout": "30m"}
}
EOF
run_plan "$proj/.claude-code-hermit" local "$proj/plan.json"
run_test "operator value preserved: set quality_gate.tier not re-listed" python3 -c "
import json
d=json.load(open('$proj/plan.json'))
paths=[k['path'] for k in d['new_config_keys']]
assert 'quality_gate' not in paths, paths
assert 'heartbeat.waiting_timeout' not in paths, paths
"
rm -rf "$proj"

# -------------------------------------------------------
# 10. no_hatch_target: required flag missing -> errors[no_hatch_target]
# -------------------------------------------------------
proj="$(mktemp -d)"; mkdir -p "$proj/.claude-code-hermit"
echo '{"_hermit_versions":{"claude-code-hermit":"1.1.6"}}' > "$proj/.claude-code-hermit/config.json"
CLAUDE_PLUGIN_ROOT="$PR" node "$EVOLVE_PLAN" "$proj/.claude-code-hermit" > "$proj/plan.json" 2>/dev/null
run_test "no_hatch_target: missing flag -> errors[no_hatch_target], exit 0" python3 -c "
import json
d=json.load(open('$proj/plan.json'))
codes=[e['code'] for e in d['errors']]
assert 'no_hatch_target' in codes, codes
"
rm -rf "$proj"

rm -rf "$PR"
print_results
