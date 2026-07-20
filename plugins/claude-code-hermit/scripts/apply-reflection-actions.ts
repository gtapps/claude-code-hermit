// scripts/apply-reflection-actions.ts — transactional apply of the reflect eval
// runner's `resolution_actions` (reflect/SKILL.md § eval-runner return schema).
// Replaces the prose-directed apply: the whole batch is validated before ANY
// write, so malformed model output can never leave a proposal half-patched.
//
// Usage: bun apply-reflection-actions.ts <hermit-state-dir>   (stdin: JSON)
// Stdin: {"resolution_actions":[{proposal_id, action, frontmatter_patch,
//         metrics_event, shell_findings_line}, ...]}
// Output: one JSON line — {"ok":true,"applied":{...}} (+ "errors" when any
// post-validation write failed) or {"ok":false,"reason":...} with zero writes.
// Exit 0 always (update-alert-state.ts pattern); only missing argv exits 1.
//
// Durability split: proposal frontmatter patches and metrics appends are the
// all-or-nothing core; SHELL.md `## Findings` appends are best-effort session
// notes — a missing SHELL.md or heading lands in `errors`, never aborts.

import fs from 'node:fs';
import path from 'node:path';
import { listProposalFiles, readFileWithFrontmatter } from './lib/frontmatter';
import { appendJsonlLine } from './lib/append-jsonl';

type Json = any;

const ACTIONS = new Set(['auto-resolve', 'nudge', 'skip']);
// Mirrors the frontmatter parser's own key grammar (lib/frontmatter.ts).
const PATCH_KEY_RE = /^\w[\w_]*$/;
const BARE_VALUE_RE = /^[A-Za-z0-9][\w./:+-]*$/;

