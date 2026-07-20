// proposal.ts — single CLI for the proposal-lifecycle state-dir mutations that
// used to go through the Write/Edit tools. The harness background-isolation
// guard blocks Write/Edit on the main-rooted `.claude-code-hermit/` state dir
// (pre-isolation rejected outright; post-EnterWorktree redirected to a
// gitignored worktree copy invisible to the live hermit) — Bash script writes
// to the same paths succeed in both states. One CLI (not one script per verb)
// keeps the sealed permission allow-list to a single entry.
//
// Usage: bun proposal.ts <verb> <hermit-state-dir> [args...]
//
// Verbs:
//   create <stateDir>
//     stdin (heredoc): `Key: value` header lines, a bare `---` separator line,
//     then the raw markdown body. Headers: Title (required), Source (default
//     manual), Session (default state/runtime.json session_id), Category
//     (default improvement; improvement|routine|capability|constraint|bug),
//     Tags / Related-Sessions (JSON string arrays, default []), Findings
//     (optional one-line SHELL.md summary). Claims the ID and writes the file
//     as one atomic operation (exclusive create, suffix walk on EEXIST — never
//     a separate assign-then-write step, which would allow a burned ID with no
//     file). Best-effort tail: SHELL.md Findings line, `created` metrics event,
//     proposals-index + state-summary regen. Output: the canonical ID, or
//     `ERROR|<token>` with zero writes.
//
//   patch <stateDir> <filename> [--set key=value]... [--request-compact]
//     stdin (optional, heredoc): `Decision: <line>` and/or `Set: key=value`
//     lines (free-text values — argv --set is for enum/bool/date/@now values
//     only). `@now` in any --set value or stdin line expands to the current
//     zoned ISO timestamp. Frontmatter patch + Operator Decision append apply
//     to one in-memory copy, then a single atomic write — validation failures
//     touch nothing. The Decision append is idempotent (skipped if the section
//     already ends with the identical line). `--request-compact` writes
//     state/compact-requested.json. Output: `OK|<id>` or `ERROR|<reason>`.
//
//   shell-append <stateDir> --section <findings|progress>
//     stdin: the one line to append. Output: `OK` or `ERROR|<reason>`.
//
//   next-task <stateDir>
//     stdin: full NEXT-TASK.md content. Exclusive create — an existing file
//     is left untouched. Output: `OK` or `ERROR|<reason>`.
//
//   routine <stateDir>
//     stdin: one routine entry as JSON ({id, schedule, skill, enabled, ...}).
//     Upserts by `id` into config.json's routines array. Output:
//     `OK|added` / `OK|updated` or `ERROR|<reason>`.
//
// Exit 0 always; only a missing verb/state-dir argv exits 1 (creation should
// never proceed on a mis-invocation, but a resolved, validated failure is
// always a verdict line, not a crash).

import fs from 'node:fs';
import path from 'node:path';
import { readStdin, readJson } from './lib/cli';
import { appendJsonlLine } from './lib/append-jsonl';
import { writeFileAtomic, patchFrontmatter, appendToSection, appendShellLine, findSection, PATCH_KEY_RE } from './lib/md-write';
import { computeBase, readTimezone, SUFFIX_LETTERS } from './lib/prop-id';
import { zonedISOStamp, utcISOStamp } from './lib/time';
import { rebuildIndex } from './proposals-index';
import { run as regenerateSummary } from './generate-summary';

type Json = any;

function fail(token: string): never {
  process.stdout.write(`ERROR|${token}\n`);
  process.exit(0);
}

function ok(token: string): never {
  process.stdout.write(`${token}\n`);
  process.exit(0);
}

function warn(msg: string): void {
  console.error(`WARN: ${msg}`);
}

// Best-effort — a stale/missing index or summary is regenerated on the next
// write anyway, so failures here are never fatal to the calling verb.
function regenTail(stateDir: string): void {
  try { rebuildIndex(stateDir); } catch (e: any) { warn(`index rebuild failed: ${e.message}`); }
  try { regenerateSummary(path.join(stateDir, 'state')); } catch (e: any) { warn(`summary regen failed: ${e.message}`); }
}

function parseFlags(argv: string[]): Record<string, string | true> {
  const out: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      const key = argv[i].slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) { out[key] = next; i++; }
      else out[key] = true;
    }
  }
  return out;
}

