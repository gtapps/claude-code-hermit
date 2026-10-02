// cost-report.ts — single CLI for the three cost readouts, over
// lib/cost-report/{today,session,reflect}.ts.
//
// Usage:
//   bun cost-report.ts today
//     "$X.XX (<tokens>) across N session(s)" for today. An unreadable log prints
//     "cost data unavailable" rather than a misleading $0.00.
//
//   bun cost-report.ts session <session_id> [--opened-at <iso>] [--closed-at <iso>]
//     {"cost_usd":<n>,"tokens":<n>} for one logical session's arc window.
//
//   bun cost-report.ts reflect [<stateDir>] [<days>] [--plain]
//     The spend breakdown; --plain is the channel-safe prose form.
//
// Each verb keeps the exit code and stdout grammar it had as its own script —
// all three are fail-open readers (exit 0 even with no data), because their
// callers are briefs and channel replies that must still compose without cost.

import { run as runToday } from './lib/cost-report/today';
import { run as runSession } from './lib/cost-report/session';
import { run as runReflect } from './lib/cost-report/reflect';

const USAGE = 'Usage: bun cost-report.ts <today|session|reflect> [args...]';

const verb = process.argv[2];
const rest = process.argv.slice(3);

switch (verb) {
  case 'today': runToday(); break;
  case 'session': runSession(rest); break;
  case 'reflect': runReflect(rest); break;
  default:
    console.error(USAGE);
    process.exit(1);
}
