'use strict';

const fs = require('fs');
const path = require('path');

/**
 * Stop hook — checks routine-queue.json for pending routines that never ran.
 * Logs missed routines to SHELL.md so the next session knows what was skipped.
 */

const QUEUE_FILE = path.resolve('.claude-code-hermit/state/routine-queue.json');
const SHELL_FILE = path.resolve('.claude-code-hermit/sessions/SHELL.md');
const MAX_STDIN = 64 * 1024;

// Core flush logic — synchronous, no stdin.
function _flush() {
  try {
    let queue;
    try {
      queue = JSON.parse(fs.readFileSync(QUEUE_FILE, 'utf8'));
    } catch {
      return; // Missing or invalid — nothing to flush
    }

    const pending = Array.isArray(queue) ? queue : (Array.isArray(queue?.queued) ? queue.queued : []);
    if (pending.length === 0) return;

    let shell;
    try {
      shell = fs.readFileSync(SHELL_FILE, 'utf8');
    } catch {
      process.stderr.write(
        `[routine-flush] ${pending.length} queued routine(s) never ran: ${pending.map(r => r.id || r.skill).join(', ')}\n`
      );
      return;
    }

    const now = new Date().toISOString().slice(11, 16);
    const lines = pending.map(r => {
      const id = r.id || 'unknown';
      const since = r.queued_since || 'unknown';
      return `- \`${id}\` (queued since ${since})`;
    });
    const note = `\n[${now}] **Missed routines at shutdown:** ${pending.length} routine(s) were queued but never ran:\n${lines.join('\n')}\n`;

    const progressIdx = shell.indexOf('## Progress Log');
    if (progressIdx !== -1) {
      const nextSection = shell.indexOf('\n## ', progressIdx + 1);
      const insertAt = nextSection !== -1 ? nextSection : shell.length;
      const updated = shell.slice(0, insertAt) + note + shell.slice(insertAt);
      fs.writeFileSync(SHELL_FILE, updated);
    } else {
      fs.appendFileSync(SHELL_FILE, '\n' + note);
    }

    process.stderr.write(
      `[routine-flush] Logged ${pending.length} missed routine(s) to SHELL.md\n`
    );
  } catch (e) {
    process.stderr.write(`[routine-flush] Error: ${e.message}\n`);
  }
}

// Exported run() function for use by stop-pipeline.js.
// Synchronous — no stdin reading needed.
function run(_payload) {
  _flush();
}

module.exports = { run };

if (require.main === module) {
  // Standalone: consume stdin (avoid broken pipe), then flush
  let raw = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => {
    raw += chunk;
    if (raw.length > MAX_STDIN) process.exit(0);
  });
  process.stdin.on('end', () => {
    _flush();
  });
}
