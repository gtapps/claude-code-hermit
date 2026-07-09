// Regression: reflect-loop contract tests (bun test port of test-reflect-loop.sh) —
// tooling debrief, vital-signs, observations ledger, success-signal push,
// artifact-cited evidence, ephemerality exception. Guards pinned SKILL.md / agent
// phrases so future trims don't silently lose them; also unit-tests the related
// scripts (weekly-review.ts, prune-observations.ts — both CLI entry points with
// top-level execution, so they run as subprocesses).
//
// Usage: bun test tests/reflect-loop.test.ts   (from the plugin root)

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { runScript, PLUGIN_ROOT } from './helpers/run';

const read = (...p: string[]) => fs.readFileSync(path.join(PLUGIN_ROOT, ...p), 'utf-8');

const sessionClose = read('skills', 'session-close', 'SKILL.md');
// reflect's candidate-processing detail lives in branches.md (the
// rare-branch procedures file); assert against the combined surface.
const reflect = read('skills', 'reflect', 'SKILL.md') + '\n' + read('skills', 'reflect', 'branches.md');
const reflectRef = read('skills', 'reflect', 'reference.md');
const judge = read('agents', 'reflection-judge.md');
const hatch = read('skills', 'hatch', 'SKILL.md');
const proposalCreate = read('skills', 'proposal-create', 'SKILL.md');

const todayYmd = () => new Date().toISOString().slice(0, 10);

// ── item 1: session-close tooling debrief ───────────────────────────────────

describe('session-close tooling debrief', () => {
  test('session-close: tooling debrief question present', () => {
    expect(sessionClose).toContain('What did I build ad-hoc this session');
  });

  test('session-close: re-derivation debrief question present', () => {
    expect(sessionClose).toContain('re-derive or re-discover');
  });

  test('session-close: debrief asks for quantified cost', () => {
    expect(sessionClose).toContain('quantified cost');
  });

  test('session-close: debrief feeds procedure-capture Lessons', () => {
    expect(sessionClose).toContain('procedure-capture recurs on');
  });
});

// ── item 2: weekly-review reflect vital-signs ───────────────────────────────

describe('weekly-review reflect vital-signs', () => {
  let workdir: string;
  let review: string;

  beforeAll(async () => {
    workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'hermit-reflect-'));
    const hermitDir = path.join(workdir, '.claude-code-hermit');
    fs.mkdirSync(path.join(hermitDir, 'sessions'), { recursive: true });
    fs.mkdirSync(path.join(hermitDir, 'state'), { recursive: true });
    fs.mkdirSync(path.join(workdir, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(hermitDir, 'config.json'), '{"timezone":"UTC"}\n');

    const TODAY = `${todayYmd()}T12:00:00+00:00`;
    const TODAY_TS = `${todayYmd()}T12:00:00Z`;

    fs.writeFileSync(path.join(hermitDir, 'sessions', 'S-001-REPORT.md'), `---
id: S-001
status: completed
date: ${TODAY}
cost_usd: 1.50
tokens: 50000
tags: []
operator_turns: 5
closed_via: operator
---
## Overview
Work.

## Progress Log
- [10:00] reflect (adult) — 2 candidates; verdicts: accept=1 downgrade=0 suppress=1; outcomes: none; suppressed: [cost-spike: no-sessions]
`);

    fs.writeFileSync(path.join(hermitDir, 'sessions', 'S-002-REPORT.md'), `---
id: S-002
status: completed
date: ${TODAY}
cost_usd: 0.80
tokens: 20000
tags: []
operator_turns: 3
closed_via: operator
---
## Overview
Work.

## Progress Log
- [11:00] reflect (quick, post-routine) — 0 candidates; verdicts: accept=0 downgrade=0 suppress=0; outcomes: none
`);

    // micro-queued / micro-resolved are reflect-exclusive (count toward surfaced/accepted).
    // created / responded are shared by non-reflect callers (brainstorm, operator, channel)
    // and must NOT be attributed to reflect. PROP-OLD is out-of-week (date filter).
    fs.writeFileSync(path.join(hermitDir, 'state', 'proposal-metrics.jsonl'), `{"ts":"${TODAY_TS}","type":"micro-queued","micro_id":"MP-1","tier":1,"question":"q"}
{"ts":"${TODAY_TS}","type":"created","proposal_id":"PROP-001"}
{"ts":"${TODAY_TS}","type":"responded","proposal_id":"PROP-001","action":"accept"}
{"ts":"${TODAY_TS}","type":"micro-resolved","micro_id":"MP-1","action":"approved"}
{"ts":"2020-01-01T12:00:00Z","type":"created","proposal_id":"PROP-OLD"}
`);

    fs.writeFileSync(path.join(workdir, '.claude', 'cost-log.jsonl'), `{"timestamp":"${TODAY_TS}","source":"routine:reflect-cadence","estimated_cost_usd":0.50,"total_tokens":1000}
{"timestamp":"${TODAY_TS}","source":"session","estimated_cost_usd":2.00,"total_tokens":9000}
{"timestamp":"2020-01-01T12:00:00Z","source":"routine:reflect-cadence","estimated_cost_usd":9.99,"total_tokens":1000}
`);

    await runScript('weekly-review.ts', { cwd: workdir, args: ['.claude-code-hermit'] });
    const compiled = path.join(hermitDir, 'compiled');
    const file = fs.readdirSync(compiled).find((f) => /^review-weekly-.*\.md$/.test(f));
    review = fs.readFileSync(path.join(compiled, file!), 'utf-8');
  });

  afterAll(() => {
    try { fs.rmSync(workdir, { recursive: true, force: true }); } catch {}
  });

  test('weekly-review: reflect_runs counts both phases incl quick', () => {
    expect(review).toContain('reflect_runs: 2');
  });

  test('weekly-review: reflect_candidates summed', () => {
    expect(review).toContain('reflect_candidates: 2');
  });

  test('weekly-review: reflect_surfaced counts micro-queued only (excludes shared created)', () => {
    expect(review).toContain('reflect_surfaced: 1');
  });

  test('weekly-review: reflect_accepted counts micro-resolved approved only (excludes shared responded)', () => {
    expect(review).toContain('reflect_accepted: 1');
  });

  test('weekly-review: reflect_cost_usd from routine:reflect sources in-week', () => {
    expect(review).toContain('reflect_cost_usd: 0.50');
  });

  test('weekly-review: suppression digest normalized slug:code', () => {
    expect(review).toContain('suppressed: cost-spike:no-sessions');
  });

  test('weekly-review: regression — sessions_count intact', () => {
    expect(review).toContain('sessions_count: 2');
  });

  test('weekly-review: regression — self_directed_rate intact', () => {
    expect(review).toContain('self_directed_rate:');
  });
});

