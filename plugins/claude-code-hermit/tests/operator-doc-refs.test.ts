// Operator-facing surfaces must not name a plugin-root doc by a bare path.
//
// CLAUDE-APPEND blocks are cat'd verbatim into a downstream operator's
// CLAUDE.md, and SessionStart injections are emitted into operator context —
// both read from the operator's project cwd, where a bare `docs/foo.md`
// resolves to `<operator-project>/docs/foo.md` and does not exist (the docs
// live only under the plugin root). This guard fails on any such bare ref so
// the class of bug can't creep back in. Allowed forms all resolve:
//   ${CLAUDE_PLUGIN_ROOT}/docs/...   (skill-execution context, installed mode)
//   https://.../docs/...             (absolute URL)
//   ../../docs/...                    (markdown relative link)
//
// Usage: bun test tests/operator-doc-refs.test.ts   (from the plugin root)

import { describe, test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';

import { PLUGIN_ROOT, MONOREPO_ROOT } from './helpers/run';

// A bare doc ref: `docs/<name>.md` NOT preceded by `/` (URL or ${...}/docs or
// ../docs), `.` (relative), a word char, `:`, or `}`. The name class allows
// upper/lower/digits/-/_ so uppercase doc names (docs/GIT-SAFETY.md) are caught
// too. Global so we can report every hit, not just the first.
const BARE_DOCS = /(?<![./\w:}])docs\/[A-Za-z0-9_-]+\.md/g;

function bareRefs(text: string): string[] {
  return [...text.matchAll(BARE_DOCS)].map(m => m[0]);
}

// Walk plugins/*/state-templates for *.md and *.template — the surfaces cat'd
// or rendered into the operator's project (CLAUDE.md blocks, docker compose).
// Siblings are guaranteed present in the monorepo.
function stateTemplateSurfaces(): string[] {
  const out: string[] = [];
  const pluginsDir = path.join(MONOREPO_ROOT, 'plugins');
  for (const plugin of fs.readdirSync(pluginsDir)) {
    const root = path.join(pluginsDir, plugin, 'state-templates');
    if (!fs.existsSync(root)) continue;
    const stack = [root];
    while (stack.length) {
      const dir = stack.pop()!;
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) stack.push(full);
        else if (entry.name.endsWith('.md') || entry.name.endsWith('.template')) out.push(full);
      }
    }
  }
  return out;
}

describe('operator surfaces have no bare docs/ refs', () => {
  for (const file of stateTemplateSurfaces()) {
    const rel = path.relative(MONOREPO_ROOT, file);
    test(rel, () => {
      const hits = bareRefs(fs.readFileSync(file, 'utf8'));
      expect(hits).toEqual([]);
    });
  }

  // Scripts that print doc pointers to the operator's terminal from their
  // project cwd, where a bare `docs/foo.md` dangles. Listed explicitly (not a
  // blanket scripts/ walk) so code-comment refs in helper libs don't trip the
  // guard — only strings the operator actually sees are in scope.
  for (const script of ['startup-context.ts', 'hermit-start.ts']) {
    test(`scripts/${script} emits no bare docs/ ref`, () => {
      const src = fs.readFileSync(path.join(PLUGIN_ROOT, 'scripts', script), 'utf8');
      expect(bareRefs(src)).toEqual([]);
    });
  }
});