function writeFileAtomic(p: string, content: string): void {
  const tmp = `${p}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, content, 'utf-8');
  fs.renameSync(tmp, p);
}

function serializeValue(v: Json): string {
  if (v === null) return 'null';
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return BARE_VALUE_RE.test(v) ? v : JSON.stringify(v);
}

// Line-level frontmatter patch: replaces the first `key:` line inside the
// `---` block (inserts before the closing delimiter when absent), preserving
// every non-patched byte — comments, ordering, and the body stay untouched.
function patchFrontmatter(content: string, patch: Record<string, Json>): string {
  const end = content.indexOf('\n---', 3);
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

// Best-effort append of a pre-rendered line to SHELL.md's `## Findings`
// section (inserted at section end: before the next `## ` heading or EOF).
// Returns null on success, error message otherwise.
function appendFinding(sessionsDir: string, line: string): string | null {
  const shellPath = path.join(sessionsDir, 'SHELL.md');
  let shell: string;
  try { shell = fs.readFileSync(shellPath, 'utf-8'); }
  catch { return 'SHELL.md unreadable'; }
  const m = /^## Findings[ \t]*$/m.exec(shell);
  if (!m) return 'SHELL.md has no ## Findings section';
  const sectionStart = m.index + m[0].length;
  const nextHeading = shell.indexOf('\n## ', sectionStart);
  const insertAt = nextHeading === -1 ? shell.length : nextHeading;
  const before = shell.slice(0, insertAt).replace(/\n*$/, '\n');
  const after = shell.slice(insertAt).replace(/^\n*/, '\n');
  try {
    writeFileAtomic(shellPath, before + line + (nextHeading === -1 ? '\n' : '') + after);
    return null;
  } catch (e: any) {
    return 'SHELL.md write failed: ' + e.message;
  }
}

function apply(stateDir: string, stdin: string): Json {
  let input: Json;
  try { input = JSON.parse(stdin); }
  catch (e: any) { return { ok: false, reason: 'stdin not parseable as JSON: ' + e.message }; }
  const actions = input?.resolution_actions;
  if (!Array.isArray(actions)) return { ok: false, reason: 'resolution_actions missing or not an array' };

  const proposalsDir = path.join(stateDir, 'proposals');
  const resolvedFiles = new Map<number, string>();
  let listed: { ok: boolean; files?: string[] } | null = null;

  // --- Validation pass: reject the whole batch before any write. ---
  for (let i = 0; i < actions.length; i++) {
    const a = actions[i];
    const label = `entry ${i} (${a?.proposal_id ?? '?'})`;
    if (!a || typeof a !== 'object') return { ok: false, reason: `${label}: not an object` };
    if (typeof a.proposal_id !== 'string' || !/^PROP-\d+$/.test(a.proposal_id)) {
      return { ok: false, reason: `${label}: proposal_id must match PROP-<digits>` };
    }
    if (!ACTIONS.has(a.action)) return { ok: false, reason: `${label}: unknown action "${a.action}"` };
    if (a.metrics_event != null) {
      if (typeof a.metrics_event !== 'string') return { ok: false, reason: `${label}: metrics_event must be a JSON string` };
      try { JSON.parse(a.metrics_event); }
      catch { return { ok: false, reason: `${label}: metrics_event is not valid JSON` }; }
    }
    if (a.shell_findings_line != null && typeof a.shell_findings_line !== 'string') {
      return { ok: false, reason: `${label}: shell_findings_line must be a string or null` };
    }
    if (a.action !== 'auto-resolve') continue;

    const patch = a.frontmatter_patch;
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
      return { ok: false, reason: `${label}: auto-resolve requires a frontmatter_patch object` };
    }
    for (const [k, v] of Object.entries(patch)) {
      if (!PATCH_KEY_RE.test(k)) return { ok: false, reason: `${label}: invalid patch key "${k}"` };
      if (v !== null && !['string', 'number', 'boolean'].includes(typeof v)) {
        return { ok: false, reason: `${label}: patch value for "${k}" must be scalar or null` };
      }
    }
    if (listed === null) listed = listProposalFiles(proposalsDir);
    if (!listed.ok) return { ok: false, reason: 'proposals-dir-unreadable' };
    // Boundary-safe prefix match: PROP-1 must never match PROP-12.
    const file = (listed.files ?? []).find(f => f.startsWith(a.proposal_id + '-') || f === a.proposal_id + '.md');
    if (!file) return { ok: false, reason: `${label}: no matching proposal file` };
    const full = path.join(proposalsDir, file);
    const parsed = readFileWithFrontmatter(full);
    if (!parsed || !parsed.fm) return { ok: false, reason: `${label}: proposal frontmatter unparseable` };
    resolvedFiles.set(i, full);
  }

  // --- Apply pass: validation passed; I/O failures collect, don't abort. ---
  const applied = { auto_resolve: 0, nudge: 0, skip: 0 };
  const errors: string[] = [];
  for (let i = 0; i < actions.length; i++) {
    const a = actions[i];
    if (a.action === 'skip') { applied.skip++; continue; }
    if (a.action === 'auto-resolve') {
      const file = resolvedFiles.get(i)!;
      try {
        writeFileAtomic(file, patchFrontmatter(fs.readFileSync(file, 'utf-8'), a.frontmatter_patch));
      } catch (e: any) {
        errors.push(`${a.proposal_id}: frontmatter patch failed: ${e.message}`);
        continue; // don't record metrics/findings for a proposal that wasn't patched
      }
      if (a.metrics_event) {
        try {
          const err = appendJsonlLine(path.join(stateDir, 'state', 'proposal-metrics.jsonl'), a.metrics_event);
          if (err) errors.push(`${a.proposal_id}: metrics append: ${err}`);
        } catch (e: any) {
          errors.push(`${a.proposal_id}: metrics append failed: ${e.message}`);
        }
      }
      applied.auto_resolve++;
    } else {
      applied.nudge++;
    }
    if (a.shell_findings_line) {
      const err = appendFinding(path.join(stateDir, 'sessions'), a.shell_findings_line);
      if (err) errors.push(`${a.proposal_id}: findings append: ${err}`);
    }
  }

  const out: Json = { ok: true, applied };
  if (errors.length > 0) out.errors = errors;
  return out;
}

if (import.meta.main) {
  const stateDir = process.argv[2];
  if (!stateDir) {
    console.error('Usage: bun apply-reflection-actions.ts <hermit-state-dir>   (stdin: {"resolution_actions":[...]})');
    process.exit(1);
  }
  let stdin = '';
  try { stdin = fs.readFileSync(0, 'utf-8'); } catch { /* treated as unparseable below */ }
  let result: Json;
  try { result = apply(path.resolve(stateDir), stdin); }
  catch (e: any) { result = { ok: false, reason: 'error: ' + e.message }; }
  process.stdout.write(JSON.stringify(result) + '\n');
  process.exit(0);
}

export { apply, patchFrontmatter };
