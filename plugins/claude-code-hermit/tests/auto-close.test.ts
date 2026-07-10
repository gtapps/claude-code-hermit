// bun test port of tests/test-auto-close.sh — PROP-040: automatic session close.
// Covers: heartbeat-precheck AUTO_CLOSE verdict, the last-operator-action.json
// signal (record-operator-action hook), the daily-auto-close pending-close
// drain, reflect-precheck closed_via handling, weekly-review partition of
// auto-archived sessions, and the stale-session gate.
//
// Scripts are exercised as subprocesses (via runScript) because that is the
// boundary the hooks/routines see — args + cwd + HERMIT_NOW in, verdict out.
//
// Usage: bun test tests/auto-close.test.ts   (from the plugin root)

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { runScript, PLUGIN_ROOT } from './helpers/run';
import { fixturesDir } from './helpers/workdir';

// ---------- fixture scaffolding ----------

const hermit = (dir: string, ...p: string[]) => path.join(dir, '.claude-code-hermit', ...p);

interface Tmp { dir: string; cleanup(): void }

function makeDir(): Tmp {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hermit-autoclose-'));
  fs.mkdirSync(hermit(dir, 'sessions'), { recursive: true });
  fs.mkdirSync(hermit(dir, 'state'), { recursive: true });
  return {
    dir,
    cleanup: () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} },
  };
}

/** Run a test body inside a throwaway workdir, always cleaning up. */
function withTmp(fn: (dir: string) => Promise<void> | void) {
  return async () => {
    const t = makeDir();
    try { await fn(t.dir); } finally { t.cleanup(); }
  };
}

const HEARTBEAT_MD = '# Heartbeat\n\n- [ ] Check system\n';
const RUNTIME_IN_PROGRESS = '{"session_state":"in_progress","session_id":"S-001"}';
const ALERT_EMPTY = '{"alerts":{},"last_digest_date":null,"self_eval":{},"total_ticks":0}';

const writeState = (dir: string, name: string, content: string) =>
  fs.writeFileSync(hermit(dir, 'state', name), content);

/** touch -d "<hours> hours ago" equivalent (creates the file if absent). */
function touchAgo(p: string, hours: number): void {
  if (!fs.existsSync(p)) fs.writeFileSync(p, '');
  const t = new Date(Date.now() - hours * 3600_000);
  fs.utimesSync(p, t, t);
}

/** Run heartbeat-precheck from inside the workdir and return its verdict. */
async function precheck(dir: string, opts: { now?: string; peek?: boolean } = {}): Promise<string> {
  const r = await runScript('heartbeat-precheck.ts', {
    args: [...(opts.peek ? ['--peek'] : []), '.claude-code-hermit'],
    cwd: dir,
    env: opts.now ? { HERMIT_NOW: opts.now } : {},
  });
  return r.stdout.trim();
}

async function reflectPrecheck(dir: string): Promise<string> {
  const r = await runScript('reflect-precheck.ts', {
    args: ['.claude-code-hermit', PLUGIN_ROOT], cwd: dir,
  });
  return r.stdout.trim();
}

/** Run weekly-review and return the generated review file's content. */
async function weeklyReview(dir: string): Promise<string> {
  await runScript('weekly-review.ts', { args: ['.claude-code-hermit', '/nonexistent'], cwd: dir });
  const compiled = hermit(dir, 'compiled');
  const name = fs.readdirSync(compiled).find((f) => /^review-weekly-.*\.md$/.test(f));
  expect(name).toBeDefined();
  return fs.readFileSync(path.join(compiled, name!), 'utf-8');
}

/** Session report frontmatter matching the bash heredocs. */
function report(o: {
  id: string; date: string; duration: string; cost: string; tokens: number;
  task: string; turns: number; closedVia: string; overview: string;
}): string {
  return `---
id: ${o.id}
status: completed
date: ${o.date}
duration: ${o.duration}
cost_usd: ${o.cost}
tokens: ${o.tokens}
tags: []
proposals_created: []
task: "${o.task}"
escalation: balanced
operator_turns: ${o.turns}
closed_via: ${o.closedVia}
---
## Overview
${o.overview}
`;
}

// date -u +%Y-%m-%dT12:00:00+00:00 / +%Y-%m-%d equivalents.
const TODAY = `${new Date().toISOString().slice(0, 10)}T12:00:00+00:00`;
const TODAY_DATE = new Date().toISOString().slice(0, 10);

// Standard precheck fixture: HEARTBEAT.md + SHELL.md + runtime + empty alert state.
function seedPrecheck(dir: string, opts: { shellAgeHours?: number } = {}): void {
  fs.writeFileSync(hermit(dir, 'HEARTBEAT.md'), HEARTBEAT_MD);
  touchAgo(hermit(dir, 'sessions', 'SHELL.md'), opts.shellAgeHours ?? 0);
  writeState(dir, 'runtime.json', RUNTIME_IN_PROGRESS);
  writeState(dir, 'alert-state.json', ALERT_EMPTY);
}

// Reusable fixture for the drain cases: HEARTBEAT.md with one item + alert-state scaffold.
function hbSetup(dir: string): void {
  fs.writeFileSync(hermit(dir, 'HEARTBEAT.md'), HEARTBEAT_MD);
  fs.writeFileSync(hermit(dir, 'sessions', 'SHELL.md'), '');
  writeState(dir, 'alert-state.json', ALERT_EMPTY);
}

