// Pure 5-field cron matcher. Evaluates against wall-clock parts in a target timezone —
// used by routine-due.ts to check schedules directly in config.timezone (no shiftCron).
import { parseCronField } from '../validate-config';

export interface DateParts { minute: number; hour: number; dom: number; month: number; dow: number; }

// null tz → machine-local. Returns null if Intl fails (bad tz).
export function datePartsInTz(date: Date, tz: string | null): DateParts | null {
  try {
    const fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: tz ?? undefined, hourCycle: 'h23',
      minute: 'numeric', hour: 'numeric', day: 'numeric', month: 'numeric', weekday: 'short',
    });
    const parts = Object.fromEntries(fmt.formatToParts(date).map(p => [p.type, p.value]));
    const DOW: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
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

// expr must already be validated (validateCronSchedule rejects DOM+DOW both restricted,
// so plain AND of all five fields is correct here). DOW: 7 ≡ 0 (cron-tz-shift.ts precedent).
export function cronMatches(expr: string, parts: DateParts): boolean {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) return false;
  const [min, hour, dom, month, dow] = fields;
  try {
    const dowSet = parseCronField(dow, 0, 7);
    if (dowSet.has(7)) dowSet.add(0);
    return parseCronField(min, 0, 59).has(parts.minute)
      && parseCronField(hour, 0, 23).has(parts.hour)
      && parseCronField(dom, 1, 31).has(parts.dom)
      && parseCronField(month, 1, 12).has(parts.month)
      && dowSet.has(parts.dow);
  } catch {
    return false;
  }
}
