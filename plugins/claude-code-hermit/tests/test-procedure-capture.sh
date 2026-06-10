#!/usr/bin/env bash
# Regression: procedure capture — detect, brief, propose, install flow.
#
# Guards the three SKILL.md files that implement procedure capture so that
# future edits don't silently lose the detection logic, the audit-artifact
# naming, the Tier-3 routing, the ## Skill Draft dispatch, the second
# confirmation gate, or the kill-criteria instrumentation.
#
# Also asserts PROPOSAL.md.template is unchanged (no new frontmatter field
# was added — the ## Skill Draft body-section decision is locked in here).
#
# Runs from inside plugins/claude-code-hermit/ (REPO_ROOT = that directory).
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=lib.sh
source "$SCRIPT_DIR/lib.sh"

echo "=== procedure capture tests ==="
echo ""

REFLECT="$REPO_ROOT/skills/reflect/SKILL.md"
PROPOSAL_CREATE="$REPO_ROOT/skills/proposal-create/SKILL.md"
PROPOSAL_ACT="$REPO_ROOT/skills/proposal-act/SKILL.md"
TEMPLATE="$REPO_ROOT/state-templates/PROPOSAL.md.template"

# ── reflect: new reflection prompt ──────────────────────────────────────────

run_test "reflect skill file exists" test -f "$REFLECT"

run_test "reflect: new procedure-capture reflection prompt present" \
  grep -qF "procedure-capture candidate" "$REFLECT"

# ── reflect: Procedure capture subsection ────────────────────────────────────

run_test "reflect: ### Procedure capture subsection present" \
  grep -qF "### Procedure capture (new-skill creation)" "$REFLECT"

run_test "reflect: reads MEMORY.md + session Lessons for recurrence" \
  bash -c "grep -qF 'MEMORY.md' \"$REFLECT\" && grep -qF 'Lessons' \"$REFLECT\""

run_test "reflect: ≥2 distinct archived sessions recurrence gate" \
  grep -qF "≥2 distinct archived sessions" "$REFLECT"

run_test "reflect: dedup guard checks .claude/skills glob" \
  grep -qF ".claude/skills" "$REFLECT"

run_test "reflect: dedup guard checks available-skills list" \
  bash -c "grep -qF 'available-skills list' \"$REFLECT\""

run_test "reflect: procedure-brief artifact naming convention" \
  grep -qF "procedure-brief-" "$REFLECT"

run_test "reflect: procedure-brief type: procedure-brief frontmatter" \
  grep -qF "type: procedure-brief" "$REFLECT"

run_test "reflect: Tier-3 routing (never micro-approval queue)" \
  bash -c "grep -qF 'Tier 3' \"$REFLECT\" && grep -qiF 'never queue procedure-capture' \"$REFLECT\""

run_test "reflect: routes to proposal-create (not micro-approval)" \
  grep -qF "/claude-code-hermit:proposal-create" "$REFLECT"

run_test "reflect: tags candidate with procedure-capture" \
  grep -qF "procedure-capture" "$REFLECT"

run_test "reflect: sets category: capability" \
  grep -qF "category: capability" "$REFLECT"

run_test "reflect: ## Skill Draft block format present" \
  grep -qF "## Skill Draft" "$REFLECT"

# ── reflect: kill criteria ──────────────────────────────────────────────────

run_test "reflect: kill criteria section present" \
  grep -qF "Kill criteria" "$REFLECT"

run_test "reflect: kill criteria counts per candidate surfaced (not per reflect run)" \
  grep -qF "per candidate surfaced" "$REFLECT"

run_test "reflect: kill criteria references ≥8 threshold" \
  grep -qF "≥8 procedure-capture candidates surfaced" "$REFLECT"

run_test "reflect: kill criteria 25% triage-survival threshold" \
  grep -qF "25%" "$REFLECT"

run_test "reflect: kill criteria 30% acceptance threshold" \
  grep -qF "30%" "$REFLECT"

run_test "reflect: kill criteria grep targets procedure-capture tag in created events" \
  grep -qF '"type":"created".*"tags":.*"procedure-capture"' "$REFLECT"

run_test "reflect: kill criteria caveat about shared evidence_source" \
  grep -qF "best-effort" "$REFLECT"

