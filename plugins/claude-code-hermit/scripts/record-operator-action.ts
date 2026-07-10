process.stdout.on('error', () => {});

// UserPromptSubmit + SessionStart hook — records when an operator prompt is received.
// Writes state/last-operator-action.json so heartbeat-precheck.ts can gate AUTO_CLOSE
// on genuine operator silence rather than SHELL.md mtime (which routine writes reset).
//
// Invocation modes:
//   (stdin) UserPromptSubmit — JSON payload with `prompt`. Filter applied, write if kept.
//   (stdin) SessionStart     — no `prompt` field. Seeds file only if absent (cold start).
//                              Avoids unattended restarts masking a vanished operator.
//   --force                  — unconditional write. Used by skills that know they're
//                              handling a genuine operator action (e.g. channel-responder
//                              after the allowlist check passes).
//
// Filtered prompts (not operator activity):
//   [hermit-routine:…   — cron-delivered routine prompts (hermit-routines/SKILL.md:43-54)
//   <channel…           — unauthorized DMs arrive here before channel-responder's allowlist
//                          check; recording them would let bot traffic suppress AUTO_CLOSE
//   hermit's own tmux-injected slash commands — see INJECTED_EXACT below. Every
//   other bare `/…` prompt counts as operator activity (see isRoutinePrompt).

import fs from 'node:fs';
import path from 'node:path';
import { hermitDir } from './lib/cc-compat';
import { appendUsageEvent } from './lib/usage-ledger';

const AGENT_DIR = hermitDir();
const STATE_PATH = path.join(AGENT_DIR, 'state', 'last-operator-action.json');
const TMP_PATH   = path.join(AGENT_DIR, 'state', '.last-operator-action.json.tmp');

function write() {
  try {
    fs.writeFileSync(TMP_PATH, JSON.stringify({ at: new Date().toISOString() }) + '\n', 'utf-8');
    fs.renameSync(TMP_PATH, STATE_PATH);
  } catch { /* fail-open */ }
}

// Hermit-injected slash prompts — tmux send-keys from hermit-watchdog.ts and
// hermit-stop.ts arrive at this hook as bare text, byte-identical to operator
// typing. A live probe (2026-07-10, CC v2.1.206) showed operator-typed slash
// commands ALSO arrive bare (no <command-message> wrapper reaches stdin), so
// there is no stdin-visible signal to key on: drop exactly our own known
// injections and count every other prompt as operator activity. Missing the
// operator is the destructive direction (mid-session /clear, AUTO_CLOSE);
// counting a stray programmatic prompt only delays cleanup.
// tests/auto-close.test.ts syncs this list against the actual sendKeys call
// sites — extend it when adding a new injection.
const INJECTED_EXACT = new Set([
  '/claude-code-hermit:heartbeat run',
  '/claude-code-hermit:heartbeat start',
  '/claude-code-hermit:heartbeat stop',
  '/claude-code-hermit:hermit-routines load',
  '/claude-code-hermit:session-close --shutdown',
]);

function isRoutinePrompt(prompt: string): boolean {
  if (prompt.startsWith('[hermit-routine:')) return true;
  const t = prompt.trim();
  if (t.startsWith('<channel')) return true;
  if (INJECTED_EXACT.has(t)) return true;
  // Watchdog hygiene injections (hermit-watchdog.ts:421,620,754). Native
  // commands may never reach this hook at all; dropping them is safe either
  // way — typing /clear or /compact ends a context, it doesn't signal presence.
  if (t === '/clear' || t.startsWith('/compact')) return true;
  return false;
}

// User-typed skill invocations bypass the Skill tool entirely (live-probed
// 2026-07-10: zero PostToolUse events fire), so scripts/usage-track.ts never
// sees them. This is the only capture point for that path.
//
// The raw UserPromptSubmit payload for an operator-typed slash command is the
// bare text as typed (e.g. "/claude-code-hermit:recall") — empirically
// verified 2026-07-10 (CC v2.1.206) via a raw-stdin capture. The
// <command-message>/<command-name> wrapper visible in stored transcripts is
// added later by CC's own prompt-expansion pipeline and never reaches this
// hook's stdin; an earlier design assumed otherwise by reading transcripts
// instead of the hook boundary, which was wrong.
//
// Restricted to the namespaced `plugin:skill` form (colon required) so
// native CC commands (/model, /clear, /effort, ...) — never namespaced —
// can't be mistaken for skill usage. This also means a bare, un-namespaced
// personal/project skill (e.g. /tackle-issue) isn't captured here; documented
// as a known gap rather than risking false "skill" entries from native
// commands. A path or prose that happens to start with "/" only matches if it
// has the exact "/word:word " shape, which is vanishingly rare.
const SLASH_COMMAND_RE = /^\/([a-zA-Z][a-zA-Z0-9_-]*:[a-zA-Z][a-zA-Z0-9_-]*)(?:\s|$)/;

function extractSkillName(prompt: string): string | null {
  const m = prompt.match(SLASH_COMMAND_RE);
  return m ? m[1] : null;
}

function appendSkillUsage(name: string): void {
  try {
    appendUsageEvent(AGENT_DIR, { ts: new Date().toISOString(), kind: 'skill', name, source: 'prompt' });
  } catch { /* fail-open */ }
}

function main(raw: string): void {
  let prompt: string | null = null;
  try {
    const payload = JSON.parse(raw);
    if (payload && typeof payload.prompt === 'string') prompt = payload.prompt;
  } catch { /* not JSON or empty — SessionStart path */ }

  if (prompt === null) {
    if (!fs.existsSync(STATE_PATH)) write();
    return;
  }

  const skillName = extractSkillName(prompt);
  if (skillName) appendSkillUsage(skillName);

  if (!isRoutinePrompt(prompt)) write();
}

if (process.argv.includes('--force')) {
  write();
  process.exit(0);
}

try {
  let buf = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => { buf += chunk; });
  process.stdin.on('error', () => {});
  process.stdin.on('end', () => {
    try { main(buf); } catch { /* fail-open */ }
    process.exit(0);
  });
} catch {
  process.exit(0);
}
