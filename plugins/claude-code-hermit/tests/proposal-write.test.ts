// Contract tests for scripts/proposal.ts — the single CLI covering every
// proposal-lifecycle state-dir mutation formerly done via the Write/Edit
// tools (blocked under the harness background-isolation guard).

import { describe, test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';

import { runScript, runProposal, PLUGIN_ROOT } from './helpers/run';
import { withDir } from './helpers/workdir';

function stateArg(dir: string): string {
  return path.join(dir, '.claude-code-hermit');
}
function propPath(dir: string, file: string): string {
  return path.join(stateArg(dir), 'proposals', file.endsWith('.md') ? file : `${file}.md`);
}
function shellPath(dir: string): string {
  return path.join(stateArg(dir), 'sessions', 'SHELL.md');
}
function metricsLines(dir: string): any[] {
  const p = path.join(stateArg(dir), 'state', 'proposal-metrics.jsonl');
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, 'utf-8').split('\n').filter(Boolean).map(l => JSON.parse(l));
}

function seedState(dir: string, opts: { timezone?: string; routines?: any[] } = {}): void {
  const base = stateArg(dir);
  fs.mkdirSync(path.join(base, 'proposals'), { recursive: true });
  fs.mkdirSync(path.join(base, 'templates'), { recursive: true });
  fs.copyFileSync(
    path.join(PLUGIN_ROOT, 'state-templates', 'PROPOSAL.md.template'),
    path.join(base, 'templates', 'PROPOSAL.md.template'),
  );
  fs.writeFileSync(
    path.join(base, 'config.json'),
    JSON.stringify({ timezone: opts.timezone ?? 'Europe/London', routines: opts.routines ?? [] }),
  );
  fs.writeFileSync(path.join(base, 'state', 'alert-state.json'), '{}');
}

function heredoc(header: Record<string, string>, body: string): string {
  const lines = Object.entries(header).map(([k, v]) => `${k}: ${v}`);
  return lines.join('\n') + '\n---\n' + body;
}

const MIN_BODY = [
  '## Context', 'ctx', '',
  '## Problem', 'prob', '',
  '## Proposed Solution', 'sol', '',
  '## Impact', 'impact', '',
  '## Verification', 'verify', '',
  '## References', 'n/a', '',
  '## Success Signal', '<!-- none -->', '',
  '## Operator Decision', '',
].join('\n');

