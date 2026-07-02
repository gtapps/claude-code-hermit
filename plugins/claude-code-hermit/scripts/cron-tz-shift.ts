// Rewrite a 5-field cron expression from one IANA timezone to the machine's local timezone.
// Usage: bun cron-tz-shift.ts "<cron-expr>" "<from-tz>"
// Stdout: shifted cron (or original on unsupported/fail-open paths)
// Stderr: WARN: <reason>  (when passing through unchanged due to unsupported pattern)
// Exit 0 always except: malformed cron that fails validateCronSchedule, or unparseable HERMIT_CRON_TZ_SHIFT_NOW

import { parseCronField, validateCronSchedule } from './validate-config';
import { currentHHMM } from './lib/time';

function wallMinutes(tz: string, ref: Date): number | null {
  const hhmm = currentHHMM(tz, ref);
  if (!hhmm) return null;
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

function resolveMachineTz() {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone; }
  catch { return null; }
}

// Collapse a sorted array of integers back to a compact cron field token.
function collapseField(vals: number[], lo: number, hi: number): string | null {
  if (!vals || vals.length === 0) return null;
  if (vals.length === 1) return String(vals[0]);
  if (vals.length === hi - lo + 1) return '*';
  const step = vals[1] - vals[0];
  const isArithmetic = step > 0 && vals.every((v, i) => i === 0 || v === vals[i - 1] + step);
  if (isArithmetic) {
    const first = vals[0], last = vals[vals.length - 1];
    if (step === 1) return vals.length >= 3 ? `${first}-${last}` : vals.join(',');
    if (vals.length < 3) return vals.join(',');
    const endsAtHi = last + step > hi;
    if (first === lo && endsAtHi) return `*/${step}`;
    if (endsAtHi) return `${first}/${step}`;
    return `${first}-${last}/${step}`;
  }
  return vals.join(',');
}

