// Unit tests for the lib modules extracted/added for scripts/proposal.ts:
// lib/prop-id.ts (ID assignment), lib/md-write.ts (transactional md helpers),
// and lib/time.ts's zonedISOStamp addition.

import { describe, test, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { computeBase, resolveSuffix, slugify, SUFFIX_LETTERS } from '../scripts/lib/prop-id';
import { zonedISOStamp } from '../scripts/lib/time';
import { serializeValue, appendToSection, patchFrontmatter } from '../scripts/lib/md-write';

describe('lib/prop-id: collision suffix', () => {
  // resolveSuffix takes a FIXED base (num/slug/hhmmss already computed) so the
  // suffix walk is tested in isolation from nextNumber's own NNN scan — any
  // pre-seeded collision file also matches that scan and would otherwise shift
  // `num` before the walk ever runs (nextPropId's own num recomputation).
  test('walks a -> b when both the unsuffixed and -a candidates already exist', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prop-id-'));
    const proposalsDir = path.join(dir, 'proposals');
    fs.mkdirSync(proposalsDir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ timezone: 'UTC' }));
    const now = new Date('2026-07-20T22:00:00Z');

    const base = computeBase(dir, 'Collision test', now);
    fs.writeFileSync(path.join(proposalsDir, `PROP-${base.num}-${base.slug}-${base.hhmmss}.md`), 'x');
    fs.writeFileSync(path.join(proposalsDir, `PROP-${base.num}-${base.slug}-${base.hhmmss}a.md`), 'x');

    const result = resolveSuffix(proposalsDir, base);
    expect(result?.suffix).toBe('b');
    expect(result?.id).toBe(`PROP-${base.num}-${base.slug}-${base.hhmmss}b`);

    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('exhausts the a-z suffix range and returns null', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prop-id-'));
    const proposalsDir = path.join(dir, 'proposals');
    fs.mkdirSync(proposalsDir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ timezone: 'UTC' }));
    const now = new Date('2026-07-20T22:00:00Z');

    const base = computeBase(dir, 'Exhaust test', now);
    fs.writeFileSync(path.join(proposalsDir, `PROP-${base.num}-${base.slug}-${base.hhmmss}.md`), 'x');
    for (const letter of SUFFIX_LETTERS) {
      fs.writeFileSync(path.join(proposalsDir, `PROP-${base.num}-${base.slug}-${base.hhmmss}${letter}.md`), 'x');
    }

    expect(resolveSuffix(proposalsDir, base)).toBeNull();

    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('slugify drops stopwords and truncates at a word boundary', () => {
    expect(slugify('Fix the thing for real')).toBe('fix-thing-real');
    expect(slugify('   ')).toBe('proposal');
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