describe('proposal.ts create', () => {
  test('happy path writes proposals/<id>.md and prints the canonical id', withDir(async (dir) => {
    seedState(dir);
    const stdin = heredoc({ Title: 'Fix the thing', Category: 'bug', Tags: '["tag-a","tag-b"]' }, MIN_BODY);
    const r = await runProposal(stateArg(dir), ['create'], { stdin });
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toMatch(/^PROP-001-fix-thing-\d{6}$/); // 'the' is a slugify stopword
    const id = r.stdout.trim();
    const content = fs.readFileSync(propPath(dir, id), 'utf-8');
    expect(content).toContain(`id: ${id}`);
    expect(content).toContain('title: "Fix the thing"');
    expect(content).toContain('status: proposed');
    expect(content).toContain('category: bug');
    expect(content).toContain('tags: ["tag-a","tag-b"]');
    expect(content).toMatch(/created: \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}/);
    expect(content).toContain(`# Proposal: ${id} — Fix the thing`);
    expect(content).toContain('## Context\nctx');
  }));

  test('NNN continues from max existing', withDir(async (dir) => {
    seedState(dir);
    fs.writeFileSync(propPath(dir, 'PROP-007-old-100000'), '---\nid: x\n---\nbody\n');
    const stdin = heredoc({ Title: 'Next one' }, MIN_BODY);
    const r = await runProposal(stateArg(dir), ['create'], { stdin });
    expect(r.stdout.trim()).toMatch(/^PROP-008-/);
  }));

  test('session defaults from runtime.json when Session header omitted', withDir(async (dir) => {
    seedState(dir);
    fs.writeFileSync(path.join(stateArg(dir), 'state', 'runtime.json'), JSON.stringify({ session_id: 'S-042' }));
    const stdin = heredoc({ Title: 'Session default test' }, MIN_BODY);
    const r = await runProposal(stateArg(dir), ['create'], { stdin });
    const id = r.stdout.trim();
    const content = fs.readFileSync(propPath(dir, id), 'utf-8');
    expect(content).toContain('session: S-042');
  }));

  test('template missing -> ERROR|template-missing, zero writes', withDir(async (dir) => {
    fs.mkdirSync(path.join(stateArg(dir), 'proposals'), { recursive: true });
    fs.writeFileSync(path.join(stateArg(dir), 'config.json'), JSON.stringify({ timezone: 'UTC' }));
    const stdin = heredoc({ Title: 'No template' }, MIN_BODY);
    const r = await runProposal(stateArg(dir), ['create'], { stdin });
    expect(r.stdout.trim()).toBe('ERROR|template-missing');
    expect(fs.readdirSync(path.join(stateArg(dir), 'proposals'))).toHaveLength(0);
    expect(metricsLines(dir)).toHaveLength(0);
  }));

  const invalidCases: Array<[string, Record<string, string>, string, string]> = [
    ['missing title', {}, MIN_BODY, 'ERROR|missing-title'],
    ['missing separator', {}, '', 'ERROR|missing-separator'],
    ['empty body', { Title: 'T' }, '   \n\n', 'ERROR|empty-body'],
    ['bad category', { Title: 'T', Category: 'nonsense' }, MIN_BODY, 'ERROR|invalid-category'],
    ['bad tags JSON', { Title: 'T', Tags: 'not-json' }, MIN_BODY, 'ERROR|invalid-tags'],
    ['bad related-sessions JSON', { Title: 'T', 'Related-Sessions': '{not an array}' }, MIN_BODY, 'ERROR|invalid-related-sessions'],
  ];
  for (const [label, header, body, expected] of invalidCases) {
    test(`validation error: ${label} -> ${expected}, zero writes`, withDir(async (dir) => {
      seedState(dir);
      const stdin = label === 'missing separator'
        ? 'Title: T\nno separator here'
        : heredoc(header, body);
      const r = await runProposal(stateArg(dir), ['create'], { stdin });
      expect(r.stdout.trim()).toBe(expected);
      expect(fs.readdirSync(path.join(stateArg(dir), 'proposals'))).toHaveLength(0);
    }));
  }

  test('unwritable proposals dir -> ERROR, no metrics, SHELL.md unchanged', withDir(async (dir) => {
    seedState(dir);
    const proposalsDir = path.join(stateArg(dir), 'proposals');
    fs.chmodSync(proposalsDir, 0o555);
    const shellBefore = fs.readFileSync(shellPath(dir), 'utf-8');
    try {
      const stdin = heredoc({ Title: 'Blocked write' }, MIN_BODY);
      const r = await runProposal(stateArg(dir), ['create'], { stdin });
      expect(r.stdout.trim()).toMatch(/^ERROR\|/);
      expect(metricsLines(dir)).toHaveLength(0);
      expect(fs.readFileSync(shellPath(dir), 'utf-8')).toBe(shellBefore);
    } finally {
      fs.chmodSync(proposalsDir, 0o755);
    }
  }));

  test('SHELL.md deleted -> still succeeds, ID printed, stderr warns', withDir(async (dir) => {
    seedState(dir);
    fs.rmSync(shellPath(dir));
    const stdin = heredoc({ Title: 'No shell file' }, MIN_BODY);
    const r = await runProposal(stateArg(dir), ['create'], { stdin });
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toMatch(/^PROP-001-/);
    expect(fs.existsSync(propPath(dir, r.stdout.trim()))).toBe(true);
    expect(r.stderr).toContain('findings append');
  }));

  test('Findings line lands inside ## Findings before the next heading', withDir(async (dir) => {
    seedState(dir);
    const stdin = heredoc({ Title: 'Findings placement', Findings: 'custom summary' }, MIN_BODY);
    const r = await runProposal(stateArg(dir), ['create'], { stdin });
    const id = r.stdout.trim();
    const shell = fs.readFileSync(shellPath(dir), 'utf-8');
    const findingsSection = shell.slice(shell.indexOf('## Findings'), shell.indexOf('## Changed'));
    expect(findingsSection).toContain(`- ${id}: custom summary`);
  }));

  test('created metrics event carries source/category/tags', withDir(async (dir) => {
    seedState(dir);
    const stdin = heredoc({ Title: 'Metrics test', Source: 'operator-request', Category: 'capability', Tags: '["x"]' }, MIN_BODY);
    const r = await runProposal(stateArg(dir), ['create'], { stdin });
    const id = r.stdout.trim();
    const lines = metricsLines(dir);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ type: 'created', proposal_id: id, source: 'operator-request', category: 'capability', tags: ['x'] });
  }));

  test('rebuilds proposals-index and state-summary', withDir(async (dir) => {
    seedState(dir);
    const stdin = heredoc({ Title: 'Index regen test' }, MIN_BODY);
    const r = await runProposal(stateArg(dir), ['create'], { stdin });
    const id = r.stdout.trim();
    const index = JSON.parse(fs.readFileSync(path.join(stateArg(dir), 'state', 'proposals-index.json'), 'utf-8'));
    expect(index.proposals.some((p: any) => p.id === id)).toBe(true);
    expect(fs.existsSync(path.join(stateArg(dir), 'state', 'state-summary.md'))).toBe(true);
  }));

  test('appends ## Operator Decision when body lacks it', withDir(async (dir) => {
    seedState(dir);
    const bodyNoDecision = '## Context\nctx\n\n## Problem\nprob\n';
    const stdin = heredoc({ Title: 'No decision section' }, bodyNoDecision);
    const r = await runProposal(stateArg(dir), ['create'], { stdin });
    const id = r.stdout.trim();
    const content = fs.readFileSync(propPath(dir, id), 'utf-8');
    expect(content).toContain('## Operator Decision');
  }));
});

describe('proposal.ts dispatcher', () => {
  test('unknown verb -> ERROR|unknown-verb, exit 0', withDir(async (dir) => {
    seedState(dir);
    const r = await runProposal(stateArg(dir), ['bogus']);
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toBe('ERROR|unknown-verb');
  }));

  test('missing state dir arg -> exit 1', async () => {
    const r = await runScript('proposal.ts', { args: ['create'] });
    expect(r.exitCode).toBe(1);
  });
});

