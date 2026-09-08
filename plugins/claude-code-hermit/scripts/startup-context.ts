// Suppress EPIPE errors (e.g. when stdout pipe closes early in tests)
process.stdout.on('error', () => {});

// startup-context.ts — SessionStart hook
// Replaces the inline bash blob with a capped, priority-ordered context injection.
// Emits only startup-relevant SHELL.md sections with per-section budgets.
// Hard cap: 9000 chars total (~2250 tokens). Source-gated: `compact` emits only
// a delta capsule (≤ COMPACT_CAP); `resume` skips the Last Report section when
// SHELL.md is active; `startup`/`clear`/unknown get the full capsule.

import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { readFrontmatter, readFileWithFrontmatter, globDir } from './lib/frontmatter';
import { hermitDir } from './lib/cc-compat';
import { findStorageDrift, findSchemaDrift } from './lib/drift';
import { safe, safeForLLMMultiline, scanInjected } from './lib/sanitize';
import { resolve as resolveOutboundChannel } from './resolve-outbound-channel';
import { operatorLanguage as resolveOperatorLanguage } from './lib/operator-language';
import { readSettledConfig } from './lib/config-read';
import { extractSection, firstContentLine, isResolvedBlockerLine, stripPlaceholders } from './lib/md-write';
import { isResetBreadcrumb } from './lib/progress-log';
import { readMicroProposals } from './lib/micro-proposals-io';
import { tmuxSessionAlive } from './lib/tmux';
import { readRuntimeJson, writeRuntimeJson } from './lib/runtime';
import { findResident, ownsResidentIdentity } from './lib/session-registry';
import { defaultConfigDir, envAuthPresent } from './lib/setup-token';
import { seedOperatorActivity } from './record-operator-action';
import { clearGuest, markGuest, pruneGuestMarkers } from './lib/guest-marker';

type Json = any;

const AGENT_DIR = hermitDir();
const PLUGIN_ROOT = process.env.CLAUDE_PLUGIN_ROOT || path.resolve(import.meta.dir, '..');
const HARD_CAP = 9000;
const COMPACT_CAP = 1200; // total stdout when source === "compact" (delta capsule only)

// Section budgets (chars). Higher priority sections emit first.
// If a section exceeds its budget, it is truncated with [...truncated].
// Lower-priority sections are dropped entirely once HARD_CAP is reached.
const BUDGETS = {
  operator:      2000,
  session:       3000,
  knowledge:     2500, // compiled/ artifacts — read from config, 2500 default
  schemaDrift:    400, // only emitted when compiled/ types are undeclared in knowledge-schema.md
  storageDrift:   500, // only emitted when misplaced files are found
  report:        1500,
  upgrade:        500,
};

// Injection-time content guard: defuse context-marker tags in everything we
// emit; replace an entry outright when a threat marker matches. The file on
// disk is never touched — hits are recorded for the doctor context-scan check.
const scanHits: { source: string; reason: string }[] = [];

// Scans `text`, records a hit against `source` when a marker fires, and
// returns the reason (or null when clean).
function checkThreat(source: string, text: string): string | null {
  const reason = scanInjected(text);
  if (reason) scanHits.push({ source, reason });
  return reason;
}

function guarded(source: string, text: string): string {
  const reason = checkThreat(source, text);
  return reason ? `[BLOCKED: ${reason}]` : safeForLLMMultiline(text);
}

// Emit artifact entries for a list, tracking chars used against a budget.
// headerFn(artifact) → string used as the section header per entry.
// Pinned and recent budgets are intentionally isolated — unused pinned budget
// does not roll over to recent, and vice versa.
function emitArtifacts(artifacts: Json[], budget: number, headerFn: (a: Json) => string, parts: string[]): void {
  let used = 0;
  for (const a of artifacts) {
    const header = headerFn(a);
    const available = budget - used - header.length;
    if (available <= 0) break;
    const stubRaw = typeof a.fm.injection_stub === 'string' ? a.fm.injection_stub : '';
    const stub = stubRaw.trim();
    let entry: string;
    if (stub) {
      if (stubRaw.length > available) continue; // too long for remaining budget — skip rather than garble
      entry = header + guarded(`compiled/${a.basename}.md`, stubRaw);
    } else {
      const body = a.body || '';
      const snippet = body.slice(0, available);
      const blockReason = checkThreat(`compiled/${a.basename}.md`, snippet);
      const content = blockReason ? `[BLOCKED: ${blockReason}]` : safeForLLMMultiline(snippet);
      entry = header + content
        + (blockReason ? '' : (snippet.length < body.length ? '\n[...]\n' : ''));
    }
    parts.push(entry);
    used += entry.length;
  }
}