// Reflect-precheck fixture shared by test 2 and exclude.2.
function seedReflect(dir: string, reportMd: string): void {
  fs.mkdirSync(hermit(dir, 'proposals'), { recursive: true });
  fs.copyFileSync(path.join(fixturesDir, 'shell-session.md'), hermit(dir, 'sessions', 'SHELL.md'));
  fs.writeFileSync(hermit(dir, 'config.json'), '{"timezone":"UTC"}');
  fs.writeFileSync(hermit(dir, 'sessions', 'S-001-REPORT.md'), reportMd);
  // old lastRunAt so the report mtime appears newer; old since so phase is
  // 'adult' (prevents newborn/digest from firing).
  writeState(dir, 'reflection-state.json',
    '{"counters":{"last_run_at":"2020-01-01T00:00:00Z","since":"2020-01-01T00:00:00Z"}}\n');
  // session_state: idle so the in_progress short-circuit doesn't apply
  writeState(dir, 'runtime.json', '{"session_state":"idle"}');
}

// -------------------------------------------------------
// heartbeat-precheck: AUTO_CLOSE verdict (PROP-040)
// -------------------------------------------------------

describe('heartbeat-precheck AUTO_CLOSE verdict', () => {
  test('heartbeat-precheck: stale SHELL.md (13h) → AUTO_CLOSE', withTmp(async (dir) => {
    seedPrecheck(dir, { shellAgeHours: 13 });
    expect(await precheck(dir)).toBe('AUTO_CLOSE');
  }));

  test('heartbeat-precheck: fresh SHELL.md → EVALUATE (not AUTO_CLOSE)', withTmp(async (dir) => {
    seedPrecheck(dir);
    expect(await precheck(dir)).toBe('EVALUATE');
  }));
});

// -------------------------------------------------------
// reflect-precheck: auto-archived session report DOES trigger compute phase
// (the prior closed_via: auto skip was removed so daily-midnight archives reach reflect)
// -------------------------------------------------------

test('reflect-precheck: auto-archived report newer than last_reflection → triggers compute phase (skip removed)',
  withTmp(async (dir) => {
    seedReflect(dir, report({
      id: 'S-001', date: '2026-01-15T10:00:00+00:00', duration: '1h', cost: '0.00',
      tokens: 0, task: 'test', turns: 3, closedVia: 'auto',
      overview: 'Auto-closed by heartbeat.',
    }));
    expect(await reflectPrecheck(dir)).not.toBe('EMPTY');
  }));

// -------------------------------------------------------
// weekly-review: auto-archived in cost total, excluded from autonomy denominator
// -------------------------------------------------------

describe('weekly-review partition of auto-archived sessions', () => {
  let wd: Tmp;
  let content: string;

  beforeAll(async () => {
    wd = makeDir();
    fs.writeFileSync(hermit(wd.dir, 'config.json'), '{"timezone":"UTC"}');
    fs.writeFileSync(hermit(wd.dir, 'sessions', 'S-001-REPORT.md'), report({
      id: 'S-001', date: TODAY, duration: '2h', cost: '1.50', tokens: 50000,
      task: 'real work', turns: 5, closedVia: 'operator', overview: 'Real work session.',
    }));
    fs.writeFileSync(hermit(wd.dir, 'sessions', 'S-002-REPORT.md'), report({
      id: 'S-002', date: TODAY, duration: '1h', cost: '0.80', tokens: 20000,
      task: 'work then quiet', turns: 3, closedVia: 'auto',
      overview: 'Auto-closed after 12h quiet.',
    }));
    content = await weeklyReview(wd.dir);
  });

  afterAll(() => wd.cleanup());

  test('weekly-review: sessions_count: 2 (both included)', () => {
    expect(content).toContain('sessions_count: 2');
  });

  test('weekly-review: total_cost_usd: 2.30 (both summed)', () => {
    expect(content).toContain('total_cost_usd: 2.30');
  });

  test('weekly-review: body shows 2 sessions headline', () => {
    expect(content).toContain('2 sessions');
  });

  test('weekly-review: auto-archived excluded note GONE (filter removed)', () => {
    expect(content).not.toContain('auto-archived excluded');
  });

  // Both sessions have operator_turns > 0 → neither self-directed.
  // Denominator is now all sessions (no auto exclusion). autonomousRate = 0/2 = 0.00.
  test('weekly-review: self_directed_rate: 0.00 (both in denominator, neither self-directed)', () => {
    expect(content).toContain('self_directed_rate: 0.00');
  });
});

// -------------------------------------------------------
// last-operator-action.json signal
// -------------------------------------------------------

