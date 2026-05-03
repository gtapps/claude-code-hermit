'use strict';

// Returns 'HH:MM' in the given IANA timezone, or null on error.
// Normalises Intl's '24:xx' (some locales emit this for midnight) to '00:xx'.
// Optional ref date; defaults to now.
function currentHHMM(timezone, ref) {
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
function todayYMD(timezone) {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: timezone }).format(new Date());
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
}

module.exports = { currentHHMM, todayYMD };
