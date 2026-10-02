// Unit tests for the lib modules extracted/added for scripts/proposal.ts:
// lib/prop-id.ts (ID assignment), lib/md-write.ts (transactional md helpers),
// and lib/time.ts's zonedISOStamp addition.

import { describe, test, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { computeBase, nextNumber, slugify } from '../scripts/lib/prop-id';
import { zonedISOStamp } from '../scripts/lib/time';
import { serializeValue, appendToSection, patchFrontmatter } from '../scripts/lib/md-write';

// Slug and number behavior formerly exercised through the next-prop-id.ts CLI.
// That wrapper is gone; proposal.ts's create verb reaches the same code through
// computeBase, so the cases live here as direct unit tests.
describe('lib/prop-id: slugify', () => {
  test('drops stopwords and truncates at a word boundary', () => {
    expect(slugify('Fix the thing for real')).toBe('fix-thing-real');
    expect(slugify('   ')).toBe('proposal');
  });

  test('a stopword-only title falls back to the pre-filter tokens', () => {
    expect(slugify('the a of and')).toBe('the-a-of-and');
  });

  test('an all-punctuation title falls back to the literal "proposal"', () => {
    expect(slugify('!!!???...')).toBe('proposal');
  });

  test('a single token longer than 40 chars is hard-cut to 40', () => {
    const slug = slugify('supercalifragilisticexpialidocioussupercalifragilisticexpialidocious');
    expect(slug.length).toBe(40);
  });

  test('an apostrophe becomes a separator, never a double dash', () => {
    expect(slugify("bob's widget")).toBe('bob-s-widget');
  });
});

describe('lib/prop-id: nextNumber', () => {
  function withProposals(files: string[], fn: (proposalsDir: string) => void) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prop-id-'));
    const proposalsDir = path.join(dir, 'proposals');
    fs.mkdirSync(proposalsDir, { recursive: true });
    for (const f of files) fs.writeFileSync(path.join(proposalsDir, f), 'x');
    try { fn(proposalsDir); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  }

  test('starts at 001 on an empty proposals dir', () => {
    withProposals([], (d) => expect(nextNumber(d)).toBe('001'));
  });

  test('is max + 1, zero-padded', () => {
    withProposals(['PROP-005-foo-100000.md', 'PROP-006-bar-110000.md'], (d) => {
      expect(nextNumber(d)).toBe('007');
    });
  });

  test('a missing proposals dir reads as empty', () => {
    expect(nextNumber(path.join(os.tmpdir(), 'prop-id-does-not-exist'))).toBe('001');
  });
});

describe('lib/prop-id: computeBase', () => {
  test('combines number, slug, and zoned HHMMSS from one instant', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prop-id-'));
    fs.mkdirSync(path.join(dir, 'proposals'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ timezone: 'UTC' }));

    const base = computeBase(dir, 'First Proposal Ever', new Date('2026-07-20T22:00:00Z'));
    expect(base).toEqual({ num: '001', slug: 'first-proposal-ever', hhmmss: '220000' });

    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('lib/time: zonedISOStamp', () => {
  const fixed = new Date('2026-07-20T21:12:08.000Z'); // UTC instant

  test('London offset (BST, +01:00 in July)', () => {
    expect(zonedISOStamp('Europe/London', fixed)).toBe('2026-07-20T22:12:08+01:00');
  });

  test('UTC: bare GMT maps to +00:00', () => {
    expect(zonedISOStamp('UTC', fixed)).toBe('2026-07-20T21:12:08+00:00');
  });

  test('invalid timezone falls back to UTC +00:00', () => {
    expect(zonedISOStamp('Not/AZone', fixed)).toBe('2026-07-20T21:12:08+00:00');
  });
});

describe('lib/md-write: serializeValue', () => {
  test('array of scalars serializes as JSON flow form', () => {
    expect(serializeValue(['a', 'b'])).toBe('["a","b"]');
    expect(serializeValue([])).toBe('[]');
  });

  test('scalars unchanged from prior behavior', () => {
    expect(serializeValue(null)).toBe('null');
    expect(serializeValue(true)).toBe('true');
    expect(serializeValue(42)).toBe('42');
    expect(serializeValue('bare-value')).toBe('bare-value');
    expect(serializeValue('has spaces')).toBe('"has spaces"');
  });
});

describe('lib/md-write: appendToSection', () => {
  test('appends before the next heading (mid-file section)', () => {
    const content = '## Findings\n<!-- none -->\n\n## Changed\n<!-- auto -->\n';
    const result = appendToSection(content, 'Findings', '- a finding');
    expect(result).toContain('## Findings\n<!-- none -->\n- a finding\n\n## Changed');
  });

  test('appends at EOF when the heading is the last section', () => {
    const content = '## Operator Decision\n';
    const result = appendToSection(content, 'Operator Decision', 'Accepted.');
    expect(result).toBe('## Operator Decision\nAccepted.\n');
  });

  test('throws when the heading is missing', () => {
    expect(() => appendToSection('## Other\nx\n', 'Findings', 'x')).toThrow(/no ## Findings section/);
  });
});

describe('lib/md-write: patchFrontmatter (regression, extraction sanity check)', () => {
  test('replaces an existing key and preserves the rest', () => {
    const content = '---\nid: X\nstatus: proposed\n---\nbody\n';
    const out = patchFrontmatter(content, { status: 'accepted' });
    expect(out).toBe('---\nid: X\nstatus: accepted\n---\nbody\n');
  });
});