describe('last-operator-action.json signal', () => {
  const lastOp = (dir: string) => hermit(dir, 'state', 'last-operator-action.json');
  const recordHook = (dir: string, stdin: string, args: string[] = []) =>
    runScript('record-operator-action.ts', { stdin, cwd: dir, args });

  // a. precheck: last-operator-action.json 13h ago + fresh SHELL.md mtime → AUTO_CLOSE
  test('precheck: stale last-operator-action (13h) + fresh SHELL.md → AUTO_CLOSE', withTmp(async (dir) => {
    seedPrecheck(dir); // fresh SHELL.md mtime
    writeState(dir, 'last-operator-action.json', '{"at":"2026-05-20T09:00:00+00:00"}');
    expect(await precheck(dir, { now: '2026-05-20T22:00:00+00:00' })).toBe('AUTO_CLOSE');
  }));

  // b. precheck: last-operator-action.json 1h ago + stale SHELL.md (13h) → EVALUATE
  test('precheck: fresh last-operator-action (1h) + stale SHELL.md (13h) → EVALUATE', withTmp(async (dir) => {
    seedPrecheck(dir, { shellAgeHours: 13 });
    writeState(dir, 'last-operator-action.json', '{"at":"2026-05-20T21:00:00+00:00"}');
    expect(await precheck(dir, { now: '2026-05-20T22:00:00+00:00' })).toBe('EVALUATE');
  }));

  // c. precheck: last-operator-action.json absent + stale SHELL.md → AUTO_CLOSE (mtime fallback)
  test('precheck: absent last-operator-action + stale SHELL.md → AUTO_CLOSE (mtime fallback)', withTmp(async (dir) => {
    seedPrecheck(dir, { shellAgeHours: 13 });
    expect(await precheck(dir)).toBe('AUTO_CLOSE');
  }));

  // d. precheck: malformed last-operator-action.json cases → fall back to mtime, no crash
  for (const badAt of ['null', '123', '"not-a-date"']) {
    test(`precheck: malformed at=${badAt} → AUTO_CLOSE via mtime fallback, no crash`, withTmp(async (dir) => {
      seedPrecheck(dir, { shellAgeHours: 13 });
      writeState(dir, 'last-operator-action.json', `{"at":${badAt}}`);
      expect(await precheck(dir)).toBe('AUTO_CLOSE');
    }));
  }

  // e. hook smoke: routine prompt → file NOT written
  test('hook smoke: [hermit-routine: prefix → file NOT written', withTmp(async (dir) => {
    await recordHook(dir, '{"prompt":"[hermit-routine:reflect] Invoke /claude-code-hermit:reflect."}');
    expect(fs.existsSync(lastOp(dir))).toBe(false);
  }));

  // f. hook smoke: plain operator prompt → file IS written
  test('hook smoke: plain operator prompt → file IS written', withTmp(async (dir) => {
    await recordHook(dir, '{"prompt":"hello"}');
    expect(fs.existsSync(lastOp(dir))).toBe(true);
  }));

  // g. hook smoke: exact hermit-injected commands (watchdog re-arm + shutdown) → file NOT written
  for (const injected of [
    '/claude-code-hermit:heartbeat run',
    '/claude-code-hermit:heartbeat start',
    '/claude-code-hermit:heartbeat stop',
    '/claude-code-hermit:hermit-routines load',
    '/claude-code-hermit:session-close --shutdown',
  ]) {
    test(`hook smoke: injected "${injected}" → file NOT written`, withTmp(async (dir) => {
      await recordHook(dir, JSON.stringify({ prompt: injected }));
      expect(fs.existsSync(lastOp(dir))).toBe(false);
    }));
  }

  // g3. hook smoke: injected command with trailing whitespace/newline still matches
  test('hook smoke: injected command with trailing whitespace → file NOT written', withTmp(async (dir) => {
    await recordHook(dir, JSON.stringify({ prompt: '/claude-code-hermit:heartbeat run\n' }));
    expect(fs.existsSync(lastOp(dir))).toBe(false);
  }));

  // g4. hook smoke: watchdog hygiene commands (/clear, /compact ...) → file NOT written
  test('hook smoke: bare /clear (watchdog hygiene) → file NOT written', withTmp(async (dir) => {
    await recordHook(dir, '{"prompt":"/clear"}');
    expect(fs.existsSync(lastOp(dir))).toBe(false);
  }));

  test('hook smoke: bare /compact ... (watchdog hygiene) → file NOT written', withTmp(async (dir) => {
    await recordHook(dir, JSON.stringify({
      prompt: '/compact focus on unfinished work, pending operator items, and in-flight decisions',
    }));
    expect(fs.existsSync(lastOp(dir))).toBe(false);
  }));

  // h. hook smoke: legacy wrapped shape (never actually reaches stdin per the
  // 2026-07-10 probe, but must not regress to dropped if some future CC version emits it)
  test('hook smoke: legacy <command-message> wrapped shape → file IS written', withTmp(async (dir) => {
    await recordHook(dir, JSON.stringify({
      prompt: '<command-message>heartbeat run</command-message>\n<command-name>/claude-code-hermit:heartbeat run</command-name>',
    }));
    expect(fs.existsSync(lastOp(dir))).toBe(true);
  }));

  // i. hook smoke: channel inbound prompt → file NOT written (channel-responder handles post-auth)
  test('hook smoke: <channel inbound → file NOT written by hook', withTmp(async (dir) => {
    await recordHook(dir, '{"prompt":"<channel source=discord chat_id=x>hi</channel>"}');
    expect(fs.existsSync(lastOp(dir))).toBe(false);
  }));

  // j. hook smoke: operator-typed bare /brief → file IS written (#574 repro — this is the
  // shape a real operator slash-command turn actually arrives as; no <command-message>
  // wrapper reaches this hook's stdin)
  test('hook smoke: operator-typed bare /claude-code-hermit:brief → file IS written', withTmp(async (dir) => {
    await recordHook(dir, '{"prompt":"/claude-code-hermit:brief"}');
    expect(fs.existsSync(lastOp(dir))).toBe(true);
  }));

  // k. hook smoke: legacy wrapped /brief shape → still written
  test('hook smoke: legacy <command-message> wrapped /brief shape → file IS written', withTmp(async (dir) => {
    await recordHook(dir, JSON.stringify({
      prompt: '<command-message>claude-code-hermit:brief</command-message>\n<command-name>/claude-code-hermit:brief</command-name>',
    }));
    expect(fs.existsSync(lastOp(dir))).toBe(true);
  }));

  // l. hook smoke: bare arbitrary namespaced slash command → file IS written (not on the
  // hermit-injected drop-list, so it counts as operator activity — see #574)
  test('hook smoke: bare /some-future-plugin:some-cmd → file IS written', withTmp(async (dir) => {
    await recordHook(dir, '{"prompt":"/some-future-plugin:some-cmd --flag"}');
    expect(fs.existsSync(lastOp(dir))).toBe(true);
  }));

  // l2. hook smoke: un-namespaced operator command (e.g. a personal/project skill) → file IS written
  test('hook smoke: bare /tackle-issue 574 (un-namespaced) → file IS written', withTmp(async (dir) => {
    await recordHook(dir, '{"prompt":"/tackle-issue 574"}');
    expect(fs.existsSync(lastOp(dir))).toBe(true);
  }));

  // l3. hook smoke: single-step always-on boot skill (hermit-start.ts argv bootstrap) →
  // file IS written (accepted delta: this is indistinguishable from operator-typed /session)
  test('hook smoke: bare /claude-code-hermit:session (boot_skill) → file IS written', withTmp(async (dir) => {
    await recordHook(dir, '{"prompt":"/claude-code-hermit:session"}');
    expect(fs.existsSync(lastOp(dir))).toBe(true);
  }));

  // m. SessionStart (no payload) + absent file → file IS written (cold-start seed)
  test('SessionStart with absent state file → file IS written (cold-start seed)', withTmp(async (dir) => {
    await recordHook(dir, '');
    expect(fs.existsSync(lastOp(dir))).toBe(true);
  }));

  // n. SessionStart (no payload) + existing file → timestamp preserved (no mask on restart)
  test("SessionStart with existing state file → timestamp preserved (restart doesn't reset clock)", withTmp(async (dir) => {
    writeState(dir, 'last-operator-action.json', '{"at":"2026-05-20T09:00:00.000Z"}');
    await recordHook(dir, '');
    expect(fs.readFileSync(lastOp(dir), 'utf-8')).toContain('2026-05-20T09:00:00');
  }));

  // o. --force invocation (channel-responder post-auth path) → file IS written
  test('--force → file IS written (channel-responder post-auth)', withTmp(async (dir) => {
    await recordHook(dir, '', ['--force']);
    expect(fs.existsSync(lastOp(dir))).toBe(true);
  }));

  // p. --force overwrites existing file (channel inbound = fresh operator activity)
  test('--force overwrites existing file (channel inbound bumps clock)', withTmp(async (dir) => {
    writeState(dir, 'last-operator-action.json', '{"at":"2026-05-20T09:00:00.000Z"}');
    await recordHook(dir, '', ['--force']);
    expect(fs.readFileSync(lastOp(dir), 'utf-8')).not.toContain('2026-05-20T09:00:00');
  }));
});

