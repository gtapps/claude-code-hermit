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
// <hermit-state-dir> is validated, not trusted: it must resolve to this
// project's own state dir (`lib/cc-compat.ts` assertStateDir/hermitDir), so a
// pre-approved call cannot be redirected at another project. An absolute
// AGENT_DIR is the one sanctioned override, and an env-prefixed command falls
// outside the `Bash(bun */scripts/proposal.ts*)` grant, so it re-prompts.
//
// Verbs:
//   create <stateDir>
//     stdin (heredoc): `Key: value` header lines, a bare `---` separator line,
//     then the raw markdown body. Headers: Title (required), Source (default
//     manual), Session (default state/runtime.json session_id), Category
//     (default improvement; improvement|routine|capability|constraint|bug),
//     Tags / Related-Sessions (JSON string arrays, default []), Findings
//     (optional one-line SHELL.md summary), Self-Eval-Key (optional checklist key). Claims the ID and writes the file
//     as one atomic operation (exclusive create, suffix walk on EEXIST — never
//     a separate assign-then-write step, which would allow a burned ID with no
//     file). Best-effort tail: SHELL.md Findings line, `created` metrics event,
//     proposals-index + state-summary regen. Output: the canonical ID, or
//     `ERROR|<token>` with zero writes.
//
//   patch <stateDir> <filename> [--set key=value]... [--request-compact] [--stdin]
//     <filename> must be a direct-child basename of the proposals dir (no `/`,
//     no leading `.`) — it is joined onto that dir, so a `../` prefix would
//     otherwise reach any frontmatter-bearing .md on disk. Rejected the same
//     way a genuinely absent proposal is: `ERROR|no-such-proposal`.
//     stdin (opt-in with --stdin, heredoc): `Decision: <line>` and/or `Set: key=value`
//     lines (free-text values — argv --set is for enum/bool/date/@now values
//     only). `@now` in any --set value or stdin line expands to the current
//     zoned ISO timestamp. Frontmatter patch + Operator Decision append apply
//     to one in-memory copy, then a single atomic write — validation failures
//     touch nothing. The Decision append is idempotent (skipped if the section
//     already ends with the identical line). `--request-compact` writes
//     state/compact-requested.json. Output: `OK|<id>` or `ERROR|<reason>`.
//
//   shell-append <stateDir> --section <findings|progress|monitoring|blockers>
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
// The verbs below are the proposal-lifecycle *readers and satellites*, absorbed
// from what used to be one top-level script each. They keep their own stdout
// grammars and exit codes rather than being forced into `OK`/`ERROR|<token>` —
// callers branch on those, and rewriting them would be a behavior change:
//
//   resolve-id <stateDir> <operator-input>       MATCH|… AMBIGUOUS|… NONE|…
//   gate <stateDir> --gate … --caller …          PROCEED|… DROP|… GATE_FAILED
//   queue-micro <stateDir>                       QUEUED|<MP-id> / DUPLICATE|<id>
//   micro <stateDir> resolve|nudge|brief-cycle|sweep  RESOLVED|… NUDGED|… SWEPT|… NONE|… / JSON
//   index <stateDir>                             OK|<n> proposals / SKIP|…
//   anchor <stateDir>                            Anchor: root=… memory_dir=…
//   metrics [<stateDir>] [--source=<key>]        markdown table / one-line verdict
//   success-signal --validate "<predicate>"      OK (exit 0) / reason (exit 1)
//   success-signal <stateDir> <date> <sess> <p>  one JSON verdict line
//   quality-gate <stateDir> <prop-file> [--files-json <json>]   one JSON verdict line
//
// Exit 0 always, EXCEPT: a missing OR foreign state-dir argv exits 1 (creation should
// never proceed on a mis-invocation, but a resolved, validated failure is always
// a verdict line, not a crash), and `queue-micro` / `micro` / `success-signal
// --validate` exit 1 on malformed input — a silent queue-drop or a silently
// accepted bad predicate is the failure mode those three exist to remove.

