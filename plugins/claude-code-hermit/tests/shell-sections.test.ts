// Tests for the `## <heading>` section grammar in lib/md-write.ts — the single
// parser every SHELL.md reader and writer goes through. Pure functions, so
// in-process import is safe (no load-time path resolution).
//
// The anchoring cases are the point: before consolidation, six sites located
// sections with `indexOf('## Task')` or an unanchored `/## Task\n/`, and
// `'### Task'.indexOf('## Task') === 1` — a `### Task` sub-heading anywhere
// above the real section hijacked the read, including session-start injection.

import { describe, test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { runScript } from './helpers/run';
import { setupWorkdir } from './helpers/workdir';
import {
  findSection,
  extractSection,
  stripPlaceholders,
  firstContentLine,
  replaceSectionInPlace,
  appendToSection,
} from '../scripts/lib/md-write';

const SHELL = [
  '# Active Session',
  '',
  '## Session Info',
  '- **ID:** S-001',
  '',
  '## Task',
  'Real task body',
  '',
  '## Progress Log',
  '[09:00] Did a thing',
  '[10:30] Did another',
  '',
  '## Blockers',
  '<!-- What is preventing progress? -->',
  '',
  '## Session Summary',
  'Wrapped up.',
  '',
].join('\n');

describe('extractSection anchoring', () => {
  test('a ### sub-heading above the real section does not hijack the read', () => {
    const md = '## Progress Log\n[09:00] ### Task decoy in a log line\n\n## Task\nReal task body\n';
    expect(extractSection(md, 'Task')?.trim()).toBe('Real task body');
  });

  test('a ### heading with the same name is not the section', () => {
    const md = '# Doc\n\n### Task\nSub-heading body\n\n## Task\nReal task body\n';
    expect(extractSection(md, 'Task')?.trim()).toBe('Real task body');
  });

  test('a longer heading is not a prefix match', () => {
    const md = '## Tasks Completed\nnot this\n\n## Task\nReal task body\n';
    expect(extractSection(md, 'Task')?.trim()).toBe('Real task body');
  });

  test('heading with trailing text does not match', () => {
    expect(extractSection('## Task now\nbody\n', 'Task')).toBeNull();
  });

  test('trailing spaces and tabs on the heading still match', () => {
    expect(extractSection('## Task  \nbody\n', 'Task')?.trim()).toBe('body');
    expect(extractSection('## Task\t\nbody\n', 'Task')?.trim()).toBe('body');
  });

  test('absent heading returns null', () => {
    expect(extractSection(SHELL, 'Nonexistent')).toBeNull();
  });
});

describe('extractSection boundaries', () => {
  test('body stops at the next ## heading and excludes the heading line', () => {
    expect(extractSection(SHELL, 'Task')).toBe('Real task body\n');
  });

  test('multi-line body is returned verbatim', () => {
    expect(extractSection(SHELL, 'Progress Log')).toBe('[09:00] Did a thing\n[10:30] Did another\n');
  });

  test('last section runs to EOF', () => {
    expect(extractSection(SHELL, 'Session Summary')).toBe('Wrapped up.\n');
  });

  test('last section without a trailing newline still terminates', () => {
    expect(extractSection('## Task\nbody', 'Task')).toBe('body');
  });

  test('empty section body is empty, not the rest of the document', () => {
    expect(extractSection('## Task\n\n## Blockers\nb\n', 'Task')).toBe('');
  });

  test('heading at EOF with no body returns empty', () => {
    expect(extractSection('# Doc\n\n## Task', 'Task')).toBe('');
  });

  test('### sub-headings inside the body do not truncate it', () => {
    const md = '## Task\nline one\n### detail\nline two\n\n## Blockers\nb\n';
    expect(extractSection(md, 'Task')).toBe('line one\n### detail\nline two\n');
  });
});

describe('operator-owned content passes through', () => {
  test('an operator-added custom section is readable', () => {
    const md = SHELL + '\n## Operator Notes\nhand-written\n';
    expect(extractSection(md, 'Operator Notes')?.trim()).toBe('hand-written');
  });

  test('replacing one section leaves every other byte untouched', () => {
    const md = SHELL + '\n## Operator Notes\nhand-written\n';
    const out = replaceSectionInPlace(md, 'Task', '\nNew task\n\n');
    expect(out).toContain('## Operator Notes\nhand-written\n');
    expect(out).toContain('[09:00] Did a thing');
    // The trailing blank line in newBody is preserved — it is what keeps the
    // replaced section from gluing onto the next heading.
    expect(extractSection(out, 'Task')).toBe('New task\n\n');
  });

  test('appending to one section leaves an operator section untouched', () => {
    const md = SHELL + '\n## Operator Notes\nhand-written\n';
    const out = appendToSection(md, 'Progress Log', '[11:00] Appended');
    expect(out).toContain('## Operator Notes\nhand-written\n');
    expect(extractSection(out, 'Progress Log')).toContain('[11:00] Appended');
    expect(extractSection(out, 'Blockers')).toBe(extractSection(md, 'Blockers'));
  });
});

describe('stripPlaceholders', () => {
  test('drops a whole-line placeholder comment', () => {
    expect(stripPlaceholders('<!-- What is preventing progress? -->\n')).toBe('');
  });

  test('drops a multi-line placeholder comment', () => {
    expect(stripPlaceholders('<!-- line one\nline two -->\n')).toBe('');
  });

  test('drops an inline comment and keeps the surrounding text', () => {
    expect(stripPlaceholders('Ship it <!-- note --> today')).toBe('Ship it  today');
  });

  test('keeps real content sitting below a retained placeholder', () => {
    expect(stripPlaceholders('<!-- placeholder -->\nA real finding')).toBe('A real finding');
  });

  test('a placeholder-only Blockers section reads as empty', () => {
    expect(stripPlaceholders(extractSection(SHELL, 'Blockers')!)).toBe('');
  });
});

describe('firstContentLine', () => {
  test('skips blanks and placeholders', () => {
    expect(firstContentLine('\n<!-- hint -->\n  Real line  \nsecond\n')).toBe('Real line');
  });

  test('clips to maxLen', () => {
    expect(firstContentLine('abcdef\n', 3)).toBe('abc');
  });

  test('placeholder-only section yields empty string', () => {
    expect(firstContentLine('<!-- Awaiting next task -->\n')).toBe('');
  });
});

describe('replaceSectionInPlace', () => {
  test('replaces a middle section without touching its neighbours', () => {
    const out = replaceSectionInPlace(SHELL, 'Progress Log', '\n[12:00] Only entry\n\n');
    expect(extractSection(out, 'Progress Log')).toBe('[12:00] Only entry\n\n');
    expect(extractSection(out, 'Task')).toBe('Real task body\n');
    expect(extractSection(out, 'Blockers')).toBe(extractSection(SHELL, 'Blockers'));
  });

  test('replaces the last section at EOF', () => {
    const out = replaceSectionInPlace(SHELL, 'Session Summary', '\nNew summary\n');
    expect(extractSection(out, 'Session Summary')).toBe('New summary\n');
  });

  test('absent heading leaves content unchanged', () => {
    expect(replaceSectionInPlace(SHELL, 'Nonexistent', '\nx\n')).toBe(SHELL);
  });

  test('does not target a ### sub-heading of the same name', () => {
    const md = '### Task\nsub body\n\n## Task\nreal body\n';
    const out = replaceSectionInPlace(md, 'Task', '\nreplaced\n');
    expect(out).toContain('### Task\nsub body');
    expect(extractSection(out, 'Task')).toBe('replaced\n');
  });
});

// End-to-end on the surface that matters most: session-start injection. A model
// writing a `### Blockers` sub-heading inside the Task body used to make the
// injected "## Blockers" carry that sub-heading's text instead of the real one.
describe('startup-context injection is not hijackable by a ### sub-heading', () => {
  test('injects the real ## Blockers body, not the decoy above it', async () => {
    const wd = setupWorkdir();
    try {
      fs.writeFileSync(path.join(wd.dir, '.claude-code-hermit', 'sessions', 'SHELL.md'), [
        '# Active Session',
        '',
        '## Session Info',
        '- **ID:** S-001',
        '',
        '## Task',
        'Ship the parser consolidation.',
        '### Blockers',
        'DECOY-BLOCKER from a task sub-heading',
        '',
        '## Progress Log',
        '[09:00] Started',
        '',
        '## Blockers',
        'REAL-BLOCKER waiting on review',
        '',
        '## Session Summary',
        '',
      ].join('\n'));

      const res = await runScript('startup-context.ts', {
        stdin: '{}',
        env: { AGENT_DIR: path.join(wd.dir, '.claude-code-hermit'), HERMIT_RESIDENT: '1' },
      });

      // Anchored: the decoy legitimately appears inside the injected Task body,
      // and `'### Blockers'` ends with the substring `'## Blockers'` — the very
      // trap this consolidation removes. Only the emitted `## Blockers` heading
      // (at a line start) is under test.
      expect(res.stdout).toMatch(/^## Blockers\nREAL-BLOCKER waiting on review$/m);
      expect(res.stdout).not.toMatch(/^## Blockers\nDECOY-BLOCKER/m);
    } finally {
      wd.cleanup();
    }
  });
});

// Content under a retained placeholder is the steady state after any idle
// reset, not an edge case — see stripPlaceholders' doc comment in md-write.ts.
describe('startup-context sees content below a retained placeholder', () => {
  test('injects Task and Progress Log content written under the template comments', async () => {
    const wd = setupWorkdir();
    try {
      fs.writeFileSync(path.join(wd.dir, '.claude-code-hermit', 'sessions', 'SHELL.md'), [
        '# Active Session',
        '',
        '## Session Info',
        '- **ID:** S-001',
        '',
        '## Task',
        '<!-- Awaiting next task -->',
        'REAL-TASK ship the thing',
        '',
        '## Progress Log',
        '<!-- Primary record of work -->',
        '<!-- Format: [HH:MM] Did X — result/outcome -->',
        '[09:00] REAL-ENTRY started',
        '',
        '## Blockers',
        '',
        '## Session Summary',
        '',
      ].join('\n'));

      const res = await runScript('startup-context.ts', {
        stdin: '{}',
        env: { AGENT_DIR: path.join(wd.dir, '.claude-code-hermit'), HERMIT_RESIDENT: '1' },
      });

      expect(res.stdout).toContain('REAL-TASK ship the thing');
      expect(res.stdout).toContain('[09:00] REAL-ENTRY started');
      expect(res.stdout).not.toContain('Awaiting next task');
      expect(res.stdout).not.toContain('has no actionable content');
    } finally {
      wd.cleanup();
    }
  });
});

describe('findSection escapes the heading', () => {
  test('a metacharacter in the heading is matched literally', () => {
    expect(extractSection('## Notes (2026)\nbody\n', 'Notes (2026)')?.trim()).toBe('body');
    expect(extractSection('## Notes 2026\nbody\n', 'Notes (2026)')).toBeNull();
    expect(extractSection('## AxB\nbody\n', 'A.B')).toBeNull();
  });
});

describe('findSection agrees with extractSection', () => {
  test('the located span, minus its leading newline, is the extracted body', () => {
    for (const heading of ['Session Info', 'Task', 'Progress Log', 'Blockers', 'Session Summary']) {
      const s = findSection(SHELL, heading)!;
      expect(SHELL.slice(s.start, s.end).replace(/^\n/, '')).toBe(extractSection(SHELL, heading)!);
    }
  });
});
