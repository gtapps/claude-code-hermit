// UserPromptSubmit stage — injects per-prompt context so the model never anchors to stale state.

import type { StageContext, StageResult } from './types';

export function run(ctx: StageContext): StageResult | void {
  const config = ctx.config();

  const tz = (typeof config?.timezone === 'string' && config.timezone) ? config.timezone : 'UTC';

  try {
    const fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      weekday: 'long',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      timeZoneName: 'short',
      hour12: false,
    });

    const parts = Object.fromEntries(fmt.formatToParts(new Date()).map(p => [p.type, p.value]));
    const formatted = `${parts.weekday}, ${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute} ${parts.timeZoneName}`;
    return { context: `[Now: ${formatted}]\n` };
  } catch {
    // Invalid TZ or Intl unavailable — emit nothing; CC's currentDate remains
  }
}
