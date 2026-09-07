// lib/md-write.ts — transactional markdown/frontmatter write helpers, promoted
// from apply-reflection-actions.ts so proposal.ts's create/patch/shell-append
// verbs can reuse the same atomic-write and section-append primitives.
//
// Also the single home for the `## <heading>` section grammar (findSection and
// the extract/replace/placeholder helpers built on it). Every SHELL.md reader
// and writer goes through here so they agree on where a section starts and ends.

import fs from 'node:fs';
import path from 'node:path';
import { acquireLockWithWait, releaseLock } from './lockfile';

type Json = any;

// Mirrors the frontmatter parser's own key grammar (lib/frontmatter.ts).
export const PATCH_KEY_RE = /^\w[\w_]*$/;
const BARE_VALUE_RE = /^[A-Za-z0-9][\w./:+-]*$/;

export function writeFileAtomic(p: string, content: string, mode?: number): void {
  const tmp = `${p}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, content, { encoding: 'utf-8', mode });
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

export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Locates a `## <heading>` section's body — [start, end) bounded by the next
// `## ` heading or EOF. Returns null when the heading is absent. Shared by
// appendToSection and proposal.ts's read-only idempotency check so both agree
// on where a section ends.
export function findSection(content: string, heading: string): { start: number; end: number } | null {
  // Escaped: the heading is a literal, and an operator-named section carrying a
  // regex metacharacter (`## Notes (2026)`, `## v1.2.3`) would otherwise be read
  // as a pattern and match the wrong line — or no line at all.
  const re = new RegExp(`^## ${escapeRegExp(heading)}[ \\t]*$`, 'm');
  const m = re.exec(content);
  if (!m) return null;
  const start = m.index + m[0].length;
  const nextHeading = content.indexOf('\n## ', start);
  return { start, end: nextHeading === -1 ? content.length : nextHeading };
}

// Reads a `## <heading>` section's body (heading line excluded, otherwise
// verbatim — callers own their own trimming). Null when the heading is absent.
// Anchored via findSection: `'### Task'.indexOf('## Task') === 1`, so the
// unanchored substring/regex reads this replaces would let a `### Task`
// sub-heading anywhere above the real section hijack the answer.
export function extractSection(content: string, heading: string): string | null {
  const section = findSection(content, heading);
  if (!section) return null;
  const body = content.slice(section.start, section.end);
  // `\r?\n`, not `\n`: findSection's `$` matches before a CR too, so on a CRLF
  // SHELL.md the span starts at the `\r` and a bare `\n` strip would leave it
  // glued to the first body line.
  return body.replace(/^\r?\n/, '');
}

// Drops placeholder comments (`<!-- ... -->`, possibly multi-line) and trims.
// The single rule for "is this section really empty, or does it just still
// carry its template placeholder?". Use this rather than a whole-body
// `startsWith('<!--')` check: the reset templates keep their placeholder
// comments in place and real content is appended below them, so a whole-body
// check reads a populated section as empty.
export function stripPlaceholders(text: string): string {
  return text.replace(/<!--[\s\S]*?-->/g, '').trim();
}

// True for a blocker line already marked resolved. Two spellings, one convention:
// `~ <text>` is the mid-session mark an operator or the model writes into SHELL.md the
// moment a blocker clears, and `- [resolved] <text>` is how the archived report renders
// it. Neither is a current blocker. Shared so the two sides of that convention cannot
// drift — session-archive decides what a report and the next session carry, while
// startup-context decides what a resumed or compacted session is told it is blocked on;
// if those disagree, a cleared blocker comes back from whichever side is behind.
// The tilde must be followed by whitespace or end-of-line — `~ <text>` is the whole
// convention. Matching a bare `~` would swallow any blocker that opens on a home path
// ("- ~/.claude/settings.json is read-only"), silently retiring a live blocker and
// mangling its text in the archived report.
// One marker source for both the test and the strip: session-archive needs the text
// without the marker, and re-spelling the pattern there is how the two last drifted.
const RESOLVED_MARKER = String.raw`(?:~(?=\s|$)|\[resolved\])`;
const RESOLVED_LINE_RE = new RegExp(String.raw`^\s*-?\s*${RESOLVED_MARKER}`, 'i');
const RESOLVED_PREFIX_RE = new RegExp(String.raw`^${RESOLVED_MARKER}\s*`, 'i');

export function isResolvedBlockerLine(line: string): boolean {
  return RESOLVED_LINE_RE.test(line);
}

// Drops a leading resolved marker, leaving the blocker's own text. No-op when unmarked.
export function stripResolvedMarker(text: string): string {
  return text.replace(RESOLVED_PREFIX_RE, '');
}

// First non-empty, non-placeholder line of a section body, optionally clipped.
// '' when the section holds nothing but blanks and placeholders.
export function firstContentLine(section: string, maxLen?: number): string {
  for (const line of section.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('<!--')) continue;
    return maxLen ? trimmed.slice(0, maxLen) : trimmed;
  }
  return '';
}

// Replaces a `## <heading>` section's body wholesale; content unchanged when the
// heading is absent. `newBody` is inserted immediately after the heading line's
// text, so it must carry its own leading newline.
export function replaceSectionInPlace(content: string, heading: string, newBody: string): string {
  const section = findSection(content, heading);
  if (!section) return content;
  return content.slice(0, section.start) + newBody + content.slice(section.end);
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

// All mechanical SHELL rewrites share this lock, including lifecycle resets.
// Dead owners are reclaimed by lockfile; a busy or unwritable lock is a retry,
// never permission to overwrite a peer's read-modify-write without the lock.
export function withShellLock<T>(shellPath: string, fn: () => T): T {
  const lockPath = `${shellPath}.lock`;
  if (!acquireLockWithWait(lockPath, 2000)) throw new Error('SHELL.md lock unavailable; retry the operation');
  try { return fn(); }
  finally { releaseLock(lockPath); }
}

// Best-effort append of a pre-rendered line to `<stateDir>/sessions/SHELL.md`
// under `## <heading>` (Findings/Progress Log). Returns null on success, an
// error message otherwise — never throws.
export function appendShellLine(sessionsDir: string, heading: string, line: string): string | null {
  const shellPath = path.join(sessionsDir, 'SHELL.md');
  try {
    return withShellLock(shellPath, () => {
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
    });
  } catch (e: any) {
    return e.message;
  }
}
