// WP7 tier 1: tests for src/markdown.ts — 1:1 port of tests/test_markdown.py
// (4 cases), plus pins for the two port-level semantics: insertion-order key
// preservation (sort_keys=False parity) and the sanctioned `created:`
// representation change (ISO string end-to-end, never a datetime/Date).

import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach } from 'bun:test';

import { dumpFrontmatter, loadFrontmatter, renderFrontmatter } from '../src/markdown';

const tmpDirs: string[] = [];

function tmpPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ha-markdown-test-'));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

test('roundtrip', () => {
  const path = join(tmpPath(), 'test.md');
  const metadata = { id: 'S-001', status: 'completed', cost_usd: 1.23 };
  const body = '# Session Report\n\nSome content here.';

  dumpFrontmatter(path, metadata, body);
  const [loadedMeta, loadedBody] = loadFrontmatter(path);

  expect(loadedMeta).toEqual(metadata);
  expect(loadedBody).toContain('# Session Report');
});

test('no frontmatter returns empty dict', () => {
  const path = join(tmpPath(), 'plain.md');
  writeFileSync(path, '# Just a plain file\n\nNo frontmatter.', 'utf8');

  const [meta, body] = loadFrontmatter(path);

  expect(meta).toEqual({});
  expect(body).toContain('plain file');
});

test('dump creates parent dirs', () => {
  const path = join(tmpPath(), 'nested', 'dir', 'file.md');
  dumpFrontmatter(path, { key: 'value' }, 'body');
  expect(existsSync(path)).toBe(true);
});

test('non-mapping frontmatter throws', () => {
  const path = join(tmpPath(), 'bad.md');
  writeFileSync(path, '---\n- list item\n---\nbody', 'utf8');

  expect(() => loadFrontmatter(path)).toThrow(/must parse to a mapping/);
});

// --- port-level pins (not in test_markdown.py) ---

test('frontmatter keys keep insertion order (sort_keys=False parity)', () => {
  const rendered = renderFrontmatter(
    { title: 'T', type: 'audit', created: '2026-06-11T08:30:00+00:00', session: null, tags: [] },
    'body',
  );
  const keyOrder = [...rendered.matchAll(/^(\w+):/gm)].map((m) => m[1]);
  expect(keyOrder).toEqual(['title', 'type', 'created', 'session', 'tags']);
});

test('created stays an ISO string end-to-end and re-dumps PyYAML-safe', () => {
  const dir = tmpPath();
  // Unquoted timestamp, as skills write it — PyYAML returned datetime here;
  // the port's sanctioned representation is the ISO string.
  const path = join(dir, 'artifact.md');
  writeFileSync(path, '---\ncreated: 2026-06-11T08:30:00+00:00\ntype: audit\n---\nbody\n', 'utf8');
  const [meta] = loadFrontmatter(path);
  expect(meta.created).toBe('2026-06-11T08:30:00+00:00');

  // Re-dump must quote it so PyYAML/HA also reads a string (no datetime).
  const rendered = renderFrontmatter(meta, 'body');
  expect(rendered).toContain('created: "2026-06-11T08:30:00+00:00"');

  const rewritten = join(dir, 'rewritten.md');
  dumpFrontmatter(rewritten, meta, 'body');
  const [again] = loadFrontmatter(rewritten);
  expect(again).toEqual(meta);
});
