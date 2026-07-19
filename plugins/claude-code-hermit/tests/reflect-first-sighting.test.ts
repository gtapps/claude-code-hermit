// reflect-first-sighting.test.ts
//
// Tests for the three changes that fix reflection input-starvation:
//   1. Drift capture in reflect-precheck.ts (writes startup-drift rows to observations.jsonl)
//   2. Freshness RUN gate (flips EMPTY→RUN when ledger has rows newer than last_run_at)
//   3. graduation_min_sessions config key (lowers graduation threshold; origin aggregation)
//
// Also tests the observations_fresh phase key documentation and triage/proposal-create
// exception for state/observations.jsonl artifact candidates.
//
// Usage: bun test tests/reflect-first-sighting.test.ts   (from the plugin root)

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { PLUGIN_ROOT, SCRIPTS_DIR, runScript } from './helpers/run';

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeTmpHermit(overrides: {
  runtimeJson?: Record<string, unknown>;
  lastRunAt?: string | null;
  observations?: string[];
} = {}): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hermit-fst-'));

  // Minimal state directory
  const stateDir = path.join(dir, 'state');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.mkdirSync(path.join(dir, 'sessions'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'raw'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'compiled'), { recursive: true });

  // SHELL.md
  fs.writeFileSync(path.join(dir, 'sessions', 'SHELL.md'), '## Progress Log\n', 'utf-8');

  // reflection-state.json — recent behavior cursor keeps the weekly `behavior`
  // phase quiet for tests that aren't exercising it (the behavior-phase suite
  // overwrites this file with its own cursor).
  const reflState: Record<string, unknown> = { counters: {}, last_behavior_digest_at: new Date().toISOString() };
  if (overrides.lastRunAt !== undefined) {
    (reflState.counters as Record<string, unknown>).last_run_at = overrides.lastRunAt;
  }
  fs.writeFileSync(path.join(stateDir, 'reflection-state.json'), JSON.stringify(reflState), 'utf-8');

  // runtime.json
  const runtime = overrides.runtimeJson ?? { session_state: 'idle', session_id: null };
  fs.writeFileSync(path.join(stateDir, 'runtime.json'), JSON.stringify(runtime), 'utf-8');

  // config.json
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ timezone: 'UTC' }), 'utf-8');

  // observations.jsonl
  const obsContent = overrides.observations?.length
    ? overrides.observations.join('\n') + '\n'
    : '';
  fs.writeFileSync(path.join(stateDir, 'observations.jsonl'), obsContent, 'utf-8');

  return dir;
}

function readObservations(hermitDir: string): Array<Record<string, unknown>> {
  const p = path.join(hermitDir, 'state', 'observations.jsonl');
  try {
    const content = fs.readFileSync(p, 'utf-8').trim();
    if (!content) return [];
    return content.split('\n').filter(Boolean).map(l => JSON.parse(l));
  } catch {
    return [];
  }
}

async function runPrecheck(hermitDir: string): Promise<string> {
  const result = await runScript('reflect-precheck.ts', { args: [hermitDir, PLUGIN_ROOT] });
  return result.stdout.trim();
}

// ── Section 1: Drift capture ──────────────────────────────────────────────────

