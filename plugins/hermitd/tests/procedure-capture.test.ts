// Regression: procedure capture — detect, brief, propose, install flow
// (bun test port of test-procedure-capture.sh).
//
// Guards the three SKILL.md files that implement procedure capture so that
// future edits don't silently lose the detection logic, the audit-artifact
// naming, the Tier-3 routing, the ## Skill Draft dispatch, the second
// confirmation gate, or the kill-criteria instrumentation.
//
// Also asserts PROPOSAL.md.template is unchanged (no new frontmatter field
// was added — the ## Skill Draft body-section decision is locked in here;
// the bash suite's inline python3 frontmatter check is ported to JS).
//
// Usage: bun test tests/procedure-capture.test.ts   (from the plugin root)

import { describe, test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';

import { PLUGIN_ROOT } from './helpers/run';

const REFLECT = path.join(PLUGIN_ROOT, 'skills', 'reflect', 'SKILL.md');
const REFLECT_BRANCHES = path.join(PLUGIN_ROOT, 'skills', 'reflect', 'branches.md');
const PROPOSAL_CREATE = path.join(PLUGIN_ROOT, 'skills', 'proposal-create', 'SKILL.md');
const PROPOSAL_ACT = path.join(PLUGIN_ROOT, 'skills', 'proposal-act', 'SKILL.md');
const PROPOSAL_ACT_BRANCHES = path.join(PLUGIN_ROOT, 'skills', 'proposal-act', 'branches.md');
const TEMPLATE = path.join(PLUGIN_ROOT, 'state-templates', 'PROPOSAL.md.template');

// reflect's procedure-capture text is split between the SKILL.md stub and
// branches.md (the rare-branch procedures file); assert against the combined surface.
const reflect = fs.readFileSync(REFLECT, 'utf-8') + '\n' + fs.readFileSync(REFLECT_BRANCHES, 'utf-8');
const proposalCreate = fs.readFileSync(PROPOSAL_CREATE, 'utf-8');
const proposalAct = fs.readFileSync(PROPOSAL_ACT, 'utf-8') + '\n' + fs.readFileSync(PROPOSAL_ACT_BRANCHES, 'utf-8');

// ── reflect: new reflection prompt ──────────────────────────────────────────

describe('reflect: procedure capture', () => {
  test('reflect skill files exist', () => {
    expect(fs.existsSync(REFLECT)).toBe(true);
    expect(fs.existsSync(REFLECT_BRANCHES)).toBe(true);
  });

  test('reflect: new procedure-capture reflection prompt present', () => {
    expect(reflect).toContain('procedure-capture candidate');
  });

  // ── reflect: Procedure capture subsection ──────────────────────────────────

  test('reflect: ### Procedure capture subsection present', () => {
    expect(reflect).toContain('### Procedure capture (new-skill creation)');
  });

  test('reflect: reads MEMORY.md + session Lessons for recurrence', () => {
    expect(reflect).toContain('MEMORY.md');
    expect(reflect).toContain('Lessons');
  });

  test('reflect: procedure-capture recurrence gate reads graduation_min_sessions', () => {
    expect(reflect).toContain('graduation_min_sessions');
    expect(reflect).toContain('distinct archived sessions');
  });

  test('reflect: dedup guard checks .claude/skills glob', () => {
    expect(reflect).toContain('.claude/skills');
  });

  test('reflect: dedup guard checks available-skills list', () => {
    expect(reflect).toContain('available-skills list');
  });

  test('reflect: procedure-brief artifact naming convention', () => {
    expect(reflect).toContain('procedure-brief-');
  });

  test('reflect: procedure-brief type: procedure-brief frontmatter', () => {
    expect(reflect).toContain('type: procedure-brief');
  });

  test('reflect: Lane A still Tier 3 and routes to proposal-create', () => {
    expect(reflect).toContain('Lane A (Tier 3');
    expect(reflect).toContain('category: capability');
    expect(reflect).toContain('/hermitd:proposal-create');
  });

  test('reflect: Lane B is Tier 2 routine-bound with a bridged accept/dismiss ask', () => {
    expect(reflect).toContain('Lane B (Tier 2 — routine-bound)');
    expect(reflect).toContain('category: routine');
    expect(reflect).toContain('queue-micro');
    expect(reflect).toContain('"options":["accept","dismiss"]');
    expect(reflect).toContain('on_resolve":"/hermitd:proposal-act {answer} PROP-NNN');
  });

  test('reflect: chat-triggered and external-origin never go to the micro queue', () => {
    expect(reflect).toContain('Chat-triggered and external-origin candidates never go to the micro-approval queue');
  });

  test('reflect: tags candidate with procedure-capture', () => {
    expect(reflect).toContain('procedure-capture');
  });

  test('reflect: ## Skill Draft block format present', () => {
    expect(reflect).toContain('## Skill Draft');
  });
});

// ── reflect: kill criteria ──────────────────────────────────────────────────

describe('reflect: kill criteria', () => {
  test('reflect: kill criteria section present', () => {
    expect(reflect).toContain('Kill criteria');
  });

  test('reflect: kill criteria counts per candidate surfaced (not per reflect run)', () => {
    expect(reflect).toContain('per candidate surfaced');
  });

  test('reflect: kill criteria references ≥8 threshold', () => {
    expect(reflect).toContain('≥8 procedure-capture candidates surfaced');
  });

  test('reflect: kill criteria 25% triage-survival threshold', () => {
    expect(reflect).toContain('25%');
  });

  test('reflect: kill criteria 30% acceptance threshold', () => {
    expect(reflect).toContain('30%');
  });

  test('reflect: kill criteria invokes the metrics verb for procedure-capture', () => {
    expect(reflect).toContain('proposal.ts metrics');
  });

  test('reflect: kill criteria passes --source=procedure-capture to report script', () => {
    expect(reflect).toContain('--source=procedure-capture');
  });

  test("reflect: routing relies on proposal-create's single internal triage gate (no untagged pre-gate)", () => {
    expect(reflect).toContain('runs `proposal-triage` internally');
  });
});

// ── proposal-create: ## Skill Draft variant ──────────────────────────────────

describe('proposal-create: ## Skill Draft variant', () => {
  test('proposal-create skill file exists', () => {
    expect(fs.existsSync(PROPOSAL_CREATE)).toBe(true);
  });

  test('proposal-create: ## Skill Draft body section variant present', () => {
    expect(proposalCreate).toContain('## Skill Draft');
  });

  test('proposal-create: Skill Draft sets category: capability', () => {
    expect(proposalCreate).toContain('category: capability');
  });

  test('proposal-create: Lane B documents category: routine and ## Config', () => {
    expect(proposalCreate).toContain('category: routine');
    expect(proposalCreate).toMatch(/^## Config$/m);
  });

  test('proposal-create: ## Agent Draft block present', () => {
    expect(proposalCreate).toMatch(/^## Agent Draft$/m);
    expect(proposalCreate).toContain('.claude/agents/<name>.md');
  });

  test('proposal-create: Skill Draft sets tags: [procedure-capture]', () => {
    expect(proposalCreate).toContain('procedure-capture');
  });

  test('proposal-create: Skill Draft sets source: auto-detected', () => {
    expect(proposalCreate).toContain('auto-detected');
  });

  test('proposal-create: Skill Draft carries source_artifact', () => {
    expect(proposalCreate).toContain('source_artifact');
  });

  test('proposal-create: Skill Draft carries install_target', () => {
    expect(proposalCreate).toContain('install_target');
  });

  test('proposal-create: triage-verdict emission carries tags (segments triage-survival)', () => {
    // Emitted by the gate verb (tests/scripts.test.ts describe('proposal gate') guards
    // the field lands in the actual event); this guards the call site passes `--tags`.
    expect(proposalCreate).toContain("--tags '[<caller-supplied tags>]'");
  });
});

// ── proposal-act: ## Skill Draft install branch ──────────────────────────────

describe('proposal-act: ## Skill Draft install branch', () => {
  test('proposal-act skill file exists', () => {
    expect(fs.existsSync(PROPOSAL_ACT)).toBe(true);
  });

  test('proposal-act: falsification gate skips ## Skill Draft (authored in-main)', () => {
    expect(proposalAct).toContain('Skill Draft');
  });

  test('proposal-act: falsification gate checks source_artifact exists', () => {
    expect(proposalAct).toContain('source_artifact');
  });

  test('proposal-act: step (e) dispatches ## Skill Draft to install flow', () => {
    expect(proposalAct).toContain('Procedure-capture install flow');
  });

  test('proposal-act: install flow authors the SKILL.md from source_artifact in-main', () => {
    expect(proposalAct).toContain('author the SKILL.md');
    expect(proposalAct).not.toContain('/skill-creator');
  });

  test('proposal-act: second confirmation gate present (operator approves artifact)', () => {
    expect(proposalAct).toContain('Second confirmation gate');
    expect((proposalAct.match(/Second confirmation gate/g) ?? []).length).toBe(1);
  });

  test('proposal-act: second confirmation skipped only on the routine-bound branch', () => {
    expect(proposalAct).toContain('Skip step 4\'s second full-artifact confirmation for this routine-bound branch only');
  });

  test('proposal-act: ## Agent Draft install branch present', () => {
    expect(proposalAct).toContain('## Agent Draft');
    expect(proposalAct).toContain('.claude/agents/<name>.md');
  });

  test('proposal-act: collision guard — never overwrite, default cancel', () => {
    expect(proposalAct).toContain('already exists');
    expect(proposalAct).toContain('Cancel');
  });

  test('proposal-act: install target is .claude/skills/<name>/SKILL.md', () => {
    expect(proposalAct).toContain('.claude/skills/');
  });

  test('proposal-act: no auto-stage/commit of installed skill', () => {
    expect(proposalAct).toContain('Do not auto-stage or commit');
  });

  test('proposal-act: verification reads installed file frontmatter (not live available-skills)', () => {
    expect(proposalAct).toContain("installed file's frontmatter");
    expect(proposalAct).not.toContain('next session reload');
    expect(proposalAct).toContain('until the next user turn');
  });

  test('proposal-act: queued record note for ## Skill Draft present', () => {
    expect(proposalAct).toContain('Skill Draft');
  });
});

// ── PROPOSAL.md.template: unchanged (body-section decision locked in) ────────

test('PROPOSAL.md.template: no new frontmatter key added (still 15 keys)', () => {
  const text = fs.readFileSync(TEMPLATE, 'utf-8');
  // Extract the YAML frontmatter between the first pair of --- fences
  const m = /^---\n([\s\S]*?)\n---/m.exec(text);
  expect(m).not.toBeNull();
  const keys = m![1]
    .split('\n')
    .filter((line) => line.includes(':') && !line.startsWith(' '))
    .map((line) => line.split(':')[0].trim());
  // The 15 well-known frontmatter keys
  const EXPECTED = new Set([
    'id', 'title', 'status', 'source', 'session', 'created', 'accepted_date',
    'resolved_date', 'related_sessions', 'category', 'tags', 'responded',
    'self_eval_key', 'accepted_in_session', 'success_signal',
  ]);
  const extra = keys.filter((k) => !EXPECTED.has(k));
  expect(extra).toEqual([]);
});