// The two proposal-lifecycle rows that skill prose used to hand-assemble as JSON.
// `ts` is stamped by the script, so rows are asserted by field, never against a
// fixture string.
describe('proposal.ts event', () => {
  function event(dir: string, ...args: string[]) {
    return runProposal(stateArg(dir), ['event', ...args]);
  }

  for (const action of ['accept', 'defer', 'dismiss']) {
    test(`responded --action=${action} writes one row`, withDir(async (dir) => {
      seedState(dir);
      const r = await event(dir, 'responded', '--id=PROP-042', `--action=${action}`);
      expect(r.exitCode).toBe(0);
      expect(r.stdout.trim()).toBe('OK');
      const lines = metricsLines(dir);
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatchObject({ type: 'responded', proposal_id: 'PROP-042', action });
      expect(lines[0].ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    }));
  }

  test('resolved writes {ts,type,proposal_id} and nothing else', withDir(async (dir) => {
    seedState(dir);
    const r = await event(dir, 'resolved', '--id=PROP-007');
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toBe('OK');
    const lines = metricsLines(dir);
    expect(lines).toHaveLength(1);
    expect(Object.keys(lines[0])).toEqual(['ts', 'type', 'proposal_id']);
    expect(lines[0]).toMatchObject({ type: 'resolved', proposal_id: 'PROP-007' });
  }));

  test('the ledger is created lazily on first write', withDir(async (dir) => {
    seedState(dir);
    const ledger = path.join(stateArg(dir), 'state', 'proposal-metrics.jsonl');
    expect(fs.existsSync(ledger)).toBe(false);
    await event(dir, 'resolved', '--id=PROP-001');
    expect(fs.existsSync(ledger)).toBe(true);
  }));

  const errorCases: Array<[string, string[], string]> = [
    ['missing --id', ['responded', '--action=accept'], 'ERROR|missing-id'],
    ['bad --action', ['responded', '--id=PROP-042', '--action=maybe'], 'ERROR|invalid-action:maybe'],
    ['--action on resolved', ['resolved', '--id=PROP-042', '--action=accept'], 'ERROR|action-not-allowed:resolved'],
    ['unknown event type', ['archived', '--id=PROP-042'], 'ERROR|unknown-event-type:archived'],
  ];
  for (const [label, args, expected] of errorCases) {
    test(`${label} -> ${expected}, exit 0, zero writes`, withDir(async (dir) => {
      seedState(dir);
      const r = await event(dir, ...args);
      expect(r.exitCode).toBe(0);
      expect(r.stdout.trim()).toBe(expected);
      expect(metricsLines(dir)).toHaveLength(0);
    }));
  }
});

describe('proposal.ts patch', () => {
  test('patches with an open stdin pipe without a stdin flag', withDir(async (dir) => {
    seedState(dir);
    const id = await createProposal(dir);
    const r = await runProposal(stateArg(dir), ['patch', id, '--set', 'status=accepted'], { openStdin: true, cwd: dir });
    expect(r.stdout.trim()).toBe(`OK|${id}`);
    expect(r.exitCode).toBe(0);
    expect(fs.readFileSync(propPath(dir, id), 'utf-8')).toContain('status: accepted');
  }));

  function createProposal(dir: string, extra: Record<string, string> = {}): Promise<string> {
    const stdin = heredoc({ Title: 'Patch target', ...extra }, MIN_BODY);
    return runProposal(stateArg(dir), ['create'], { stdin }).then(r => r.stdout.trim());
  }

  test('accept flip: in-place frontmatter patch, @now expansion, Decision append', withDir(async (dir) => {
    seedState(dir);
    const id = await createProposal(dir);
    const before = fs.readFileSync(propPath(dir, id), 'utf-8');

    const r = await runProposal(stateArg(dir), ['patch', id, '--stdin', '--set', 'status=accepted', '--set', 'accepted_date=@now', '--set', 'responded=true'], { stdin: 'Decision: Accepted on @now.\n' });
    expect(r.stdout.trim()).toBe(`OK|${id}`);
    const after = fs.readFileSync(propPath(dir, id), 'utf-8');
    expect(after).toContain('status: accepted');
    expect(after).toContain('responded: true');
    expect(after).toMatch(/accepted_date: \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}/);
    expect(after).toMatch(/Accepted on \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}\./);
    // Only the three touched frontmatter lines differ; every other frontmatter
    // line (comments, ordering, untouched keys) is byte-identical.
    const fmOf = (s: string) => s.slice(0, s.indexOf('\n---', 3) + 4).split('\n');
    const beforeFm = fmOf(before);
    const afterFm = fmOf(after);
    expect(afterFm).toHaveLength(beforeFm.length);
    const changedFmLines = afterFm.filter((l, i) => l !== beforeFm[i]);
    expect(changedFmLines.every(l =>
      l.startsWith('status:') || l.startsWith('responded:') || l.startsWith('accepted_date:'),
    )).toBe(true);
    // Body is untouched except for the appended Decision line at the very end.
    const bodyBefore = before.slice(before.indexOf('\n---', 3) + 4);
    const bodyAfter = after.slice(after.indexOf('\n---', 3) + 4);
    expect(bodyAfter.startsWith(bodyBefore.replace(/\n+$/, ''))).toBe(true);
  }));

  test('dismiss sets both dismissed_date and resolved_date', withDir(async (dir) => {
    seedState(dir);
    const id = await createProposal(dir);
    const r = await runProposal(stateArg(dir), ['patch', id, '--set', 'status=dismissed', '--set', 'dismissed_date=@now', '--set', 'resolved_date=@now']);
    expect(r.stdout.trim()).toBe(`OK|${id}`);
    const after = fs.readFileSync(propPath(dir, id), 'utf-8');
    expect(after).toContain('status: dismissed');
    expect(after.match(/dismissed_date: \S+/)).toBeTruthy();
    expect(after.match(/resolved_date: \S+/)?.[0]).not.toContain('null');
  }));

  test('decision-only call leaves frontmatter untouched', withDir(async (dir) => {
    seedState(dir);
    const id = await createProposal(dir);
    const before = fs.readFileSync(propPath(dir, id), 'utf-8');
    const fmBefore = before.slice(0, before.indexOf('\n---', 3) + 4);
    await runProposal(stateArg(dir), ['patch', id, '--stdin'], { stdin: 'Decision: just a note.\n' });
    const after = fs.readFileSync(propPath(dir, id), 'utf-8');
    const fmAfter = after.slice(0, after.indexOf('\n---', 3) + 4);
    expect(fmAfter).toBe(fmBefore);
    expect(after).toContain('just a note.');
  }));

  test('invalid key / no-such-proposal / missing frontmatter terminator -> ERROR, file byte-identical', withDir(async (dir) => {
    seedState(dir);
    const id = await createProposal(dir);
    const before = fs.readFileSync(propPath(dir, id), 'utf-8');

    const r1 = await runProposal(stateArg(dir), ['patch', id, '--set', 'bad key=x']);
    expect(r1.stdout.trim()).toMatch(/^ERROR\|invalid-key/);

    const r2 = await runProposal(stateArg(dir), ['patch', 'PROP-999-nope-000000']);
    expect(r2.stdout.trim()).toBe('ERROR|no-such-proposal');

    const noTerm = path.join(stateArg(dir), 'proposals', 'PROP-002-broken-000001.md');
    fs.writeFileSync(noTerm, '---\nid: PROP-002-broken-000001\nno closing fence\n');
    const r3 = await runProposal(stateArg(dir), ['patch', 'PROP-002-broken-000001', '--set', 'status=accepted']);
    expect(r3.stdout.trim()).toBe('ERROR|frontmatter-terminator-missing');

    expect(fs.readFileSync(propPath(dir, id), 'utf-8')).toBe(before);
  }));

  test('--request-compact writes compact-requested.json with reason proposal-resolve', withDir(async (dir) => {
    seedState(dir);
    const id = await createProposal(dir);
    await runProposal(stateArg(dir), ['patch', id, '--set', 'status=resolved', '--request-compact']);
    const marker = JSON.parse(fs.readFileSync(path.join(stateArg(dir), 'state', 'compact-requested.json'), 'utf-8'));
    expect(marker.reason).toBe('proposal-resolve');
    expect(marker.requested_at).toMatch(/\d{4}-\d{2}-\d{2}T/);
  }));

  test('rebuilds index and summary after patch', withDir(async (dir) => {
    seedState(dir);
    const id = await createProposal(dir);
    await runProposal(stateArg(dir), ['patch', id, '--set', 'status=accepted']);
    const index = JSON.parse(fs.readFileSync(path.join(stateArg(dir), 'state', 'proposals-index.json'), 'utf-8'));
    expect(index.proposals.find((p: any) => p.id === id)?.status).toBe('accepted');
  }));

  test('Set: stdin line carries a free-text multi-word predicate into frontmatter', withDir(async (dir) => {
    seedState(dir);
    const id = await createProposal(dir);
    const r = await runProposal(stateArg(dir), ['patch', id, '--stdin'], { stdin: 'Set: success_signal=avg_session_cost_usd < 5 over 7 sessions\n' });
    expect(r.stdout.trim()).toBe(`OK|${id}`);
    const after = fs.readFileSync(propPath(dir, id), 'utf-8');
    expect(after).toContain('success_signal: "avg_session_cost_usd < 5 over 7 sessions"');
  }));

  test('re-running an identical patch call is idempotent — no duplicate Decision line', withDir(async (dir) => {
    seedState(dir);
    const id = await createProposal(dir);
    const call = () => runProposal(stateArg(dir), ['patch', id, '--stdin'], { stdin: 'Decision: Fixed timestamp note.\n' });
    await call();
    await call();
    const content = fs.readFileSync(propPath(dir, id), 'utf-8');
    const occurrences = content.split('Fixed timestamp note.').length - 1;
    expect(occurrences).toBe(1);
  }));

  test('an @now Decision line already present with a different timestamp is not duplicated', withDir(async (dir) => {
    seedState(dir);
    const id = await createProposal(dir);
    // Every SKILL-documented Decision line carries `@now`, which expands to a
    // fresh stamp per run — comparing expanded text would never match, so the
    // guard has to compare the raw line with `@now` as a timestamp wildcard.
    // Seeding an earlier run's output directly (rather than sleeping past a real
    // second boundary) proves the wildcard matches ANY differing timestamp.
    const seeded = fs.readFileSync(propPath(dir, id), 'utf-8')
      .replace('## Operator Decision\n', '## Operator Decision\nAccepted on 2001-01-01T00:00:00Z.\n');
    fs.writeFileSync(propPath(dir, id), seeded);
    await runProposal(stateArg(dir), ['patch', id, '--stdin', '--set', 'status=accepted', '--set', 'accepted_date=@now'], { stdin: 'Decision: Accepted on @now.\n' });
    const content = fs.readFileSync(propPath(dir, id), 'utf-8');
    expect(content.match(/Accepted on \d{4}-/g)?.length).toBe(1);
    expect(content).toContain('Accepted on 2001-01-01T00:00:00Z.');
  }));

  test('a bare Decision: line does not swallow the following Set: line', withDir(async (dir) => {
    seedState(dir);
    const id = await createProposal(dir);
    const r = await runProposal(stateArg(dir), ['patch', id, '--stdin'], { stdin: 'Decision:\nSet: success_signal=avg_session_cost_usd < 5 over 7 sessions\n' });
    expect(r.stdout.trim()).toBe(`OK|${id}`);
    const after = fs.readFileSync(propPath(dir, id), 'utf-8');
    expect(after).toContain('success_signal: "avg_session_cost_usd < 5 over 7 sessions"');
    // The Set: line must not also land in the Operator Decision section.
    const decision = after.slice(after.indexOf('## Operator Decision'));
    expect(decision).not.toContain('Set: success_signal');
  }));

  test('no free-text value rides --set argv in either SKILL.md', () => {
    const proposalCreate = fs.readFileSync(path.join(PLUGIN_ROOT, 'skills', 'proposal-create', 'SKILL.md'), 'utf-8');
    const proposalAct = fs.readFileSync(path.join(PLUGIN_ROOT, 'skills', 'proposal-act', 'SKILL.md'), 'utf-8');
    // success_signal predicates are free text (multi-word, `<`/`>` operators) — they
    // must travel via the stdin `Set:` line, never argv `--set`.
    expect(proposalCreate).not.toMatch(/--set\s+success_signal=/);
    expect(proposalAct).not.toMatch(/--set\s+success_signal=/);
  });
});