// -------------------------------------------------------
// injection-sync drift guard: every slash literal hermit-watchdog.ts /
// hermit-stop.ts inject via tmux send-keys must be dropped by
// record-operator-action.ts's isRoutinePrompt. Prevents a future injection
// from silently refreshing the operator clock it should not touch.
// -------------------------------------------------------

describe('record-operator-action: hermit-injected commands stay in sync', () => {
  function extractSendKeysLiterals(file: string): string[] {
    const src = fs.readFileSync(path.join(PLUGIN_ROOT, 'scripts', file), 'utf-8');
    const literals: string[] = [];
    for (const line of src.split('\n')) {
      if (!line.includes('sendKeys(') && !line.includes("'send-keys'")) continue;
      for (const m of line.matchAll(/'(\/[^']*)'/g)) literals.push(m[1]);
    }
    return literals;
  }

  const literals = [
    ...extractSendKeysLiterals('hermit-watchdog.ts'),
    ...extractSendKeysLiterals('hermit-stop.ts'),
  ];

  test('sweep finds a non-trivial number of injected slash literals', () => {
    expect(literals.length).toBeGreaterThanOrEqual(5);
  });

  for (const literal of [...new Set(literals)]) {
    test(`injected literal "${literal}" is dropped by record-operator-action.ts`, withTmp(async (dir) => {
      const r = await runScript('record-operator-action.ts', {
        stdin: JSON.stringify({ prompt: literal }),
        cwd: dir,
      });
      expect(r.exitCode).toBe(0);
      expect(fs.existsSync(hermit(dir, 'state', 'last-operator-action.json'))).toBe(false);
    }));
  }
});

// -------------------------------------------------------
// daily-auto-close lull + pending-close drain
// -------------------------------------------------------

