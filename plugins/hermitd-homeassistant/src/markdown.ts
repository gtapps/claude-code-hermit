// WP7 tier 1 port of src/ha_agent_lab/markdown.py — frontmatter load/dump.
//
// Representation changes vs the Python original (both sanctioned by the WP7
// spike, see tests/yaml-parity.test.ts):
//
// 1. `created:` (and any other unquoted ISO timestamp in frontmatter) now
//    loads as the ISO STRING, not a datetime object — the one sanctioned
//    representation change of the port. Audit of every consumer of the parsed
//    `created` field: no Python module reads it (artifacts.py only WRITES it,
//    already as an isoformat string that PyYAML quotes on dump); the core
//    plugin's TS consumers (archive-raw.ts, archive-compiled.ts,
//    knowledge-lint.ts) all do `new Date(fm.created)` on the string form.
//    dumpYaml re-quotes timestamp-shaped strings, so a PyYAML re-reader of
//    our output also sees a string. ISO strings with a fixed field layout
//    compare lexicographically in chronological order, so string comparisons
//    remain sound.
//
// 2. Python dumped with allow_unicode=False (non-ASCII escaped, e.g.
//    "caf\xE9"); dumpYaml emits raw UTF-8. The parsed content is identical
//    either way — only the file bytes differ.
//
// sort_keys=False ordering semantics are preserved: Bun.YAML.stringify emits
// keys in object insertion order (verified in tests/markdown.test.ts).

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { dumpYaml, parseYaml } from './yaml';

export type Frontmatter = Record<string, unknown>;

export function loadFrontmatter(path: string): [Frontmatter, string] {
  const text = readFileSync(path, 'utf8');
  if (!text.startsWith('---\n')) return [{}, text];

  const close = text.indexOf('\n---\n');
  if (close === -1) return [{}, text];

  const metadataText = text.slice(4, close); // '' when the frontmatter block is empty
  const body = text.slice(close + 5);
  const metadata = parseYaml(metadataText) ?? {};
  if (typeof metadata !== 'object' || Array.isArray(metadata)) {
    throw new Error(`Frontmatter in ${path} must parse to a mapping.`);
  }
  return [metadata as Frontmatter, body];
}

export function renderFrontmatter(metadata: Frontmatter, body: string): string {
  const serialized = dumpYaml(metadata).trim();
  return `---\n${serialized}\n---\n${body.trimEnd()}\n`;
}

export function dumpFrontmatter(path: string, metadata: Frontmatter, body: string): void {
  const text = renderFrontmatter(metadata, body);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text, 'utf8');
}