// Both escapes below were reproduced against HEAD before the guards landed:
// `patch <state> '../../../outside.md' --set status=OWNED` printed OK| and
// rewrote the canary, and `patch /other-project/.claude-code-hermit <clean-id>`
// printed OK| and resolved another project's proposal. The pre-approved
// `Bash(bun */scripts/proposal.ts*)` grant covers every argument, so neither
// needed a permission prompt.
describe('proposal.ts patch path containment', () => {
  const CANARY = ['---', 'title: canary', 'status: untouched', '---', '', '## Operator Decision', ''].join('\n');

  function seedCanary(p: string): string {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, CANARY);
    return p;
  }

  // Depths kept inside the scratch dir so a regression cannot litter /tmp.
  const cases: Array<[string, (dir: string) => string]> = [
    ['../outside.md', (dir) => path.join(stateArg(dir), 'outside.md')],
    ['../../outside.md', (dir) => path.join(dir, 'outside.md')],
    ['sub/PROP-001-x-000000.md', (dir) => path.join(stateArg(dir), 'proposals', 'sub', 'PROP-001-x-000000.md')],
  ];

  for (const [arg, canaryAt] of cases) {
    test(`refuses "${arg}" and leaves the target untouched`, withDir(async (dir) => {
      seedState(dir);
      const target = seedCanary(canaryAt(dir));
      const r = await runProposal(stateArg(dir), ['patch', arg, '--set', 'status=OWNED']);
      expect(r.stdout.trim()).toBe('ERROR|no-such-proposal');
      expect(fs.readFileSync(target, 'utf-8')).toBe(CANARY);
    }));
  }

  test('refuses an absolute path (pins the re-rooting that already blocked it)', withDir(async (dir) => {
    seedState(dir);
    const target = seedCanary(path.join(dir, 'abs-canary.md'));
    const r = await runProposal(stateArg(dir), ['patch', target, '--set', 'status=OWNED']);
    expect(r.stdout.trim()).toBe('ERROR|no-such-proposal');
    expect(fs.readFileSync(target, 'utf-8')).toBe(CANARY);
  }));

  test('refuses a bare ".."', withDir(async (dir) => {
    seedState(dir);
    const r = await runProposal(stateArg(dir), ['patch', '..', '--set', 'status=OWNED']);
    expect(r.stdout.trim()).toBe('ERROR|no-such-proposal');
  }));

  test('still resolves a bare id with no .md suffix', withDir(async (dir) => {
    seedState(dir);
    const created = await runProposal(stateArg(dir), ['create'], {
      stdin: heredoc({ Title: 'Suffix walk' }, MIN_BODY),
    });
    const id = created.stdout.trim();
    const r = await runProposal(stateArg(dir), ['patch', id, '--set', 'status=accepted']);
    expect(r.stdout.trim()).toBe(`OK|${id}`);
    expect(fs.readFileSync(propPath(dir, id), 'utf-8')).toContain('status: accepted');
  }));
});