describe('daily-auto-close lull + pending-close drain', () => {
  const PENDING = '{"queued_at":"2026-05-20T22:00:00+00:00","queued_by":"daily-auto-close"}';
  const NOW = '2026-05-20T22:45:00+00:00';

  // drain.1. pending-close.json + last_op > 10min + in_progress → AUTO_CLOSE
  test('drain: pending-close + last_op > 10min + in_progress → AUTO_CLOSE', withTmp(async (dir) => {
    hbSetup(dir);
    writeState(dir, 'pending-close.json', PENDING);
    writeState(dir, 'last-operator-action.json', '{"at":"2026-05-20T22:30:00+00:00"}');
    writeState(dir, 'runtime.json', RUNTIME_IN_PROGRESS);
    expect(await precheck(dir, { now: NOW })).toBe('AUTO_CLOSE');
  }));

  // drain.2. pending-close.json + last_op < 10min + in_progress → not AUTO_CLOSE
  test('drain: pending-close + last_op < 10min + in_progress → does NOT emit AUTO_CLOSE', withTmp(async (dir) => {
    hbSetup(dir);
    writeState(dir, 'pending-close.json', PENDING);
    writeState(dir, 'last-operator-action.json', '{"at":"2026-05-20T22:40:00+00:00"}');
    writeState(dir, 'runtime.json', RUNTIME_IN_PROGRESS);
    expect(await precheck(dir, { now: NOW })).not.toBe('AUTO_CLOSE');
  }));

  // drain.3. pending-close.json + session_state == idle + lull > 10min → AUTO_CLOSE
  // (idle sessions now participate in the midnight close — always-on deployments
  //  where work happens via channels/routines without a formal task get daily archival)
  test('drain: pending-close + idle + lull > 10min → AUTO_CLOSE', withTmp(async (dir) => {
    hbSetup(dir);
    writeState(dir, 'pending-close.json', PENDING);
    writeState(dir, 'last-operator-action.json', '{"at":"2026-05-20T22:30:00+00:00"}');
    writeState(dir, 'runtime.json', '{"session_state":"idle"}');
    expect(await precheck(dir, { now: NOW })).toBe('AUTO_CLOSE');
  }));

  // drain.3b. pending-close.json + session_state == idle + last_op < 10min → not AUTO_CLOSE
  // (operator is between tasks but recently active — respect the lull threshold)
  test('drain: pending-close + idle + last_op < 10min → does NOT emit AUTO_CLOSE', withTmp(async (dir) => {
    hbSetup(dir);
    writeState(dir, 'pending-close.json', PENDING);
    writeState(dir, 'last-operator-action.json', '{"at":"2026-05-20T22:40:00+00:00"}');
    writeState(dir, 'runtime.json', '{"session_state":"idle"}');
    expect(await precheck(dir, { now: NOW })).not.toBe('AUTO_CLOSE');
  }));

  // drain.4. drain bypasses active-hours skip (load-bearing invariant)
  test('drain: outside active hours + pending-close + lull → AUTO_CLOSE (bypasses active-hours skip)', withTmp(async (dir) => {
    hbSetup(dir);
    writeState(dir, 'pending-close.json',
      '{"queued_at":"2026-05-20T22:00:00+00:00","queued_by":"daily-auto-close","heartbeat":{"active_hours":{"start":"08:00","end":"23:00"}}}');
    // config has active_hours that EXCLUDE 03:00 (we'll send HERMIT_NOW at 03:00)
    fs.writeFileSync(hermit(dir, 'config.json'),
      '{"timezone":"UTC","heartbeat":{"active_hours":{"start":"08:00","end":"23:00"}}}');
    writeState(dir, 'last-operator-action.json', '{"at":"2026-05-21T02:30:00+00:00"}');
    writeState(dir, 'runtime.json', RUNTIME_IN_PROGRESS);
    expect(await precheck(dir, { now: '2026-05-21T03:00:00+00:00' })).toBe('AUTO_CLOSE');
  }));

  // drain.5. pending-close.json absent → existing 12h fallback path unchanged
  test('drain: no pending flag + last_op 13h ago → AUTO_CLOSE via existing 12h fallback (regression guard)', withTmp(async (dir) => {
    hbSetup(dir);
    writeState(dir, 'last-operator-action.json', '{"at":"2026-05-20T09:00:00+00:00"}');
    writeState(dir, 'runtime.json', RUNTIME_IN_PROGRESS);
    expect(await precheck(dir, { now: '2026-05-20T22:00:00+00:00' })).toBe('AUTO_CLOSE');
  }));

  // drain.6. malformed pending-close.json → no drain, no crash, falls through
  test('drain: malformed pending-close.json → no drain, no crash, falls through', withTmp(async (dir) => {
    hbSetup(dir);
    writeState(dir, 'pending-close.json', '{not valid');
    writeState(dir, 'last-operator-action.json', '{"at":"2026-05-20T22:30:00+00:00"}');
    writeState(dir, 'runtime.json', RUNTIME_IN_PROGRESS);
    expect(await precheck(dir, { now: NOW })).not.toBe('AUTO_CLOSE');
  }));

  // drain.7. hook smoke: [hermit-routine:daily-auto-close ...] → file NOT written
  // (proves the routine fire doesn't poison the very clock it reads)
  test('hook smoke: [hermit-routine:daily-auto-close prefix → file NOT written', withTmp(async (dir) => {
    await runScript('record-operator-action.ts', {
      stdin: '{"prompt":"[hermit-routine:daily-auto-close] Invoke /claude-code-hermit:session-close --scheduled."}',
      cwd: dir,
    });
    expect(fs.existsSync(hermit(dir, 'state', 'last-operator-action.json'))).toBe(false);
  }));

  // drain.8. pending-close.json + in_progress + last-operator-action.json ABSENT → AUTO_CLOSE
  // (per daily-auto-close SKILL.md step 5: absent clock = idle indefinitely = fail-open close)
  test('drain: pending-close + in_progress + absent last-op → AUTO_CLOSE (fail-open)', withTmp(async (dir) => {
    hbSetup(dir);
    writeState(dir, 'pending-close.json', PENDING);
    // NO last-operator-action.json written — fresh install scenario.
    writeState(dir, 'runtime.json', RUNTIME_IN_PROGRESS);
    expect(await precheck(dir, { now: NOW })).toBe('AUTO_CLOSE');
  }));

  // drain.9. pending-close.json + in_progress + last-operator-action.json malformed → AUTO_CLOSE
  // (malformed at-field treated the same as absent — fail-open)
  test('drain: pending-close + in_progress + malformed last-op → AUTO_CLOSE (fail-open)', withTmp(async (dir) => {
    hbSetup(dir);
    writeState(dir, 'pending-close.json', PENDING);
    writeState(dir, 'last-operator-action.json', '{"at":"not-a-date"}');
    writeState(dir, 'runtime.json', RUNTIME_IN_PROGRESS);
    expect(await precheck(dir, { now: NOW })).toBe('AUTO_CLOSE');
  }));

  // drain.10. HEARTBEAT.md missing + pending-close + lull → AUTO_CLOSE
  // (drain runs before the HEARTBEAT.md SKIP gate — the close is the signal,
  //  not a notification, and must not depend on operator-editable HEARTBEAT.md)
  test('drain: HEARTBEAT.md missing + pending-close + lull → AUTO_CLOSE (drain bypasses SKIP gate)', withTmp(async (dir) => {
    // Deliberately NO HEARTBEAT.md
    fs.writeFileSync(hermit(dir, 'sessions', 'SHELL.md'), '');
    writeState(dir, 'alert-state.json', ALERT_EMPTY);
    writeState(dir, 'pending-close.json', PENDING);
    writeState(dir, 'last-operator-action.json', '{"at":"2026-05-20T22:30:00+00:00"}');
    writeState(dir, 'runtime.json', RUNTIME_IN_PROGRESS);
    expect(await precheck(dir, { now: NOW })).toBe('AUTO_CLOSE');
  }));

  // drain.11. HEARTBEAT.md empty + pending-close + lull → AUTO_CLOSE
  // (drain runs before the empty-checklist SKIP gate too)
  test('drain: HEARTBEAT.md no-checklist + pending-close + lull → AUTO_CLOSE (drain bypasses SKIP gate)', withTmp(async (dir) => {
    hbSetup(dir);
    // Overwrite HEARTBEAT.md with no checklist items
    fs.writeFileSync(hermit(dir, 'HEARTBEAT.md'), '# Heartbeat\n\nNo items today.\n');
    writeState(dir, 'pending-close.json', PENDING);
    writeState(dir, 'last-operator-action.json', '{"at":"2026-05-20T22:30:00+00:00"}');
    writeState(dir, 'runtime.json', RUNTIME_IN_PROGRESS);
    expect(await precheck(dir, { now: NOW })).toBe('AUTO_CLOSE');
  }));

  // drain.12. stale queued_at (>24h) + absent last-op + in_progress → NO AUTO_CLOSE
  // (defends fresh sessions against premature close when a leftover flag from a
  //  crashed prior session coincides with a missing last-op clock)
  test('drain: stale queued_at (>24h) + absent last-op → NO AUTO_CLOSE (stale-flag guard)', withTmp(async (dir) => {
    hbSetup(dir);
    writeState(dir, 'pending-close.json',
      '{"queued_at":"2026-05-19T00:00:00+00:00","queued_by":"daily-auto-close"}');
    // NO last-operator-action.json — fresh-session scenario after prior crash
    writeState(dir, 'runtime.json', '{"session_state":"in_progress","session_id":"S-002"}');
    // HERMIT_NOW is 2026-05-21 → queued_at is 48h+ old → stale flag
    expect(await precheck(dir, { now: '2026-05-21T01:00:00+00:00' })).not.toBe('AUTO_CLOSE');
  }));

  // drain.13. pending-close.json missing queued_at + absent last-op → NO AUTO_CLOSE
  // (defensive: if queued_at can't be parsed we can't tell the flag's age, so
  //  don't fail-open close — wait for either a valid last-op or the next routine fire)
  test('drain: pending-close missing queued_at + absent last-op → NO AUTO_CLOSE (defensive)', withTmp(async (dir) => {
    hbSetup(dir);
    writeState(dir, 'pending-close.json', '{"queued_by":"daily-auto-close"}');
    // NO last-operator-action.json
    writeState(dir, 'runtime.json', '{"session_state":"in_progress","session_id":"S-003"}');
    expect(await precheck(dir, { now: '2026-05-21T01:00:00+00:00' })).not.toBe('AUTO_CLOSE');
  }));

  // drain.14. stale queued_at + VALID old last-op (>10min) → AUTO_CLOSE
  // (a stale flag is still actionable when last-op proves a real lull; the staleness
  //  guard only suppresses the fail-open path, not the standard lull-check path)
  test('drain: stale queued_at + valid >10min last-op → AUTO_CLOSE (lull-check path unaffected by guard)', withTmp(async (dir) => {
    hbSetup(dir);
    writeState(dir, 'pending-close.json',
      '{"queued_at":"2026-05-19T00:00:00+00:00","queued_by":"daily-auto-close"}');
    writeState(dir, 'last-operator-action.json', '{"at":"2026-05-21T00:30:00+00:00"}');
    writeState(dir, 'runtime.json', '{"session_state":"in_progress","session_id":"S-004"}');
    expect(await precheck(dir, { now: '2026-05-21T01:00:00+00:00' })).toBe('AUTO_CLOSE');
  }));
});