// ── item 3: observations ledger ─────────────────────────────────────────────

describe('observations ledger phrases', () => {
  test('reflect: ledger graduation step present', () => {
    expect(reflect).toContain('Observations ledger');
  });

  test('reflect: graduation threshold reads graduation_min_sessions from config', () => {
    expect(reflect).toContain('graduation_min_sessions');
    expect(reflect).toContain('distinct `session_id`s');
  });

  test('reflect: quick-mode deferrals append to ledger', () => {
    expect(reflect).toContain('"source":"quick-deferral"');
  });

  test('reflect: quick-mode Progress Log carries suppressed suffix for the weekly digest', () => {
    expect(reflect).toContain('so quick-run suppressions reach the weekly digest');
  });

  test('reflect: cost spike recorded to ledger not memory', () => {
    expect(reflect).toContain('"source":"cost-spike"');
  });

  test('reflect: sub-threshold outcomes append to ledger not memory', () => {
    expect(reflect).toContain('"source":"reflect-noticed"');
  });

  test('judge: artifact verification section present', () => {
    expect(judge).toContain('Artifact verification');
  });

  test('judge: covered-by-memory exemption for ledger graduates', () => {
    expect(judge).toContain('never suppressed `covered-by-memory`');
  });

  test('hatch: seeds observations.jsonl', () => {
    expect(hatch).toContain('state/observations.jsonl');
  });
});