import fs from 'node:fs';
import path from 'node:path';
import { emit, readStdin, readStdinIfFlagged, readJson, flagValue } from './lib/cli';
import { pinStateDirOrExit, memoryDirFor } from './lib/cc-compat';
import { appendJsonlLine } from './lib/append-jsonl';
import { auditConfigChange } from './lib/config-audit';
import { writeFileAtomic, patchFrontmatter, appendToSection, appendShellLine, findSection, escapeRegExp, PATCH_KEY_RE } from './lib/md-write';
import { computeBase, SUFFIX_LETTERS } from './lib/prop-id';
import { readSettledConfig } from './lib/config-read';
import { zonedISOStamp, utcISOStamp } from './lib/time';
import { rebuildIndex, run as runIndex } from './lib/proposals/index-rebuild';
import { run as regenerateSummary } from './generate-summary';
import { run as runResolveId } from './lib/proposals/resolve';
import { run as runGate } from './lib/proposals/gate';
import { run as runQueueMicro } from './lib/proposals/queue-micro';
import { run as runMicro, sweepMoot, MOOT_STATUSES } from './lib/proposals/micro';
import { run as runMetrics } from './lib/proposals/metrics';
import { run as runEvent } from './lib/proposals/event';
import { run as runSuccessSignal } from './lib/proposals/success-signal';
import { run as runQualityGate } from './lib/proposals/quality-gate';

type Json = any;

// The write verbs return their complete stdout token — `ERROR|<reason>` or the
// success line — rather than exiting, so the write-path grammar is callable
// from a test without a subprocess. `main()`, via lib/cli's `emit`, is the only
// exit adapter. An exported verb takes `stateDir` already pinned (see
// requirePinnedStateDir): the pin is a property of the CLI entry, so an
// in-process caller owns it.

function warn(msg: string): void {
  console.error(`WARN: ${msg}`);
}

// Best-effort — a stale/missing index or summary is regenerated on the next
// write anyway, so failures here are never fatal to the calling verb.
function regenTail(stateDir: string): void {
  try { rebuildIndex(stateDir); } catch (e: any) { warn(`index rebuild failed: ${e.message}`); }
  try { regenerateSummary(path.join(stateDir, 'state')); } catch (e: any) { warn(`summary regen failed: ${e.message}`); }
}

// ---------------------------------------------------------------- create ---

const VALID_CATEGORIES = new Set(['improvement', 'routine', 'capability', 'constraint', 'bug']);

export function grabHeader(header: string, key: string): string | null {
  const m = new RegExp(`^${key}:[ \\t]*(.*)$`, 'm').exec(header);
  return m ? m[1].trim() : null;
}

// Returns [] for an absent/blank header, null to signal invalid JSON/shape.
export function parseStringArray(raw: string | null): string[] | null {
  if (raw == null || raw.trim() === '') return [];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.every(x => typeof x === 'string')) return parsed;
  } catch { /* falls through to null below */ }
  return null;
}

