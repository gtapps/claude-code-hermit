// UserPromptSubmit hook — deterministic status responder.
//
// When the inbound prompt is a <channel> envelope whose body is exactly
// "status" (trimmed, case-insensitive) and the sender passes the channel's
// allowed_users gate, formats an operator-language status reply from
// read-only state (pause, session status, budget, pending approvals, next
// routine) and sends it directly via lib/channel-send — bypassing the model
// entirely. This is the one case a model-composed reply can't cover: a
// paused session can speak but can't Read, so any model-answered status
// while paused would be blind.
//
// Send-then-block: only emits {"decision":"block"} after a confirmed
// successful send, so a failed send always falls through to a normal model
// turn — never "blocked prompt + failed send = silence".
//
// Near-miss bodies and mid-turn arrivals (which never reach UserPromptSubmit
// at all — CC delivers them as steering on an in-flight turn) fall through
// untouched: this hook only ever acts on an exact idle "status" request.

import fs from 'node:fs';
import path from 'node:path';
import { hermitDir } from './lib/cc-compat';
import { parseChannelEnvelope } from './lib/channel-envelope';
import { loadConfig, isAllowedSender } from './lib/channel-auth';
import { isPaused, pauseReasonLabel } from './lib/pause';
import { costIndexPath, readCostIndex } from './lib/cost-log';
import { todayYMD, thisWeekKey, thisMonthYYYYMM, currentHHMM, parseSimpleCronTime } from './lib/time';
import { wallMinutes } from './cron-tz-shift';
import { sendToChannel } from './lib/channel-send';

type Json = any;

