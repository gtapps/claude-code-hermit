'use strict';

process.stdout.on('error', () => {});

// UserPromptSubmit + SessionStart hook — records when an operator prompt is received.
// Writes state/last-operator-action.json so heartbeat-precheck.js can gate AUTO_CLOSE
// on genuine operator silence rather than SHELL.md mtime (which routine writes reset).
//
// Filtered (not operator activity):
//   [hermit-routine:…   — cron-delivered routine prompts (hermit-routines/SKILL.md:43-54)
//   /claude-code-hermit:heartbeat run (bare, no <command-message>) — /loop re-fires
//   <channel…           — unauthorized DMs arrive here before channel-responder's allowlist
//                          check; recording them would let bot traffic suppress AUTO_CLOSE
//
// SessionStart has no payload.prompt — writes unconditionally to give each session
// a fresh 12h AUTO_CLOSE window regardless of prior operator-quiet time.

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
  // /loop re-fires arrive as a bare command string; operator-typed invocations carry
  // a <command-message>…</command-message> wrapper — pass those through.
  if (t.startsWith('/claude-code-hermit:heartbeat run') && !prompt.includes('<command-message>')) return true;
  return false;
}

function main(raw) {
  let prompt = null;
  try {
    const payload = JSON.parse(raw);
    if (payload && typeof payload.prompt === 'string') prompt = payload.prompt;
  } catch { /* not JSON or empty — SessionStart path; treat as operator activity */ }

  if (prompt === null || !isRoutinePrompt(prompt)) write();
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
