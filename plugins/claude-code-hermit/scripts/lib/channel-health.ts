// Advisory per-channel send-health signal (state/channel-health.json), written by
// lib/channel-send on every actual send attempt and read by ask-gate to decide
// whether a configured channel is actually reachable before denying an
// AskUserQuestion toward it. "Configured" is not "reachable": with a revoked bot
// token, resolve-outbound-channel still returns a target, so without this the gate
// would deny the question and redirect it to a dead channel — stranding it.
//
// Advisory only: best-effort atomic write, last-writer-wins across the few
// processes that send (Stop-hook budget alert, watchdog tick, status hook). An
// occasional lost update just delays the heuristic by one send; it self-corrects.

import fs from 'node:fs';
import path from 'node:path';

type Json = any;

export function channelHealthPath(hermitDir: string): string {
  return path.join(hermitDir, 'state', 'channel-health.json');
}

function readAll(hermitDir: string): Json {
  try {
    const d = JSON.parse(fs.readFileSync(channelHealthPath(hermitDir), 'utf-8'));
    return d && typeof d === 'object' && !Array.isArray(d) ? d : {};
  } catch {
    return {};
  }
}

/** Record a send outcome for `channelId`. Never throws. */
export function recordChannelHealth(hermitDir: string, channelId: string, ok: boolean): void {
  try {
    const all = readAll(hermitDir);
    const prev = all[channelId] && typeof all[channelId] === 'object' ? all[channelId] : {};
    all[channelId] = ok
      ? { last_success_at: new Date().toISOString(), consecutive_failures: 0 }
      : { last_success_at: prev.last_success_at ?? null, consecutive_failures: (prev.consecutive_failures ?? 0) + 1 };
    const p = channelHealthPath(hermitDir);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const tmp = `${p}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(all, null, 2) + '\n', 'utf-8');
    fs.renameSync(tmp, p);
  } catch { /* advisory — never throw */ }
}

/**
 * True when `channelId` has failed `threshold`+ sends in a row with no success
 * since — i.e. it's configured but probably unreachable, so it shouldn't be
 * trusted as a redirect target for a question that would otherwise render in the
 * pane (where the watchdog stall backstop can catch it).
 */
export function channelLikelyDown(hermitDir: string, channelId: string, threshold = 3): boolean {
  const h = readAll(hermitDir)[channelId];
  return !!h && typeof h.consecutive_failures === 'number' && h.consecutive_failures >= threshold;
}