// Drops the bare "-" a comment-only bullet ("- <!-- resolved ... -->") leaves
// behind once stripPlaceholders removes the comment. A dash-only line is never
// a real entry, and injecting it reads as an unnamed blocker or finding.
function dropBulletResidue(text: string): string {
  return text.split('\n').filter(l => !/^\s*-+\s*$/.test(l)).join('\n').trim();
}

// Drops blockers the session already cleared (see isResolvedBlockerLine for the two
// spellings). Injecting one makes a resumed or compacted session re-attempt work that is
// already unblocked — the exact failure the blockers line exists to prevent.
function dropResolvedBlockers(text: string): string {
  return text.split('\n')
    .filter(l => !isResolvedBlockerLine(l))
    .join('\n')
    .trim();
}

// Return last N non-empty lines from a string.
function lastLines(text: string, n: number): string {
  const lines = text.split('\n').filter(l => l.trim());
  return lines.slice(-n).join('\n');
}

// Operator-language fact for injected context. The structural whitelist is the
// first gate — it rejects anything tag-, newline-, or control-byte-shaped, and
// accepts locale codes (`pt`, `pt-BR`, `pt_BR`) plus human language names.
// It is NOT the only gate: `hermit-settings language` can be driven from a
// channel-tagged turn, so the value is remote-influenceable and still gets the
// same threat scan every other injected surface goes through — the whitelist
// alone would pass a letters-and-spaces injection phrase.
function operatorLanguage(agentDir: string): string | null {
  return resolveOperatorLanguage(agentDir, (reason) =>
    scanHits.push({ source: 'config.json:language', reason }));
}

