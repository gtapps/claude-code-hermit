// apply-reflection-actions.ts is the transactional apply step for the reflect
// eval runner's resolution_actions batch. The contract under test: the WHOLE
// batch validates before ANY write (a single bad entry means zero writes), the
// frontmatter patch is line-level (body and unrelated frontmatter stay
// byte-identical), metrics append to state/proposal-metrics.jsonl, and the
// SHELL.md Findings append is best-effort (failures land in `errors`, never
// flip ok or abort the durable writes). Exit code is 0 always.
//
// Usage: bun test tests/apply-reflection-actions.test.ts   (from the plugin root)

import { describe, test, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { runScript } from './helpers/run';

const hermit = (dir: string, ...p: string[]) => path.join(dir, '.claude-code-hermit', ...p);
const proposalPath = (dir: string) => hermit(dir, 'proposals', 'PROP-042-some-slug-101010.md');
const shellPath = (dir: string) => hermit(dir, 'sessions', 'SHELL.md');
const metricsPath = (dir: string) => hermit(dir, 'state', 'proposal-metrics.jsonl');

const PROPOSAL_MD = `---
id: PROP-042
status: proposed
title: Route channel sends through the resolver
created: 2026-07-18T10:10:10+0000
tags: [reflect]
---

## Summary
The resolver should own channel target selection.

## Notes
- this body line must stay byte-identical
`;

const SHELL_MD = `# Active Session

## Task
ongoing work

## Findings
<!-- Anything unexpected found during work. -->

## Monitoring
- [12:00] tick
`;

interface Tmp { dir: string; cleanup(): void }

function makeDir(): Tmp {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hermit-reflact-'));
  fs.mkdirSync(hermit(dir, 'proposals'), { recursive: true });
  fs.mkdirSync(hermit(dir, 'sessions'), { recursive: true });
  fs.mkdirSync(hermit(dir, 'state'), { recursive: true });
  fs.writeFileSync(proposalPath(dir), PROPOSAL_MD);
  fs.writeFileSync(shellPath(dir), SHELL_MD);
  return { dir, cleanup: () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} } };
}

function withTmp(fn: (dir: string) => Promise<void> | void) {
  return async () => {
    const t = makeDir();
    try { await fn(t.dir); } finally { t.cleanup(); }
  };
}

async function apply(dir: string, input: unknown) {
  const r = await runScript('apply-reflection-actions.ts', {
    args: [hermit(dir)],
    stdin: typeof input === 'string' ? input : JSON.stringify(input),
  });
  expect(r.exitCode).toBe(0);
  return JSON.parse(r.stdout.trim());
}

const METRICS_EVENT = JSON.stringify({ event: 'auto_resolved', proposal_id: 'PROP-042' });
const FINDINGS_LINE = '- [reflect] PROP-042 auto-resolved (shipped in #612)';

const AUTO_RESOLVE = {
  proposal_id: 'PROP-042',
  action: 'auto-resolve',
  frontmatter_patch: { status: 'resolved', resolved_date: '2026-07-20' },
  metrics_event: METRICS_EVENT,
  shell_findings_line: FINDINGS_LINE,
};

// Everything from the closing --- onward — the byte-identical region of a patch.
const bodyOf = (content: string) => content.slice(content.indexOf('\n---', 3));