describe('proposal.ts state-dir pin', () => {
  test('refuses a state dir belonging to another project', withDir(async (mine) => {
    seedState(mine);
    await withDir(async (victim) => {
      seedState(victim);
      const created = await runProposal(stateArg(victim), ['create'], {
        stdin: heredoc({ Title: 'Victim prop' }, MIN_BODY),
      });
      const id = created.stdout.trim();
      const before = fs.readFileSync(propPath(victim, id), 'utf-8');

      // Clean basename, foreign root: the basename guard alone would not stop this.
      const r = await runScript('proposal.ts', {
        args: ['patch', stateArg(victim), `${id}.md`, '--set', 'status=dismissed'],
        env: { AGENT_DIR: stateArg(mine) },
      });
      expect(r.exitCode).toBe(1);
      expect(r.stderr).toContain('state dir must be');
      expect(fs.readFileSync(propPath(victim, id), 'utf-8')).toBe(before);
    })();
  }));

  // Hermit state is deliberately main-rooted and shared across worktrees, so a
  // worktree session passes the main checkout's absolute path — but hermitDir()
  // walks up into the partial decoy state dir a worktree carries. Pinning to
  // hermitDir() alone broke every proposal write from a worktree, which is the
  // case proposal.ts exists to serve (Write/Edit are blocked there).
  test('accepts the main checkout state dir from inside a worktree', withDir(async (dir) => {
    const main = path.join(dir, 'main');
    fs.mkdirSync(main, { recursive: true });
    const git = (args: string[], cwd: string) =>
      Bun.spawnSync({ cmd: ['git', ...args], cwd, stdout: 'pipe', stderr: 'pipe' });
    git(['init', '-q', '-b', 'main'], main);
    git(['config', 'user.email', 't@t.t'], main);
    git(['config', 'user.name', 't'], main);
    fs.writeFileSync(path.join(main, 'README.md'), 'x\n');
    git(['add', '-A'], main);
    git(['commit', '-qm', 'init'], main);

    const wt = path.join(dir, 'wt');
    git(['worktree', 'add', '-q', '-b', 'feat', wt], main);

    // Real state in main; partial decoy in the worktree, as the harness leaves it.
    fs.mkdirSync(path.join(main, '.claude-code-hermit', 'state'), { recursive: true });
    seedState(main);
    fs.mkdirSync(path.join(wt, '.claude-code-hermit'), { recursive: true });
    fs.writeFileSync(path.join(wt, '.claude-code-hermit', 'config.json'), '{}');

    // No AGENT_DIR: hermitDir() must resolve off the worktree cwd for this to
    // be a real reproduction. The walk skips the projection (config.json, no
    // state/) and lands on main, so argv and hermitDir() agree here; the
    // mainCheckoutStateDir() fallback covers the out-of-tree worktree instead.
    const r = await runScript('proposal.ts', {
      args: ['create', path.join(main, '.claude-code-hermit')],
      cwd: wt,
      stdin: heredoc({ Title: 'From a worktree' }, MIN_BODY),
    });
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toMatch(/^PROP-\d+-/);
    expect(fs.existsSync(propPath(main, r.stdout.trim()))).toBe(true);
  }));

  // The worktree carve-out is gated on actually being in a linked worktree.
  // Ungated, a hermit living in a subdirectory of a repo also gets the repo
  // root's `.claude-code-hermit/` as a second accepted root — a sibling
  // hermit's state, which is the cross-project write the pin exists to block.
  test('refuses the git root state dir from a subdirectory hermit in the main checkout', withDir(async (dir) => {
    const git = (args: string[], cwd: string) =>
      Bun.spawnSync({ cmd: ['git', ...args], cwd, stdout: 'pipe', stderr: 'pipe' });
    git(['init', '-q', '-b', 'main'], dir);

    // Sibling hermit at the git root; ours lives one level down, so hermitDir()
    // walks up into it and never reaches the root one.
    seedState(dir);
    const sub = path.join(dir, 'sub');
    fs.mkdirSync(path.join(sub, '.claude-code-hermit', 'state'), { recursive: true });
    fs.writeFileSync(path.join(sub, '.claude-code-hermit', 'config.json'), '{}');

    const created = await runScript('proposal.ts', {
      args: ['create', '.claude-code-hermit'],
      cwd: dir,
      stdin: heredoc({ Title: 'Sibling prop' }, MIN_BODY),
    });
    const id = created.stdout.trim();
    const before = fs.readFileSync(propPath(dir, id), 'utf-8');

    const r = await runScript('proposal.ts', {
      args: ['patch', path.join(dir, '.claude-code-hermit'), `${id}.md`, '--set', 'status=dismissed'],
      cwd: sub,
    });
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain('state dir must be');
    expect(fs.readFileSync(propPath(dir, id), 'utf-8')).toBe(before);
  }));

  // `metrics` and `success-signal` take the whole argv tail (their state dir is
  // optional / positionally different), so they bypassed the dispatcher guard.
  // Both read hermit state and print it — an unpinned root made one
  // pre-approved call a read of another project's queue and session costs.
  test('refuses a foreign state dir on the read-only verbs too', withDir(async (mine) => {
    seedState(mine);
    await withDir(async (victim) => {
      seedState(victim);
      const env = { AGENT_DIR: stateArg(mine) };

      const metrics = await runScript('proposal.ts', { args: ['metrics', stateArg(victim)], env });
      expect(metrics.exitCode).toBe(1);
      expect(metrics.stderr).toContain('state dir must be');

      const signal = await runScript('proposal.ts', {
        args: ['success-signal', stateArg(victim), '2026-01-01', 'S-001', 'avg_session_cost_usd < 5 over 7 sessions'],
        env,
      });
      expect(signal.exitCode).toBe(1);
      expect(signal.stderr).toContain('state dir must be');
    })();
  }));

  test('accepts the production shape: relative state dir resolved from cwd', withDir(async (dir) => {
    seedState(dir);
    const created = await runScript('proposal.ts', {
      args: ['create', '.claude-code-hermit'],
      cwd: dir,
      stdin: heredoc({ Title: 'Cwd relative' }, MIN_BODY),
    });
    expect(created.stdout.trim()).toMatch(/^PROP-\d+-/);
  }));
});