// ---------------------------------------------------------------- create ---

const VALID_CATEGORIES = new Set(['improvement', 'routine', 'capability', 'constraint', 'bug']);

function grabHeader(header: string, key: string): string | null {
  const m = new RegExp(`^${key}:[ \\t]*(.*)$`, 'm').exec(header);
  return m ? m[1].trim() : null;
}

// Returns [] for an absent/blank header, null to signal invalid JSON/shape.
function parseStringArray(raw: string | null): string[] | null {
  if (raw == null || raw.trim() === '') return [];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.every(x => typeof x === 'string')) return parsed;
  } catch { /* falls through to null below */ }
  return null;
}

async function verbCreate(stateDir: string): Promise<void> {
  const stdin = await readStdin();
  const sep = /^---[ \t]*$/m.exec(stdin);
  if (!sep) fail('missing-separator');
  const header = stdin.slice(0, sep.index);
  let body = stdin.slice(sep.index + sep[0].length).replace(/^\n+/, '').replace(/\s+$/, '');
  if (!body) fail('empty-body');

  const title = grabHeader(header, 'Title');
  if (!title) fail('missing-title');

  const source = grabHeader(header, 'Source') || 'manual';
  let session = grabHeader(header, 'Session');
  if (session === null) {
    const runtime = readJson(path.join(stateDir, 'state', 'runtime.json'));
    session = runtime?.session_id ?? null;
  }
  const category = grabHeader(header, 'Category') || 'improvement';
  if (!VALID_CATEGORIES.has(category)) fail('invalid-category');

  const tags = parseStringArray(grabHeader(header, 'Tags'));
  if (tags === null) fail('invalid-tags');
  const relatedSessions = parseStringArray(grabHeader(header, 'Related-Sessions'));
  if (relatedSessions === null) fail('invalid-related-sessions');
  const findingsSummary = grabHeader(header, 'Findings');

  if (!fs.existsSync(stateDir)) fail('state-dir-not-found');

  const templatePath = path.join(stateDir, 'templates', 'PROPOSAL.md.template');
  let templateContent: string;
  try { templateContent = fs.readFileSync(templatePath, 'utf-8'); }
  catch { fail('template-missing'); }
  if (!templateContent.startsWith('---')) fail('template-malformed');
  const fmEnd = templateContent.indexOf('\n---', 3);
  if (fmEnd === -1) fail('template-malformed');
  const templateFrontmatterBlock = templateContent.slice(0, fmEnd + 4);

  if (!/^## Operator Decision[ \t]*$/m.test(body)) {
    body = body.replace(/\n+$/, '') + '\n\n## Operator Decision\n';
  }

  const now = new Date();
  const timezone = readTimezone(stateDir);
  const created = zonedISOStamp(timezone, now);
  const base = computeBase(stateDir, title, now, timezone);

  const basePatch: Record<string, Json> = {
    title, status: 'proposed', source, session, created,
    related_sessions: relatedSessions, category, tags,
  };

  const proposalsDir = path.join(stateDir, 'proposals');
  try { fs.mkdirSync(proposalsDir, { recursive: true }); } catch { /* the write below reports the real failure */ }

  let claimedId: string | null = null;
  let suffixIdx = -1;
  let suffix = '';
  while (true) {
    const candidateId = `PROP-${base.num}-${base.slug}-${base.hhmmss}${suffix}`;
    const candidatePath = path.join(proposalsDir, `${candidateId}.md`);
    const frontmatter = patchFrontmatter(templateFrontmatterBlock, { ...basePatch, id: candidateId });
    const content = `${frontmatter}\n# Proposal: ${candidateId} — ${title}\n\n${body}\n`;
    try {
      fs.writeFileSync(candidatePath, content, { flag: 'wx' });
      claimedId = candidateId;
      break;
    } catch (e: any) {
      if (e.code !== 'EEXIST') fail('proposals-dir-unwritable');
    }
    suffixIdx++;
    if (suffixIdx >= SUFFIX_LETTERS.length) fail('collision-suffixes-exhausted');
    suffix = SUFFIX_LETTERS[suffixIdx];
  }

  // Best-effort tail — the proposal file already exists; failures warn on
  // stderr but never change the stdout verdict or roll anything back.
  const findingsLine = `- ${claimedId}: ${findingsSummary || title}`;
  const shellErr = appendShellLine(path.join(stateDir, 'sessions'), 'Findings', findingsLine);
  if (shellErr) warn(`findings append: ${shellErr}`);

  try {
    const metricsErr = appendJsonlLine(
      path.join(stateDir, 'state', 'proposal-metrics.jsonl'),
      JSON.stringify({ ts: utcISOStamp(), type: 'created', proposal_id: claimedId, source, category, tags }),
    );
    if (metricsErr) warn(`metrics append: ${metricsErr}`);
  } catch (e: any) {
    warn(`metrics append failed: ${e.message}`);
  }

  regenTail(stateDir);

  ok(claimedId!);
}

