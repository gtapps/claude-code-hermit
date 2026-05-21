'use strict';

process.stdout.on('error', () => {});

// UserPromptSubmit + SessionStart hook — records when an operator prompt is received.
// Writes state/last-operator-action.json so heartbeat-precheck.js can gate AUTO_CLOSE
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
//   /<anything> (bare, no <command-message>) — /loop re-fires, cron injections,
//                          programmatic slash invocations
//   <channel…           — unauthorized DMs arrive here before channel-responder's allowlist
//                          check; recording them would let bot traffic suppress AUTO_CLOSE

const fs = require('fs');
const path = require('path');

const AGENT_DIR = process.env.AGENT_DIR || '.claude-code-hermit';
const STATE_PATH = path.resolve(AGENT_DIR, 'state', 'last-operator-action.json');
const TMP_PATH   = path.resolve(AGENT_DIR, 'state', '.last-operator-action.json.tmp');

function write() {
  try {
    fs.writeFileSync(TMP_PATH, JSON.stringify({ at: new Date().toISOString() }) + '\n', 'utf-8');
    fs.renameSync(TMP_PATH, STATE_PATH);
  } catch { /* fail-open */ }
}

function isRoutinePrompt(prompt) {
  if (prompt.startsWith('[hermit-routine:')) return true;
  const t = prompt.trimStart();
  if (t.startsWith('<channel')) return true;
  // /loop re-fires and other programmatic slash injections arrive as bare strings.
  // Operator-typed slash commands always carry a <command-message> wrapper (verified
  // across CC v2.1.119–v2.1.145 transcripts). Drop any bare `/...` prompt.
  if (t.startsWith('/') && !prompt.includes('<command-message>')) return true;
  return false;
}

function main(raw) {
  let prompt = null;
  try {
    const payload = JSON.parse(raw);
    if (payload && typeof payload.prompt === 'string') prompt = payload.prompt;
  } catch { /* not JSON or empty — SessionStart path */ }

  if (prompt === null) {
    if (!fs.existsSync(STATE_PATH)) write();
    return;
  }

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
