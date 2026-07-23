// Contract tests for scripts/proposal.ts — the single CLI covering every
// proposal-lifecycle state-dir mutation formerly done via the Write/Edit
// tools (blocked under the harness background-isolation guard).

import { describe, test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';

import { runScript, PLUGIN_ROOT } from './helpers/run';
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
    const r = await runScript('proposal.ts', { args: ['create', stateArg(dir)], stdin });
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
    const r = await runScript('proposal.ts', { args: ['create', stateArg(dir)], stdin });
    expect(r.stdout.trim()).toMatch(/^PROP-008-/);
  }));

  test('session defaults from runtime.json when Session header omitted', withDir(async (dir) => {
    seedState(dir);
    fs.writeFileSync(path.join(stateArg(dir), 'state', 'runtime.json'), JSON.stringify({ session_id: 'S-042' }));
    const stdin = heredoc({ Title: 'Session default test' }, MIN_BODY);
    const r = await runScript('proposal.ts', { args: ['create', stateArg(dir)], stdin });
    const id = r.stdout.trim();
    const content = fs.readFileSync(propPath(dir, id), 'utf-8');
    expect(content).toContain('session: S-042');
  }));

  test('template missing -> ERROR|template-missing, zero writes', withDir(async (dir) => {
    fs.mkdirSync(path.join(stateArg(dir), 'proposals'), { recursive: true });
    fs.writeFileSync(path.join(stateArg(dir), 'config.json'), JSON.stringify({ timezone: 'UTC' }));
    const stdin = heredoc({ Title: 'No template' }, MIN_BODY);
    const r = await runScript('proposal.ts', { args: ['create', stateArg(dir)], stdin });
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
      const r = await runScript('proposal.ts', { args: ['create', stateArg(dir)], stdin });
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
      const r = await runScript('proposal.ts', { args: ['create', stateArg(dir)], stdin });
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
    const r = await runScript('proposal.ts', { args: ['create', stateArg(dir)], stdin });
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toMatch(/^PROP-001-/);
    expect(fs.existsSync(propPath(dir, r.stdout.trim()))).toBe(true);
    expect(r.stderr).toContain('findings append');
  }));

  test('Findings line lands inside ## Findings before the next heading', withDir(async (dir) => {
    seedState(dir);
    const stdin = heredoc({ Title: 'Findings placement', Findings: 'custom summary' }, MIN_BODY);
    const r = await runScript('proposal.ts', { args: ['create', stateArg(dir)], stdin });
    const id = r.stdout.trim();
    const shell = fs.readFileSync(shellPath(dir), 'utf-8');
    const findingsSection = shell.slice(shell.indexOf('## Findings'), shell.indexOf('## Changed'));
    expect(findingsSection).toContain(`- ${id}: custom summary`);
  }));

  test('created metrics event carries source/category/tags', withDir(async (dir) => {
    seedState(dir);
    const stdin = heredoc({ Title: 'Metrics test', Source: 'operator-request', Category: 'capability', Tags: '["x"]' }, MIN_BODY);
    const r = await runScript('proposal.ts', { args: ['create', stateArg(dir)], stdin });
    const id = r.stdout.trim();
    const lines = metricsLines(dir);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ type: 'created', proposal_id: id, source: 'operator-request', category: 'capability', tags: ['x'] });
  }));

  test('rebuilds proposals-index and state-summary', withDir(async (dir) => {
    seedState(dir);
    const stdin = heredoc({ Title: 'Index regen test' }, MIN_BODY);
    const r = await runScript('proposal.ts', { args: ['create', stateArg(dir)], stdin });
    const id = r.stdout.trim();
    const index = JSON.parse(fs.readFileSync(path.join(stateArg(dir), 'state', 'proposals-index.json'), 'utf-8'));
    expect(index.proposals.some((p: any) => p.id === id)).toBe(true);
    expect(fs.existsSync(path.join(stateArg(dir), 'state', 'state-summary.md'))).toBe(true);
  }));

  test('appends ## Operator Decision when body lacks it', withDir(async (dir) => {
    seedState(dir);
    const bodyNoDecision = '## Context\nctx\n\n## Problem\nprob\n';
    const stdin = heredoc({ Title: 'No decision section' }, bodyNoDecision);
    const r = await runScript('proposal.ts', { args: ['create', stateArg(dir)], stdin });
    const id = r.stdout.trim();
    const content = fs.readFileSync(propPath(dir, id), 'utf-8');
    expect(content).toContain('## Operator Decision');
  }));
});