describe('proposal.ts shell-append', () => {
  test('findings and progress appends are section-aware', withDir(async (dir) => {
    seedState(dir);
    await runProposal(stateArg(dir), ['shell-append', '--section', 'findings'], { stdin: 'a finding\n' });
    await runProposal(stateArg(dir), ['shell-append', '--section', 'progress'], { stdin: '[10:05] did a thing\n' });
    const shell = fs.readFileSync(shellPath(dir), 'utf-8');
    const findingsSection = shell.slice(shell.indexOf('## Findings'), shell.indexOf('## Changed'));
    const progressSection = shell.slice(shell.indexOf('## Progress Log'), shell.indexOf('## Blockers'));
    expect(findingsSection).toContain('a finding');
    expect(progressSection).toContain('[10:05] did a thing');
  }));

  test('missing SHELL.md -> ERROR|shell-unreadable, exit 0', withDir(async (dir) => {
    seedState(dir);
    fs.rmSync(shellPath(dir));
    const r = await runProposal(stateArg(dir), ['shell-append', '--section', 'findings'], { stdin: 'x\n' });
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toBe('ERROR|shell-unreadable');
  }));

  test('unknown --section -> ERROR', withDir(async (dir) => {
    seedState(dir);
    const r = await runProposal(stateArg(dir), ['shell-append', '--section', 'bogus'], { stdin: 'x\n' });
    expect(r.stdout.trim()).toBe('ERROR|unknown-section');
  }));
});

