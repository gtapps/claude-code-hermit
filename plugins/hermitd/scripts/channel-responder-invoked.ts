// PostToolUse Skill hook: resident-only evidence that the responder was invoked.
import path from 'node:path';
import { hermitDir, sessionId } from './lib/cc-compat';
import { isGuest } from './lib/guest-marker';
import { writeFileAtomic } from './lib/md-write';

function record(raw: string): void {
  const payload = JSON.parse(raw);
  if (payload?.hook_event_name !== 'PostToolUse' || payload.tool_name !== 'Skill') return;
  if (typeof payload.tool_input?.skill !== 'string'
    || !payload.tool_input.skill.endsWith('channel-responder')
    || payload.tool_response?.success !== true) return;
  const id = sessionId(payload);
  if (typeof id !== 'string' || !id) return;
  const stateDir = path.join(hermitDir(), 'state');
  if (isGuest(stateDir, id)) return;
  writeFileAtomic(path.join(stateDir, 'channel-responder-invoked.json'),
    JSON.stringify({ session_id: id, at: new Date().toISOString() }) + '\n');
}

// Drain even oversized input, but do not retain it or act on a truncated payload.
let raw = '';
let oversized = false;
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  if (oversized) return;
  raw += chunk;
  if (raw.length > 1024 * 1024) { oversized = true; raw = ''; }
});
process.stdin.on('error', () => {});
process.stdin.on('end', () => {
  try { if (!oversized) record(raw); } catch { /* fail open, no hook output */ }
  process.exit(0);
});