// -------------------------------------------------------
// empty-12h-archive exclusion in weekly-review / reflect-precheck
// -------------------------------------------------------

describe('empty-12h-archive exclusion in weekly-review / reflect-precheck', () => {
  // exclude.1. weekly-review: closed_via:auto + operator_turns:0 EXCLUDED from autonomy denominator
  describe('weekly-review exclusion', () => {
    let wd: Tmp;
    let content: string;

    beforeAll(async () => {
      wd = makeDir();
      fs.writeFileSync(hermit(wd.dir, 'config.json'), '{"timezone":"UTC"}');
      fs.writeFileSync(hermit(wd.dir, 'sessions', 'S-001-REPORT.md'), report({
        id: 'S-001', date: TODAY, duration: '2h', cost: '1.50', tokens: 50000,
        task: 'real work', turns: 5, closedVia: 'operator', overview: 'Real work session.',
      }));
      fs.writeFileSync(hermit(wd.dir, 'sessions', 'S-002-REPORT.md'), report({
        id: 'S-002', date: TODAY, duration: '12h', cost: '0.00', tokens: 0,
        task: '', turns: 0, closedVia: 'auto', overview: 'Auto-closed by heartbeat.',
      }));
      content = await weeklyReview(wd.dir);
    });

    afterAll(() => wd.cleanup());

    // Both sessions count in sessions_count and total_cost (raw aggregates).
    test('weekly-review: sessions_count: 2 (raw count includes empty 12h archive)', () => {
      expect(content).toContain('sessions_count: 2');
    });

    // S-002 (empty 12h auto) excluded from autonomy calc. Denominator = 1 (S-001 only).
    // S-001 has operator_turns=5 → not self-directed → numerator=0. autonomousRate = 0/1 = 0.00.
    test('weekly-review: self_directed_rate: 0.00 (S-001 in denominator, S-002 empty-12h excluded)', () => {
      expect(content).toContain('self_directed_rate: 0.00');
    });

    // Header text: 1 operator-assisted (S-001 with operator_turns=5), 0 self-directed.
    test("weekly-review: '0 self-directed' (empty 12h archive NOT counted as self-directed)", () => {
      expect(content).toContain('0 self-directed');
    });
  });

  // exclude.2. reflect-precheck: closed_via:auto + operator_turns:0 does NOT trigger compute phase
  test('reflect-precheck: only empty 12h archive (operator_turns:0, closed_via:auto) → EMPTY (skipped)',
    withTmp(async (dir) => {
      seedReflect(dir, report({
        id: 'S-001', date: '2026-01-15T10:00:00+00:00', duration: '12h', cost: '0.00',
        tokens: 0, task: '', turns: 0, closedVia: 'auto',
        overview: 'Auto-closed by heartbeat.',
      }));
      expect(await reflectPrecheck(dir)).toBe('EMPTY');
    }));
});

