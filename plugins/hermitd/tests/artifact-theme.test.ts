// Invariants for the shared Artifact stylesheet. These are the rules from Claude
// Code's `artifact-design` skill that can be checked mechanically — the sync
// mechanism for a prose skill that offers nothing importable. When that skill
// gains a checkable rule, add an assertion here rather than trusting a re-read.
//
// The regressions these pin are real, not hypothetical: the sheet this module
// replaced painted no background on `body` (so the page borrowed the viewer's
// ground outside its centred column) and declared only 6 of its 19 tokens in the
// two [data-theme] blocks (so an explicit theme choice left chip colours
// resolved from the other theme).

import { describe, test, expect } from 'bun:test';
import { PALETTE, CSS, chipHtml, railRow, pills } from '../scripts/lib/artifact-theme';

const TOKENS = Object.keys(PALETTE.light);

/** The four blocks that must each carry the full token set. */
const THEME_BLOCK_SELECTORS = [
  ':root {',
  ':root:not([data-theme="light"]) {',
  ':root[data-theme="dark"] {',
  ':root[data-theme="light"] {',
];

function blockBody(selector: string): string {
  const start = CSS.indexOf(selector);
  expect(start).toBeGreaterThan(-1);
  const open = start + selector.length;
  const end = CSS.indexOf('}', open);
  return CSS.slice(open, end);
}

describe('palette', () => {
  test('both themes declare identical token sets', () => {
    expect(Object.keys(PALETTE.dark).sort()).toEqual(TOKENS.slice().sort());
  });

  test('every token resolves to a literal colour, not another var()', () => {
    for (const theme of [PALETTE.light, PALETTE.dark]) {
      for (const [name, value] of Object.entries(theme)) {
        expect(value, `${name} must be a hex literal`).toMatch(/^#[0-9a-f]{3,8}$/i);
      }
    }
  });
});

describe('theme blocks', () => {
  // The bug this replaces: [data-theme] blocks that redefine only part of the
  // set leave the rest resolved from whichever earlier block won, so a viewer
  // who picks a theme gets half of each.
  for (const selector of THEME_BLOCK_SELECTORS) {
    test(`${selector} declares all ${TOKENS.length} tokens`, () => {
      const body = blockBody(selector);
      const missing = TOKENS.filter(t => !body.includes(`--${t}:`));
      expect(missing).toEqual([]);
    });
  }

  test('the dark media query is guarded so an explicit light choice wins', () => {
    expect(CSS).toContain('@media (prefers-color-scheme: dark) { :root:not([data-theme="light"])');
  });

  test('both explicit-theme blocks exist, so the toggle wins in both directions', () => {
    expect(CSS).toContain(':root[data-theme="dark"]');
    expect(CSS).toContain(':root[data-theme="light"]');
  });
});

describe('page-level rules', () => {
  test('body paints its own background from a token', () => {
    // Without this the artifact composites over the host's ground and the page
    // renders one theme's text on the other theme's background.
    expect(CSS).toMatch(/body\s*\{[^}]*background:\s*var\(--bg\)/);
  });

  test('digits that line up in columns use tabular figures', () => {
    expect(CSS).toContain('tabular-nums');
  });

  test('wide content can scroll inside its own container', () => {
    // Every rendered section is a `.card`, and its body can be model-authored
    // markdown — without this the page itself scrolls horizontally.
    expect(CSS).toMatch(/\.card\s*\{[^}]*overflow-x:\s*auto/);
    expect(CSS).toMatch(/pre\s*\{[^}]*overflow-x:\s*auto/);
  });

  test('reduced-motion is respected', () => {
    expect(CSS).toContain('prefers-reduced-motion');
  });
});

describe('CSP and token discipline', () => {
  test('no external references — a published artifact blocks every other host', () => {
    expect(CSS).not.toMatch(/https?:\/\//);
    expect(CSS).not.toMatch(/url\(/);
    expect(CSS).not.toMatch(/@import/);
  });

  test('colours are only ever declared in the generated theme blocks', () => {
    // Every hex literal in the sheet must come from a `--token:` declaration.
    // A raw hex on a component rule is the failure mode that makes one theme
    // unreadable, and it is invisible until someone opens the other theme.
    const stray = CSS.split('\n')
      .filter(line => /#[0-9a-f]{3,8}\b/i.test(line))
      .filter(line => !/--[a-z-]+:\s*#/i.test(line));
    expect(stray).toEqual([]);
  });
});

describe('markup helpers', () => {
  test('known statuses map to their own chip class, unknown ones fall back', () => {
    expect(chipHtml('proposed', 'proposed')).toContain('chip-proposed');
    expect(chipHtml('resolved', 'resolved')).toContain('chip-resolved');
    expect(chipHtml('banana', 'banana')).toContain('chip-unknown');
  });

  test('every chip class the helper can emit is styled', () => {
    for (const status of ['proposed', 'accepted', 'resolved', 'dismissed', 'deferred', 'unknown']) {
      expect(CSS).toContain(`.chip-${status} {`);
    }
  });

  test('railRow emits a tone class that the sheet styles', () => {
    const html = railRow({ tone: 'warn', title: 'Something needs you' });
    expect(html).toContain('rail rail-warn');
    expect(CSS).toContain('.rail-warn {');
  });

  test('railRow omits the meta line rather than emitting an empty one', () => {
    expect(railRow({ tone: 'mute', title: 'x' })).not.toContain('rail-meta');
    expect(railRow({ tone: 'mute', title: 'x', meta: ['a', 'b'] })).toContain('rail-meta');
  });

  test('pills collapse to nothing when empty', () => {
    expect(pills([])).toBe('');
  });
});