describe('prune-observations.ts behavior', () => {
  let workdir: string;
  let ledger: string;
  let runStdout: string;
  let runExit: number;
  let after: string;

  beforeAll(async () => {
    workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'hermit-prune-'));
    fs.mkdirSync(path.join(workdir, '.claude-code-hermit', 'state'), { recursive: true });
    ledger = path.join(workdir, '.claude-code-hermit', 'state', 'observations.jsonl');
    const FRESH_TS = `${todayYmd()}T12:00:00Z`;

    fs.writeFileSync(ledger, `{"ts":"${FRESH_TS}","pattern":"fresh-pattern","session_id":"S-010","source":"reflect"}
{"ts":"2020-01-01T00:00:00Z","pattern":"fresh-pattern","session_id":"S-001","source":"reflect"}
{"ts":"2020-01-01T00:00:00Z","pattern":"dead-pattern","session_id":"S-001","source":"reflect"}
not json at all
`);

    const r = await runScript('prune-observations.ts', {
      args: [path.join(workdir, '.claude-code-hermit')],
    });
    runStdout = r.stdout;
    runExit = r.exitCode;
    after = fs.readFileSync(ledger, 'utf-8');
  });

  afterAll(() => {
    try { fs.rmSync(workdir, { recursive: true, force: true }); } catch {}
  });

  test('prune-observations: exits 0 and reports counts', () => {
    expect(runExit).toBe(0);
    expect(runStdout).toContain('pruned 1, kept 3');
  });

  test('prune-observations: fresh entry kept', () => {
    expect(after).toContain('S-010');
  });

  test('prune-observations: stale entry of fresh pattern kept (recurrence history)', () => {
    expect(after).toContain('"pattern":"fresh-pattern","session_id":"S-001"');
  });

  test('prune-observations: fully stale pattern dropped', () => {
    expect(after).not.toContain('dead-pattern');
  });

  test('prune-observations: unparseable line preserved verbatim', () => {
    expect(after.split('\n')).toContain('not json at all');
  });

  test('prune-observations: missing file exits 0', async () => {
    const r = await runScript('prune-observations.ts', {
      args: [path.join(workdir, 'nonexistent-dir')],
    });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('pruned 0, kept 0');
  });

  test('prune-observations: no args exits 1', async () => {
    const r = await runScript('prune-observations.ts');
    expect(r.exitCode).not.toBe(0);
  });

  // timestamp-format robustness: ledger ts is agent-written and not format-enforced,
  // so a fresh entry in +00:00-offset form (not Z) must still be parsed as fresh.
  test('prune-observations: +00:00-offset fresh entry parsed as fresh (kept)', async () => {
    const wd = fs.mkdtempSync(path.join(os.tmpdir(), 'hermit-prune-'));
    try {
      fs.mkdirSync(path.join(wd, '.claude-code-hermit', 'state'), { recursive: true });
      const l = path.join(wd, '.claude-code-hermit', 'state', 'observations.jsonl');
      const OFFSET_TS = `${todayYmd()}T12:00:00+00:00`;
      fs.writeFileSync(l, `{"ts":"${OFFSET_TS}","pattern":"offset-fresh","session_id":"S-030","source":"reflect"}
{"ts":"2020-01-01T00:00:00+00:00","pattern":"offset-dead","session_id":"S-031","source":"reflect"}
`);
      const r = await runScript('prune-observations.ts', {
        args: [path.join(wd, '.claude-code-hermit')],
      });
      expect(r.stdout).toContain('pruned 1, kept 1');
      expect(fs.readFileSync(l, 'utf-8')).toContain('offset-fresh');
    } finally {
      try { fs.rmSync(wd, { recursive: true, force: true }); } catch {}
    }
  });
});

// ── item 4: success_signal push + same-area absence guard ───────────────────

describe('success_signal push + same-area guard', () => {
  test('proposal-create: pushes for measurable success signal', () => {
    expect(proposalCreate).toContain('Success signal — push for measurable');
  });

  test('proposal-create: validates predicate before writing', () => {
    expect(proposalCreate).toContain('--validate');
  });

  test('proposal-create: empty signal is the documented exception', () => {
    expect(proposalCreate).toContain('documented exception');
  });

  test('reflect: same-area guard before pattern-absence resolution', () => {
    expect(reflectRef).toContain('Same-area guard');
  });

  test('reflect: same-area guard requires tag overlap', () => {
    expect(reflectRef).toContain('share ≥1 tag');
  });
});

// ── item 5: artifact-cited evidence path ────────────────────────────────────

describe('artifact-cited evidence path', () => {
  test('judge: Sessions none artifact exception present', () => {
    expect(judge).toContain('Artifact exception');
  });

  test('judge: artifact exception scoped to efficiency/cost class', () => {
    expect(judge).toContain('efficiency/cost-class');
  });

  test('judge: generalizes verification beyond the ledger', () => {
    expect(judge).toContain('artifact does not contain cited value');
  });

  test('reflect: integrity rule keeps prose self-certification barred', () => {
    expect(reflect).toContain('must never write the pattern into SHELL.md');
  });

  test('reflect: integrity rule gains artifact-cited path', () => {
    expect(reflect).toContain('Artifact-cited (efficiency/cost-class only)');
  });

  test('reflect: three-condition rule covers artifact-cited recurrence', () => {
    expect(reflect).toContain('measured ≥2 times in a machine-written state file');
  });
});

// ── item 6: ephemerality exception for procedure capture ────────────────────

describe('ephemerality exception', () => {
  test('reflect: ephemerality exception present', () => {
    expect(reflect).toContain('Ephemerality exception');
  });

  test('reflect: exception requires artifacts that will not survive', () => {
    expect(reflect).toContain('will not survive the session');
  });

  test('reflect: exception requires pre-existing quantified cost', () => {
    expect(reflect).toContain('cost is quantified in session content that already exists');
  });

  test('reflect: exception stays Tier 3 and counts toward kill criteria', () => {
    expect(reflect).toContain('count toward the kill-criteria sample');
  });

  test('reflect: procedure-capture recurrence signal reads graduation_min_sessions', () => {
    expect(reflect).toContain('graduation_min_sessions');
    expect(reflect).toContain('distinct archived sessions');
  });
});
