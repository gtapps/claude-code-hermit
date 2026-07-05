// Returns 'HH:MM' in the given IANA timezone, or null on error.
// Normalises Intl's '24:xx' (some locales emit this for midnight) to '00:xx'.
// Optional ref date; defaults to now.
function currentHHMM(timezone: string, ref?: Date): string | null {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).formatToParts(ref || new Date());
    const h = String(parts.find(p => p.type === 'hour')?.value ?? '0').padStart(2, '0');
    const m = String(parts.find(p => p.type === 'minute')?.value ?? '0').padStart(2, '0');
    return (h === '24' ? '00' : h) + ':' + m;
  } catch {
    return null;
  }
}

// Returns today (or `ref`) as 'YYYY-MM-DD' in the given timezone.
function todayYMD(timezone: string, ref: Date = new Date()): string {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: timezone }).format(ref);
  } catch {
    return ref.toISOString().slice(0, 10);
  }
}

// Returns the 'YYYY-MM' (year-month) for `ref` in the given timezone.
function thisMonthYYYYMM(timezone: string, ref: Date = new Date()): string {
  return todayYMD(timezone, ref).slice(0, 7);
}

// Extract {year, month, day} for `ref` as observed in `timezone`. Shared by
// thisWeekKey and nextBoundaryISO so both start from the same local calendar
// date. Falls back to UTC components on any Intl failure.
function localYMDParts(timezone: string, ref: Date): { y: number; mo: number; d: number } {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone, hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit',
    }).formatToParts(ref);
    const get = (t: string) => parseInt(parts.find(p => p.type === t)!.value, 10);
    return { y: get('year'), mo: get('month'), d: get('day') };
  } catch {
    return { y: ref.getUTCFullYear(), mo: ref.getUTCMonth() + 1, d: ref.getUTCDate() };
  }
}

// Returns the ISO-8601 week key ('YYYY-Www') for `ref`'s local calendar date
// in `timezone`. Uses the standard nearest-Thursday algorithm on the
// tz-resolved Y-M-D — day-of-week/week-number arithmetic needs only the
// calendar date, not a time-of-day, so this runs on a UTC-anchored Date
// purely as a calendar-math scratch value (no further tz lookups needed).
function thisWeekKey(timezone: string, ref: Date = new Date()): string {
  const { y, mo, d } = localYMDParts(timezone, ref);
  const date = new Date(Date.UTC(y, mo - 1, d));
  const dayNum = (date.getUTCDay() + 6) % 7; // Mon=0..Sun=6
  date.setUTCDate(date.getUTCDate() - dayNum + 3); // nearest Thursday
  const firstThursday = new Date(Date.UTC(date.getUTCFullYear(), 0, 4));
  const firstDayNum = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - firstDayNum + 3);
  const weekNum = 1 + Math.round((date.getTime() - firstThursday.getTime()) / (7 * 86400000));
  return `${date.getUTCFullYear()}-W${String(weekNum).padStart(2, '0')}`;
}

// Resolves the UTC instant at which `timezone` reads the given local wall-clock
// time (y-mo-d hh:mm:ss). Standard guess-and-correct approach (no tz database
// library available — Bun-stdlib-only): treat the wall-clock values as if they
// were already UTC, format that guess back through the real timezone, and
// shift by the observed delta. Converges in one correction for every real
// IANA zone (all of which have offsets constant across the correction window,
// bar the exact DST-transition second — an accepted, rare edge case).
function zonedTimeToUtcMs(y: number, mo: number, d: number, hh: number, mm: number, ss: number, timezone: string): number {
  const asUTC = Date.UTC(y, mo - 1, d, hh, mm, ss);
  let ms = asUTC;
  for (let i = 0; i < 2; i++) {
    try {
      const parts = new Intl.DateTimeFormat('en-US', {
        timeZone: timezone, hourCycle: 'h23',
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit',
      }).formatToParts(new Date(ms));
      const get = (t: string) => parseInt(parts.find(p => p.type === t)!.value, 10);
      const observedUTC = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour') % 24, get('minute'), get('second'));
      const diff = asUTC - observedUTC;
      if (diff === 0) break;
      ms += diff;
    } catch {
      return asUTC;
    }
  }
  return ms;
}