// Build the post-compaction delta capsule: the ONLY injection on
// source === "compact". Carries hermit lifecycle state (never assumed
// preserved by the native summary — its quality varies) plus file pointers;
// bodies, catalog, cost, and upgrade status stay out — they are not
// continuity state. Fail-open per-field — one missing/malformed
// state file must not blank the rest. Returns "" if nothing is available.
function buildCompactionPointers(agentDir: string): string {
  const parts: string[] = [];

  // First: the capsule is hard-sliced at COMPACT_CAP, so anything appended
  // late is what a state-heavy hermit loses. Language is the one fact here
  // that has no other post-compaction source.
  const lang = operatorLanguage(agentDir);
  if (lang) parts.push(`operator language: ${safe(lang)} (reply in this language)`);

  try {
    const runtime = JSON.parse(fs.readFileSync(path.resolve(agentDir, 'state', 'runtime.json'), 'utf-8'));
    const sessionState = typeof runtime.session_state === 'string' ? runtime.session_state : null;
    const waitingReason = typeof runtime.waiting_reason === 'string' ? runtime.waiting_reason : null;
    if (sessionState) {
      parts.push(`session_state: ${safe(sessionState)}` + (waitingReason ? ` (waiting_reason: ${safe(waitingReason)})` : ''));
    }
  } catch {}

  // Read once, process per field: the two SHELL.md-derived pointers are emitted at
  // opposite ends of the capsule (see the ordering note below), but a second read of the
  // same path in the same synchronous pass buys no extra fail-open — it fails
  // identically. Each field keeps its own try/catch so a malformed section still can't
  // blank the other.
  let shellContent: string | null = null;
  try { shellContent = fs.readFileSync(path.resolve(agentDir, 'sessions', 'SHELL.md'), 'utf-8'); } catch {}

  try {
    if (shellContent === null) throw new Error('no shell');
    const firstLine = firstContentLine(extractSection(shellContent, 'Task') ?? '', 300);
    if (firstLine) parts.push(`task: ${guarded('sessions/SHELL.md', firstLine)}`);
    const progress = extractSection(shellContent, 'Progress Log');
    // Skip the reset breadcrumbs: the PreCompact hook appends "context compacted (…)"
    // immediately before this capsule is built, so the newest entry is always that
    // stamp — 200 characters of a budget this tight, saying only that the thing that
    // just happened happened. The last real entry is what "last progress" means.
    const lastEntry = progress
      ? progress.split('\n').map(l => l.trim())
          .filter(l => l && !l.startsWith('<!--') && !isResetBreadcrumb(l))
          .pop()
      : null;
    if (lastEntry) parts.push(`last progress: ${guarded('sessions/SHELL.md', lastEntry.slice(0, 200))}`);
  } catch {}

  try {
    const read = readMicroProposals(path.resolve(agentDir, 'state', 'micro-proposals.json'));
    // Omitting the line on a corrupt file implies an empty queue (#764) — say so instead.
    if (read.status === 'corrupt') parts.push('pending micro-proposals: unreadable');
    const mp = read.status === 'ok' ? read.data : { pending: [] };
    const pending = (Array.isArray(mp.pending) ? mp.pending : []).filter((p: Json) => p && p.status === 'pending');
    if (pending.length > 0) {
      const ids = pending.slice(0, 10).map((p: Json) => safe(p.id ?? '?'));
      const overflow = pending.length > ids.length ? ` (+${pending.length - ids.length} more)` : '';
      parts.push(`pending micro-proposals: ${ids.join(', ')}${overflow}`);
    }
  } catch {}

  try {
    const config = readSettledConfig(agentDir);
    const route = resolveOutboundChannel(config.channels);
    if (route) parts.push(`outbound channel: ${safe(route.id)} (chat_id: ${safe(route.chat_id)})`);
  } catch {}

  // Ordered after the channel route deliberately. Both are re-seed facts, but a hermit
  // that loses its route stops being reachable at all, while one that loses the blockers
  // line re-reads SHELL.md. The capsule is hard-capped, so whichever sits last is what a
  // long task line plus a full micro-proposal queue push out first.
  try {
    if (shellContent === null) throw new Error('no shell');
    // dropBulletResidue first: stripPlaceholders trims the whole section, so a
    // comment-only bullet ("- <!-- resolved ... -->") would otherwise reach here
    // as a bare "-" and surface as "blockers: -".
    const blockerLines = dropResolvedBlockers(dropBulletResidue(stripPlaceholders(extractSection(shellContent, 'Blockers') ?? '')))
      .split('\n').map(l => l.trim().replace(/^-\s+/, '').trim()).filter(Boolean);
    if (blockerLines.length) {
      // Cap each entry, not the joined string: one verbose blocker would
      // otherwise eat the whole budget and truncate away the newest one, which
      // is the entry `slice(-2)` exists to preserve.
      const blockers = blockerLines.slice(-2).map(l => l.slice(0, 118)).join(' | ');
      parts.push(`blockers: ${guarded('sessions/SHELL.md', blockers.slice(0, 240))}`);
    }
  } catch {}

  try {
    const reports = globDir(path.resolve(agentDir, 'sessions'), /^S-\d+-REPORT\.md$/)
      .map(f => path.basename(f))
      .reverse();
    if (reports.length > 0) parts.push(`latest report: sessions/${reports[0]}`);
  } catch {}

  try {
    if (fs.statSync(path.resolve(agentDir, 'OPERATOR.md')).size > 0) {
      parts.push('operator context: OPERATOR.md (not re-read; consult before outward-facing actions)');
    }
  } catch {}

  try {
    if (fs.readdirSync(path.resolve(agentDir, 'proposals')).some(f => f.endsWith('.md'))) {
      parts.push('proposals dir: proposals/');
    }
  } catch {}

  if (parts.length === 0) return '';

  parts.push('Full state: SHELL.md + runtime.json. Plan: SHELL.md Progress Log. Don\'t re-read large files to reconstruct context.');
  return parts.join('\n');
}

// --- Residency: resident vs guest ---------------------------------------
// hermit-start marks resident launches with HERMIT_RESIDENT=1. Other sessions
// are guests even when the resident is stopped. A session carrying the flag but
// not holding the registry stamp is also a guest. The tmux liveness check below
// only determines whether the guest banner can point to a running resident.
function residentSessionActive(agentDir: string): boolean {
  const runtime = readRuntimeJson(path.resolve(agentDir, 'state'));
  const tmuxSession = runtime && typeof runtime.tmux_session === 'string' ? runtime.tmux_session : '';
  // Unreadable state or no recorded session → no resident claim, full framing (fail-open).
  if (!tmuxSession) return false;
  return tmuxSessionAlive(tmuxSession);
}

// The name a peer must address to reach the resident. `peer_name` is only the
// name the resident *requested* at boot — Claude Code renames a session that
// collides with a live one already holding it, so the registry entry's own
// `name` is authoritative and `peer_name` is the fallback for a resident that
// booted before the `session_pid` stamp existed (or on a host whose registry
// can't be validated). The registry is read under the resident's own recorded
// config dir: a guest may have been launched with a different CLAUDE_CONFIG_DIR.
// Empty means there is no addressable resident.
function residentPeerName(agentDir: string): string {
  const runtime = readRuntimeJson(path.resolve(agentDir, 'state'));
  if (!runtime) return '';
  const configDir = typeof runtime.config_dir === 'string' && runtime.config_dir ? runtime.config_dir : undefined;
  const registered = findResident(runtime, configDir);
  if (registered && typeof registered.name === 'string' && registered.name) return registered.name;
  return typeof runtime.peer_name === 'string' ? runtime.peer_name : '';
}

