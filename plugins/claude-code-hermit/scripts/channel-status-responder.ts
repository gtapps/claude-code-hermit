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
import { loadConfig, isAllowedSender, isTrustedController } from './lib/channel-auth';
import { isPaused, pauseReasonLabel } from './lib/pause';
import { resolveTimezone, budgetLine } from './lib/spend-status';
import { friendlyBoundary, parseSimpleCronTime } from './lib/time';
import { wallMinutes } from './cron-tz-shift';
import { sendToChannel } from './lib/channel-send';
import { STATUS, resolveLocale, type Locale } from './lib/messages';

type Json = any;

function readJson(p: string): Json | null {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

function pauseLine(dir: string, timezone: string, locale: Locale): string | null {
  const status = isPaused(dir);
  if (!status.paused) return null;
  const label = pauseReasonLabel(status.reason, locale);
  // Dated form (not bare HH:MM) so a resume days/weeks out isn't read as minutes away.
  const valid = status.until != null && !isNaN(new Date(status.until).getTime());
  if (!valid) return STATUS[locale].pausedUntilResume(label);
  return STATUS[locale].pausedUntilDate(label, friendlyBoundary(status.until as string, timezone));
}

function taskLine(dir: string, locale: Locale): string | null {
  const status = readJson(path.join(dir, 'sessions', '.status.json'));
  if (!status) return null;
  if (typeof status.task === 'string' && status.task) return STATUS[locale].workingOn(status.task);
  if (status.status === 'idle') return STATUS[locale].idleNothing();
  return null;
}

// Only worth a line when something is actually pending — an empty queue
// shouldn't crowd out the "all quiet" fallback in composeStatusReply.
function approvalsLine(dir: string, locale: Locale): string | null {
  const mp = readJson(path.join(dir, 'state', 'micro-proposals.json'));
  const pending = Array.isArray(mp?.pending) ? mp.pending.filter((p: Json) => p?.status === 'pending') : [];
  if (pending.length === 0) return null;
  if (pending.length === 1) {
    const id = typeof pending[0].id === 'string' ? pending[0].id : 'the pending item';
    return STATUS[locale].oneApproval(id);
  }
  return STATUS[locale].nApprovals(pending.length);
}

// Cron day-of-week matcher (0=Sun..6=Sat; 7 also Sun). Supports '*', comma
// lists, and 'a-b' ranges — enough for the routine schedules. Anything
// unparseable defaults to matching, so a routine is never wrongly hidden.
function cronDowMatches(field: string, weekday: number): boolean {
  if (field === '*') return true;
  for (const tok of field.split(',')) {
    const range = tok.match(/^(\d+)-(\d+)$/);
    if (range) {
      const lo = parseInt(range[1], 10) % 7;
      const hi = parseInt(range[2], 10) % 7;
      if (lo <= hi ? weekday >= lo && weekday <= hi : weekday >= lo || weekday <= hi) return true;
      continue;
    }
    const n = parseInt(tok, 10);
    if (!isNaN(n) && n % 7 === weekday) return true;
  }
  return false;
}

// Weekday 0=Sun..6=Sat in `timezone`, or null on Intl failure.
function localWeekday(timezone: string): number | null {
  try {
    const wd = new Intl.DateTimeFormat('en-US', { timeZone: timezone, weekday: 'short' }).format(new Date());
    const map: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
    return wd in map ? map[wd] : null;
  } catch { return null; }
}

// Minutes from now until this routine's next fire, honoring its DOW field:
// scans today (offset 0) through the next week for the first matching weekday
// whose fire time hasn't already passed.
function minutesUntilNextFire(dowField: string, fireMin: number, nowMin: number, todayWeekday: number): number | null {
  for (let offset = 0; offset < 8; offset++) {
    const weekday = (todayWeekday + offset) % 7;
    if (!cronDowMatches(dowField, weekday)) continue;
    const delta = offset * 24 * 60 + fireMin - nowMin;
    if (delta >= 0) return delta;
  }
  return null;
}

function nextRoutineLine(config: Json, timezone: string, locale: Locale): string | null {
  const routines = Array.isArray(config?.routines) ? config.routines : [];
  const now = wallMinutes(timezone, new Date());
  if (now === null) return null;
  const weekday = localWeekday(timezone);
  if (weekday === null) return null;

  let best: { id: string; hour: number; minute: number; delta: number } | null = null;
  for (const r of routines) {
    if (!r || r.enabled === false || typeof r.schedule !== 'string') continue;
    const fireTime = parseSimpleCronTime(r.schedule);
    if (!fireTime) continue;
    const dowField = String(r.schedule).trim().split(/\s+/)[4] ?? '*';
    const delta = minutesUntilNextFire(dowField, fireTime.hour * 60 + fireTime.minute, now, weekday);
    if (delta === null) continue;
    if (!best || delta < best.delta) best = { id: String(r.id ?? 'routine'), hour: fireTime.hour, minute: fireTime.minute, delta };
  }
  if (!best) return null;
  const hh = String(best.hour).padStart(2, '0');
  const mm = String(best.minute).padStart(2, '0');
  return STATUS[locale].nextRoutine(hh, mm, best.id);
}

export function composeStatusReply(dir: string, config: Json, opts: { redact?: boolean } = {}): string {
  const timezone = resolveTimezone(config);
  const locale = resolveLocale(config?.language);
  const lines: string[] = [];

  const pause = pauseLine(dir, timezone, locale);
  if (pause) lines.push(pause);

  if (opts.redact) {
    // Unauthenticated sender on a no-allowlist channel: coarse state only — never
    // spend figures, task text, pending-approval IDs, or the routine schedule.
    const status = readJson(path.join(dir, 'sessions', '.status.json'));
    const working = !!status && ((typeof status.task === 'string' && status.task.length > 0) || status.status === 'in_progress');
    lines.push(working ? STATUS[locale].redactedWorking() : STATUS[locale].redactedIdle());
    return lines.join(' ');
  }

  const task = taskLine(dir, locale);
  if (task) lines.push(task);

  const budget = budgetLine(dir, config, timezone, locale);
  if (budget) lines.push(budget);

  const approvals = approvalsLine(dir, locale);
  if (approvals) lines.push(approvals);

  const routine = nextRoutineLine(config, timezone, locale);
  if (routine) lines.push(routine);

  if (lines.length === 0) return STATUS[locale].allQuiet();
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

  // Full status only for the trusted operator (explicit allowlist, or the DM chat
  // when no list is set); any other accepted sender gets a redacted, coarse reply.
  const trusted = isTrustedController(config, envelope.source, envelope.userId, envelope.chatId);
  const reply = composeStatusReply(dir, config, { redact: !trusted });
  // Reply to the chat the request arrived on — not the globally-resolved
  // outbound channel — so a status asked in a group or a non-primary channel is
  // answered where it was asked. This also keeps the destination aligned with the
  // allowed_users gate above. A tight timeout bounds this hook's blocking.
  const result = await sendToChannel(dir, reply, {
    target: { id: envelope.sourceKey, chat_id: envelope.chatId },
    timeoutMs: 6000,
  });
  if (result.ok) {
    console.log(JSON.stringify({ decision: 'block', reason: 'status answered deterministically' }));
    return;
  }

  // Deterministic delivery failed — an unsupported platform (iMessage/webhook aren't
  // in lib/channel-send's SENDERS) or a transient send error. Rather than fall through
  // to a blind model turn — which, while paused, can't Read state and would answer from
  // nothing — inject the already-composed (and redaction-correct) status as context and
  // have the model relay it verbatim via its channel reply tool (pause-gate exempts that
  // tool). Not a block, so the model's turn proceeds. Probe-verified that a
  // UserPromptSubmit hook's stdout reaches the model on the same turn
  // (compiled/spike-userprompt-additionalcontext-probe-2026-07-05.md) — the same
  // mechanism channel-reply-reminder.ts relies on.
  process.stdout.write(
    `[status] Deterministic status delivery is unavailable on this channel. Relay the ` +
    `following status to the operator verbatim via the channel reply tool (to the chat ` +
    `this message arrived on), then stop — add no commentary:\n${reply}\n`
  );
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