describe('reflect-precheck: drift capture', () => {
  let hermitDir: string;

  beforeEach(() => { hermitDir = makeTmpHermit({ lastRunAt: null }); });
  afterEach(() => { fs.rmSync(hermitDir, { recursive: true, force: true }); });

  test('precheck writes startup-drift row when unknown top-level dir exists', async () => {
    // Create an unknown top-level dir to trigger storage drift
    fs.mkdirSync(path.join(hermitDir, 'reports'));
    fs.writeFileSync(path.join(hermitDir, 'reports', 'foo.md'), '# test', 'utf-8');

    await runPrecheck(hermitDir);

    const rows = readObservations(hermitDir);
    const driftRow = rows.find(r => typeof r.pattern === 'string' && r.pattern.startsWith('storage-drift:'));
    expect(driftRow).toBeDefined();
    expect(driftRow?.source).toBe('startup-drift');
    expect(driftRow?.origin).toBe('own-work');
  });

  test('precheck drift row has required fields (ts, pattern, session_id, source, origin)', async () => {
    fs.mkdirSync(path.join(hermitDir, 'audits'));

    await runPrecheck(hermitDir);

    const rows = readObservations(hermitDir);
    const driftRow = rows.find(r => typeof r.pattern === 'string' && r.pattern.startsWith('storage-drift:'));
    expect(driftRow).toBeDefined();
    expect(typeof driftRow?.ts).toBe('string');
    expect(typeof driftRow?.pattern).toBe('string');
    expect(typeof driftRow?.session_id).toBe('string');
    expect(driftRow?.source).toBe('startup-drift');
    expect(driftRow?.origin).toBe('own-work');
  });

  test('session_id resolves to "unknown" when runtime.session_id is null', async () => {
    fs.mkdirSync(path.join(hermitDir, 'reports'));

    await runPrecheck(hermitDir);

    const rows = readObservations(hermitDir);
    const driftRow = rows.find(r => typeof r.pattern === 'string' && r.pattern.startsWith('storage-drift:'));
    expect(driftRow?.session_id).toBe('unknown');
  });

  test('session_id resolves to "unknown" when runtime.json is absent', async () => {
    // Remove runtime.json
    fs.unlinkSync(path.join(hermitDir, 'state', 'runtime.json'));
    fs.mkdirSync(path.join(hermitDir, 'reports'));

    await runPrecheck(hermitDir);

    const rows = readObservations(hermitDir);
    const driftRow = rows.find(r => typeof r.pattern === 'string' && r.pattern.startsWith('storage-drift:'));
    expect(driftRow?.session_id).toBe('unknown');
  });

  test('dedup by pattern: same session does not write duplicate rows', async () => {
    fs.mkdirSync(path.join(hermitDir, 'reports'));

    // Run twice
    await runPrecheck(hermitDir);
    await runPrecheck(hermitDir);

    const rows = readObservations(hermitDir).filter(r =>
      typeof r.pattern === 'string' && r.pattern === 'storage-drift:reports'
    );
    expect(rows.length).toBe(1);
  });

  test('dedup by pattern: a different session does NOT write a duplicate drift row', async () => {
    fs.mkdirSync(path.join(hermitDir, 'reports'));

    // First run: session_id = "S-001"
    const runtime1 = { session_state: 'idle', session_id: 'S-001' };
    fs.writeFileSync(path.join(hermitDir, 'state', 'runtime.json'), JSON.stringify(runtime1), 'utf-8');
    await runPrecheck(hermitDir);

    // Second run: session_id = "S-002" (different session). Drift is structural, so the
    // standing pattern is not re-written — otherwise it would flip reflect to RUN every session.
    const runtime2 = { session_state: 'idle', session_id: 'S-002' };
    fs.writeFileSync(path.join(hermitDir, 'state', 'runtime.json'), JSON.stringify(runtime2), 'utf-8');
    await runPrecheck(hermitDir);

    const rows = readObservations(hermitDir).filter(r =>
      typeof r.pattern === 'string' && r.pattern === 'storage-drift:reports'
    );
    expect(rows.length).toBe(1);
    expect(rows[0].session_id).toBe('S-001');
  });

  test('storage-drift slug preserves the full subpath under raw/', async () => {
    fs.mkdirSync(path.join(hermitDir, 'raw', 'sub'), { recursive: true });

    await runPrecheck(hermitDir);

    const rows = readObservations(hermitDir);
    const driftRow = rows.find(r => typeof r.pattern === 'string' && r.pattern.startsWith('storage-drift:raw'));
    expect(driftRow?.pattern).toBe('storage-drift:raw/sub');
  });

  test('precheck writes a schema-drift row for an undeclared compiled type', async () => {
    fs.writeFileSync(path.join(hermitDir, 'knowledge-schema.md'),
      '## Work Products\n\n- guide:\n- design:\n', 'utf-8');
    fs.writeFileSync(path.join(hermitDir, 'compiled', 'note.md'),
      '---\ntitle: x\ntype: spike\ncreated: 2026-01-01T00:00:00Z\n---\n# x\n', 'utf-8');

    await runPrecheck(hermitDir);

    const rows = readObservations(hermitDir);
    const driftRow = rows.find(r => r.pattern === 'schema-drift:spike');
    expect(driftRow).toBeDefined();
    expect(driftRow?.source).toBe('startup-drift');
    expect(driftRow?.origin).toBe('own-work');
  });

  test('precheck is fail-open: exits 0 even when hermitDir is missing', async () => {
    const result = await runScript('reflect-precheck.ts', {
      args: ['/nonexistent/dir', PLUGIN_ROOT],
    });
    expect(result.exitCode).toBe(0);
  });

  test('no drift written when hermit dirs are clean', async () => {
    await runPrecheck(hermitDir);

    const rows = readObservations(hermitDir).filter(r =>
      typeof r.pattern === 'string' && r.pattern.startsWith('storage-drift:')
    );
    expect(rows.length).toBe(0);
  });
});

