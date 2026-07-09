// cron-registry.ts — diff-based plan/commit for hermit-routines CronCreate registration.
//
// Usage:
//   bun cron-registry.ts plan   <hermit-state-dir> <plugin-root> [--force]
//   bun cron-registry.ts commit <hermit-state-dir> <plugin-root> <created-id-csv>
//
// --force (used by `load --reset`) skips every mirror/hash/age comparison and
// returns every enabled routine as CREATE with no DELETE lines — the caller is
// expected to do its own unconditional CronList-based sweep for deletes first.
//
// plan (stdout, one line per entry):
//   DELETE:<id>              existing CronCreate to tear down before recreating
//   CREATE:<id>|<schedule>   to register, with the timezone-shifted schedule already computed
//   WARN:<id>|<reason>       only for CREATE ids whose tz-shift fell back to the unshifted schedule
//   KEEP:<n>                 count of routines needing no registration change this round
//
// A CREATE with no matching DELETE is a brand-new or never-registered routine.
// On boot mismatch (or a missing/corrupt mirror) every enabled routine is CREATE
// with NO deletes — durable:false crons already died with the prior process, so
// there is nothing live to tear down; deleting anyway would just be a wasted
// CronDelete call on an id CC has already forgotten.
//
// commit rewrites state/cron-registry.json: every id in <created-id-csv> is
// stamped registered_at=now (resetting its age clock); every other id from the
// last plan's CREATE/DELETE sets is dropped (skipped or failed CronCreate is
// NOT recorded as live — that would let a real failure hide behind a "KEEP"
// on the next run); ids untouched by the last plan (KEEP) carry forward with
// their registered_at UNCHANGED, since no CronCreate happened for them.
//
// Exit 0 always (fail-open: a mirror problem must never block routine registration;
// `load --reset`'s unconditional CronList/CronDelete/CronCreate sweep remains the
// self-healing recovery path for any mirror/reality drift).

import fs from 'node:fs';
import path from 'node:path';
import { sha256 } from './lib/hash';
import { shiftCron } from './cron-tz-shift';

type Json = any;

// Re-register even an unchanged routine once it has been alive this long. CC's
// recurring-task auto-expiry is a hard 7-day-from-creation cliff — it is NOT
// extended by CronList/activity, only by cancel-and-recreate — so this must stay
// comfortably under 7 days. In practice the daily heartbeat-restart reload is what
// crosses this threshold for every routine, exactly as it does with the old
// unconditional-reset design; the diff just skips the ones nowhere near the cliff.
const REREGISTER_AGE_MS = 5 * 24 * 60 * 60 * 1000;

interface MirrorEntry {
  prompt_hash: string;
  registered_at: number;
}

interface Mirror {
  boot_id: string | null;
  routines: Record<string, MirrorEntry>;
}

interface PlanCreate { id: string; schedule: string; warn?: string; }
interface PlanResult { deletes: string[]; creates: PlanCreate[]; keepCount: number; }

function readMirror(mirrorPath: string): Mirror {
  try {
    const parsed = JSON.parse(fs.readFileSync(mirrorPath, 'utf8'));
    if (parsed && typeof parsed === 'object' && parsed.routines && typeof parsed.routines === 'object') {
      return { boot_id: typeof parsed.boot_id === 'string' ? parsed.boot_id : null, routines: parsed.routines };
    }
  } catch { /* missing or corrupt — treated as an empty mirror (all-CREATE) below */ }
  return { boot_id: null, routines: {} };
}

function readBootId(hermitDir: string): string | null {
  try {
    const v = fs.readFileSync(path.join(hermitDir, 'state', '.boot-id'), 'utf8').trim();
    return v || null;
  } catch {
    return null;
  }
}

function resolveMachineTz(): string | null {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch { return null; }
}

// Wraps cron-tz-shift's shiftCron for a single routine. Returns the schedule
// unchanged (no warn) when the machine timezone can't be resolved — the same
// fail-open behavior cron-tz-shift.ts's CLI uses.
function shiftForRoutine(
  schedule: string, configTz: string | null, machineTz: string | null, ref: Date,
): { result: string; warn?: string } {
  if (!machineTz) return { result: schedule };
  const { result, warn } = shiftCron(schedule, configTz || '', machineTz, ref);
  return { result, warn };
}

// Hash over every input that determines what gets registered — a change to any
// of these must force a delete+recreate. Schedule is the already-shifted value,
// so a DST re-shift changes the hash exactly like an id/skill/flag edit would.
function promptHash(r: Json, shiftedSchedule: string, pluginRoot: string): string {
  return sha256(JSON.stringify({
    id: r.id,
    skill: r.skill,
    run_during_waiting: !!r.run_during_waiting,
    model: r.model ?? null,
    reflect_after: !!r.reflect_after,
    shifted_schedule: shiftedSchedule,
    pluginRoot,
  }));
}