describe('apply-reflection-actions: happy paths', () => {
  test('auto-resolve patches frontmatter in place, appends metrics + findings', withTmp(async (dir) => {
    const result = await apply(dir, { resolution_actions: [AUTO_RESOLVE] });
    expect(result.ok).toBe(true);
    expect(result.applied).toEqual({ auto_resolve: 1, nudge: 0, skip: 0 });
    expect(result.errors).toBeUndefined();

    const after = fs.readFileSync(proposalPath(dir), 'utf-8');
    // status: replaced in place; resolved_date: inserted before the closing ---.
    expect(after).toMatch(/^status: resolved$/m);
    expect(after).not.toMatch(/^status: proposed$/m);
    const fmBlock = after.slice(0, after.indexOf('\n---', 3));
    expect(fmBlock).toContain('resolved_date: 2026-07-20');
    // Unrelated frontmatter and the entire body are byte-identical.
    expect(fmBlock).toContain('id: PROP-042');
    expect(fmBlock).toContain('title: Route channel sends through the resolver');
    expect(fmBlock).toContain('created: 2026-07-18T10:10:10+0000');
    expect(bodyOf(after)).toBe(bodyOf(PROPOSAL_MD));

    const metrics = fs.readFileSync(metricsPath(dir), 'utf-8');
    expect(metrics).toBe(METRICS_EVENT + '\n');

    // Findings line lands inside ## Findings, before the next heading.
    const shell = fs.readFileSync(shellPath(dir), 'utf-8');
    expect(shell.indexOf(FINDINGS_LINE)).toBeGreaterThan(shell.indexOf('## Findings'));
    expect(shell.indexOf(FINDINGS_LINE)).toBeLessThan(shell.indexOf('\n## Monitoring'));
  }));

  test('nudge appends findings only — no proposal patch, no metrics', withTmp(async (dir) => {
    const result = await apply(dir, {
      resolution_actions: [{
        proposal_id: 'PROP-042', action: 'nudge',
        shell_findings_line: '- [reflect] PROP-042 nudged: 3 sessions stale',
      }],
    });
    expect(result.ok).toBe(true);
    expect(result.applied).toEqual({ auto_resolve: 0, nudge: 1, skip: 0 });
    expect(fs.readFileSync(proposalPath(dir), 'utf-8')).toBe(PROPOSAL_MD);
    expect(fs.existsSync(metricsPath(dir))).toBe(false);
    expect(fs.readFileSync(shellPath(dir), 'utf-8')).toContain('PROP-042 nudged');
  }));

  test('skip writes nothing at all', withTmp(async (dir) => {
    const result = await apply(dir, {
      resolution_actions: [{ proposal_id: 'PROP-042', action: 'skip' }],
    });
    expect(result.ok).toBe(true);
    expect(result.applied).toEqual({ auto_resolve: 0, nudge: 0, skip: 1 });
    expect(fs.readFileSync(proposalPath(dir), 'utf-8')).toBe(PROPOSAL_MD);
    expect(fs.readFileSync(shellPath(dir), 'utf-8')).toBe(SHELL_MD);
    expect(fs.existsSync(metricsPath(dir))).toBe(false);
  }));

  test('mixed batch [auto-resolve, nudge, skip] counts each bucket', withTmp(async (dir) => {
    const result = await apply(dir, {
      resolution_actions: [
        AUTO_RESOLVE,
        { proposal_id: 'PROP-042', action: 'nudge', shell_findings_line: '- [reflect] PROP-042 nudged' },
        { proposal_id: 'PROP-042', action: 'skip' },
      ],
    });
    expect(result.ok).toBe(true);
    expect(result.applied).toEqual({ auto_resolve: 1, nudge: 1, skip: 1 });
  }));

  test('empty resolution_actions → ok with all-zero counts', withTmp(async (dir) => {
    const result = await apply(dir, { resolution_actions: [] });
    expect(result.ok).toBe(true);
    expect(result.applied).toEqual({ auto_resolve: 0, nudge: 0, skip: 0 });
  }));
});