// Keep the guest injection short because a guest session is here to do
// ordinary work, not to be briefed on the hermit.
function emitGuestBanner(agentDir: string): void {
  // One liveness check, not two: it spawns `tmux has-session`, and asking twice
  // also lets the resident die between the two answers and print a banner that
  // claims a running resident with no name to address.
  if (residentSessionActive(agentDir)) {
    const peerName = residentPeerName(agentDir);
    console.log(`---Guest Session--- A managed hermit session is already running here.${peerName ? ` Resident: @${safe(peerName)}. SendMessage it GUEST_REPORT: when finished.` : ''} Work normally; resident duties belong to the hermit.`);
  } else {
    console.log('---Guest Session--- Start the resident with .claude-code-hermit/bin/hermit-start.');
  }
}

// --- Launch stamp: the session's own auth environment -------------------
// The watchdog diagnoses this session from a systemd unit / launchd job / cron
// entry whose only injected variable is PATH, so its own `process.env` describes
// the watchdog, not the hermit. Reading CLAUDE_CONFIG_DIR there resolves to
// ~/.claude and a token-mode hermit with a custom config dir looks like a
// /login hermit; reading ANTHROPIC_API_KEY there is always empty and an
// API-key hermit's 401 looks like an expired login.
//
// A SessionStart hook is the exact witness: it runs inside the session, so it
// sees the environment Claude Code actually resolved — including the value from
// user or managed settings' `env` block, which never passes through hermit-start
// at all (probed on CC 2.1.251: user-settings CLAUDE_CONFIG_DIR re-points
// .credentials.json, and the hook inherits the resolved value).
//
// Only the managed session stamps: HERMIT_MANAGED=1 is set solely by
// hermit-start's tmux env-file, so a hand-launched session in the same folder
// never overwrites the resident's record. No secret is written — a path and a
// boolean.
//
// HERMIT_MANAGED alone is not enough, though: it is an exported shell variable,
// so any `claude` the resident itself launches from its own pane inherits it and
// would stamp itself as the resident — repointing all five fields, including the
// wake socket and the session id the watchdog's hygiene tiers judge context by.
// The incumbency check below is the discriminator: a live registry entry at a pid
// that is not this hook's parent means someone else already holds the stamp.
//
// hermit-start rewrites runtime.json moments after spawning tmux, seconds before
// Claude Code boots and fires this hook; both sides read-modify-write, so the
// later write preserves the earlier one's fields.
function stampSessionEnv(stateDir: string, sessionId: string | null): void {
  if (process.env.HERMIT_MANAGED !== '1') return;
  try {
    const runtime = readRuntimeJson(stateDir);
    if (runtime === null) return; // no lifecycle record yet — hermit-start owns creating it
    // A live claude already holds the stamp and it isn't me → a session the resident
    // launched, not the resident. A restarted resident's dead predecessor is dropped by
    // the registry, so a reboot stamps freely (see ownsResidentIdentity).
    if (!ownsResidentIdentity(runtime)) return;
    const configDir = defaultConfigDir();
    const envAuth = envAuthPresent();
    // The session's own inbox socket, exported by Claude Code before any hook
    // runs. Stamping it here is what lets the watchdog wake this session
    // over the socket instead of typing into its pane. The registry at
    // <config dir>/sessions/<pid>.json carries the same path, but finding the
    // right entry there means disambiguating the resident from any guest session
    // in the same folder; the resident writing its own path is exact by
    // construction. `session_pid` is that registry entry's filename — the hook is
    // spawned directly by Claude Code (argv form in hooks.json, no shell between),
    // so ppid is the claude process.
    const inboxSocket = process.env.CLAUDE_CODE_MESSAGING_SOCKET || null;
    const sessionPid = process.ppid;
    // The resident's own Claude Code session id. `session_id` holds the S-NNN work-arc
    // label (session-archive.ts) and is null between arcs, so it can't identify which
    // harness session the resident is — and the hygiene tiers were falling back to
    // sessions/.status.json, which every session in the folder overwrites on Stop.
    // Under HERMIT_MANAGED this hook IS the resident, so the payload id is exact.
    const ccSessionId = sessionId || null;
    // All five describe the launch, so every later SessionStart (resume, compact)
    // recomputes the same values; /clear mints a new session id, which is a real
    // change and must be written. Skip the write when nothing moved:
    // writeRuntimeJson stamps updated_at, and refreshing that on the strength of a
    // compaction alone would hide a wedged session from doctor's stale-session
    // check. stampContextReset in lib/context-reset.ts avoids the same hazard by
    // writing around the helper.
    if (
      runtime.config_dir === configDir &&
      runtime.env_auth === envAuth &&
      runtime.inbox_socket === inboxSocket &&
      runtime.session_pid === sessionPid &&
      runtime.cc_session_id === ccSessionId
    ) {
      return;
    }
    runtime.config_dir = configDir;
    runtime.env_auth = envAuth;
    runtime.inbox_socket = inboxSocket;
    runtime.session_pid = sessionPid;
    runtime.cc_session_id = ccSessionId;
    writeRuntimeJson(runtime, stateDir);
  } catch {
    // fail-open — the watchdog falls back to its own env, and to typing, when the
    // fields are absent
  }
}

