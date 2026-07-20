// lib/md-write.ts — transactional markdown/frontmatter write helpers, promoted
// from apply-reflection-actions.ts so proposal.ts's create/patch/shell-append
// verbs can reuse the same atomic-write and section-append primitives.

import fs from 'node:fs';
import path from 'node:path';

type Json = any;

// Mirrors the frontmatter parser's own key grammar (lib/frontmatter.ts).
export const PATCH_KEY_RE = /^\w[\w_]*$/;
const BARE_VALUE_RE = /^[A-Za-z0-9][\w./:+-]*$/;

export function writeFileAtomic(p: string, content: string): void {
  const tmp = `${p}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, content, 'utf-8');
  fs.renameSync(tmp, p);
}

// Scalars serialize bare when safe, else JSON-quoted. Arrays of scalars
// serialize as JSON flow form (`["a","b"]`) — valid YAML flow-sequence syntax,
// needed for proposal `tags` / `related_sessions` fields.
export function serializeValue(v: Json): string {
  if (v === null) return 'null';
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (Array.isArray(v)) return JSON.stringify(v);
  return BARE_VALUE_RE.test(v) ? v : JSON.stringify(v);
}

// Line-level frontmatter patch: replaces the first `key:` line inside the
// `---` block (inserts before the closing delimiter when absent), preserving
// every non-patched byte — comments, ordering, and the body stay untouched.
export function patchFrontmatter(content: string, patch: Record<string, Json>): string {
  const end = content.indexOf('\n---', 3);
  // The validation pass proves this holds, but the apply pass re-reads from disk
  // and the function is exported — without the guard, slice(4, -1) would absorb
  // the entire body into the frontmatter line array and discard all but its last
  // byte. Throwing lands the entry in `errors` instead of corrupting the file.
  if (end === -1) throw new Error('no frontmatter terminator');
  const lines = content.slice(4, end).split('\n');
  for (const [key, value] of Object.entries(patch)) {
    const line = `${key}: ${serializeValue(value)}`;
    const re = new RegExp(`^${key}\\s*:`);
    const idx = lines.findIndex(l => re.test(l));
    if (idx >= 0) lines[idx] = line;
    else lines.push(line);
  }
  return '---\n' + lines.join('\n') + content.slice(end);
}

// Locates a `## <heading>` section's body — [start, end) bounded by the next
// `## ` heading or EOF. Returns null when the heading is absent. Shared by
// appendToSection and proposal.ts's read-only idempotency check so both agree
// on where a section ends.
export function findSection(content: string, heading: string): { start: number; end: number } | null {
  const re = new RegExp(`^## ${heading}[ \\t]*$`, 'm');
  const m = re.exec(content);
  if (!m) return null;
  const start = m.index + m[0].length;
  const nextHeading = content.indexOf('\n## ', start);
  return { start, end: nextHeading === -1 ? content.length : nextHeading };
}

// Appends a pre-rendered line to a `## <heading>` section (inserted at section
// end: before the next `## ` heading or EOF). Throws when the heading is
// missing — callers decide whether that's fatal or best-effort.
export function appendToSection(content: string, heading: string, line: string): string {
  const section = findSection(content, heading);
  if (!section) throw new Error(`no ## ${heading} section`);
  const insertAt = section.end;
  const atEOF = insertAt === content.length;
  const before = content.slice(0, insertAt).replace(/\n*$/, '\n');
  // Normalizing `after` to a single leading newline would swallow the blank line
  // that separates this section from the next heading, gluing them together.
  const after = content.slice(insertAt).replace(/^\n*/, atEOF ? '\n' : '\n\n');
  return before + line + after;
}

// Best-effort append of a pre-rendered line to `<stateDir>/sessions/SHELL.md`
// under `## <heading>` (Findings/Progress Log). Returns null on success, an
// error message otherwise — never throws.
export function appendShellLine(sessionsDir: string, heading: string, line: string): string | null {
  const shellPath = path.join(sessionsDir, 'SHELL.md');
  let shell: string;
  try { shell = fs.readFileSync(shellPath, 'utf-8'); }
  catch { return 'SHELL.md unreadable'; }
  let next: string;
  try { next = appendToSection(shell, heading, line); }
  catch (e: any) { return `SHELL.md has no ## ${heading} section: ${e.message}`; }
  try {
    writeFileAtomic(shellPath, next);
    return null;
  } catch (e: any) {
    return 'SHELL.md write failed: ' + e.message;
  }
}