function readJson(p: string): Json | null {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

function money(n: number): string {
  return `$${n.toFixed(2)}`;
}

function resolveTimezone(config: Json): string {
  return typeof config?.timezone === 'string' && config.timezone ? config.timezone : 'UTC';
}

function pauseLine(dir: string, timezone: string): string | null {
  const status = isPaused(dir);
  if (!status.paused) return null;
  const label = pauseReasonLabel(status.reason);
  const hhmm = status.until ? currentHHMM(timezone, new Date(status.until)) : null;
  if (!hhmm) return `Paused (${label}) until you resume it.`;
  return `Paused (${label}) until ${hhmm}.`;
}

function taskLine(dir: string): string | null {
  const status = readJson(path.join(dir, 'sessions', '.status.json'));
  if (!status) return null;
  if (typeof status.task === 'string' && status.task) return `Working on ${status.task}.`;
  if (status.status === 'idle') return 'Idle — nothing in progress.';
  return null;
}

// Reports the first cap set, in daily > weekly > monthly precedence — the
// shortest configured window is what an operator checking in mid-day cares
// about first.
function budgetLine(dir: string, config: Json, timezone: string): string | null {
  const budget = config?.budget;
  if (!budget) return null;
  const candidates: Array<['daily' | 'weekly' | 'monthly', number | null]> = [
    ['daily', typeof budget.daily_usd === 'number' ? budget.daily_usd : null],
    ['weekly', typeof budget.weekly_usd === 'number' ? budget.weekly_usd : null],
    ['monthly', typeof budget.monthly_usd === 'number' ? budget.monthly_usd : null],
  ];
  const active = candidates.find(([, cap]) => cap !== null);
  if (!active) return null;
  const [period, cap] = active;
  if (cap === null) return null;

  // A cap can be configured before any spend is ever logged — a missing/absent
  // cost-index means zero spend so far, not "nothing to report".
  const idx = readCostIndex(costIndexPath(dir));
  const spend = period === 'daily' ? idx?.by_date?.[todayYMD(timezone)]?.cost || 0
    : period === 'weekly' ? idx?.by_week?.[thisWeekKey(timezone)]?.cost || 0
    : idx?.by_month?.[thisMonthYYYYMM(timezone)]?.cost || 0;
  const label = period === 'daily' ? 'Today' : period === 'weekly' ? 'This week' : 'This month';
  return `${label}: ${money(spend)} of ${money(cap)} cap.`;
}

// Only worth a line when something is actually pending — an empty queue
// shouldn't crowd out the "all quiet" fallback in composeStatusReply.
function approvalsLine(dir: string): string | null {
  const mp = readJson(path.join(dir, 'state', 'micro-proposals.json'));
  const pending = Array.isArray(mp?.pending) ? mp.pending.filter((p: Json) => p?.status === 'pending') : [];
  if (pending.length === 0) return null;
  if (pending.length === 1) {
    const id = typeof pending[0].id === 'string' ? pending[0].id : 'the pending item';
    return `1 approval waiting (reply "${id} yes/no").`;
  }
  return `${pending.length} approvals waiting.`;
}

function nextRoutineLine(config: Json, timezone: string): string | null {
  const routines = Array.isArray(config?.routines) ? config.routines : [];
  const now = wallMinutes(timezone, new Date());
  if (now === null) return null;

  let best: { id: string; hour: number; minute: number; delta: number } | null = null;
  for (const r of routines) {
    if (!r || r.enabled === false || typeof r.schedule !== 'string') continue;
    const fireTime = parseSimpleCronTime(r.schedule);
    if (!fireTime) continue;
    let delta = fireTime.hour * 60 + fireTime.minute - now;
    if (delta < 0) delta += 24 * 60;
    if (!best || delta < best.delta) best = { id: String(r.id ?? 'routine'), hour: fireTime.hour, minute: fireTime.minute, delta };
  }
  if (!best) return null;
  const hh = String(best.hour).padStart(2, '0');
  const mm = String(best.minute).padStart(2, '0');
  return `Next routine: ${hh}:${mm} (${best.id}).`;
}

export function composeStatusReply(dir: string, config: Json): string {
  const timezone = resolveTimezone(config);
  const lines: string[] = [];

  const pause = pauseLine(dir, timezone);
  if (pause) lines.push(pause);

  const task = taskLine(dir);
  if (task) lines.push(task);

  const budget = budgetLine(dir, config, timezone);
  if (budget) lines.push(budget);

  const approvals = approvalsLine(dir);
  if (approvals) lines.push(approvals);

  const routine = nextRoutineLine(config, timezone);
  if (routine) lines.push(routine);

  if (lines.length === 0) return 'All quiet — nothing in progress, nothing waiting.';
  return lines.join(' ');
}

async function main(raw: string): Promise<void> {
  let payload: Json;
  try {
    payload = JSON.parse(raw);
  } catch {
    return;
  }

  const prompt = payload && typeof payload.prompt === 'string' ? payload.prompt : null;
  if (!prompt) return;

  const envelope = parseChannelEnvelope(prompt);
  if (!envelope) return;

  // Exact-match only — near-misses fall through to the model (probe-verified).
  if (envelope.body.trim().toLowerCase() !== 'status') return;

  const dir = hermitDir();
  const config = loadConfig(dir);
  if (!config) return;

  if (!isAllowedSender(config, envelope.source, envelope.userId)) return;

  const reply = composeStatusReply(dir, config);
  // Reply to the chat the request arrived on — not the globally-resolved
  // outbound channel — so a status asked in a group or a non-primary channel is
  // answered where it was asked (the model reply path already targets the origin
  // chat_id). This also keeps the destination aligned with the allowed_users gate
  // above, which is checked against the inbound channel. A tight timeout bounds
  // this hook's blocking; on any failure we emit nothing and the model answers.
  const result = await sendToChannel(dir, reply, {
    target: { id: envelope.source, chat_id: envelope.chatId },
    timeoutMs: 6000,
  });
  if (result.ok) {
    console.log(JSON.stringify({ decision: 'block', reason: 'status answered deterministically' }));
  }
  // On failure: print nothing — the prompt falls through and the model answers normally.
}

try {
  let buf = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => { buf += chunk; });
  process.stdin.on('error', () => {});
  process.stdin.on('end', () => {
    main(buf)
      .catch(() => {})
      .finally(() => process.exit(0));
  });
} catch {
  process.exit(0);
}
