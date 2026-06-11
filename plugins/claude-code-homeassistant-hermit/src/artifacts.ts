// WP7 tier 2 port of src/ha_agent_lab/artifacts.py — artifact writers shared
// by history.ts and audits.ts. artifacts.py has no dedicated pytest file; its
// behavior is exercised through the history/audits suites.
//
// Byte-level divergences from Python (parsed content identical):
//   - json.dumps(ensure_ascii=True) escaped non-ASCII; JSON.stringify emits
//     raw UTF-8.
//   - `created` is emitted via toISOString() (ms + "Z") instead of Python's
//     microseconds + "+00:00" isoformat. All consumers do `new Date(created)`
//     (see src/markdown.ts header audit), and dumpYaml re-quotes
//     timestamp-shaped strings so PyYAML re-readers still see a string.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { renderFrontmatter, type Frontmatter } from './markdown';

/** strftime("%Y%m%dT%H%M%SZ") on the current UTC time. */
export function utcTimestamp(): string {
  return new Date().toISOString().slice(0, 19).replaceAll('-', '').replaceAll(':', '') + 'Z';
}

export function slugify(value: string): string {
  // Python: ch.isalnum() or ch in {"-", "_"} else "_", then .strip("_").
  let out = '';
  for (const ch of value) {
    out += /[\p{L}\p{N}\-_]/u.test(ch) ? ch : '_';
  }
  return out.replace(/^_+|_+$/g, '');
}

export function currentSessionId(root: string): string | null {
  const runtime = join(root, '.claude-code-hermit', 'state', 'runtime.json');
  try {
    const sessionId = JSON.parse(readFileSync(runtime, 'utf8'))?.session_id;
    return sessionId === undefined ? null : sessionId;
  } catch {
    return null;
  }
}

/** Build v1.0.17-compliant frontmatter with canonical field ordering. */
export function standardMetadata(
  type: string,
  title: string,
  options: {
    session?: string | null;
    tags?: string[] | null;
    extra?: Record<string, unknown> | null;
  } = {},
): Frontmatter {
  const meta: Frontmatter = {
    title,
    type,
    created: new Date().toISOString(),
    session: options.session ?? null,
    tags: options.tags || [],
  };
  if (options.extra) Object.assign(meta, options.extra);
  return meta;
}

function artifactName(kind: string, ext: string, directory: string): string {
  const now = new Date().toISOString(); // strftime on UTC now
  const today = now.slice(0, 10);
  let name = `${kind}-${today}.${ext}`;
  if (existsSync(join(directory, name))) {
    name = `${kind}-${today}-${now.slice(11, 19).replaceAll(':', '')}.${ext}`;
  }
  return name;
}

// json.dumps(sort_keys=True) parity: recursive key sort (code-point order).
function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, sortKeysDeep((value as Record<string, unknown>)[key])]),
    );
  }
  return value;
}

export function writeJsonArtifact(
  root: string,
  relativeDir: string,
  kind: string,
  payload: Record<string, unknown> | unknown[],
  latestName: string | null = null,
): string {
  const directory = join(root, relativeDir);
  mkdirSync(directory, { recursive: true });
  const path = join(directory, artifactName(kind, 'json', directory));
  const serialized = JSON.stringify(sortKeysDeep(payload), null, 2) + '\n';
  writeFileSync(path, serialized, 'utf8');
  if (latestName) writeFileSync(join(directory, latestName), serialized, 'utf8');
  return path;
}

export function writeMarkdownArtifact(
  root: string,
  relativeDir: string,
  kind: string,
  metadata: Frontmatter,
  body: string,
  latestName: string | null = null,
): string {
  const directory = join(root, relativeDir);
  mkdirSync(directory, { recursive: true });
  const path = join(directory, artifactName(kind, 'md', directory));
  const text = renderFrontmatter(metadata, body);
  writeFileSync(path, text, 'utf8');
  if (latestName) writeFileSync(join(directory, latestName), text, 'utf8');
  return path;
}
