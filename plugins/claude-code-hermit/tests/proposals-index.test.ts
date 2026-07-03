// proposals-index.ts — derived-cache correctness + hook-dispatch wiring.
// The index replaces reading every PROP-*.md body (~22K tokens) with a single
// frontmatter mirror, and becomes the single source of proposal counts.
//
// Usage: bun test tests/proposals-index.test.ts   (from the plugin root)

import { describe, test, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { rebuildIndex } from '../scripts/proposals-index';
import { runScript } from './helpers/run';

const hermit = (dir: string, ...p: string[]) => path.join(dir, '.claude-code-hermit', ...p);

function makeDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hermit-propidx-'));
  fs.mkdirSync(hermit(dir, 'state'), { recursive: true });
  fs.mkdirSync(hermit(dir, 'proposals'), { recursive: true });
  return dir;
}

function writeProposal(dir: string, name: string, body: string): void {
  fs.writeFileSync(hermit(dir, 'proposals', name), body);
}

const fm = (o: Record<string, string>) =>
  '---\n' + Object.entries(o).map(([k, v]) => `${k}: ${v}`).join('\n') + '\n---\n';

describe('rebuildIndex', () => {
  test('parses frontmatter proposals into rows with counts', () => {
    const dir = makeDir();
    writeProposal(dir, 'PROP-001-foo-120000.md',
      fm({ id: 'PROP-001-foo-120000', status: 'proposed', source: 'auto-detected', category: 'improvement', created: '2026-07-01T10:00:00Z', session: 'S-005' }) +
      '# Proposal: PROP-001 — Foo\n');
    writeProposal(dir, 'PROP-002-bar-130000.md',
      fm({ id: 'PROP-002-bar-130000', status: 'accepted', title: '"Bar direct"' }) +
      '# Proposal: PROP-002 — Bar heading\n');

    const idx = rebuildIndex(hermit(dir))!;
    expect(idx.count).toBe(2);
    expect(idx.counts).toEqual({ proposed: 1, accepted: 1 });

    const p1 = idx.proposals.find(p => p.id === 'PROP-001-foo-120000')!;
    expect(p1.status).toBe('proposed');
    expect(p1.source).toBe('auto-detected');
    expect(p1.title).toBe('Foo'); // from heading (no frontmatter title)
    expect(p1.legacy).toBe(false);

    const p2 = idx.proposals.find(p => p.id === 'PROP-002-bar-130000')!;
    expect(p2.title).toBe('Bar direct'); // frontmatter title wins over heading
  });

  test('parses legacy (no-frontmatter) proposals with legacy:true', () => {
    const dir = makeDir();
    writeProposal(dir, 'PROP-006.md',
      '# Proposal: PROP-006 — Legacy one\n\n**Status:** accepted\n**Created:** 2026-01-01\n');
    const idx = rebuildIndex(hermit(dir))!;
    const p = idx.proposals[0];
    expect(p.legacy).toBe(true);
    expect(p.id).toBe('PROP-006');
    expect(p.status).toBe('accepted');
    expect(p.source).toBe('manual'); // legacy default
    expect(p.title).toBe('Legacy one');
  });

  test('writes proposals-index.json and is idempotent on content', () => {
    const dir = makeDir();
    writeProposal(dir, 'PROP-001-a-120000.md', fm({ status: 'proposed' }) + '# Proposal: PROP-001 — A\n');
    rebuildIndex(hermit(dir));
    const p = hermit(dir, 'state', 'proposals-index.json');
    expect(fs.existsSync(p)).toBe(true);
    const parsed = JSON.parse(fs.readFileSync(p, 'utf8'));
    expect(parsed.count).toBe(1);
    expect(parsed.proposals[0].status).toBe('proposed');
  });

  test('returns null when there is no proposals dir', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hermit-noprop-'));
    fs.mkdirSync(hermit(dir, 'state'), { recursive: true });
    expect(rebuildIndex(hermit(dir))).toBe(null);
  });
});

describe('CLI verdict', () => {
  test('OK|<n> proposals with a proposals dir', async () => {
    const dir = makeDir();
    writeProposal(dir, 'PROP-001-a-120000.md', fm({ status: 'proposed' }) + '# Proposal: PROP-001 — A\n');
    const r = await runScript('proposals-index.ts', { args: ['.claude-code-hermit'], cwd: dir });
    expect(r.stdout.trim()).toBe('OK|1 proposals');
  });

  test('SKIP|no proposals dir when absent', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hermit-noprop-'));
    fs.mkdirSync(hermit(dir, 'state'), { recursive: true });
    const r = await runScript('proposals-index.ts', { args: ['.claude-code-hermit'], cwd: dir });
    expect(r.stdout.trim()).toBe('SKIP|no proposals dir');
  });
});

describe('generate-summary hook regenerates the index on a proposal write', () => {
  test('proposal-path payload builds the index', async () => {
    const dir = makeDir();
    writeProposal(dir, 'PROP-001-a-120000.md', fm({ status: 'proposed' }) + '# Proposal: PROP-001 — A\n');
    const payload = JSON.stringify({
      tool_name: 'Write',
      tool_input: { file_path: hermit(dir, 'proposals', 'PROP-001-a-120000.md') },
    });
    await runScript('generate-summary.ts', { stdin: payload });
    expect(fs.existsSync(hermit(dir, 'state', 'proposals-index.json'))).toBe(true);
  });

  test('non-proposal, non-state payload writes nothing', async () => {
    const dir = makeDir();
    const payload = JSON.stringify({ tool_name: 'Write', tool_input: { file_path: path.join(dir, 'src', 'x.ts') } });
    await runScript('generate-summary.ts', { stdin: payload });
    expect(fs.existsSync(hermit(dir, 'state', 'proposals-index.json'))).toBe(false);
  });
});