describe('proposal.ts next-task', () => {
  function nextTaskPath(dir: string): string {
    return path.join(stateArg(dir), 'sessions', 'NEXT-TASK.md');
  }

  test('creates with stdin content', withDir(async (dir) => {
    seedState(dir);
    const r = await runProposal(stateArg(dir), ['next-task'], { stdin: '# Next\nDo the thing.\n' });
    expect(r.stdout.trim()).toBe('OK');
    expect(fs.readFileSync(nextTaskPath(dir), 'utf-8')).toBe('# Next\nDo the thing.\n');
  }));

  test('existing file -> ERROR|next-task-exists, file untouched', withDir(async (dir) => {
    seedState(dir);
    fs.writeFileSync(nextTaskPath(dir), 'original\n');
    const r = await runProposal(stateArg(dir), ['next-task'], { stdin: 'overwrite attempt\n' });
    expect(r.stdout.trim()).toBe('ERROR|next-task-exists');
    expect(fs.readFileSync(nextTaskPath(dir), 'utf-8')).toBe('original\n');
  }));

  test('empty stdin -> ERROR', withDir(async (dir) => {
    seedState(dir);
    const r = await runProposal(stateArg(dir), ['next-task'], { stdin: '   \n' });
    expect(r.stdout.trim()).toBe('ERROR|empty-content');
  }));
});

describe('proposal.ts routine', () => {
  function readConfig(dir: string): any {
    return JSON.parse(fs.readFileSync(path.join(stateArg(dir), 'config.json'), 'utf-8'));
  }

  test('appends to routines array, other config keys byte-preserved', withDir(async (dir) => {
    seedState(dir, { timezone: 'UTC', routines: [{ id: 'existing', schedule: '0 0 * * *', skill: 'x', enabled: true }] });
    const r = await runProposal(stateArg(dir), ['routine'], { stdin: JSON.stringify({ id: 'new-routine', schedule: '0 8 * * *', skill: 'brief', enabled: true }) });
    expect(r.stdout.trim()).toBe('OK|added');
    const cfg = readConfig(dir);
    expect(cfg.timezone).toBe('UTC');
    expect(cfg.routines).toHaveLength(2);
    expect(cfg.routines.find((x: any) => x.id === 'new-routine')).toBeTruthy();
  }));

  test('duplicate id replaces entry, OK|updated', withDir(async (dir) => {
    seedState(dir, { routines: [{ id: 'r1', schedule: '0 0 * * *', skill: 'old', enabled: false }] });
    const r = await runProposal(stateArg(dir), ['routine'], { stdin: JSON.stringify({ id: 'r1', schedule: '0 9 * * *', skill: 'new', enabled: true }) });
    expect(r.stdout.trim()).toBe('OK|updated');
    const cfg = readConfig(dir);
    expect(cfg.routines).toHaveLength(1);
    expect(cfg.routines[0].skill).toBe('new');
  }));

  test('invalid JSON / missing field -> ERROR, config untouched', withDir(async (dir) => {
    seedState(dir);
    const before = fs.readFileSync(path.join(stateArg(dir), 'config.json'), 'utf-8');

    const r1 = await runProposal(stateArg(dir), ['routine'], { stdin: 'not json' });
    expect(r1.stdout.trim()).toBe('ERROR|invalid-json');

    const r2 = await runProposal(stateArg(dir), ['routine'], { stdin: JSON.stringify({ schedule: '0 0 * * *', skill: 'x', enabled: true }) });
    expect(r2.stdout.trim()).toBe('ERROR|missing-field:id');

    expect(fs.readFileSync(path.join(stateArg(dir), 'config.json'), 'utf-8')).toBe(before);
  }));
});

// -------------------------------------------------------
// Dispatch gate — the two absorbed verbs that legitimately take no state dir
// -------------------------------------------------------
//
// Every other verb is refused without one (`!verb || !stateDir` → exit 1), which
// is what stops a mis-invocation from creating anything. These two are carved
// out ahead of that guard: `success-signal --validate` is a pure grammar check
// that reads no state, and `metrics` defaults the state dir. If the carve-out
// regressed, both would exit 1 with a usage line and their callers — a
// proposal-create predicate check, a domain brainstorm's kill-criteria check —
// would read that as a failure verdict.

