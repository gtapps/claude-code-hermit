// Regression: skill-correction inner-loop — prose-pin + ledger behavioral tests.
//
// Guards the capture contract (session-close debrief question 3 + append row),
// the graduation routing (reflect step 3b `skill-correction:*` branch),
// the proposal-act anchor parse (## Skill Improvement source_artifact),
// and the graceful-degrade path (no brief → moderate proposal, no REJECT).
//
// Usage: bun test tests/skill-correction-ledger.test.ts   (from the plugin root)

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { runScript, PLUGIN_ROOT } from './helpers/run';

const read = (...p: string[]) => fs.readFileSync(path.join(PLUGIN_ROOT, ...p), 'utf-8');

// Ledger rows must be dated relative to now, not pinned to a literal date:
// prune-observations.ts enforces a 30-day retention window, so a hardcoded
// timestamp silently flips the "both rows are fresh" prune assertion from pass
// to fail once the wall clock passes it.
const hoursAgoISO = (h: number) => new Date(Date.now() - h * 3600000).toISOString();

const sessionClose = read('skills', 'session-close', 'SKILL.md');
// reflect's skill-correction routing detail lives in branches.md (the
// rare-branch procedures file); assert against the combined surface.
const reflect        = read('skills', 'reflect', 'SKILL.md') + '\n' + read('skills', 'reflect', 'branches.md');
const proposalAct    = read('skills', 'proposal-act', 'SKILL.md');
const channelResponder = read('skills', 'channel-responder', 'SKILL.md');

// ── 1. session-close: capture contract prose pins ───────────────────────────

describe('session-close: skill-correction capture', () => {
  test('session-close: third debrief question asks about defective skill output', () => {
    expect(sessionClose).toContain('Did a skill produce output this session that was wrong');
  });

  test('session-close: defect-only criterion excludes preference/scope changes', () => {
    expect(sessionClose).toContain('Exclude preference, scope, or context changes');
  });

  test('session-close: uses skill-correction source value in the append row', () => {
    expect(sessionClose).toContain('"source":"skill-correction"');
  });

  test('session-close: pattern is skill-correction:<canonical-name>', () => {
    expect(sessionClose).toContain('"pattern":"skill-correction:<canonical-name>"');
  });

  test('session-close: append command tolerates failure with || true', () => {
    expect(sessionClose).toContain('|| true');
  });

  test('session-close: canonical name reads name: frontmatter, strips plugin prefix', () => {
    expect(sessionClose).toContain('strip any `claude-code-hermit:`/`<plugin>:` prefix');
  });

  test('session-close: what/why goes on a ## Lessons line (not a ledger field)', () => {
    expect(sessionClose).toContain('Lessons line carries the reason content');
  });

  test('session-close: auto-close skips correction rows (gated to operator-close)', () => {
    expect(sessionClose).toContain('`--auto` skips step 1 and writes no correction rows');
  });
});

// ── 2. observations ledger: append-metrics behavioral test ──────────────────

describe('append-metrics: skill-correction row round-trip', () => {
  let workdir: string;
  let ledger: string;

  beforeAll(() => {
    workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'hermit-skill-corr-'));
    fs.mkdirSync(path.join(workdir, '.claude-code-hermit', 'state'), { recursive: true });
    ledger = path.join(workdir, '.claude-code-hermit', 'state', 'observations.jsonl');
  });

  afterAll(() => {
    try { fs.rmSync(workdir, { recursive: true, force: true }); } catch {}
  });

  test('append-metrics: skill-correction row appended and parseable', async () => {
    const row = JSON.stringify({
      ts: hoursAgoISO(2),
      pattern: 'skill-correction:my-skill',
      session_id: 'S-001',
      source: 'skill-correction',
      origin: 'own-work',
    });
    const r = await runScript('append-metrics.ts', { args: [ledger, row] });
    expect(r.exitCode).toBe(0);

    const lines = fs.readFileSync(ledger, 'utf-8').trim().split('\n');
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]);
    expect(parsed.pattern).toBe('skill-correction:my-skill');
    expect(parsed.source).toBe('skill-correction');
    expect(parsed.origin).toBe('own-work');
    expect(parsed.session_id).toBe('S-001');
  });

  test('append-metrics: two distinct-session rows group by pattern in prune', async () => {
    // append a second session row for the same pattern
    const row2 = JSON.stringify({
      ts: hoursAgoISO(1),
      pattern: 'skill-correction:my-skill',
      session_id: 'S-002',
      source: 'skill-correction',
      origin: 'own-work',
    });
    await runScript('append-metrics.ts', { args: [ledger, row2] });

    const lines = fs.readFileSync(ledger, 'utf-8').trim().split('\n');
    expect(lines).toHaveLength(2);

    // Both rows have the same pattern — grouping by pattern gives distinct session_ids [S-001, S-002]
    const parsed = lines.map((l) => JSON.parse(l));
    const sessions = new Set(parsed.filter((r) => r.pattern === 'skill-correction:my-skill').map((r) => r.session_id));
    expect(sessions.size).toBe(2);
  });

  // Depends on both prior append tests having run (shared workdir ledger has 2 rows).
  test('prune-observations: skill-correction rows survive (both sessions fresh)', async () => {
    const r = await runScript('prune-observations.ts', {
      args: [path.join(workdir, '.claude-code-hermit')],
    });
    expect(r.exitCode).toBe(0);
    // both rows are fresh — neither should be pruned
    expect(r.stdout).toContain('pruned 0, kept 2');
    const after = fs.readFileSync(ledger, 'utf-8');
    expect(after).toContain('skill-correction:my-skill');
    expect(after).toContain('S-001');
    expect(after).toContain('S-002');
  });
});