function main(source: string | null, sessionId: string | null) {
  const stateDir = path.resolve(AGENT_DIR, 'state');
  stampSessionEnv(stateDir, sessionId);
  pruneGuestMarkers(stateDir);
  if (process.env.HERMIT_RESIDENT !== '1' || !ownsResidentIdentity(readRuntimeJson(stateDir))) {
    // The banner only reaches the model; the marker is what the state-writing
    // hooks read, since they run per turn with no model in the loop.
    markGuest(stateDir, sessionId);
    if (source !== 'compact') emitGuestBanner(AGENT_DIR);
    return;
  }
  // No resident but a marker from an earlier SessionStart of this same session id
  // (resume/compact reuse it; /clear mints a new one): this session is the resident now, so drop
  // the verdict rather than leave it silently muting its own liveness signal.
  clearGuest(stateDir, sessionId);
  seedOperatorActivity();
  if (source === 'compact') {
    emitCompactCapsule();
  } else {
    emitFullContext(source);
  }
  // Always — a full-path clean scan clears a prior warning; the compact path
  // merges (it only scanned the capsule) so it can't clear a real warning.
  persistScanRecord(source);
}

// Post-compaction path: the delta capsule is the ONLY injection. The native
// summary carries the narrative; full sections would re-inject up to HARD_CAP
// chars of state the session just paid to summarize.
function emitCompactCapsule(): void {
  try {
    const pointers = buildCompactionPointers(AGENT_DIR);
    if (!pointers) return;
    const header = '---Compaction Pointers---\n';
    const maxBody = COMPACT_CAP - header.length - 1;
    if (pointers.length <= maxBody) {
      process.stdout.write(header + pointers + '\n');
      return;
    }
    // Truncated: cut back to the last complete line rather than emit a
    // garbled partial one; drop entirely when even the first line doesn't fit.
    // maxBody + 1 so a line whose terminator sits exactly at maxBody still
    // counts as fitting — slicing at maxBody would hide it and drop the line.
    const sliced = pointers.slice(0, maxBody + 1);
    const cut = sliced.lastIndexOf('\n');
    if (cut <= 0) return;
    process.stdout.write(header + sliced.slice(0, cut) + '\n');
  } catch {
    // fail-open — a broken capsule must never block startup
  }
}