// Core shift logic. Returns { result, shifted, warn }.
// shifted=true means the cron was actually changed.
// warn is set when passing through unchanged due to an unsupported pattern.
function shiftCron(cronExpr: string, fromTz: string, machineTz: string, ref: Date): { result: string; shifted?: boolean; warn?: string } {
  const cleanFrom = (fromTz || '').trim();
  if (!cleanFrom || cleanFrom === machineTz) return { result: cronExpr, shifted: false };

  const fields = cronExpr.trim().split(/\s+/);
  const [minF, hourF, domF, monF, dowF] = fields;

  if (domF !== '*') {
    return { result: cronExpr, warn: 'DOM-restricted schedules are not shifted; machine-local time used' };
  }

  // hour=* fires every hour — no per-hour shift possible
  if (hourF === '*') return { result: cronExpr, shifted: false };

  const fromMin = wallMinutes(cleanFrom, ref);
  if (fromMin === null) return { result: cronExpr, warn: `invalid from-tz "${cleanFrom}"` };
  const machMin = wallMinutes(machineTz, ref);
  if (machMin === null) return { result: cronExpr, warn: 'could not resolve machine timezone' };

  let offsetMin = machMin - fromMin;
  if (offsetMin > 720) offsetMin -= 1440;
  if (offsetMin <= -720) offsetMin += 1440;
  if (offsetMin === 0) return { result: cronExpr, shifted: false };

  let minVals: number[], hourVals: number[];
  try {
    minVals = [...parseCronField(minF, 0, 59)].sort((a, b) => a - b);
    hourVals = [...parseCronField(hourF, 0, 23)].sort((a, b) => a - b);
  } catch (e: any) {
    return { result: cronExpr, warn: `cannot expand fields: ${e.message}` };
  }

  // Compute shifted (newM, newH, dayDelta) for every (m, h) pair
  const shiftedPairs: { newM: number; newH: number; dayDelta: number }[] = [];
  for (const h of hourVals) {
    for (const m of minVals) {
      const total = h * 60 + m + offsetMin;
      const dayDelta = total < 0 ? -1 : total >= 1440 ? 1 : 0;
      const wrapped = ((total % 1440) + 1440) % 1440;
      shiftedPairs.push({ newM: wrapped % 60, newH: Math.floor(wrapped / 60), dayDelta });
    }
  }

  // Group by shifted hour; collect sorted min arrays once for both outer-product check and newMinVals
  const byHour = new Map<number, Set<number>>();
  for (const { newM, newH } of shiftedPairs) {
    if (!byHour.has(newH)) byHour.set(newH, new Set());
    byHour.get(newH)!.add(newM);
  }
  if (byHour.size === 0) return { result: cronExpr, shifted: false };

  const minArrays = [...byHour.values()].map(s => [...s].sort((a, b) => a - b));
  const refKey = minArrays[0].join(',');
  if (!minArrays.every(a => a.join(',') === refKey)) {
    return { result: cronExpr, warn: 'shifted (minute, hour) set is not an outer product, cannot be expressed as a single cron' };
  }

  const allDeltas = new Set(shiftedPairs.map(p => p.dayDelta));
  const dowRestricted = dowF !== '*';
  if (dowRestricted && allDeltas.size > 1) {
    return { result: cronExpr, warn: 'cron has mixed day-wrap after shift, cannot be expressed as a single cron' };
  }

  const newHourVals = [...byHour.keys()].sort((a, b) => a - b);
  const newMinVals = minArrays[0];

  // If original hour field was a step, verify the step structure survives the shift
  const hourIsStep = /^(\*|\d+(-\d+)?)\/\d+$/.test(hourF);
  if (hourIsStep && newHourVals.length > 1) {
    const collapsed = collapseField(newHourVals, 0, 23);
    if (!collapsed!.includes('/')) {
      return { result: cronExpr, warn: 'hour step pattern loses its structure after timezone shift; split into fixed-time routines instead' };
    }
  }

  const newMinF = collapseField(newMinVals, 0, 59);
  const newHourF = collapseField(newHourVals, 0, 23);

  let newDowF = dowF;
  if (dowRestricted) {
    const delta = [...allDeltas][0];
    if (delta !== 0) {
      try {
        const dowVals = [...parseCronField(dowF, 0, 7)].map(v => v === 7 ? 0 : v);
        const shiftedDow = [...new Set(dowVals.map(v => ((v + delta) % 7 + 7) % 7))].sort((a, b) => a - b);
        newDowF = collapseField(shiftedDow, 0, 6)!;
      } catch (e: any) {
        return { result: cronExpr, warn: `cannot shift DOW field: ${e.message}` };
      }
    }
  }

  return { result: `${newMinF} ${newHourF} ${domF} ${monF} ${newDowF}`, shifted: true };
}

function main() {
  const [,, cronExpr, fromTz] = process.argv;

  if (!cronExpr) {
    process.stderr.write('Usage: bun cron-tz-shift.ts "<cron-expr>" "<from-tz>"\n');
    process.exit(1);
  }

  let ref: Date;
  if (process.env.HERMIT_CRON_TZ_SHIFT_NOW) {
    ref = new Date(process.env.HERMIT_CRON_TZ_SHIFT_NOW);
    if (isNaN(ref.getTime())) {
      process.stderr.write(`Error: HERMIT_CRON_TZ_SHIFT_NOW is not a valid ISO 8601 date: "${process.env.HERMIT_CRON_TZ_SHIFT_NOW}"\n`);
      process.exit(1);
    }
  } else {
    ref = new Date();
  }

  const validErr = validateCronSchedule(cronExpr);
  if (validErr) {
    process.stderr.write(`Error: invalid cron expression: ${validErr}\n`);
    process.exit(1);
  }

  const machineTz = resolveMachineTz();
  if (!machineTz) {
    process.stdout.write(cronExpr + '\n');
    process.stderr.write('WARN: could not resolve machine timezone\n');
    return;
  }

  const { result, warn } = shiftCron(cronExpr, fromTz || '', machineTz, ref);
  process.stdout.write(result + '\n');
  if (warn) process.stderr.write(`WARN: ${warn}\n`);
}

export { shiftCron, wallMinutes };

if (import.meta.main) {
  main();
}