// ----------------------------------------------------------------- patch ---

function parseSetValue(raw: string): Json {
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  if (raw === 'null') return null;
  if (/^-?\d+(\.\d+)?$/.test(raw)) return Number(raw);
  return raw;
}

function parsePatchArgs(args: string[]): { filename: string | undefined; sets: string[]; requestCompact: boolean } {
  const filename = args[0];
  const sets: string[] = [];
  let requestCompact = false;
  for (let i = 1; i < args.length; i++) {
    if (args[i] === '--set') { sets.push(args[i + 1] ?? ''); i++; continue; }
    if (args[i] === '--request-compact') { requestCompact = true; continue; }
  }
  return { filename, sets, requestCompact };
}

// True when `heading`'s section already ends with `line` (trimmed, exact) —
// makes a re-run of the same patch call idempotent instead of duplicating
// the Operator Decision entry.
function sectionEndsWithLine(content: string, heading: string, line: string): boolean {
  const section = findSection(content, heading);
  if (!section) return false;
  const sectionText = content.slice(section.start, section.end);
  const lines = sectionText.split('\n').map(l => l.trim()).filter(Boolean);
  return lines.length > 0 && lines[lines.length - 1] === line.trim();
}

async function verbPatch(stateDir: string, args: string[]): Promise<void> {
  const { filename, sets: rawSets, requestCompact } = parsePatchArgs(args);
  if (!filename) fail('no-such-proposal');

  const sets: Record<string, string> = {};
  for (const kv of rawSets) {
    const eq = kv.indexOf('=');
    if (eq === -1) fail('invalid-set');
    const key = kv.slice(0, eq);
    if (!PATCH_KEY_RE.test(key)) fail(`invalid-key:${key}`);
    sets[key] = kv.slice(eq + 1);
  }

  const stdin = await readStdin();
  const decisionMatch = /^Decision:\s*(.*)$/m.exec(stdin);
  const decisionLine = decisionMatch ? decisionMatch[1].trim() : null;
  const stdinSets: Record<string, string> = {};
  const setLineRe = /^Set:\s*([^\s=]+)=(.*)$/gm;
  let m: RegExpExecArray | null;
  while ((m = setLineRe.exec(stdin))) {
    if (!PATCH_KEY_RE.test(m[1])) fail(`invalid-key:${m[1]}`);
    stdinSets[m[1]] = m[2];
  }

  const proposalsDir = path.join(stateDir, 'proposals');
  const candidateNames = filename.endsWith('.md') ? [filename] : [filename, `${filename}.md`];
  let targetPath: string | null = null;
  for (const name of candidateNames) {
    const p = path.join(proposalsDir, name);
    if (fs.existsSync(p)) { targetPath = p; break; }
  }
  if (!targetPath) fail('no-such-proposal');

  let content: string;
  try { content = fs.readFileSync(targetPath, 'utf-8'); }
  catch { fail('no-such-proposal'); }

  const now = new Date();
  const timezone = readTimezone(stateDir);
  const nowStamp = zonedISOStamp(timezone, now);
  const expand = (v: string) => v.replaceAll('@now', nowStamp);

  const patch: Record<string, Json> = {};
  for (const [k, v] of Object.entries(sets)) patch[k] = parseSetValue(expand(v));
  for (const [k, v] of Object.entries(stdinSets)) patch[k] = expand(v);

  let patched = content;
  if (Object.keys(patch).length > 0) {
    try { patched = patchFrontmatter(content, patch); }
    catch { fail('frontmatter-terminator-missing'); }
  }

  if (decisionLine) {
    const expanded = expand(decisionLine);
    if (!sectionEndsWithLine(patched, 'Operator Decision', expanded)) {
      try { patched = appendToSection(patched, 'Operator Decision', expanded); }
      catch { fail('no-operator-decision-section'); }
    }
  }

  try { writeFileAtomic(targetPath, patched); }
  catch { fail('write-failed'); }

  if (requestCompact) {
    try {
      writeFileAtomic(
        path.join(stateDir, 'state', 'compact-requested.json'),
        JSON.stringify({ requested_at: nowStamp, reason: 'proposal-resolve' }) + '\n',
      );
    } catch (e: any) {
      warn(`compact marker write failed: ${e.message}`);
    }
  }

  regenTail(stateDir);

  ok(`OK|${path.basename(targetPath).replace(/\.md$/, '')}`);
}