export function verbCreate(stateDir: string, stdin: string): string {
  const sep = /^---[ \t]*$/m.exec(stdin);
  if (!sep) return 'ERROR|missing-separator';
  const header = stdin.slice(0, sep.index);
  let body = stdin.slice(sep.index + sep[0].length).replace(/^\n+/, '').replace(/\s+$/, '');
  if (!body) return 'ERROR|empty-body';

  const title = grabHeader(header, 'Title');
  if (!title) return 'ERROR|missing-title';

  const source = grabHeader(header, 'Source') || 'manual';
  const selfEvalKey = grabHeader(header, 'Self-Eval-Key');
  let session = grabHeader(header, 'Session');
  // Falsy, not just null: a bare `Session:` line means "no session", which must
  // fall through to the runtime.json default (and then to null) rather than
  // writing `session: ""` — every other header defaults on falsy too.
  if (!session) {
    const runtime = readJson(path.join(stateDir, 'state', 'runtime.json'));
    session = runtime?.session_id ?? null;
  }
  const category = grabHeader(header, 'Category') || 'improvement';
  if (!VALID_CATEGORIES.has(category)) return 'ERROR|invalid-category';

  const tags = parseStringArray(grabHeader(header, 'Tags'));
  if (tags === null) return 'ERROR|invalid-tags';
  const relatedSessions = parseStringArray(grabHeader(header, 'Related-Sessions'));
  if (relatedSessions === null) return 'ERROR|invalid-related-sessions';
  const findingsSummary = grabHeader(header, 'Findings');

  if (!fs.existsSync(stateDir)) return 'ERROR|state-dir-not-found';

  const templatePath = path.join(stateDir, 'templates', 'PROPOSAL.md.template');
  let templateContent: string;
  try { templateContent = fs.readFileSync(templatePath, 'utf-8'); }
  catch { return 'ERROR|template-missing'; }
  if (!templateContent.startsWith('---')) return 'ERROR|template-malformed';
  const fmEnd = templateContent.indexOf('\n---', 3);
  if (fmEnd === -1) return 'ERROR|template-malformed';
  const templateFrontmatterBlock = templateContent.slice(0, fmEnd + 4);

  if (!/^## Operator Decision[ \t]*$/m.test(body)) {
    body = body.replace(/\n+$/, '') + '\n\n## Operator Decision\n';
  }

  const now = new Date();
  const timezone = readSettledConfig(stateDir).timezone ?? 'UTC';
  const created = zonedISOStamp(timezone, now);
  const base = computeBase(stateDir, title, now, timezone);

  const basePatch: Record<string, Json> = {
    title, status: 'proposed', source, session, created,
    related_sessions: relatedSessions, category, tags,
    ...(selfEvalKey ? { self_eval_key: selfEvalKey } : {}),
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
      if (e.code !== 'EEXIST') return 'ERROR|proposals-dir-unwritable';
    }
    suffixIdx++;
    if (suffixIdx >= SUFFIX_LETTERS.length) return 'ERROR|collision-suffixes-exhausted';
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

  return claimedId!;
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

const TIMESTAMP_RE_SRC = '\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:[+-]\\d{2}:\\d{2}|Z)';

// True when `heading`'s section already ends with `rawLine` — makes a re-run of
// the same patch call idempotent instead of duplicating the Operator Decision
// entry. Compares against the RAW (unexpanded) line with `@now` as a timestamp
// wildcard: every SKILL-documented Decision line is `... on @now.`, which
// expands to a fresh stamp each second, so a byte-comparison against the
// expanded line would never match on a retry and the guard would never fire.
export function sectionEndsWithLine(content: string, heading: string, rawLine: string): boolean {
  const section = findSection(content, heading);
  if (!section) return false;
  const lines = content.slice(section.start, section.end).split('\n').map(l => l.trim()).filter(Boolean);
  if (lines.length === 0) return false;
  const pattern = rawLine.trim().split('@now').map(escapeRegExp).join(TIMESTAMP_RE_SRC);
  return new RegExp(`^${pattern}$`).test(lines[lines.length - 1]);
}

export function verbPatch(stateDir: string, stdin: string, args: string[]): string {
  const { filename, sets: rawSets, requestCompact } = parsePatchArgs(args);
  if (!filename) return 'ERROR|no-such-proposal';
  // Direct-child basename only. The `path.join` below would otherwise let a
  // `../` prefix escape the proposals dir and patch any frontmatter-bearing
  // .md on disk; the state-dir pin in main() does not constrain this argument.
  // `startsWith('.')` covers `.`, `..`, and dotfiles in one predicate.
  if (filename !== path.basename(filename) || filename.startsWith('.')) return 'ERROR|no-such-proposal';

  const sets: Record<string, string> = {};
  for (const kv of rawSets) {
    const eq = kv.indexOf('=');
    if (eq === -1) return 'ERROR|invalid-set';
    const key = kv.slice(0, eq);
    if (!PATCH_KEY_RE.test(key)) return `ERROR|invalid-key:${key}`;
    sets[key] = kv.slice(eq + 1);
  }

  // `[ \t]*` not `\s*`: `\s` matches newlines, so a bare `Decision:` line
  // followed by a `Set:` line would capture the Set line as the decision text
  // (and then also apply it as a frontmatter set).
  const decisionMatch = /^Decision:[ \t]*(.*)$/m.exec(stdin);
  const decisionLine = decisionMatch ? decisionMatch[1].trim() || null : null;
  const stdinSets: Record<string, string> = {};
  const setLineRe = /^Set:[ \t]*([^\s=]+)=(.*)$/gm;
  let m: RegExpExecArray | null;
  while ((m = setLineRe.exec(stdin))) {
    if (!PATCH_KEY_RE.test(m[1])) return `ERROR|invalid-key:${m[1]}`;
    stdinSets[m[1]] = m[2];
  }

  const proposalsDir = path.join(stateDir, 'proposals');
  const candidateNames = filename.endsWith('.md') ? [filename] : [filename, `${filename}.md`];
  let targetPath: string | null = null;
  for (const name of candidateNames) {
    const p = path.join(proposalsDir, name);
    if (fs.existsSync(p)) { targetPath = p; break; }
  }
  if (!targetPath) return 'ERROR|no-such-proposal';

  let content: string;
  try { content = fs.readFileSync(targetPath, 'utf-8'); }
  catch { return 'ERROR|no-such-proposal'; }

  const now = new Date();
  const timezone = readSettledConfig(stateDir).timezone ?? 'UTC';
  const nowStamp = zonedISOStamp(timezone, now);
  const expand = (v: string) => v.replaceAll('@now', nowStamp);

  const patch: Record<string, Json> = {};
  for (const [k, v] of Object.entries(sets)) patch[k] = parseSetValue(expand(v));
  for (const [k, v] of Object.entries(stdinSets)) patch[k] = expand(v);

  let patched = content;
  if (Object.keys(patch).length > 0) {
    try { patched = patchFrontmatter(content, patch); }
    catch { return 'ERROR|frontmatter-terminator-missing'; }
  }

  if (decisionLine) {
    if (!sectionEndsWithLine(patched, 'Operator Decision', decisionLine)) {
      try { patched = appendToSection(patched, 'Operator Decision', expand(decisionLine)); }
      catch { return 'ERROR|no-operator-decision-section'; }
    }
  }

  try { writeFileAtomic(targetPath, patched); }
  catch { return 'ERROR|write-failed'; }

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

  // A terminal status retires any ask parked on this proposal by proposal-act's
  // accept flow — otherwise the queue keeps a question the decision already
  // answered, and the heartbeat digests it daily forever. Best-effort by
  // design: the proposal write has landed, so a reconciliation miss is a
  // warning, never `ERROR|` (which would read as "nothing was patched").
  // `proposal.ts micro <dir> sweep` re-runs the same pass.
  if (typeof patch.status === 'string' && MOOT_STATUSES.includes(patch.status)) {
    const propId = /^(PROP-\d+)/.exec(path.basename(targetPath))?.[1];
    if (propId) {
      const swept = sweepMoot(stateDir, { proposalId: propId });
      if (!swept.ok) warn(`pending-ask reconciliation for ${propId} failed: ${swept.error}`);
    }
  }

  return `OK|${path.basename(targetPath).replace(/\.md$/, '')}`;
}

// ----------------------------------------------------------- shell-append --

const SHELL_SECTIONS: Record<string, string> = {
  findings: 'Findings',
  progress: 'Progress Log',
  monitoring: 'Monitoring',
  blockers: 'Blockers',
};

export function verbShellAppend(stateDir: string, stdin: string, args: string[]): string {
  const line = stdin.trim();
  const section = flagValue(args, '--section') ?? '';
  const heading = Object.prototype.hasOwnProperty.call(SHELL_SECTIONS, section)
    ? SHELL_SECTIONS[section]
    : undefined;
  if (!heading) return 'ERROR|unknown-section';
  if (!line) return 'ERROR|empty-line';
  const err = appendShellLine(path.join(stateDir, 'sessions'), heading, line);
  if (err) {
    if (err.startsWith('SHELL.md unreadable')) return 'ERROR|shell-unreadable';
    return 'ERROR|shell-append-failed';
  }
  return 'OK';
}

// --------------------------------------------------------------- next-task -

export function verbNextTask(stateDir: string, stdin: string): string {
  if (!stdin.trim()) return 'ERROR|empty-content';
  const target = path.join(stateDir, 'sessions', 'NEXT-TASK.md');
  try {
    fs.writeFileSync(target, stdin, { flag: 'wx' });
  } catch (e: any) {
    if (e.code === 'EEXIST') return 'ERROR|next-task-exists';
    return 'ERROR|write-failed';
  }
  return 'OK';
}

// ------------------------------------------------------------------ routine

const ROUTINE_REQUIRED_FIELDS = ['id', 'schedule', 'skill', 'enabled'];

export function verbRoutine(stateDir: string, stdin: string): string {
  let entry: Json;
  try { entry = JSON.parse(stdin); } catch { return 'ERROR|invalid-json'; }
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return 'ERROR|invalid-json';
  for (const field of ROUTINE_REQUIRED_FIELDS) {
    if (!(field in entry)) return `ERROR|missing-field:${field}`;
  }
  if (typeof entry.id !== 'string' || !entry.id) return 'ERROR|missing-field:id';

  const configPath = path.join(stateDir, 'config.json');
  const config: Json = readJson(configPath);
  if (!config) return 'ERROR|config-unreadable';

  if (!Array.isArray(config.routines)) config.routines = [];
  const configBefore = structuredClone(config);
  const idx = config.routines.findIndex((r: Json) => r && r.id === entry.id);
  const verdict = idx >= 0 ? 'updated' : 'added';
  if (idx >= 0) config.routines[idx] = entry;
  else config.routines.push(entry);

  try {
    writeFileAtomic(configPath, JSON.stringify(config, null, 2) + '\n');
  } catch {
    return 'ERROR|config-write-failed';
  }
  auditConfigChange(stateDir, configBefore, config, 'proposal');

  return `OK|${verdict}`;
}

// ------------------------------------------------------------------- main --

const VERBS = 'create|patch|shell-append|next-task|routine|resolve-id|gate|queue-micro|micro|index|anchor|metrics|event|success-signal|quality-gate';

// The state dir is not caller-chosen. Every production call passes the literal
// `.claude-code-hermit` from the project root; accepting an arbitrary root let
// one pre-approved `Bash(bun */scripts/proposal.ts*)` call mutate — or read —
// another project's proposal queue. Deliberately a usage error (stderr, exit 1)
// rather than an `ERROR|<token>` verdict line: that line goes to stdout, which
// would corrupt the distinct stdout grammars several verbs own and callers
// branch on (`gate` -> PROCEED|/DROP|/GATE_FAILED, `resolve-id` -> MATCH|/NONE|,
// `micro` -> RESOLVED|). This also turns a drifted cwd into a loud failure
// instead of a write against the wrong tree.
function requirePinnedStateDir(dir: string): string {
  return pinStateDirOrExit(dir, 'proposal.ts');
}

// `root` is the PINNED dir, not the raw argv: from a `claude --worktree` session
// the shipped relative spelling resolves to the worktree projection, which the pin
// normalizes back to main's root. The projection carries config.json, so an anchor
// naming it would pass the agents' blindness check while every real source
// (state/proposals-index.json, sessions/, proposals/) sits in main — a silent
// dedup-blind gate, the exact failure the anchor exists to close.
// rebuildIndex is a no-op write when proposals/ is absent; the line still prints.
function runAnchor(root: string): never {
  rebuildIndex(root);
  emit(`Anchor: root=${root} memory_dir=${memoryDirFor(path.dirname(root))}`);
}

async function main(): Promise<void> {
  const verb = process.argv[2];
  const stateDir = process.argv[3];

  // `metrics` defaults its state dir, and `success-signal --validate` is a pure
  // grammar check that reads no state at all — for those two, argv[3] is not a
  // state dir and the guard below must not demand one. Both take the whole tail
  // (argv[3] onward) so their own arg parsing is unchanged from when they were
  // standalone scripts. When they DO carry a state dir it is pinned like every
  // other verb: both read hermit state (`state/proposal-metrics.jsonl`,
  // `sessions/`) and print it, so an unpinned root turned one pre-approved call
  // into a read of another project's queue and session costs. The positional
  // lookups below mirror each module's own arg parsing.
  const tail = process.argv.slice(3);
  if (verb === 'metrics') {
    const positional = tail.find(a => !a.startsWith('--'));
    if (positional !== undefined) requirePinnedStateDir(positional);
    return runMetrics(tail);
  }
  if (verb === 'success-signal') {
    if (tail[0] !== '--validate' && tail.length >= 4) requirePinnedStateDir(tail[0]);
    return runSuccessSignal(tail);
  }
  // `index` was fail-open before it was absorbed: a missing state dir answered
  // `SKIP|no state dir` on stdout at exit 0, never a usage error. Preserve that —
  // it is a derived-cache rebuild, and its callers treat a non-zero exit as a
  // real failure rather than "nothing to do".
  if (verb === 'index' && !stateDir) {
    process.stdout.write('SKIP|no state dir\n');
    process.exit(0);
  }

  if (!verb || !stateDir) {
    console.error(`Usage: bun proposal.ts <${VERBS}> <hermit-state-dir> [args...]`);
    process.exit(1);
  }

  const pinnedDir = requirePinnedStateDir(stateDir);

  const rest = process.argv.slice(4);
  switch (verb) {
    case 'create': return emit(verbCreate(stateDir, await readStdin()));
    case 'patch': {
      const stdin = await readStdinIfFlagged(rest, '--stdin');
      return emit(verbPatch(stateDir, stdin, rest));
    }
    case 'shell-append': return emit(verbShellAppend(stateDir, await readStdin(), rest));
    case 'next-task': return emit(verbNextTask(stateDir, await readStdin()));
    case 'routine': return emit(verbRoutine(stateDir, await readStdin()));
    case 'resolve-id': return runResolveId(stateDir, rest[0]);
    case 'gate': return runGate(stateDir, rest);
    case 'queue-micro': return runQueueMicro(stateDir);
    case 'micro': return runMicro(stateDir, rest);
    case 'index': return runIndex(stateDir);
    case 'anchor': return runAnchor(pinnedDir);
    // `event` is the writer; `metrics` above is the reader. Deliberately not named
    // `metric` — one character from `metrics` in a dispatcher whose default branch
    // exits 0 would make a typo a silent no-op in either direction.
    case 'event': return emit(runEvent(stateDir, rest));
    case 'quality-gate': return runQualityGate(stateDir, rest);
    default:
      return emit('ERROR|unknown-verb');
  }
}

// Guarded so importing a verb for an in-process test does not run the CLI.
if (import.meta.main) {
  main().catch((e: any) => {
    console.error('proposal.ts: unexpected error: ' + e.message);
    process.stdout.write('ERROR|unexpected\n');
    process.exit(0);
  });
}