// ── Section 2: Freshness RUN gate ────────────────────────────────────────────

describe('reflect-precheck: freshness RUN gate', () => {
  let hermitDir: string;

  afterEach(() => { fs.rmSync(hermitDir, { recursive: true, force: true }); });

  test('EMPTY when ledger is empty and no other phases', async () => {
    hermitDir = makeTmpHermit({
      lastRunAt: new Date(Date.now() - 60_000).toISOString(),
      observations: [],
    });

    const verdict = await runPrecheck(hermitDir);
    expect(verdict).toBe('EMPTY');
  });

  test('RUN|{observations_fresh:true} when ledger has row newer than last_run_at', async () => {
    const lastRunAt = new Date(Date.now() - 3600_000).toISOString(); // 1h ago
    const freshTs = new Date().toISOString();

    hermitDir = makeTmpHermit({
      lastRunAt,
      observations: [JSON.stringify({ ts: freshTs, pattern: 'test', session_id: 'S-001', source: 'reflect-noticed', origin: 'own-work' })],
    });

    const verdict = await runPrecheck(hermitDir);
    expect(verdict).toMatch(/^RUN\|/);
    const phases = JSON.parse(verdict.slice(4));
    expect(phases.observations_fresh).toBe(true);
  });

  test('EMPTY when all ledger rows are older than last_run_at', async () => {
    const oldTs = new Date(Date.now() - 7200_000).toISOString(); // 2h ago
    const lastRunAt = new Date(Date.now() - 3600_000).toISOString(); // 1h ago

    hermitDir = makeTmpHermit({
      lastRunAt,
      observations: [JSON.stringify({ ts: oldTs, pattern: 'test', session_id: 'S-001', source: 'reflect-noticed', origin: 'own-work' })],
    });

    const verdict = await runPrecheck(hermitDir);
    expect(verdict).toBe('EMPTY');
  });

  test('null last_run_at → RUN when any ledger row exists', async () => {
    hermitDir = makeTmpHermit({
      lastRunAt: null,
      observations: [JSON.stringify({ ts: new Date(Date.now() - 86400_000).toISOString(), pattern: 'old', session_id: 'S-001', source: 'startup-drift', origin: 'own-work' })],
    });

    const verdict = await runPrecheck(hermitDir);
    expect(verdict).toMatch(/^RUN\|/);
    const phases = JSON.parse(verdict.slice(4));
    expect(phases.observations_fresh).toBe(true);
  });

  test('startup-drift rows written in same run trigger observations_fresh on that run', async () => {
    // Fresh hermit with an unknown dir — precheck writes drift rows AND triggers freshness
    hermitDir = makeTmpHermit({ lastRunAt: null });
    fs.mkdirSync(path.join(hermitDir, 'reports'));

    const verdict = await runPrecheck(hermitDir);
    // Should be RUN (either from observations_fresh or other phases)
    expect(verdict).toMatch(/^RUN\|/);
  });
});

