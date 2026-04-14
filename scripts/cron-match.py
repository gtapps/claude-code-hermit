#!/usr/bin/env python3
"""Minimal 5-field cron matcher for hermit routine-watcher.

Usage: cron-match.py <schedule> [YYYY-MM-DDTHH:MM [DOW]]
  DOW: 0=Sun..6=Sat. If omitted, derived from timestamp.
  DOM and month are always parsed from the timestamp.
  If timestamp omitted, uses current local time.

Exit codes: 0 = match, 1 = no match, 2 = parse error (invalid expression).
Errors go to stderr.
"""
import sys


def parse_field(token, lo, hi):
    """Parse one cron field token into a set of matching integers."""
    values = set()
    for part in token.split(','):
        if not part:
            raise ValueError('empty segment in list')
        # step: */N or N-M/N
        if '/' in part:
            base, step_s = part.split('/', 1)
            step = int(step_s)
            if step <= 0:
                raise ValueError(f'zero or negative step: {part}')
            if base == '*':
                start, end = lo, hi
            elif '-' in base:
                start, end = (int(x) for x in base.split('-', 1))
            else:
                start, end = int(base), hi
            if start < lo or end > hi or start > end:
                raise ValueError(f'out of range or reverse: {part}')
            values.update(range(start, end + 1, step))
        elif '-' in part:
            a, b = (int(x) for x in part.split('-', 1))
            if a < lo or b > hi or a > b:
                raise ValueError(f'out of range or reverse range: {part}')
            values.update(range(a, b + 1))
        elif part == '*':
            values.update(range(lo, hi + 1))
        else:
            v = int(part)
            if v < lo or v > hi:
                raise ValueError(f'value {v} out of range [{lo},{hi}]')
            values.add(v)
    return values


def parse_schedule(schedule):
    """Parse a 5-field cron schedule. Returns (minute_set, hour_set, dom_set, month_set, dow_set)."""
    fields = schedule.split()
    if len(fields) != 5:
        raise ValueError(f'expected 5 fields, got {len(fields)}')

    # Reject named days/months and macros
    if schedule.startswith('@'):
        raise ValueError(f'macros not supported: {schedule}')
    for f in fields:
        if any(c.isalpha() for c in f):
            raise ValueError(f'named values not supported: {f}')

    minute_set = parse_field(fields[0], 0, 59)
    hour_set = parse_field(fields[1], 0, 23)
    dom_set = parse_field(fields[2], 1, 31)
    month_set = parse_field(fields[3], 1, 12)
    dow_set = parse_field(fields[4], 0, 7)
    # Normalize DOW 7 → 0 (both mean Sunday)
    if 7 in dow_set:
        dow_set.add(0)
        dow_set.discard(7)

    if fields[2] != '*' and fields[4] != '*':
        raise ValueError('both DOM and DOW restricted — not supported in v1')

    return minute_set, hour_set, dom_set, month_set, dow_set


def matches(schedule, minute, hour, dom, month, dow):
    """Return True if the given time matches the schedule."""
    minute_set, hour_set, dom_set, month_set, dow_set = parse_schedule(schedule)
    # Normalize DOW: input 7 → 0
    if dow == 7:
        dow = 0
    return (minute in minute_set and hour in hour_set and
            dom in dom_set and month in month_set and dow in dow_set)


def main():
    if len(sys.argv) < 2:
        print('Usage: cron-match.py <schedule> [YYYY-MM-DDTHH:MM [DOW]]', file=sys.stderr)
        sys.exit(2)

    schedule = sys.argv[1]

    if len(sys.argv) >= 3:
        # Parse YYYY-MM-DDTHH:MM — DOM and month come from the timestamp
        ts = sys.argv[2]
        try:
            date_part, time_part = ts.split('T')
            year, month_s, day_s = date_part.split('-')
            hour_s, minute_s = time_part.split(':')
            minute, hour, dom, month = int(minute_s), int(hour_s), int(day_s), int(month_s)
        except Exception:
            print(f'Invalid timestamp: {ts}', file=sys.stderr)
            sys.exit(2)
        dow = int(sys.argv[3]) if len(sys.argv) >= 4 else None
        if dow is None:
            import datetime
            dow = datetime.date(int(year), month, dom).weekday()
            # Python weekday: 0=Mon. Convert to cron: 0=Sun
            dow = (dow + 1) % 7
    else:
        import datetime
        now = datetime.datetime.now()
        minute, hour, dom, month = now.minute, now.hour, now.day, now.month
        dow = (now.weekday() + 1) % 7

    try:
        if matches(schedule, minute, hour, dom, month, dow):
            sys.exit(0)
        else:
            sys.exit(1)
    except ValueError as e:
        print(f'Invalid schedule "{schedule}": {e}', file=sys.stderr)
        sys.exit(2)


if __name__ == '__main__':
    main()