function emitFullContext(source: string | null) {
  let totalChars = 0;

  function emit(label: string, content: string): void {
    if (totalChars >= HARD_CAP) return;
    const header = `---${label}---\n`;
    // Subtract 1 for the trailing newline written after body
    const available = HARD_CAP - totalChars - header.length - 1;
    if (available <= 0) return;
    let body = content;
    if (body.length > available) {
      body = body.slice(0, available - 15) + '\n[...truncated]';
    }
    process.stdout.write(header + body + '\n');
    totalChars += header.length + body.length + 1;
  }

  const lang = operatorLanguage(AGENT_DIR);
  if (lang) {
    emit('Operator Preferences', `operator_language: ${safe(lang)}\nAll operator-facing prose uses this language.`);
  }

  // -------------------------------------------------------
  // 1. Operator context (priority 1, budget 2000)
  // -------------------------------------------------------
  const operatorPath = path.resolve(AGENT_DIR, 'OPERATOR.md');
  try {
    const lines = fs.readFileSync(operatorPath, 'utf-8').split('\n').slice(0, 50).join('\n');
    if (lines.trim()) {
      emit('Operator Context (OPERATOR.md)', guarded('OPERATOR.md', lines.slice(0, BUDGETS.operator)));
    }
  } catch {
    // No OPERATOR.md — skip silently
  }

  // -------------------------------------------------------
  // 2. Remove stale eval hash (was done inline in the bash hook)
  // -------------------------------------------------------
  try { fs.unlinkSync(path.resolve(AGENT_DIR, 'sessions', '.eval-hash')); } catch {}

  // -------------------------------------------------------
  // 3. Active session (priority 2, budget 3000)
  // -------------------------------------------------------
  const shellPath = path.resolve(AGENT_DIR, 'sessions', 'SHELL.md');
  let shellContent: string | null = null;
  try {
    shellContent = fs.readFileSync(shellPath, 'utf-8');
  } catch {}

  let hasActiveSession = false;
  if (shellContent === null) {
    emit('Active Session', 'No active session');
  } else {
    const parts: string[] = [];

    // stripPlaceholders, not startsWith('<!--') — see its doc comment in md-write.ts.
    const task = stripPlaceholders(extractSection(shellContent, 'Task') ?? '');
    if (task) {
      parts.push(`## Task\n${task}`);
    }

    const progressRaw = stripPlaceholders(extractSection(shellContent, 'Progress Log') ?? '');
    if (progressRaw) {
      const recent = lastLines(progressRaw, 10);
      parts.push(`## Progress Log (last 10)\n${recent}`);
    }

    const blockers = dropResolvedBlockers(dropBulletResidue(stripPlaceholders(extractSection(shellContent, 'Blockers') ?? '')));
    if (blockers) {
      parts.push(`## Blockers\n${blockers}`);
    }

    const monitoringRaw = stripPlaceholders(extractSection(shellContent, 'Monitoring') ?? '');
    if (monitoringRaw) {
      const monLines = monitoringRaw.split('\n').filter(l => l.trim() && (l.startsWith('- ') || l.startsWith('[')));
      if (monLines.length > 0) {
        parts.push(`## Monitoring (last 5)\n${monLines.slice(-5).join('\n')}`);
      }
    }

    const findingsRaw = dropBulletResidue(stripPlaceholders(extractSection(shellContent, 'Findings') ?? ''));
    if (findingsRaw) {
      parts.push(`## Findings (last 5)\n${lastLines(findingsRaw, 5).slice(0, 600)}`);
    }

    const sessionOutput = parts.join('\n\n');
    if (sessionOutput.trim()) {
      hasActiveSession = true;
      emit('Active Session', guarded('sessions/SHELL.md', sessionOutput.slice(0, BUDGETS.session)));
    } else {
      emit('Active Session', 'Session file exists but has no actionable content');
    }
  }

  // -------------------------------------------------------
  // 4. Compiled knowledge (priority 2.5, budget from config — default 2500)
  // -------------------------------------------------------
  if (totalChars < HARD_CAP) {
    try {
      let knowledgeBudget = BUDGETS.knowledge;
      try {
        const config = readSettledConfig(AGENT_DIR);
        if (config.knowledge && typeof config.knowledge.compiled_budget_chars === 'number') {
          knowledgeBudget = config.knowledge.compiled_budget_chars;
        }
      } catch {}

      // Clamp to remaining headroom so a maxed compiled budget doesn't crowd lower-priority
      // sections (cost, report, upgrade). Operator and session emit first and are already safe.
      knowledgeBudget = Math.min(knowledgeBudget, HARD_CAP - totalChars);

      const compiledDir = path.resolve(AGENT_DIR, 'compiled');
      const compiledFiles = globDir(compiledDir, /^[^.].*\.md$/);

      if (compiledFiles.length > 0) {
        // Single read per file: frontmatter + body in one pass
        const artifacts: Json[] = compiledFiles
          .map(f => {
            const r = readFileWithFrontmatter(f);
            return r && r.fm && r.fm.created
              ? { file: f, fm: r.fm, body: r.body, basename: path.basename(f, '.md') }
              : null;
          })
          .filter(Boolean);

        if (artifacts.length > 0) {
          const dateOf = (a: Json) =>
            (typeof a.fm.updated === 'string' && a.fm.updated) || a.fm.created || '';

          // All foundational artifacts pin full bodies (no per-type collapse — multiple
          // foundational topic pages must co-pin). Everything else gets a catalog line.
          // procedure-briefs are transient audit records, declared not-session-injected
          // in the schema — excluded from the catalog.
          const pinned = artifacts
            .filter(a => (a.fm.tags || []).includes('foundational'))
            .sort((a, b) => dateOf(b).localeCompare(dateOf(a)));
          const rest = artifacts
            .filter(a => !(a.fm.tags || []).includes('foundational')
              && a.fm.type !== 'procedure-brief')
            .sort((a, b) => dateOf(b).localeCompare(dateOf(a)));

          const pinnedBudget = Math.floor(knowledgeBudget * 0.4);

          const parts: string[] = [];
          emitArtifacts(pinned, pinnedBudget,
            a => `[${a.fm.type || 'artifact'}] ${a.fm.title || a.basename}\n`,
            parts);

          // Unused pinned budget rolls into the catalog — with few or no foundational
          // pages, the 40% reservation would otherwise be dead weight.
          const pinnedUsed = parts.reduce((s, p) => s + p.length, 0);
          const catalogBudget = knowledgeBudget - Math.min(pinnedBudget, pinnedUsed);

          // Catalog: pointers, not bodies — depth on demand via /recall or Read.
          if (rest.length > 0) {
            const intro = 'Catalog — Read compiled/<file>.md for full content:';
            const catLines: string[] = [];
            let used = intro.length + 1;
            for (const a of rest) {
              const date = dateOf(a).slice(0, 10);
              const tags = (Array.isArray(a.fm.tags) ? a.fm.tags : [])
                .map((t: string) => `#${t}`).join(' ');
              const summary = typeof a.fm.summary === 'string' && a.fm.summary.trim()
                ? a.fm.summary.trim()
                : (typeof a.fm.title === 'string' ? a.fm.title : '');
              let entry = `- ${a.basename} [${a.fm.type || 'artifact'}]`
                + (date ? ` (${date})` : '') + (tags ? ` ${tags}` : '');
              if (summary) entry += `\n  ${summary.slice(0, 100)}`;
              const blockReason = checkThreat(`compiled/${a.basename}.md`, entry);
              entry = blockReason
                ? `- ${a.basename} [BLOCKED: ${blockReason}]`
                : safeForLLMMultiline(entry);
              if (used + entry.length + 1 > catalogBudget) break;
              catLines.push(entry);
              used += entry.length + 1;
            }
            if (catLines.length > 0) {
              if (catLines.length < rest.length) catLines.push(`(+${rest.length - catLines.length} more)`);
              parts.push([intro, ...catLines].join('\n'));
            }
          }

          if (parts.length > 0) {
            emit('Compiled Knowledge', parts.join('\n'));
          }
        }
      }
    } catch {
      // skip on unexpected errors
    }
  }

  // -------------------------------------------------------
  // 5. Storage drift (priority 2.8, budget 500 — silent when clean)
  // -------------------------------------------------------
  if (totalChars < HARD_CAP) {
    try {
      const hits = findStorageDrift(AGENT_DIR);
      if (hits.length > 0) {
        const lines = hits.slice(0, 5).map(h => `- ${h}`).join('\n');
        const suffix = hits.length > 5 ? `\n(${hits.length - 5} more)` : '';
        const body = `${hits.length} path${hits.length !== 1 ? 's' : ''} invisible to session injection and archival:\n${lines}${suffix}\nMove files into .claude-code-hermit/raw/ or compiled/ (flat).`;
        emit('Storage Drift', body.slice(0, BUDGETS.storageDrift));
      }
    } catch {}
  }

  // -------------------------------------------------------
  // 5b. Schema drift (priority 2.9, budget 400 — silent when clean or no schema)
  // -------------------------------------------------------
  if (totalChars < HARD_CAP) {
    try {
      const drifts = findSchemaDrift(AGENT_DIR);
      if (drifts.length > 0) {
        const lines = drifts.map(({ type, example }) => `- \`${type}\` (e.g. compiled/${example})`).join('\n');
        const body = `${drifts.length} undeclared type${drifts.length !== 1 ? 's' : ''} in compiled/ — add to knowledge-schema.md ## Work Products:\n${lines}`;
        emit('Schema Drift', body.slice(0, BUDGETS.schemaDrift));
      }
    } catch {}
  }

  // -------------------------------------------------------
  // 6. Last report (priority 4, budget 1500) — skipped on resume with an
  //    active SHELL.md: the resumed transcript already contains the report.
  // -------------------------------------------------------
  if (totalChars < HARD_CAP && !(source === 'resume' && hasActiveSession)) {
    try {
      const sessionsDir = path.resolve(AGENT_DIR, 'sessions');
      const reports = fs.readdirSync(sessionsDir)
        .filter(f => /^S-\d+-REPORT\.md$/.test(f))
        .sort()
        .reverse();

      if (reports.length > 0) {
        const reportPath = path.join(sessionsDir, reports[0]);
        const parsed = readFileWithFrontmatter(reportPath);
        const fm = parsed?.fm;
        const reportContent = parsed?.content ?? fs.readFileSync(reportPath, 'utf-8');

        let reportExcerpt = `[${reports[0]}]\n`;
        if (fm && Object.prototype.hasOwnProperty.call(fm, 'next_start')) {
          // New-format report: the frontmatter row is the index — skip the
          // Overview body entirely.
          reportExcerpt += `status=${fm.status || 'unknown'} ${fm.task || ''}`.trimEnd();
          if (fm.next_start) reportExcerpt += `\nnext: ${fm.next_start}`;
          // The report's blockers row keeps resolved entries as `[resolved] <text>` —
          // that is the record. Naming one here would hand the next session a blocker
          // the last one cleared, which is the whole failure the mark exists to stop.
          const blockers = (Array.isArray(fm.blockers) ? fm.blockers : [])
            .filter((b: string) => !isResolvedBlockerLine(b));
          if (blockers.length > 0) {
            const extra = blockers.length > 1 ? ` (+${blockers.length - 1} more)` : '';
            reportExcerpt += `\nblockers: ${blockers[0]}${extra}`;
          }
        } else {
          // Legacy report — no structured fields, fall back to the Overview body.
          const overview = extractSection(reportContent, 'Overview');
          if (overview && overview.trim()) {
            reportExcerpt += `## Overview\n${overview.trimEnd()}`;
          } else {
            // No Overview header — emit first 20 lines
            reportExcerpt += reportContent.split('\n').slice(0, 20).join('\n');
          }
        }

        emit('Last Report', guarded(`sessions/${reports[0]}`, reportExcerpt.slice(0, BUDGETS.report)));
      } else {
        emit('Last Report', 'No previous sessions');
      }
    } catch {
      emit('Last Report', 'No previous sessions');
    }
  }

  // -------------------------------------------------------
  // 7. Upgrade check (priority 5, budget 500)
  // -------------------------------------------------------
  if (totalChars < HARD_CAP) {
    try {
      const out = execSync(
        `bash "${path.join(PLUGIN_ROOT, 'scripts', 'check-upgrade.sh')}" "${PLUGIN_ROOT}"`,
        { encoding: 'utf-8', timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'] }
      ).trim();
      if (out) emit('Upgrade Check', out.slice(0, BUDGETS.upgrade));
    } catch {
      // Non-fatal
    }
  }

}

// Persist scan record. A full-path scan is comprehensive, so it overwrites —
// empty hits legitimately clear a prior warning. The compact path only scanned
// the delta capsule (task/progress), so it MERGES with the existing record
// rather than overwriting: a compaction must never clear a warning a prior full
// scan recorded for OPERATOR.md/compiled/report. The next full start re-scans
// comprehensively and overwrites, self-healing any stale merged hit.
function persistScanRecord(source: string | null): void {
  try {
    const stateDir = path.resolve(AGENT_DIR, 'state');
    fs.mkdirSync(stateDir, { recursive: true });
    const scanPath = path.join(stateDir, 'context-scan.json');
    let hits = scanHits;
    if (source === 'compact') {
      try {
        const prev = JSON.parse(fs.readFileSync(scanPath, 'utf-8'));
        const prevHits: { source: string; reason: string }[] = Array.isArray(prev.hits) ? prev.hits : [];
        const seen = new Set(hits.map(h => `${h.source}\0${h.reason}`));
        hits = hits.concat(prevHits.filter(h => !seen.has(`${h.source}\0${h.reason}`)));
      } catch {}
    }
    const tmp = scanPath + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ ts: new Date().toISOString(), hits }, null, 2) + '\n', { encoding: 'utf-8', mode: 0o600 });
    fs.renameSync(tmp, scanPath);
  } catch {}
}

if (import.meta.main) {
  // main() must run exactly once. It runs when stdin reaches EOF (the normal hook
  // path, carrying the `source` field) — but if stdin never closes (TTY, unpiped
  // invocation, a held-open pipe), a short fallback still emits the source-less
  // startup context rather than silently injecting nothing at all.
  let ran = false;
  const runOnce = (source: string | null, sessionId: string | null): void => {
    if (ran) return;
    ran = true;
    try { main(source, sessionId); } catch { /* fail-open */ }
  };
  try {
    let buf = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => { buf += chunk; });
    process.stdin.on('error', () => {});
    const fallback = setTimeout(() => runOnce(null, null), 2000);
    process.stdin.on('end', () => {
      clearTimeout(fallback); // normal path — no need to wait out the fallback
      let source: string | null = null;
      let sessionId: string | null = null;
      try {
        const payload = JSON.parse(buf);
        if (payload && typeof payload.source === 'string') source = payload.source;
        if (payload && typeof payload.session_id === 'string') sessionId = payload.session_id;
      } catch { /* empty/non-JSON stdin — treat as unknown source */ }
      runOnce(source, sessionId);
    });
  } catch {
    runOnce(null, null);
  }
}