// ----------------------------------------------------------- shell-append --

async function verbShellAppend(stateDir: string, args: string[]): Promise<void> {
  const line = (await readStdin()).trim();
  const flags = parseFlags(args);
  const section = flags['section'];
  if (section !== 'findings' && section !== 'progress') fail('unknown-section');
  if (!line) fail('empty-line');
  const heading = section === 'findings' ? 'Findings' : 'Progress Log';
  const err = appendShellLine(path.join(stateDir, 'sessions'), heading, line);
  if (err) {
    if (err.startsWith('SHELL.md unreadable')) fail('shell-unreadable');
    fail('shell-append-failed');
  }
  ok('OK');
}

// --------------------------------------------------------------- next-task -

async function verbNextTask(stateDir: string): Promise<void> {
  const content = await readStdin();
  if (!content.trim()) fail('empty-content');
  const target = path.join(stateDir, 'sessions', 'NEXT-TASK.md');
  try {
    fs.writeFileSync(target, content, { flag: 'wx' });
  } catch (e: any) {
    if (e.code === 'EEXIST') fail('next-task-exists');
    fail('write-failed');
  }
  ok('OK');
}

// ------------------------------------------------------------------ routine

const ROUTINE_REQUIRED_FIELDS = ['id', 'schedule', 'skill', 'enabled'];

async function verbRoutine(stateDir: string): Promise<void> {
  const stdin = await readStdin();
  let entry: Json;
  try { entry = JSON.parse(stdin); } catch { fail('invalid-json'); }
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) fail('invalid-json');
  for (const field of ROUTINE_REQUIRED_FIELDS) {
    if (!(field in entry)) fail(`missing-field:${field}`);
  }
  if (typeof entry.id !== 'string' || !entry.id) fail('missing-field:id');

  const configPath = path.join(stateDir, 'config.json');
  const config: Json = readJson(configPath);
  if (!config) fail('config-unreadable');

  if (!Array.isArray(config.routines)) config.routines = [];
  const idx = config.routines.findIndex((r: Json) => r && r.id === entry.id);
  const verdict = idx >= 0 ? 'updated' : 'added';
  if (idx >= 0) config.routines[idx] = entry;
  else config.routines.push(entry);

  try {
    writeFileAtomic(configPath, JSON.stringify(config, null, 2) + '\n');
  } catch {
    fail('config-write-failed');
  }

  ok(`OK|${verdict}`);
}

// ------------------------------------------------------------------- main --

async function main(): Promise<void> {
  const verb = process.argv[2];
  const stateDir = process.argv[3];

  if (!verb || !stateDir) {
    console.error('Usage: bun proposal.ts <create|patch|shell-append|next-task|routine> <hermit-state-dir> [args...]');
    process.exit(1);
  }

  const rest = process.argv.slice(4);
  switch (verb) {
    case 'create': return verbCreate(stateDir);
    case 'patch': return verbPatch(stateDir, rest);
    case 'shell-append': return verbShellAppend(stateDir, rest);
    case 'next-task': return verbNextTask(stateDir);
    case 'routine': return verbRoutine(stateDir);
    default:
      fail('unknown-verb');
  }
}

main().catch((e: any) => {
  console.error('proposal.ts: unexpected error: ' + e.message);
  process.stdout.write('ERROR|unexpected\n');
  process.exit(0);
});