// Returns the ISO instant of the next calendar boundary (local midnight) after
// `ref`, in `timezone`: 'day' -> tomorrow, 'week' -> next Monday (always a full
// week ahead if `ref` itself is a Monday), 'month' -> the 1st of next month.
// Used to compute a budget pause's auto-resume point.
function nextBoundaryISO(timezone: string, unit: 'day' | 'week' | 'month', ref: Date = new Date()): string {
  const { y, mo, d } = localYMDParts(timezone, ref);
  let ny = y, nmo = mo, nd = d;
  if (unit === 'day') {
    nd += 1;
  } else if (unit === 'week') {
    const dow = new Date(Date.UTC(y, mo - 1, d)).getUTCDay(); // 0=Sun..6=Sat
    const daysUntilMonday = ((1 - dow) + 7) % 7 || 7; // always strictly ahead, even if ref is Monday
    nd += daysUntilMonday;
  } else {
    nmo += 1;
    nd = 1;
  }
  // Normalize month/day overflow (e.g. nmo=13, or nd past the month's length)
  // via a UTC Date — JS Date arithmetic auto-rolls these correctly.
  const norm = new Date(Date.UTC(ny, nmo - 1, nd));
  const ms = zonedTimeToUtcMs(norm.getUTCFullYear(), norm.getUTCMonth() + 1, norm.getUTCDate(), 0, 0, 0, timezone);
  return new Date(ms).toISOString();
}

// Local timestamp in Python's time.strftime('%Y-%m-%dT%H:%M:%S%z') shape
// (no colon in the offset) — runtime.json's established format.
function localISOStamp(d: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  const abs = Math.abs(off);
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}` +
    `${sign}${pad(Math.floor(abs / 60))}${pad(abs % 60)}`
  );
}

// UTC timestamp in Python's time.strftime('%Y-%m-%dT%H:%M:%SZ', gmtime()) shape.
function utcISOStamp(): string {
  return new Date().toISOString().slice(0, 19) + 'Z';
}

// Parses a duration string like "30s", "5m", "2h" to milliseconds.
// Returns defaultMs on any parse failure.
function parseDuration(str: unknown, defaultMs: number): number {
  if (typeof str !== 'string') return defaultMs;
  const m = str.trim().match(/^(\d+)\s*([smh])$/i);
  if (!m) return defaultMs;
  const mult = ({ s: 1000, m: 60000, h: 3600000 } as Record<string, number>)[m[2].toLowerCase()];
  return parseInt(m[1], 10) * mult;
}

// Parse the minute/hour fields of a simple numeric 5-field cron schedule
// (e.g. "0 0 * * *"). Shared by hermit-watchdog.ts (daily-auto-close proximity)
// and channel-status-responder.ts (next-routine line) — both only need the
// fixed-time case, not full cron range/step/list support.
function parseSimpleCronTime(schedule: string): { hour: number; minute: number } | null {
  const parts = String(schedule).trim().split(/\s+/);
  if (parts.length < 2) return null;
  const minute = parseInt(parts[0], 10);
  const hour = parseInt(parts[1], 10);
  if (isNaN(minute) || isNaN(hour) || minute < 0 || minute > 59 || hour < 0 || hour > 23) return null;
  return { hour, minute };
}

// Friendly "YYYY-MM-DD HH:MM" rendering of an ISO instant in `timezone`. Plain
// HH:MM is ambiguous for a resume boundary that's days or weeks out ("until 00:00"
// reads as minutes away), so pause/budget messages that print an auto-resume time
// use this dated form.
function friendlyBoundary(iso: string, timezone: string): string {
  const d = new Date(iso);
  const date = todayYMD(timezone, d);
  const hhmm = currentHHMM(timezone, d) ?? '';
  return `${date} ${hhmm}`.trim();
}

export { currentHHMM, todayYMD, thisWeekKey, thisMonthYYYYMM, nextBoundaryISO, localISOStamp, utcISOStamp, parseDuration, parseSimpleCronTime, friendlyBoundary };