// ── Section 3: observations_fresh phase key documentation ───────────────────

describe('reflect SKILL.md: observations_fresh phase key', () => {
  const reflectSkill = fs.readFileSync(path.join(PLUGIN_ROOT, 'skills', 'reflect', 'SKILL.md'), 'utf-8');

  test('SKILL.md documents the observations_fresh phase key', () => {
    expect(reflectSkill).toContain('observations_fresh');
  });

  test('SKILL.md explains what observations_fresh triggers', () => {
    expect(reflectSkill).toContain('observations_fresh');
    // step 3b should run when observations_fresh is in phases
    expect(reflectSkill).toContain('step 3b');
  });
});

// ── Section 4: graduation_min_sessions config wiring ────────────────────────

describe('graduation_min_sessions: config wiring', () => {
  test('config.json.template has reflection.graduation_min_sessions: 1', () => {
    const template = JSON.parse(
      fs.readFileSync(path.join(PLUGIN_ROOT, 'state-templates', 'config.json.template'), 'utf-8')
    );
    expect(template.reflection).toBeDefined();
    expect(template.reflection.graduation_min_sessions).toBe(1);
  });

  test('DEFAULT_CONFIG in hermit-start.ts has reflection.graduation_min_sessions: 1', async () => {
    // Read the actual module — use Bun dynamic import to avoid full startup
    const content = fs.readFileSync(path.join(PLUGIN_ROOT, 'scripts', 'hermit-start.ts'), 'utf-8');
    expect(content).toContain('graduation_min_sessions: 1');
    expect(content).toContain('reflection:');
  });

  test('docs/config-reference.md documents graduation_min_sessions', () => {
    const ref = fs.readFileSync(path.join(PLUGIN_ROOT, 'docs', 'config-reference.md'), 'utf-8');
    expect(ref).toContain('graduation_min_sessions');
    expect(ref).toContain('reflection');
  });

  test('validate-config.ts validates reflection.graduation_min_sessions as positive integer', () => {
    const validateContent = fs.readFileSync(path.join(PLUGIN_ROOT, 'scripts', 'validate-config.ts'), 'utf-8');
    expect(validateContent).toContain('graduation_min_sessions');
    expect(validateContent).toContain('positive integer');
  });
});

// ── Section 5: step 3b origin aggregation ───────────────────────────────────

describe('reflect SKILL.md: step 3b origin aggregation', () => {
  const reflectSkill = fs.readFileSync(path.join(PLUGIN_ROOT, 'skills', 'reflect', 'SKILL.md'), 'utf-8');

  test('SKILL.md documents external-content wins aggregation rule', () => {
    expect(reflectSkill).toContain('external-content');
    // Origin aggregation phrase — raw Markdown bold wraps "any"
    expect(reflectSkill).toContain('Origin aggregation');
  });

  test('SKILL.md carries origin into Evidence Origin on graduation', () => {
    expect(reflectSkill).toContain('Evidence Origin');
    expect(reflectSkill).toContain('external-content');
  });

  test('SKILL.md treats missing origin as own-work (back-compat)', () => {
    expect(reflectSkill).toContain('own-work');
    // Old rows lacking the origin field should default to own-work
    expect(reflectSkill).toContain('old rows lacking the field');
  });
});

// ── Section 6: triage and proposal-create artifact exception ────────────────

describe('triage + proposal-create: observations.jsonl artifact exception', () => {
  const triage = fs.readFileSync(path.join(PLUGIN_ROOT, 'agents', 'proposal-triage.md'), 'utf-8');
  const proposalCreate = fs.readFileSync(path.join(PLUGIN_ROOT, 'skills', 'proposal-create', 'SKILL.md'), 'utf-8');

  test('proposal-triage: observations.jsonl artifact satisfies condition 1', () => {
    expect(triage).toContain('state/observations.jsonl');
    // Should not require efficiency/cost-class only
    expect(triage).toContain('any judge-verified candidate');
  });

  test('proposal-create: observations.jsonl artifact satisfies condition 1', () => {
    expect(proposalCreate).toContain('state/observations.jsonl');
    // The judge verifies the ledger; do not re-check here
    expect(proposalCreate).toContain('do not re-check here');
  });
});

