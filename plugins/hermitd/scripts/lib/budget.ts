// Pure budget-cap evaluation (PROP-016) — no I/O. cost-tracker.ts supplies current
// spend (from the cost index) + the operator's `budget` config block; this module
// decides the warn/breach level and, for a pause breach, which calendar boundary the
// pause should self-resume at.
//
// Thresholds: >=80% of a cap -> warn, >=100% -> breach. Each of the three caps
// (daily/weekly/monthly) is independent and optional — only caps that are positive
// numbers are evaluated; a null/absent cap never contributes an alert.

import { nextBoundaryISO } from './time';

type Period = 'daily' | 'weekly' | 'monthly';
type Level = 'none' | 'warn' | 'breach';
type Action = 'alert' | 'pause';

const WARN_RATIO = 0.8;
const BREACH_RATIO = 1.0;

// Longer window first — it never resolves before a shorter one, so it is the
// binding boundary/precedent when several periods are breached at once.
const PERIOD_PRECEDENCE: Period[] = ['monthly', 'weekly', 'daily'];
const PERIOD_UNIT: Record<Period, 'day' | 'week' | 'month'> = {
  daily: 'day',
  weekly: 'week',
  monthly: 'month',
};

interface BudgetCaps {
  daily_usd?: number | null;
  weekly_usd?: number | null;
  monthly_usd?: number | null;
}

interface PeriodResult {
  period: Period;
  spend: number;
  cap: number;
  ratio: number;
  level: 'warn' | 'breach';
}

interface BudgetEvaluation {
  level: Level;
  // Only warn/breach periods, most-binding (longest window) first.
  periods: PeriodResult[];
  action: Action;
}

function evaluateBudget(input: {
  dailySpend: number;
  weeklySpend: number;
  monthlySpend: number;
  caps: BudgetCaps;
  action?: Action;
}): BudgetEvaluation {
  const action: Action = input.action === 'pause' ? 'pause' : 'alert';
  const spends: Record<Period, number> = {
    daily: input.dailySpend || 0,
    weekly: input.weeklySpend || 0,
    monthly: input.monthlySpend || 0,
  };
  const caps: Record<Period, number | null | undefined> = {
    daily: input.caps.daily_usd,
    weekly: input.caps.weekly_usd,
    monthly: input.caps.monthly_usd,
  };

  const periods: PeriodResult[] = [];
  for (const period of PERIOD_PRECEDENCE) {
    const cap = caps[period];
    if (typeof cap !== 'number' || !(cap > 0)) continue; // unset/invalid cap — never evaluated
    const spend = spends[period];
    const ratio = spend / cap;
    if (ratio >= BREACH_RATIO) periods.push({ period, spend, cap, ratio, level: 'breach' });
    else if (ratio >= WARN_RATIO) periods.push({ period, spend, cap, ratio, level: 'warn' });
  }

  const level: Level = periods.some(p => p.level === 'breach') ? 'breach'
    : periods.some(p => p.level === 'warn') ? 'warn' : 'none';

  return { level, periods, action };
}

// Next self-resume point for a `pause` breach: the most-binding (longest) breached
// window's next calendar boundary in `timezone`. A longer window always outlasts a
// shorter one, so a monthly breach must resume at the start of next month, not at
// tonight's midnight only to trip the monthly cap again a moment later.
function pauseBoundary(breachedPeriods: Period[], timezone: string, ref?: Date): string | null {
  for (const period of PERIOD_PRECEDENCE) {
    if (breachedPeriods.includes(period)) return nextBoundaryISO(timezone, PERIOD_UNIT[period], ref);
  }
  return null;
}

export { evaluateBudget, pauseBoundary, PERIOD_PRECEDENCE };
export type { BudgetCaps, BudgetEvaluation, PeriodResult, Period, Level, Action };