describe('apply-reflection-actions: transactionality (invalid batch = zero writes)', () => {
  test('one bogus entry poisons the whole batch — the valid auto-resolve writes nothing', withTmp(async (dir) => {
    const result = await apply(dir, {
      resolution_actions: [AUTO_RESOLVE, { proposal_id: 'PROP-042', action: 'bogus' }],
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('bogus');
    expect(fs.readFileSync(proposalPath(dir), 'utf-8')).toBe(PROPOSAL_MD);
    expect(fs.existsSync(metricsPath(dir))).toBe(false);
    expect(fs.readFileSync(shellPath(dir), 'utf-8')).toBe(SHELL_MD);
  }));

  test('auto-resolve with frontmatter_patch: null → ok:false, nothing written', withTmp(async (dir) => {
    const result = await apply(dir, {
      resolution_actions: [{ ...AUTO_RESOLVE, frontmatter_patch: null }],
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('frontmatter_patch');
    expect(fs.readFileSync(proposalPath(dir), 'utf-8')).toBe(PROPOSAL_MD);
    expect(fs.existsSync(metricsPath(dir))).toBe(false);
  }));

  test('metrics_event that is not valid JSON → ok:false', withTmp(async (dir) => {
    const result = await apply(dir, {
      resolution_actions: [{ ...AUTO_RESOLVE, metrics_event: 'not json' }],
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('metrics_event');
    expect(fs.readFileSync(proposalPath(dir), 'utf-8')).toBe(PROPOSAL_MD);
  }));

  test('proposal_id with no matching file (PROP-999) → ok:false', withTmp(async (dir) => {
    const result = await apply(dir, {
      resolution_actions: [{ ...AUTO_RESOLVE, proposal_id: 'PROP-999' }],
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('no matching proposal file');
  }));

  test('malformed proposal_id shape (PROP-x) → ok:false', withTmp(async (dir) => {
    const result = await apply(dir, {
      resolution_actions: [{ ...AUTO_RESOLVE, proposal_id: 'PROP-x' }],
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('PROP-<digits>');
  }));

  test('malformed stdin → ok:false, still exit 0', withTmp(async (dir) => {
    const result = await apply(dir, 'not json');
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('stdin');
  }));
});

describe('apply-reflection-actions: edges', () => {
  test('prefix boundary: PROP-1 patches only PROP-1-*.md, never PROP-12-*.md', withTmp(async (dir) => {
    const mk = (id: string) => `---\nid: ${id}\nstatus: proposed\n---\n\nbody of ${id}\n`;
    const p1 = hermit(dir, 'proposals', 'PROP-1-a-000000.md');
    const p12 = hermit(dir, 'proposals', 'PROP-12-b-000000.md');
    fs.writeFileSync(p1, mk('PROP-1'));
    fs.writeFileSync(p12, mk('PROP-12'));
    const result = await apply(dir, {
      resolution_actions: [{
        proposal_id: 'PROP-1', action: 'auto-resolve',
        frontmatter_patch: { status: 'resolved' },
      }],
    });
    expect(result.ok).toBe(true);
    expect(fs.readFileSync(p1, 'utf-8')).toMatch(/^status: resolved$/m);
    expect(fs.readFileSync(p12, 'utf-8')).toBe(mk('PROP-12'));
  }));

  test('SHELL.md without a ## Findings heading: durable writes land, ok:true with errors', withTmp(async (dir) => {
    fs.writeFileSync(shellPath(dir), '# Active Session\n\n## Task\nno findings section here\n');
    const result = await apply(dir, { resolution_actions: [AUTO_RESOLVE] });
    expect(result.ok).toBe(true);
    expect(result.applied).toEqual({ auto_resolve: 1, nudge: 0, skip: 0 });
    expect(result.errors).toBeDefined();
    expect(result.errors.join(' ')).toContain('Findings');
    // Durable core still landed: proposal patched, metrics appended.
    expect(fs.readFileSync(proposalPath(dir), 'utf-8')).toMatch(/^status: resolved$/m);
    expect(fs.readFileSync(metricsPath(dir), 'utf-8')).toBe(METRICS_EVENT + '\n');
  }));

  // The ledger is line-delimited and every reader parses it line by line inside a
  // bare catch, so a pretty-printed metrics_event appended verbatim would be
  // dropped silently rather than erroring. Canonicalize to one physical line.
  test('pretty-printed metrics_event is re-serialized to a single JSONL line', withTmp(async (dir) => {
    const pretty = '{\n  "event": "auto_resolved",\n  "proposal_id": "PROP-042"\n}';
    const result = await apply(dir, {
      resolution_actions: [{ ...AUTO_RESOLVE, metrics_event: pretty }],
    });
    expect(result.ok).toBe(true);
    expect(result.errors).toBeUndefined();
    const written = fs.readFileSync(metricsPath(dir), 'utf-8');
    expect(written.trimEnd().split('\n')).toHaveLength(1);
    expect(JSON.parse(written)).toEqual({ event: 'auto_resolved', proposal_id: 'PROP-042' });
  }));

  // Normalizing the tail to a single newline used to swallow the blank line that
  // separates ## Findings from the heading after it, gluing the sections together.
  test('findings append preserves the blank line before the next heading', withTmp(async (dir) => {
    await apply(dir, { resolution_actions: [AUTO_RESOLVE] });
    const once = fs.readFileSync(shellPath(dir), 'utf-8');
    expect(once).toContain(`${FINDINGS_LINE}\n\n## Monitoring`);
    // Stable across repeated runs — neither collapsing nor accumulating blank lines.
    await apply(dir, {
      resolution_actions: [{ ...AUTO_RESOLVE, shell_findings_line: '- [reflect] second line' }],
    });
    const twice = fs.readFileSync(shellPath(dir), 'utf-8');
    expect(twice).toContain(`${FINDINGS_LINE}\n- [reflect] second line\n\n## Monitoring`);
  }));

  // patchFrontmatter is exported and the apply pass re-reads from disk, so the
  // validation pass is not a sufficient guarantee. Without the terminator guard,
  // slice(4, -1) absorbs the body into the frontmatter and discards it.
  test('proposal with no closing frontmatter delimiter is rejected, file untouched', withTmp(async (dir) => {
    const truncated = '---\nid: PROP-042\nstatus: proposed\n\nbody with no terminator\n';
    fs.writeFileSync(proposalPath(dir), truncated);
    const result = await apply(dir, { resolution_actions: [AUTO_RESOLVE] });
    expect(result.ok).toBe(false);
    expect(fs.readFileSync(proposalPath(dir), 'utf-8')).toBe(truncated);
  }));
});