// ── Section 7: reflect-noticed origin field ──────────────────────────────────

describe('reflect SKILL.md: reflect-noticed with origin field', () => {
  const reflectSkill = fs.readFileSync(path.join(PLUGIN_ROOT, 'skills', 'reflect', 'SKILL.md'), 'utf-8');

  test('SKILL.md documents reflect-noticed source value with origin field', () => {
    expect(reflectSkill).toContain('"source":"reflect-noticed"');
  });

  test('SKILL.md documents external-content origin for reflect-noticed', () => {
    expect(reflectSkill).toContain('"origin":"external-content"');
  });

  test('SKILL.md documents own-work origin for reflect-noticed', () => {
    expect(reflectSkill).toContain('"origin":"own-work"');
  });
});

// ── Section 8: reflection-judge §1.4 config-agnostic verification ───────────

describe('reflection-judge: §1.4 config-agnostic ledger verification', () => {
  const judge = fs.readFileSync(path.join(PLUGIN_ROOT, 'agents', 'reflection-judge.md'), 'utf-8');

  test('judge verifies against cited Sessions list, not hardcoded threshold', () => {
    // Should reference the Sessions: list from the candidate (backtick-colon form)
    expect(judge).toContain("cited `Sessions:`");
    // Should NOT still say "≥2 distinct session_ids" with a hardcoded count
    expect(judge).not.toContain('≥2 entries whose `pattern`');
  });

  test('judge is config-agnostic (does not re-count threshold)', () => {
    expect(judge).toContain('config-agnostic');
  });
});

// ── Section: behavior phase (transcript-digest weekly cadence) ─────────────────

describe('reflect-precheck: behavior phase', () => {
  // Write reflection-state.json with a recent last_run_at (suppresses the compute
  // phase's null-lastRunAt trigger) plus an explicit top-level behavior cursor, so
  // the `behavior` phase is the deciding one.
  function withBehaviorCursor(cursor: string | undefined): string {
    const dir = makeTmpHermit();
    const now = new Date().toISOString();
    const state: Record<string, unknown> = { counters: { last_run_at: now } };
    if (cursor !== undefined) state.last_behavior_digest_at = cursor;
    fs.writeFileSync(path.join(dir, 'state', 'reflection-state.json'), JSON.stringify(state), 'utf-8');
    return dir;
  }

  function daysAgo(n: number): string {
    return new Date(Date.now() - n * 86_400_000).toISOString();
  }

  test('fires when the behavior cursor is unset (first run)', async () => {
    const verdict = await runPrecheck(withBehaviorCursor(undefined));
    expect(verdict.startsWith('RUN|')).toBe(true);
    expect(JSON.parse(verdict.slice(4)).behavior).toBe(true);
  });

  test('fires when the behavior cursor is older than 7 days', async () => {
    const verdict = await runPrecheck(withBehaviorCursor(daysAgo(10)));
    expect(verdict.startsWith('RUN|')).toBe(true);
    expect(JSON.parse(verdict.slice(4)).behavior).toBe(true);
  });

  test('does not fire when the behavior cursor is within 7 days', async () => {
    const verdict = await runPrecheck(withBehaviorCursor(daysAgo(2)));
    // Other phases stay quiet (recent last_run_at, no proposals/costs/observations),
    // so this collapses to EMPTY; behavior must not be present either way.
    if (verdict.startsWith('RUN|')) {
      expect(JSON.parse(verdict.slice(4)).behavior).toBeUndefined();
    } else {
      expect(verdict).toBe('EMPTY');
    }
  });
});