describe('proposal.ts dispatch gate', () => {
  test('success-signal --validate needs no state dir; exit code still carries the verdict', async () => {
    const ok = await runScript('proposal.ts', {
      args: ['success-signal', '--validate', 'avg_session_cost_usd < 1.5 over 5 sessions'],
    });
    expect(ok.exitCode).toBe(0);
    expect(ok.stdout.trim()).toBe('OK');

    // Non-zero on a bad predicate is load-bearing: proposal-create branches on it.
    const bad = await runScript('proposal.ts', { args: ['success-signal', '--validate', 'nonsense'] });
    expect(bad.exitCode).toBe(1);
    expect(bad.stdout).toContain('invalid grammar');
  });

  test('metrics needs no state dir — it defaults to .claude-code-hermit', withDir(async (dir) => {
    const r = await runScript('proposal.ts', { args: ['metrics'], cwd: dir });
    expect(r.exitCode).toBe(0);
    // No ledger under the default dir → the fail-open line, not a usage error.
    expect(r.stdout).toContain('No proposal metrics yet.');
    expect(r.stderr).not.toContain('Usage:');
  }));

  test('a verb that does need a state dir is still refused without one', async () => {
    const r = await runScript('proposal.ts', { args: ['create'] });
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain('Usage: bun proposal.ts');
  });
});

// Every proposal-act flow writes status through `patch`, so this is where an
// ask parked on the proposal has to be retired — the queue would otherwise keep
// asking how to implement something already resolved, dismissed, or deferred.
describe('proposal.ts patch — pending-ask reconciliation', () => {
  function seedAsk(dir: string, propId: string, extra: Record<string, any> = {}): void {
    fs.writeFileSync(
      path.join(stateArg(dir), 'state', 'micro-proposals.json'),
      JSON.stringify({
        pending: [{
          id: 'MP-1', tier: 1, status: 'pending', follow_up_count: 0, ts: '2026-08-21T13:48:35Z',
          question: 'Suggestion #1 accepted — how should it be implemented?',
          proposal_id: propId, on_resolve: `/claude-code-hermit:proposal-act accept ${propId} --answer {answer}`,
          ...extra,
        }],
      }, null, 2) + '\n',
    );
  }
  function pending(dir: string): any[] {
    return JSON.parse(fs.readFileSync(path.join(stateArg(dir), 'state', 'micro-proposals.json'), 'utf-8')).pending;
  }
  function createProposal(dir: string): Promise<string> {
    return runProposal(stateArg(dir), ['create'], { stdin: heredoc({ Title: 'Reconcile target' }, MIN_BODY) })
      .then(r => r.stdout.trim());
  }

  for (const [status, extraSets] of [
    ['resolved', ['--set', 'resolved_date=@now']],
    ['dismissed', ['--set', 'dismissed_date=@now']],
    ['deferred', ['--set', 'deferred_date=@now']],
  ] as Array<[string, string[]]>) {
    test(`patch to ${status} retires the linked ask`, withDir(async (dir) => {
      seedState(dir);
      const id = await createProposal(dir);
      seedAsk(dir, id.slice(0, 8));

      const r = await runProposal(stateArg(dir), ['patch', id, '--set', `status=${status}`, ...extraSets]);
      expect(r.stdout.trim()).toBe(`OK|${id}`);
      expect(pending(dir)).toHaveLength(0);
      expect(metricsLines(dir).filter(e => e.action === 'moot')).toHaveLength(1);
    }));
  }

  test('patch to accepted keeps the ask pending', withDir(async (dir) => {
    seedState(dir);
    const id = await createProposal(dir);
    seedAsk(dir, id.slice(0, 8));

    await runProposal(stateArg(dir), ['patch', id, '--set', 'status=accepted']);
    expect(pending(dir)).toHaveLength(1);
  }));

  test('an ask for another proposal survives', withDir(async (dir) => {
    seedState(dir);
    const id = await createProposal(dir);
    seedAsk(dir, 'PROP-999');

    await runProposal(stateArg(dir), ['patch', id, '--set', 'status=resolved']);
    expect(pending(dir)).toHaveLength(1);
  }));

  // The stdin `Set:` form is the one proposal-act's resolve/dismiss flows use
  // alongside a Decision line; a hook reading only argv would miss it.
  test('the stdin Set: form reconciles too', withDir(async (dir) => {
    seedState(dir);
    const id = await createProposal(dir);
    seedAsk(dir, id.slice(0, 8));

    const r = await runProposal(stateArg(dir), ['patch', id, '--stdin'], { stdin: 'Set: status=resolved\nDecision: Done.\n' });
    expect(r.stdout.trim()).toBe(`OK|${id}`);
    expect(pending(dir)).toHaveLength(0);
  }));

  // The proposal write already landed — reporting ERROR| would tell the caller
  // nothing was patched, which is false and worse than the stale ask.
  test('a corrupt queue warns but still reports the patch as applied', withDir(async (dir) => {
    seedState(dir);
    const id = await createProposal(dir);
    fs.writeFileSync(path.join(stateArg(dir), 'state', 'micro-proposals.json'), '{"pending": [ ,] }\n');

    const r = await runProposal(stateArg(dir), ['patch', id, '--set', 'status=resolved']);
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toBe(`OK|${id}`);
    expect(r.stderr).toContain('reconciliation');
    expect(fs.readFileSync(propPath(dir, id), 'utf-8')).toContain('status: resolved');
  }));
});

// `index` is the third carve-out: it was a fail-open derived-cache rebuild before
// absorption (`SKIP|no state dir`, exit 0) and stays one. Falling through to the
// generic exit-1 usage guard would read as a real failure to its callers.
describe('proposal.ts index fail-open contract', () => {
  test('index with no state dir → SKIP on stdout, exit 0', async () => {
    const r = await runScript('proposal.ts', { args: ['index'] });
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toBe('SKIP|no state dir');
  });
});