// ── 3. reflect: skill-correction graduation routing prose pins ──────────────

describe('reflect: skill-correction:* graduation routing', () => {
  test('reflect: skill-correction routing block present in step 3b', () => {
    expect(reflect).toContain('skill-correction:*` routing');
  });

  test('reflect: brief search covers compiled/ and compiled/.archive/', () => {
    expect(reflect).toContain('compiled/.archive/procedure-brief-');
  });

  test('reflect: brief selection prefers live compiled/ over archived', () => {
    expect(reflect).toContain('prefer a live `compiled/` match over an archived one');
  });

  test('reflect: brief tiebreak uses newest created: frontmatter', () => {
    expect(reflect).toContain("newest `created:` frontmatter date");
  });

  test('reflect: brief found path routes to ## Skill Improvement with source_artifact', () => {
    expect(reflect).toContain('## Skill Improvement');
    expect(reflect).toContain('source_artifact: <brief path>');
  });

  test('reflect: brief found path reads cited sessions Lessons for corrected behaviors', () => {
    expect(reflect).toContain("each session listed in the graduated ledger rows' `session_id` fields");
  });

  test('reflect: no brief found path produces moderate plain proposal (no ## Skill Improvement)', () => {
    expect(reflect).toContain('plain Tier 2 improvement proposal (no `## Skill Improvement`, no skill-creator). The candidate carries `Artifact: state/observations.jsonl`');
  });

  test('reflect: both paths carry Artifact: state/observations.jsonl for judge §1.4', () => {
    // The routing block mentions the Artifact line in both branches — count occurrences
    const count = (reflect.match(/Artifact: state\/observations\.jsonl/g) ?? []).length;
    expect(count).toBeGreaterThanOrEqual(2);
  });

  test('reflect: Component Health Skills bullet references ledger graduation as backing', () => {
    expect(reflect).toContain('skill-correction:*` ledger graduation in step 3b');
  });
});

// ── 3b. channel-responder: correction → ledger row prose pins ───────────────

describe('channel-responder: resolved correction routes to ledger row', () => {
  test('channel-responder: resolved corrections append instead of a Findings line', () => {
    expect(channelResponder).toContain('Resolved corrections → observations ledger, not Findings');
  });

  test('channel-responder: uses skill-correction source value in the append row', () => {
    expect(channelResponder).toContain('"source":"skill-correction"');
  });

  test('channel-responder: pattern is skill-correction:<canonical-name>', () => {
    expect(channelResponder).toContain('"pattern":"skill-correction:<canonical-name>"');
  });

  test('channel-responder: append command tolerates failure with || true', () => {
    expect(channelResponder).toContain('|| true');
  });

  test('channel-responder: unresolved corrections fall back to the Findings line', () => {
    expect(channelResponder).toContain('do not guess a `<name>`');
  });
});

// ── 4. proposal-act: ## Skill Improvement source_artifact parse ─────────────

describe('proposal-act: ## Skill Improvement anchor handling', () => {
  test('proposal-act: parses source_artifact from ## Skill Improvement body', () => {
    expect(proposalAct).toContain('parse the `source_artifact:` line from the `## Skill Improvement` body');
  });

  test('proposal-act: anchor lookup searches compiled/ then compiled/.archive/', () => {
    // The Skill Improvement branch description references the archive search
    expect(proposalAct).toContain("search `compiled/` then `compiled/.archive/`");
  });

  test('proposal-act: missing anchor degrades gracefully (no REJECT)', () => {
    expect(proposalAct).toContain('Missing or unreadable anchor: proceed without it (no REJECT');
  });

  test('proposal-act: anchor absence contrast with ## Skill Draft (which hard-rejects stale paths)', () => {
    expect(proposalAct).toContain('unlike `## Skill Draft` which hard-rejects stale paths');
  });

  test('proposal-act: brief content passed as input context to skill-creator improve', () => {
    expect(proposalAct).toContain('pass its content as input context to skill-creator improve');
  });
});