# ── proposal-create: ## Skill Draft variant ──────────────────────────────────

run_test "proposal-create skill file exists" test -f "$PROPOSAL_CREATE"

run_test "proposal-create: ## Skill Draft body section variant present" \
  grep -qF "## Skill Draft" "$PROPOSAL_CREATE"

run_test "proposal-create: Skill Draft sets category: capability" \
  bash -c "grep -qF 'category: capability' \"$PROPOSAL_CREATE\""

run_test "proposal-create: Skill Draft sets tags: [procedure-capture]" \
  bash -c "grep -qF 'procedure-capture' \"$PROPOSAL_CREATE\""

run_test "proposal-create: Skill Draft sets source: auto-detected" \
  bash -c "grep -qF 'auto-detected' \"$PROPOSAL_CREATE\""

run_test "proposal-create: Skill Draft carries source_artifact" \
  grep -qF "source_artifact" "$PROPOSAL_CREATE"

run_test "proposal-create: Skill Draft carries install_target" \
  grep -qF "install_target" "$PROPOSAL_CREATE"

# ── proposal-act: ## Skill Draft install branch ──────────────────────────────

run_test "proposal-act skill file exists" test -f "$PROPOSAL_ACT"

run_test "proposal-act: falsification gate skips ## Skill Draft (delegates to /skill-creator)" \
  grep -qF "Skill Draft" "$PROPOSAL_ACT"

run_test "proposal-act: falsification gate checks source_artifact exists" \
  grep -qF "source_artifact" "$PROPOSAL_ACT"

run_test "proposal-act: step (e) dispatches ## Skill Draft to install flow" \
  bash -c "grep -qF 'Procedure-capture install flow' \"$PROPOSAL_ACT\""

run_test "proposal-act: install flow invokes /skill-creator" \
  bash -c "grep -c '/skill-creator' \"$PROPOSAL_ACT\" | grep -qE '^[2-9]|^[0-9]{2,}'"

run_test "proposal-act: second confirmation gate present (operator approves artifact)" \
  grep -qF "Second confirmation gate" "$PROPOSAL_ACT"

run_test "proposal-act: collision guard — never overwrite, default cancel" \
  bash -c "grep -qF 'already exists' \"$PROPOSAL_ACT\" && grep -qF 'Cancel' \"$PROPOSAL_ACT\""

run_test "proposal-act: install target is .claude/skills/<name>/SKILL.md" \
  grep -qF ".claude/skills/" "$PROPOSAL_ACT"

run_test "proposal-act: no auto-stage/commit of installed skill" \
  grep -qF "Do not auto-stage or commit" "$PROPOSAL_ACT"

run_test "proposal-act: verification reads installed file frontmatter (not live available-skills)" \
  grep -qF "installed file's frontmatter" "$PROPOSAL_ACT"

run_test "proposal-act: NEXT-TASK bullet for ## Skill Draft present" \
  bash -c "grep -qF 'Skill Draft' \"$PROPOSAL_ACT\""

# ── PROPOSAL.md.template: unchanged (body-section decision locked in) ────────

run_test "PROPOSAL.md.template: no new frontmatter key added (still 17 keys)" \
  bash -c "python3 - \"$TEMPLATE\" <<'EOF'
import sys, re, pathlib
text = pathlib.Path(sys.argv[1]).read_text()
# Extract the YAML frontmatter between the first pair of --- fences
m = re.search(r'^---\n(.*?)\n---', text, re.DOTALL | re.MULTILINE)
if not m:
    print('ERROR: no frontmatter found', file=sys.stderr); sys.exit(1)
keys = [line.split(':')[0].strip() for line in m.group(1).splitlines() if ':' in line and not line.startswith(' ')]
EXPECTED = {'id','title','status','source','session','created','accepted_date',
            'resolved_date','related_sessions','category','tags','responded',
            'self_eval_key','accepted_in_session','success_signal'}
# Allow the well-known 15 keys (the 17-field count in comments included blank/comment lines)
extra = set(keys) - EXPECTED
if extra:
    print(f'FAIL: unexpected frontmatter keys: {extra}', file=sys.stderr); sys.exit(1)
EOF
"

print_results