// -------------------------------------------------------
// stale-session gate: skip LLM wake when operator is present
// -------------------------------------------------------

describe('stale-session gate: skip LLM wake when operator is present', () => {
  // Shared setup: HEARTBEAT.md with one suppressed item (all OK for checklist gate),
  // last_digest_date = today so the digest gate doesn't fire, total_ticks = 1.
  const SUPPRESSED_ALERT_STATE = JSON.stringify({
    alerts: {
      'checklist:checksys': {
        count: 6, consecutive_clean: 0, suppressed: true,
        first_seen: TODAY_DATE, last_seen: TODAY_DATE, text: 'Check system',
      },
    },
    last_digest_date: TODAY_DATE, self_eval: {}, total_ticks: 1,
  });
  const NOW = '2026-05-20T22:00:00+00:00';

  // HEARTBEAT.md with a plain (non-checkbox) item, per the bash fixture.
  function seedStale(dir: string, alertState: string = SUPPRESSED_ALERT_STATE): void {
    fs.writeFileSync(hermit(dir, 'HEARTBEAT.md'), '# Heartbeat\n\n- Check system\n');
    fs.writeFileSync(hermit(dir, 'sessions', 'SHELL.md'), '');
    writeState(dir, 'runtime.json', RUNTIME_IN_PROGRESS);
    writeState(dir, 'alert-state.json', alertState);
  }

  // stale.1. in_progress + operator within stale_threshold + all items suppressed + digest ran → OK
  test('stale-gate: in_progress + operator 30min ago + suppressed checklist + digest done → OK', withTmp(async (dir) => {
    seedStale(dir);
    writeState(dir, 'last-operator-action.json', '{"at":"2026-05-20T21:30:00+00:00"}');
    expect(await precheck(dir, { now: NOW, peek: true })).toBe('OK');
  }));

  // stale.2. in_progress + operator quiet beyond stale_threshold → EVALUATE (unchanged)
  test('stale-gate: in_progress + operator 3h ago (> 2h threshold) → EVALUATE', withTmp(async (dir) => {
    seedStale(dir);
    writeState(dir, 'last-operator-action.json', '{"at":"2026-05-20T19:00:00+00:00"}');
    expect(await precheck(dir, { now: NOW, peek: true })).toBe('EVALUATE');
  }));

  // stale.3. in_progress + operator recent + stale-session alert active → EVALUATE (resolution tracking)
  test('stale-gate: operator recent + stale-session alert active → EVALUATE (resolution tracking)', withTmp(async (dir) => {
    const staleActive = JSON.stringify({
      alerts: {
        'checklist:checksys': {
          count: 6, consecutive_clean: 0, suppressed: true,
          first_seen: TODAY_DATE, last_seen: TODAY_DATE, text: 'Check system',
        },
        'stale-session': {
          count: 1, consecutive_clean: 0, suppressed: false,
          first_seen: TODAY_DATE, last_seen: TODAY_DATE, text: 'Stale session',
        },
      },
      last_digest_date: TODAY_DATE, self_eval: {}, total_ticks: 1,
    });
    seedStale(dir, staleActive);
    writeState(dir, 'last-operator-action.json', '{"at":"2026-05-20T21:30:00+00:00"}');
    expect(await precheck(dir, { now: NOW, peek: true })).toBe('EVALUATE');
  }));

  // stale.4. in_progress + future-dated last-operator-action (clock skew) → EVALUATE (fail-open)
  test('stale-gate: future-dated last-operator-action (clock skew) → EVALUATE (fail-open)', withTmp(async (dir) => {
    seedStale(dir);
    writeState(dir, 'last-operator-action.json', '{"at":"2026-05-20T23:00:00+00:00"}');
    expect(await precheck(dir, { now: NOW, peek: true })).toBe('EVALUATE');
  }));

  // stale.5. in_progress + no last-operator-action.json → EVALUATE (no regression for pre-upgrade installs)
  test('stale-gate: absent last-operator-action (pre-upgrade install) → EVALUATE (no regression)', withTmp(async (dir) => {
    seedStale(dir);
    expect(await precheck(dir, { now: NOW, peek: true })).toBe('EVALUATE');
  }));

  // stale.6. stale.1 variant WITHOUT last_digest_date=today → EVALUATE (digest gate fires correctly)
  test('stale-gate: operator recent + suppressed but digest not yet run today → EVALUATE (daily digest)', withTmp(async (dir) => {
    // Same suppressed item but last_digest_date is yesterday → digest gate fires
    const staleNoDigest = JSON.stringify({
      alerts: {
        'checklist:checksys': {
          count: 6, consecutive_clean: 0, suppressed: true,
          first_seen: '2026-05-19', last_seen: '2026-05-19', text: 'Check system',
        },
      },
      last_digest_date: '2026-05-19', self_eval: {}, total_ticks: 1,
    });
    seedStale(dir, staleNoDigest);
    writeState(dir, 'last-operator-action.json', '{"at":"2026-05-20T21:30:00+00:00"}');
    expect(await precheck(dir, { now: NOW, peek: true })).toBe('EVALUATE');
  }));

  // stale.7. Damper: second tick within stale_threshold, unchanged condition → fall-through → OK
  test('stale-gate: damper — stale condition unchanged within threshold → fall-through → OK', withTmp(async (dir) => {
    const damped = JSON.stringify({
      alerts: {
        'checklist:checksys': {
          count: 6, consecutive_clean: 0, suppressed: true,
          first_seen: TODAY_DATE, last_seen: TODAY_DATE, text: 'Check system',
        },
      },
      last_digest_date: TODAY_DATE, self_eval: {}, total_ticks: 1,
      last_stale_wake_at: '2026-05-20T21:00:00+00:00', // 1h before NOW, < 2h threshold
    });
    seedStale(dir, damped);
    writeState(dir, 'last-operator-action.json', '{"at":"2026-05-20T19:00:00+00:00"}'); // 3h ago (opQuiet)
    expect(await precheck(dir, { now: NOW, peek: true })).toBe('OK');
  }));

  // stale.8. Damper: stale_threshold elapsed since last wake → EVALUATE again
  test('stale-gate: damper — stale_threshold elapsed since last_stale_wake_at → EVALUATE', withTmp(async (dir) => {
    const damped = JSON.stringify({
      alerts: {
        'checklist:checksys': {
          count: 6, consecutive_clean: 0, suppressed: true,
          first_seen: TODAY_DATE, last_seen: TODAY_DATE, text: 'Check system',
        },
      },
      last_digest_date: TODAY_DATE, self_eval: {}, total_ticks: 1,
      last_stale_wake_at: '2026-05-20T19:30:00+00:00', // 2.5h before NOW, > 2h threshold
    });
    seedStale(dir, damped);
    writeState(dir, 'last-operator-action.json', '{"at":"2026-05-20T19:00:00+00:00"}'); // 3h ago (opQuiet)
    expect(await precheck(dir, { now: NOW, peek: true })).toBe('EVALUATE');
  }));

  // stale.9. Damper: operator advances after damp period → EVALUATE (operatorAdvanced)
  test('stale-gate: damper — operator advances after damp → EVALUATE', withTmp(async (dir) => {
    const staleActive = JSON.stringify({
      alerts: {
        'checklist:checksys': {
          count: 6, consecutive_clean: 0, suppressed: true,
          first_seen: TODAY_DATE, last_seen: TODAY_DATE, text: 'Check system',
        },
        'stale-session': {
          count: 1, consecutive_clean: 0, suppressed: false,
          first_seen: TODAY_DATE, last_seen: TODAY_DATE, text: 'Stale session',
        },
      },
      last_digest_date: TODAY_DATE, self_eval: {}, total_ticks: 1,
      last_stale_wake_at: '2026-05-20T21:30:00+00:00', // 30min before NOW
    });
    seedStale(dir, staleActive);
    // Operator acted at 21:45 — after last_stale_wake_at (21:30) → operatorAdvanced = true
    writeState(dir, 'last-operator-action.json', '{"at":"2026-05-20T21:45:00+00:00"}');
    expect(await precheck(dir, { now: NOW, peek: true })).toBe('EVALUATE');
  }));

  // stale.10. Regression: digest gate still fires when staleness is damped (fall-through must reach it)
  test('stale-gate: damper — digest gate fires through the damp fall-through', withTmp(async (dir) => {
    const dampedNoDigest = JSON.stringify({
      alerts: {
        'checklist:checksys': {
          count: 6, consecutive_clean: 0, suppressed: true,
          first_seen: '2026-05-19', last_seen: '2026-05-19', text: 'Check system',
        },
      },
      last_digest_date: '2026-05-19', self_eval: {}, total_ticks: 1, // yesterday → digest due
      last_stale_wake_at: '2026-05-20T21:00:00+00:00', // 1h ago (within threshold → damped)
    });
    seedStale(dir, dampedNoDigest);
    writeState(dir, 'last-operator-action.json', '{"at":"2026-05-20T19:00:00+00:00"}'); // 3h ago (opQuiet)
    expect(await precheck(dir, { now: NOW, peek: true })).toBe('EVALUATE');
  }));

  // stale.11. Non-peek: first stale wake writes last_stale_wake_at to alert-state.json
  test('stale-gate: non-peek first stale wake writes last_stale_wake_at', withTmp(async (dir) => {
    seedStale(dir);
    writeState(dir, 'last-operator-action.json', '{"at":"2026-05-20T19:00:00+00:00"}'); // 3h ago (opQuiet)
    expect(await precheck(dir, { now: NOW })).toBe('EVALUATE'); // non-peek
    const state = JSON.parse(fs.readFileSync(hermit(dir, 'state', 'alert-state.json'), 'utf-8'));
    expect(typeof state.last_stale_wake_at).toBe('string');
    expect(new Date(state.last_stale_wake_at).toISOString()).toBe(new Date(NOW).toISOString());
  }));

  // stale.12. Peek: does NOT write last_stale_wake_at
  test('stale-gate: peek does not write last_stale_wake_at', withTmp(async (dir) => {
    seedStale(dir);
    writeState(dir, 'last-operator-action.json', '{"at":"2026-05-20T19:00:00+00:00"}');
    expect(await precheck(dir, { now: NOW, peek: true })).toBe('EVALUATE');
    const state = JSON.parse(fs.readFileSync(hermit(dir, 'state', 'alert-state.json'), 'utf-8'));
    expect(state.last_stale_wake_at).toBeUndefined();
  }));
});