// Pure — no fs/network/Date.now() inside. Callers inject now/machineTz so this
// (and its test fixtures) are fully deterministic.
function planCron(
  routines: Json[],
  mirror: Mirror,
  currentBootId: string | null,
  pluginRoot: string,
  configTz: string | null,
  machineTz: string | null,
  nowMs: number,
  forceReset = false,
): PlanResult {
  const enabled = routines.filter(r => r && r.enabled === true && r.id && r.skill && r.schedule);
  // forceReset (load --reset) always takes the all-CREATE/no-DELETE branch below,
  // regardless of mirror state — the caller does its own unconditional CronList
  // sweep for deletes, so the planner only needs to hand back shifted schedules.
  const bootMismatch = forceReset || !mirror.boot_id || !currentBootId || mirror.boot_id !== currentBootId;
  const ref = new Date(nowMs);

  const deletes: string[] = [];
  const creates: PlanCreate[] = [];
  let keepCount = 0;
  const seen = new Set<string>();

  for (const r of enabled) {
    seen.add(r.id);
    const shift = shiftForRoutine(r.schedule, configTz, machineTz, ref);
    const hash = promptHash(r, shift.result, pluginRoot);
    const existing = mirror.routines[r.id];

    if (bootMismatch) {
      creates.push({ id: r.id, schedule: shift.result, warn: shift.warn });
      continue;
    }
    if (!existing) {
      creates.push({ id: r.id, schedule: shift.result, warn: shift.warn });
      continue;
    }
    const changed = existing.prompt_hash !== hash;
    const aged = (nowMs - existing.registered_at) > REREGISTER_AGE_MS;
    if (changed || aged) {
      deletes.push(r.id);
      creates.push({ id: r.id, schedule: shift.result, warn: shift.warn });
      continue;
    }
    keepCount++;
  }

  // Mirror entries for routines that are no longer enabled/present — only plausibly
  // live (and thus worth a CronDelete) when the mirror's boot_id matches this process.
  if (!bootMismatch) {
    for (const id of Object.keys(mirror.routines)) {
      if (!seen.has(id)) deletes.push(id);
    }
  }

  return { deletes, creates, keepCount };
}

// Rewrites the mirror after the caller has issued the actual CronCreate/CronDelete
// calls for `plan`'s output. `createdIds` is the subset of plan.creates that the
// caller confirms actually succeeded — anything else in creates/deletes is dropped,
// not carried forward, so a failed or skipped CronCreate can never masquerade as KEEP.
function commitCron(
  mirror: Mirror,
  plan: PlanResult,
  createdIds: Set<string>,
  routineById: Map<string, Json>,
  pluginRoot: string,
  bootId: string | null,
  nowMs: number,
): Mirror {
  const deleteSet = new Set(plan.deletes);
  const createSet = new Set(plan.creates.map(c => c.id));

  const next: Mirror = { boot_id: bootId, routines: {} };
  for (const [id, entry] of Object.entries(mirror.routines)) {
    if (!deleteSet.has(id) && !createSet.has(id)) next.routines[id] = entry; // untouched KEEP — age unchanged
  }

  for (const { id, schedule } of plan.creates) {
    if (!createdIds.has(id)) continue;
    const r = routineById.get(id);
    if (!r) continue;
    next.routines[id] = { prompt_hash: promptHash(r, schedule, pluginRoot), registered_at: nowMs };
  }

  return next;
}

function writeMirror(mirrorPath: string, mirror: Mirror): void {
  fs.mkdirSync(path.dirname(mirrorPath), { recursive: true });
  const tmp = mirrorPath + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(mirror, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, mirrorPath);
}

export { planCron, commitCron, readMirror, readBootId, promptHash, REREGISTER_AGE_MS };
export type { Mirror, MirrorEntry, PlanResult, PlanCreate };

// --- CLI ---
if (import.meta.main) {
  const mode = process.argv[2];
  const hermitDir = process.argv[3];
  const pluginRoot = process.argv[4];

  if ((mode !== 'plan' && mode !== 'commit') || !hermitDir || !pluginRoot) {
    process.stdout.write('SKIP|usage: cron-registry.ts <plan|commit> <hermit-dir> <plugin-root> [created-csv]\n');
    process.exit(0);
  }

  try {
    const configPath = path.join(hermitDir, 'config.json');
    const mirrorPath = path.join(hermitDir, 'state', 'cron-registry.json');
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    const routines: Json[] = Array.isArray(config.routines) ? config.routines : [];
    const configTz = typeof config.timezone === 'string' ? config.timezone : null;
    const machineTz = resolveMachineTz();
    const mirror = readMirror(mirrorPath);
    const bootId = readBootId(hermitDir);
    const nowMs = Date.now();
    const forceReset = process.argv.includes('--force');

    const plan = planCron(routines, mirror, bootId, pluginRoot, configTz, machineTz, nowMs, forceReset);

    if (mode === 'plan') {
      for (const id of plan.deletes) process.stdout.write(`DELETE:${id}\n`);
      for (const c of plan.creates) process.stdout.write(`CREATE:${c.id}|${c.schedule}\n`);
      for (const c of plan.creates) if (c.warn) process.stdout.write(`WARN:${c.id}|${c.warn}\n`);
      process.stdout.write(`KEEP:${plan.keepCount}\n`);
    } else {
      const createdCsv = process.argv[5] || '';
      const createdIds = new Set(createdCsv.split(',').map(s => s.trim()).filter(Boolean));
      const routineById = new Map(routines.map((r: Json) => [r.id, r]));
      const next = commitCron(mirror, plan, createdIds, routineById, pluginRoot, bootId, nowMs);
      writeMirror(mirrorPath, next);
      process.stdout.write(`OK|${createdIds.size} committed\n`);
    }
  } catch (e: any) {
    process.stdout.write(`SKIP|${e.message}\n`);
  }
  process.exit(0);
}
