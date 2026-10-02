// Timezone-aware cron shifting — the pure logic behind scripts/routines.ts tz-shift.
//
// Lives in lib/ so importers (lib/routines/registry.ts, hermitd-watchdog.ts, the
// status-responder stage) don't pull in a top-level CLI script just to reach
// two functions.

import { parseCronField } from '../validate-config';
import { currentHHMM } from './time';

function wallMinutes(tz: string, ref: Date): number | null {
  const hhmm = currentHHMM(tz, ref);
  if (!hhmm) return null;
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
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
    if (endsAtHi) return `${first}-${hi}/${step}`;
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

export { shiftCron, wallMinutes };