describe('proposal.ts dispatcher', () => {
  test('unknown verb -> ERROR|unknown-verb, exit 0', withDir(async (dir) => {
    seedState(dir);
    const r = await runScript('proposal.ts', { args: ['bogus', stateArg(dir)] });
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toBe('ERROR|unknown-verb');
  }));

  test('missing state dir arg -> exit 1', async () => {
    const r = await runScript('proposal.ts', { args: ['create'] });
    expect(r.exitCode).toBe(1);
  });
});

describe('proposal.ts patch', () => {
  function createProposal(dir: string, extra: Record<string, string> = {}): Promise<string> {
    const stdin = heredoc({ Title: 'Patch target', ...extra }, MIN_BODY);
    return runScript('proposal.ts', { args: ['create', stateArg(dir)], stdin }).then(r => r.stdout.trim());
  }

  test('accept flip: in-place frontmatter patch, @now expansion, Decision append', withDir(async (dir) => {
    seedState(dir);
    const id = await createProposal(dir);
    const before = fs.readFileSync(propPath(dir, id), 'utf-8');

    const r = await runScript('proposal.ts', {
      args: ['patch', stateArg(dir), id, '--set', 'status=accepted', '--set', 'accepted_date=@now', '--set', 'responded=true'],
      stdin: 'Decision: Accepted on @now.\n',
    });
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
    const r = await runScript('proposal.ts', {
      args: ['patch', stateArg(dir), id, '--set', 'status=dismissed', '--set', 'dismissed_date=@now', '--set', 'resolved_date=@now'],
    });
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
    await runScript('proposal.ts', {
      args: ['patch', stateArg(dir), id],
      stdin: 'Decision: just a note.\n',
    });
    const after = fs.readFileSync(propPath(dir, id), 'utf-8');
    const fmAfter = after.slice(0, after.indexOf('\n---', 3) + 4);
    expect(fmAfter).toBe(fmBefore);
    expect(after).toContain('just a note.');
  }));

  test('invalid key / no-such-proposal / missing frontmatter terminator -> ERROR, file byte-identical', withDir(async (dir) => {
    seedState(dir);
    const id = await createProposal(dir);
    const before = fs.readFileSync(propPath(dir, id), 'utf-8');

    const r1 = await runScript('proposal.ts', { args: ['patch', stateArg(dir), id, '--set', 'bad key=x'] });
    expect(r1.stdout.trim()).toMatch(/^ERROR\|invalid-key/);

    const r2 = await runScript('proposal.ts', { args: ['patch', stateArg(dir), 'PROP-999-nope-000000'] });
    expect(r2.stdout.trim()).toBe('ERROR|no-such-proposal');

    const noTerm = path.join(stateArg(dir), 'proposals', 'PROP-002-broken-000001.md');
    fs.writeFileSync(noTerm, '---\nid: PROP-002-broken-000001\nno closing fence\n');
    const r3 = await runScript('proposal.ts', { args: ['patch', stateArg(dir), 'PROP-002-broken-000001', '--set', 'status=accepted'] });
    expect(r3.stdout.trim()).toBe('ERROR|frontmatter-terminator-missing');

    expect(fs.readFileSync(propPath(dir, id), 'utf-8')).toBe(before);
  }));

  test('--request-compact writes compact-requested.json with reason proposal-resolve', withDir(async (dir) => {
    seedState(dir);
    const id = await createProposal(dir);
    await runScript('proposal.ts', { args: ['patch', stateArg(dir), id, '--set', 'status=resolved', '--request-compact'] });
    const marker = JSON.parse(fs.readFileSync(path.join(stateArg(dir), 'state', 'compact-requested.json'), 'utf-8'));
    expect(marker.reason).toBe('proposal-resolve');
    expect(marker.requested_at).toMatch(/\d{4}-\d{2}-\d{2}T/);
  }));

  test('rebuilds index and summary after patch', withDir(async (dir) => {
    seedState(dir);
    const id = await createProposal(dir);
    await runScript('proposal.ts', { args: ['patch', stateArg(dir), id, '--set', 'status=accepted'] });
    const index = JSON.parse(fs.readFileSync(path.join(stateArg(dir), 'state', 'proposals-index.json'), 'utf-8'));
    expect(index.proposals.find((p: any) => p.id === id)?.status).toBe('accepted');
  }));

  test('Set: stdin line carries a free-text multi-word predicate into frontmatter', withDir(async (dir) => {
    seedState(dir);
    const id = await createProposal(dir);
    const r = await runScript('proposal.ts', {
      args: ['patch', stateArg(dir), id],
      stdin: 'Set: success_signal=avg_session_cost_usd < 5 over 7 sessions\n',
    });
    expect(r.stdout.trim()).toBe(`OK|${id}`);
    const after = fs.readFileSync(propPath(dir, id), 'utf-8');
    expect(after).toContain('success_signal: "avg_session_cost_usd < 5 over 7 sessions"');
  }));

  test('re-running an identical patch call is idempotent — no duplicate Decision line', withDir(async (dir) => {
    seedState(dir);
    const id = await createProposal(dir);
    const call = () => runScript('proposal.ts', { args: ['patch', stateArg(dir), id], stdin: 'Decision: Fixed timestamp note.\n' });
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
    await runScript('proposal.ts', {
      args: ['patch', stateArg(dir), id, '--set', 'status=accepted', '--set', 'accepted_date=@now'],
      stdin: 'Decision: Accepted on @now.\n',
    });
    const content = fs.readFileSync(propPath(dir, id), 'utf-8');
    expect(content.match(/Accepted on \d{4}-/g)?.length).toBe(1);
    expect(content).toContain('Accepted on 2001-01-01T00:00:00Z.');
  }));

  test('a bare Decision: line does not swallow the following Set: line', withDir(async (dir) => {
    seedState(dir);
    const id = await createProposal(dir);
    const r = await runScript('proposal.ts', {
      args: ['patch', stateArg(dir), id],
      stdin: 'Decision:\nSet: success_signal=avg_session_cost_usd < 5 over 7 sessions\n',
    });
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

describe('proposal.ts shell-append', () => {
  test('findings and progress appends are section-aware', withDir(async (dir) => {
    seedState(dir);
    await runScript('proposal.ts', { args: ['shell-append', stateArg(dir), '--section', 'findings'], stdin: 'a finding\n' });
    await runScript('proposal.ts', { args: ['shell-append', stateArg(dir), '--section', 'progress'], stdin: '[10:05] did a thing\n' });
    const shell = fs.readFileSync(shellPath(dir), 'utf-8');
    const findingsSection = shell.slice(shell.indexOf('## Findings'), shell.indexOf('## Changed'));
    const progressSection = shell.slice(shell.indexOf('## Progress Log'), shell.indexOf('## Blockers'));
    expect(findingsSection).toContain('a finding');
    expect(progressSection).toContain('[10:05] did a thing');
  }));

  test('missing SHELL.md -> ERROR|shell-unreadable, exit 0', withDir(async (dir) => {
    seedState(dir);
    fs.rmSync(shellPath(dir));
    const r = await runScript('proposal.ts', { args: ['shell-append', stateArg(dir), '--section', 'findings'], stdin: 'x\n' });
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toBe('ERROR|shell-unreadable');
  }));

  test('unknown --section -> ERROR', withDir(async (dir) => {
    seedState(dir);
    const r = await runScript('proposal.ts', { args: ['shell-append', stateArg(dir), '--section', 'bogus'], stdin: 'x\n' });
    expect(r.stdout.trim()).toBe('ERROR|unknown-section');
  }));
});

describe('proposal.ts next-task', () => {
  function nextTaskPath(dir: string): string {
    return path.join(stateArg(dir), 'sessions', 'NEXT-TASK.md');
  }

  test('creates with stdin content', withDir(async (dir) => {
    seedState(dir);
    const r = await runScript('proposal.ts', { args: ['next-task', stateArg(dir)], stdin: '# Next\nDo the thing.\n' });
    expect(r.stdout.trim()).toBe('OK');
    expect(fs.readFileSync(nextTaskPath(dir), 'utf-8')).toBe('# Next\nDo the thing.\n');
  }));

  test('existing file -> ERROR|next-task-exists, file untouched', withDir(async (dir) => {
    seedState(dir);
    fs.writeFileSync(nextTaskPath(dir), 'original\n');
    const r = await runScript('proposal.ts', { args: ['next-task', stateArg(dir)], stdin: 'overwrite attempt\n' });
    expect(r.stdout.trim()).toBe('ERROR|next-task-exists');
    expect(fs.readFileSync(nextTaskPath(dir), 'utf-8')).toBe('original\n');
  }));

  test('empty stdin -> ERROR', withDir(async (dir) => {
    seedState(dir);
    const r = await runScript('proposal.ts', { args: ['next-task', stateArg(dir)], stdin: '   \n' });
    expect(r.stdout.trim()).toBe('ERROR|empty-content');
  }));
});

describe('proposal.ts routine', () => {
  function readConfig(dir: string): any {
    return JSON.parse(fs.readFileSync(path.join(stateArg(dir), 'config.json'), 'utf-8'));
  }

  test('appends to routines array, other config keys byte-preserved', withDir(async (dir) => {
    seedState(dir, { timezone: 'UTC', routines: [{ id: 'existing', schedule: '0 0 * * *', skill: 'x', enabled: true }] });
    const r = await runScript('proposal.ts', {
      args: ['routine', stateArg(dir)],
      stdin: JSON.stringify({ id: 'new-routine', schedule: '0 8 * * *', skill: 'brief', enabled: true }),
    });
    expect(r.stdout.trim()).toBe('OK|added');
    const cfg = readConfig(dir);
    expect(cfg.timezone).toBe('UTC');
    expect(cfg.routines).toHaveLength(2);
    expect(cfg.routines.find((x: any) => x.id === 'new-routine')).toBeTruthy();
  }));

  test('duplicate id replaces entry, OK|updated', withDir(async (dir) => {
    seedState(dir, { routines: [{ id: 'r1', schedule: '0 0 * * *', skill: 'old', enabled: false }] });
    const r = await runScript('proposal.ts', {
      args: ['routine', stateArg(dir)],
      stdin: JSON.stringify({ id: 'r1', schedule: '0 9 * * *', skill: 'new', enabled: true }),
    });
    expect(r.stdout.trim()).toBe('OK|updated');
    const cfg = readConfig(dir);
    expect(cfg.routines).toHaveLength(1);
    expect(cfg.routines[0].skill).toBe('new');
  }));

  test('invalid JSON / missing field -> ERROR, config untouched', withDir(async (dir) => {
    seedState(dir);
    const before = fs.readFileSync(path.join(stateArg(dir), 'config.json'), 'utf-8');

    const r1 = await runScript('proposal.ts', { args: ['routine', stateArg(dir)], stdin: 'not json' });
    expect(r1.stdout.trim()).toBe('ERROR|invalid-json');

    const r2 = await runScript('proposal.ts', { args: ['routine', stateArg(dir)], stdin: JSON.stringify({ schedule: '0 0 * * *', skill: 'x', enabled: true }) });
    expect(r2.stdout.trim()).toBe('ERROR|missing-field:id');

    expect(fs.readFileSync(path.join(stateArg(dir), 'config.json'), 'utf-8')).toBe(before);
  }));
});
