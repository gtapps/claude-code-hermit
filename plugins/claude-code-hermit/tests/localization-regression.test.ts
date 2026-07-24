// Regression guard: the `en` catalog bodies must stay byte-for-byte the strings
// the deterministic senders emitted before scripts/lib/messages.ts existed, so a
// stock install (language null, technical, no maintainer channel) speaks exactly
// as it did pre-refactor. The two deliberate exceptions are EXCLUDED here:
//   - DENY.client   — the auto-mode denial copy was rewritten to the channel voice
//   - MINT.ackPrompt — the mint ack was unified to one destination-agnostic wording
// Both are covered by their own tests. Every other `en` literal is pinned below;
// a change to any of them must fail loudly rather than silently drift the wire.

import { describe, test, expect } from 'bun:test';
import { PAUSE, STATUS, SPEND, BUDGET, DENY, MINT, WATCHDOG } from '../scripts/lib/messages';

describe('en catalog byte-identity (pre-refactor literals)', () => {
  test('PAUSE reason labels', () => {
    expect(PAUSE.en.reasonLabel('budget')).toBe('a budget cap');
    expect(PAUSE.en.reasonLabel('watchdog')).toBe('the watchdog');
    expect(PAUSE.en.reasonLabel('operator')).toBe('your request');
  });

  test('STATUS lines', () => {
    expect(STATUS.en.pausedUntilResume('X')).toBe('Paused (X) until you resume it.');
    expect(STATUS.en.pausedUntilDate('X', 'B')).toBe('Paused (X) until B.');
    expect(STATUS.en.workingOn('T')).toBe('Working on T.');
    expect(STATUS.en.idleNothing()).toBe('Idle — nothing in progress.');
    expect(STATUS.en.redactedWorking()).toBe('Working.');
    expect(STATUS.en.redactedIdle()).toBe('Idle.');
    expect(STATUS.en.oneApproval('ID')).toBe('1 approval waiting (reply "ID yes/no").');
    expect(STATUS.en.nApprovals(3)).toBe('3 approvals waiting.');
    expect(STATUS.en.nextRoutine('08', '30', 'reflect')).toBe('Next routine: 08:30 (reflect).');
    expect(STATUS.en.allQuiet()).toBe('All quiet — nothing in progress, nothing waiting.');
  });

  test('SPEND cap status line', () => {
    expect(SPEND.en.capLabel('daily')).toBe('Today');
    expect(SPEND.en.capLabel('weekly')).toBe('This week');
    expect(SPEND.en.capLabel('monthly')).toBe('This month');
    expect(SPEND.en.capStatus('Today', '$0.00', '$5.00')).toBe('Today: $0.00 of $5.00 cap.');
  });

  test('BUDGET clauses and frames', () => {
    expect(BUDGET.en.periodPossessive('daily')).toBe("today's");
    expect(BUDGET.en.periodPossessive('weekly')).toBe("this week's");
    expect(BUDGET.en.periodPossessive('monthly')).toBe("this month's");
    expect(BUDGET.en.clause("today's", 1.05, 1.0, 105)).toBe("today's spend is $1.05 of your $1.00 cap (105%)");
    expect(BUDGET.en.capReachedPrefix()).toBe('Budget cap reached — ');
    expect(BUDGET.en.alsoApproaching()).toBe('. Also approaching: ');
    expect(BUDGET.en.pausedUntilSuffix('B')).toBe(". I've paused until B");
    expect(BUDGET.en.headsUpPrefix()).toBe('Heads up — ');
  });

  test('DENY maintainer frame (client copy deliberately excluded)', () => {
    expect(DENY.en.maintainerBase('Bash')).toBe('Auto-mode denied: Bash');
    expect(DENY.en.maintainerTail()).toBe('. Session continues. If intended: /hermit-settings or handle at the pane.');
  });

  test('MINT openLink / failed / signedIn (ackPrompt deliberately excluded)', () => {
    expect(MINT.en.openLink('URL')).toBe('Open this link to sign in, then send me the code it gives you:\nURL');
    expect(MINT.en.failed()).toBe("That sign-in didn't complete. Nothing changed — we can try again whenever you're ready.");
    expect(MINT.en.signedIn('5 July 2026')).toBe(
      "You're signed back in. Nothing else to do — the next renewal is due 5 July 2026, and I'll ask you then.",
    );
  });

  test('WATCHDOG lifecycle messages', () => {
    expect(WATCHDOG.en.restart('08:30', 'it had frozen')).toBe('I restarted your hermit at 08:30 — it had frozen.');
    expect(WATCHDOG.en.restartCauseNotRunning()).toBe("it wasn't running");
    expect(WATCHDOG.en.restartCauseFrozen()).toBe('it had frozen');
    expect(WATCHDOG.en.wedge('08:30')).toBe("Your hermit hasn't responded in a while — checking on it now (08:30).");
    expect(WATCHDOG.en.pauseUntilResume('X')).toBe('Your hermit is paused (X) until you resume it.');
    expect(WATCHDOG.en.pauseUntilDate('X', 'B')).toBe('Your hermit is paused (X) until B.');
    expect(WATCHDOG.en.stallQuestion('08:30')).toBe(
      "Your hermit is waiting on a question it can't ask over chat — open the terminal or Claude app to answer (08:30).",
    );
  });
});
