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

// Returns today as 'YYYY-MM-DD' in the given timezone.
function todayYMD(timezone: string): string {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: timezone }).format(new Date());
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
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

export { currentHHMM, todayYMD, localISOStamp, utcISOStamp, parseDuration };
