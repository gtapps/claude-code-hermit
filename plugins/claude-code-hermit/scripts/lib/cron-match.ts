// Pure 5-field cron matcher. Evaluates against wall-clock parts in a target timezone —
// used by routine-due.ts to check schedules directly in config.timezone (no shiftCron).
//
// Two-tier API so hot loops can hoist the invariant work out of the per-candidate scan:
//   - makeTzFormatter(tz) once per poll, then partsFromFormatter(fmt, date) per candidate;
//   - compileCron(expr) once per routine, then cronMatchesCompiled(sets, parts) per candidate.
// datePartsInTz / cronMatches are the single-shot wrappers kept for callers/tests.
import { parseCronField } from '../validate-config';

export interface DateParts { minute: number; hour: number; dom: number; month: number; dow: number; }
export interface CompiledCron { min: Set<number>; hour: Set<number>; dom: Set<number>; month: Set<number>; dow: Set<number>; }

const DOW: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

// Build one formatter for a timezone. null tz → machine-local. Returns null if Intl rejects
// the tz (bad zone) — construct once per poll and reuse across every candidate minute.
export function makeTzFormatter(tz: string | null): Intl.DateTimeFormat | null {
  try {
    return new Intl.DateTimeFormat('en-US', {
      timeZone: tz ?? undefined, hourCycle: 'h23',
      minute: 'numeric', hour: 'numeric', day: 'numeric', month: 'numeric', weekday: 'short',
    });
  } catch {
    return null;
  }
}

// Extract wall-clock parts for `date` using a pre-built formatter. Returns null if the parts
// can't be read (defensive — a valid Date + valid formatter always resolves).
export function partsFromFormatter(fmt: Intl.DateTimeFormat, date: Date): DateParts | null {
  try {
    const parts = Object.fromEntries(fmt.formatToParts(date).map(p => [p.type, p.value]));
    const dow = DOW[parts.weekday];
    if (dow === undefined || !parts.minute || !parts.hour || !parts.day || !parts.month) return null;
    return {
      minute: +parts.minute,
      hour: +parts.hour === 24 ? 0 : +parts.hour,
      dom: +parts.day,
      month: +parts.month,
      dow,
    };
  } catch {
    return null;
  }
}

// Single-shot wrapper. Returns null if Intl fails (bad tz) or parts can't be read.
export function datePartsInTz(date: Date, tz: string | null): DateParts | null {
  const fmt = makeTzFormatter(tz);
  return fmt ? partsFromFormatter(fmt, date) : null;
}

// Parse a 5-field cron expr into per-field Sets once. Returns null on a malformed expr
// (wrong field count or an unparseable field), so callers fail closed. DOW: 7 ≡ 0
// (cron-tz-shift.ts precedent). Expr should already be validated by validateCronSchedule
// (which additionally rejects DOM+DOW both restricted), so plain AND of all fields is correct.
export function compileCron(expr: string): CompiledCron | null {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) return null;
  const [min, hour, dom, month, dow] = fields;
  try {
    const dowSet = parseCronField(dow, 0, 7);
    if (dowSet.has(7)) dowSet.add(0);
    return {
      min: parseCronField(min, 0, 59),
      hour: parseCronField(hour, 0, 23),
      dom: parseCronField(dom, 1, 31),
      month: parseCronField(month, 1, 12),
      dow: dowSet,
    };
  } catch {
    return null;
  }
}

export function cronMatchesCompiled(c: CompiledCron, parts: DateParts): boolean {
  return c.min.has(parts.minute)
    && c.hour.has(parts.hour)
    && c.dom.has(parts.dom)
    && c.month.has(parts.month)
    && c.dow.has(parts.dow);
}

// Single-shot wrapper — compiles then matches. Returns false on a malformed expr.
export function cronMatches(expr: string, parts: DateParts): boolean {
  const c = compileCron(expr);
  return c ? cronMatchesCompiled(c, parts) : false;
}
