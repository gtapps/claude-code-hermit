// Shared helpers for reading YAML frontmatter from markdown files
// and listing files by pattern. Zero npm dependencies.

import fs from 'node:fs';
import path from 'node:path';

type Json = any;

/**
 * Parse YAML frontmatter from an already-read markdown string.
 * Returns { fm, end } where fm is key-value pairs (or null) and end is the
 * offset of the closing --- delimiter (-1 if no valid frontmatter found).
 * Arrays like [a, b, c] are parsed; null is preserved; inline comments stripped.
 */
// Split a `[...]` flow-array's inner content on top-level commas only — items
// quoted with " " (e.g. prose lines in session-report blockers/lessons/artifacts
// arrays) may themselves contain commas, which must not split the item.
function splitFlowArray(inner: string): string[] {
  const items: string[] = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i];
    if (c === '"' && inner[i - 1] !== '\\') inQuotes = !inQuotes;
    if (c === ',' && !inQuotes) {
      items.push(cur.trim());
      cur = '';
    } else {
      cur += c;
    }
  }
  if (cur.trim()) items.push(cur.trim());
  return items;
}

function _parseFrontmatterWithEnd(content: string): { fm: Json | null; end: number } {
  if (!content.startsWith('---')) return { fm: null, end: -1 };
  const end = content.indexOf('\n---', 3);
  if (end === -1) return { fm: null, end: -1 };
  const yaml = content.slice(4, end);
  const result: Record<string, any> = {};
  for (const line of yaml.split('\n')) {
    const m = line.match(/^(\w[\w_]*)\s*:\s*(.*)/);
    if (!m) continue;
    const key = m[1];
    let val = m[2].trim();
    if (val.startsWith('[') && val.endsWith(']')) {
      const inner = val.slice(1, -1).trim();
      result[key] = inner ? splitFlowArray(inner).map(s => s.replace(/^["']|["']$/g, '')) : [];
    } else if (val === 'null') {
      result[key] = null;
    } else {
      // A fully-quoted scalar may legitimately contain '#' (e.g. next_start
      // referencing "#591") — strip an inline comment only from an unquoted
      // value, matching YAML's rule that '#' inside quotes is literal.
      const quoted = val.match(/^"(.*)"$/) || val.match(/^'(.*)'$/);
      result[key] = quoted ? quoted[1] : val.replace(/\s+#.*$/, '').replace(/^["']|["']$/g, '');
    }
  }
  return { fm: result, end };
}

/**
 * Parse YAML frontmatter from an already-read markdown string.
 * Returns an object of key-value pairs, or null if no frontmatter found.
 * Arrays like [a, b, c] are parsed; null is preserved; inline comments stripped.
 */
function parseFrontmatter(content: string): Json | null {
  return _parseFrontmatterWithEnd(content).fm;
}

/**
 * Parse YAML frontmatter from a markdown file.
 * Returns an object of key-value pairs, or null if no frontmatter found.
 */
function readFrontmatter(filePath: string): Json | null {
  try {
    return parseFrontmatter(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Read a file and return both its frontmatter and body in one pass.
 * Body is the text after the closing --- delimiter, trimmed.
 * Returns { fm, body, content } or null on error.
 * fm may be null if no frontmatter; body is always the post-header text.
 */
function readFileWithFrontmatter(filePath: string): { fm: Json | null; body: string; content: string } | null {
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    const { fm, end } = _parseFrontmatterWithEnd(content);
    const body = end !== -1 ? content.slice(end + 4).trimStart() : content;
    return { fm, body, content };
  } catch {
    return null;
  }
}

/**
 * Returns true when a session-report frontmatter represents an empty auto-archive:
 * `closed_via: auto` AND `operator_turns: 0`. These reports come from the
 * 12h-inactivity AUTO_CLOSE path on quiet sessions and carry no operator content;
 * the daily-lull AUTO_CLOSE path carries operator_turns > 0 and is NOT empty.
 *
 * Used by reflect-precheck (excluded from compute-phase mtime trigger) and
 * weekly-review (excluded from the autonomy-rate denominator). Null frontmatter
 * returns false (an unreadable report is never excluded from evidence); a missing
 * or non-numeric operator_turns is read as 0, matching the inline behavior both
 * call sites had before extraction. Post-KAIROS the predicate becomes moot —
 * reflect and weekly-review will read KAIROS daily logs instead of S-NNN-REPORT.md
 * archives.
 */
function isEmptyAutoArchive(fm: Json): boolean {
  if (!fm) return false;
  const ops = parseInt(fm.operator_turns, 10) || 0;
  return fm.closed_via === 'auto' && ops === 0;
}

/**
 * Given an array of artifacts with { fm } (each having fm.type and fm.created),
 * return a Map<type, artifact> keeping only the newest artifact per type.
 * Artifacts without fm or fm.created are skipped.
 */
function newestByType(artifacts: Json[]): Map<string, Json> {
  const byType = new Map<string, Json>();
  for (const a of artifacts) {
    if (!a.fm || !a.fm.created) continue;
    const type = a.fm.type || '_untyped';
    const existing = byType.get(type);
    if (!existing || a.fm.created > existing.fm.created) {
      byType.set(type, a);
    }
  }
  return byType;
}

/**
 * List files in a directory matching a regex pattern.
 * Returns full paths sorted by name.
 */
function globDir(dir: string, pattern: RegExp): string[] {
  try {
    return fs.readdirSync(dir)
      .filter(f => pattern.test(f))
      .map(f => path.join(dir, f))
      .sort();
  } catch {
    return [];
  }
}

/**
 * Recursively list all .md files in a directory.
 * Returns full paths sorted by name.
 */
function globDirRecursive(dir: string): string[] {
  const results: string[] = [];
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        results.push(...globDirRecursive(full));
      } else if (entry.isFile() && entry.name.endsWith('.md')) {
        results.push(full);
      }
    }
  } catch { /* directory doesn't exist or unreadable */ }
  return results.sort();
}

/**
 * List PROP-*.md filenames (bare, not full paths) in `dir`, sorted.
 * Distinguishes "directory absent" (ok:true, empty — nothing to review) from
 * any other readdir error (ok:false — ambiguous, e.g. EACCES/EIO under the
 * Docker runtime); globDir collapses both to [], which is unsafe wherever an
 * ambiguous read must never look like "no proposals."
 */
function listProposalFiles(dir: string): { ok: boolean; files: string[] } {
  try {
    return { ok: true, files: fs.readdirSync(dir).filter(f => /^PROP-.*\.md$/.test(f)).sort() };
  } catch (err: any) {
    return err?.code === 'ENOENT' ? { ok: true, files: [] } : { ok: false, files: [] };
  }
}

/**
 * Resolve an artifact_paths entry to a list of .md file paths.
 * Supports directories (recursive scan) and simple glob patterns (*.md, name-*.md).
 * baseDir is the project root.
 */
function resolveArtifactPath(baseDir: string, pathEntry: string): string[] {
  const full = path.resolve(baseDir, pathEntry);
  if (!pathEntry.includes('*')) return globDirRecursive(full);
  // Glob pattern: match files in the parent directory
  const dir = path.dirname(full);
  const pattern = path.basename(full);
  const re = new RegExp('^' + pattern.replace(/\./g, '\\.').replace(/\*/g, '.*') + '$');
  return globDir(dir, re);
}

export { parseFrontmatter, readFrontmatter, readFileWithFrontmatter, isEmptyAutoArchive, newestByType, globDir, globDirRecursive, resolveArtifactPath, listProposalFiles };
