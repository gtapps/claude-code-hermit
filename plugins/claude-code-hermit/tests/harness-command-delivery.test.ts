import { describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';

import {
  isHarnessSwitchConfirmation,
  writePendingCommand,
} from '../scripts/lib/harness-command';
import { paneModeLine } from '../scripts/lib/tmux';
import { pidAlive } from '../scripts/lib/lockfile';
import { runScript } from './helpers/run';
import { withDir } from './helpers/workdir';

const MODEL_SWITCH_PANE = `
Switch model?
Your next response will be slower and use more tokens

This conversation is cached for the current model. Switching to Opus 5 means the full history gets
re-read on your next message.

❯ 1. Yes, switch to Opus 5
  2. No, go back
`;

// Built from the row inventory in memory cc-switch-modal-pane-geometry: the
// verbatim 2026-09-04 capture was unavailable. Modal, then queued-channel
// banner, three composer rows, statusLine, auto-mode row, IDE row.
const MODEL_SWITCH_PANE_WITH_CHROME = `${MODEL_SWITCH_PANE}
← discord · alice: follow-up after the switch
────────────────────────────────────────
❯
────────────────────────────────────────
● sonnet · 42%
  ⏵⏵ auto mode on (shift+tab to cycle)
  ⧉  claude-code-hermit
`;

const EFFORT_SWITCH_PANE = `
Change effort level?
Your next response will be slower and use more tokens

This conversation is cached for the current effort level. Switching to high means the full history gets
re-read on your next message.

❯ 1. Yes, switch to high
  2. No, go back
`;

const SWITCH_CASES = [
  { label: 'model', command: '/model', arg: 'opus', pane: MODEL_SWITCH_PANE },
  { label: 'effort', command: '/effort', arg: 'high', pane: EFFORT_SWITCH_PANE },
] as const;

const hermit = (dir: string, ...parts: string[]) =>
  path.join(dir, '.claude-code-hermit', ...parts);

// Error-path bound for the readiness polls below, not an assertion about speed:
// these tests wait on detached subprocesses, so under `bun test --parallel` on a
// contended runner a 4-5s window fails a run that is merely slow. Bun's
// `--timeout` does not extend an in-test `Date.now()` deadline, so the bound has
// to be raised here too.
const POLL_DEADLINE_MS = 20_000;

const switchVerifyMarker = (dir: string) => hermit(dir, 'state', 'harness-switch-verify.json');
const pendingMarker = (dir: string) => hermit(dir, 'state', 'pending-harness-command.json');

/** Wait for the detached cycler to record the mode the session actually landed in. */
async function waitForVerify(dir: string, arg: string, timeoutMs = POLL_DEADLINE_MS): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(switchVerifyMarker(dir))) {
      const verify = JSON.parse(fs.readFileSync(switchVerifyMarker(dir), 'utf-8'));
      if (verify.arg === arg) return;
    }
    await Bun.sleep(25);
  }
  throw new Error(`no switch-verify marker recording ${arg}`);
}

function seedPendingSwitch(dir: string, command: string, arg: string | null): void {
  fs.writeFileSync(hermit(dir, 'config.json'), JSON.stringify({ timezone: 'UTC' }));
  fs.writeFileSync(hermit(dir, 'state', 'runtime.json'), JSON.stringify({
    version: 1,
    session_state: 'in_progress',
    runtime_mode: 'headless',
    tmux_session: 'hermit-test',
    shutdown_requested_at: null,
    shutdown_completed_at: null,
  }));
  writePendingCommand(hermit(dir), {
    command,
    arg,
    by: 'operator',
    requested_at: new Date().toISOString(),
  });
}

function installFakeTmux(
  dir: string,
  pane: string,
  opts: {
    paneAfterEnter?: string;
    swapAfterCaptures?: number;
    failLiteral?: boolean;
    failSecondEnter?: boolean;
    revealAfterCapture?: number;
    deadSession?: boolean;
  } = {},
): { bin: string; log: string; helperPid: string } {
  const bin = path.join(dir, 'fake-bin');
  const log = path.join(dir, 'tmux-calls.log');
  const paneFile = path.join(dir, 'pane.txt');
  const enterCount = path.join(dir, 'enter-count');
  const captureCount = path.join(dir, 'capture-count');
  const swapDelay = path.join(dir, 'swap-delay');
  const helperPid = path.join(dir, 'helper-pid');
  fs.mkdirSync(bin);
  fs.writeFileSync(paneFile, pane);
  const nextPaneFile = path.join(dir, 'next-pane.txt');
  fs.writeFileSync(nextPaneFile, opts.paneAfterEnter ?? pane);
  fs.writeFileSync(path.join(bin, 'tmux'), `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "${log}"
case "$1" in
  has-session) exit ${opts.deadSession ? 1 : 0} ;;
  capture-pane)
    printf '%s' "$PPID" > "${helperPid}"
    if [[ -f "${swapDelay}" ]]; then
      left=$(cat "${swapDelay}")
      left=$((left - 1))
      if (( left <= 0 )); then cp "${nextPaneFile}" "${paneFile}"; rm -f "${swapDelay}"; else printf '%s' "$left" > "${swapDelay}"; fi
    fi
    count=0
    [[ -f "${captureCount}" ]] && count=$(cat "${captureCount}")
    count=$((count + 1))
    printf '%s' "$count" > "${captureCount}"
    if (( count < ${opts.revealAfterCapture ?? 1} )); then printf 'Claude ready\\n'; else cat "${paneFile}"; fi
    exit 0
    ;;
  send-keys)
    if [[ "${opts.failLiteral ? '1' : '0'}" == "1" && "$*" == *" -l -- "* ]]; then exit 1; fi
    if [[ "$*" == *" Enter" ]]; then
      count=0
      [[ -f "${enterCount}" ]] && count=$(cat "${enterCount}")
      count=$((count + 1))
      printf '%s' "$count" > "${enterCount}"
      if [[ "$count" == "2" ]]; then
        if (( ${opts.swapAfterCaptures ?? 0} > 0 )); then printf '%s' "${opts.swapAfterCaptures ?? 0}" > "${swapDelay}";
        else cp "${nextPaneFile}" "${paneFile}"; fi
      fi
      if [[ "${opts.failSecondEnter ? '1' : '0'}" == "1" && "$count" == "2" ]]; then exit 1; fi
    fi
    exit 0
    ;;
esac
exit 1
`);
  fs.chmodSync(path.join(bin, 'tmux'), 0o755);
  return { bin, log, helperPid };
}

// Status bars captured verbatim from live sessions (CC 2.1.238): a local probe and a
// production hermit. The differences are the point — `manual mode on` carries no
// "(shift+tab to cycle)" hint, the trailing segments vary with session state, and on the
// production hermit an artifact-links row renders BELOW the status bar.
const MODE_STATUS_BARS: Record<string, string> = {
  auto: '  ⏵⏵ auto mode on (shift+tab to cycle) · ← 1 agent',
  default: '  ⏸ manual mode on · ← 1 agent',
  acceptEdits: '  ⏵⏵ accept edits on (shift+tab to cycle) · ← 1 agent',
  plan: '  ⏸ plan mode on (shift+tab to cycle) · ← 1 agent',
};

const FLEET_PANE = `❯ Try "how does <filepath> work?"
────────────────────────────────────────
  ⏵⏵ auto mode on · 2 monitors · ← for agents · ↓ to manage
  ⧉  proposals-page · dashboard`;

const MODE_CYCLE = ['auto', 'default', 'acceptEdits', 'plan'];

/**
 * A tmux that cycles like Claude Code does: BTab advances the mode, capture-pane renders
 * that mode's status bar. `dialogPane` replaces the pane entirely, standing in for a
 * dialog covering the status bar.
 */
function installCyclingTmux(
  dir: string,
  startMode: string,
  opts: { dialogPane?: string; refuseKeys?: boolean } = {},
): { bin: string; log: string; modeFile: string } {
  const bin = path.join(dir, 'fake-bin');
  const log = path.join(dir, 'tmux-calls.log');
  const modeFile = path.join(dir, 'mode');
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(modeFile, startMode);

  const cases = MODE_CYCLE.map((mode, i) =>
    `    ${mode}) next=${MODE_CYCLE[(i + 1) % MODE_CYCLE.length]} ;;`).join('\n');
  const bars = MODE_CYCLE.map((mode) =>
    `    ${mode}) printf '%s\\n' "${MODE_STATUS_BARS[mode]}" ;;`).join('\n');

  fs.writeFileSync(path.join(bin, 'tmux'), `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "${log}"
case "$1" in
  has-session) exit 0 ;;
  capture-pane)
${opts.dialogPane ? `    printf '%s\\n' ${JSON.stringify(opts.dialogPane)}; exit 0 ;;` : `    printf '%s\\n' "❯ "
    case "$(cat "${modeFile}")" in
${bars}
    esac
    exit 0
    ;;`}
  send-keys)
    if [[ "${opts.refuseKeys ? '1' : '0'}" == "1" ]]; then exit 1; fi
    if [[ "$*" == *BTab* ]]; then
      case "$(cat "${modeFile}")" in
${cases}
      esac
      printf '%s' "$next" > "${modeFile}"
    fi
    exit 0
    ;;
esac
exit 1
`);
  fs.chmodSync(path.join(bin, 'tmux'), 0o755);
  return { bin, log, modeFile };
}

async function waitForMode(modeFile: string, want: string, timeoutMs = POLL_DEADLINE_MS): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.readFileSync(modeFile, 'utf-8') === want) return;
    await Bun.sleep(25);
  }
  throw new Error(`pane never reached ${want} (stuck at ${fs.readFileSync(modeFile, 'utf-8')})`);
}

// The detached verifier sleeps 100ms per poll, so its whole budget has to cover
// however many captures a case needs. 250ms leaves room for one — enough for the
// cases whose dialog is already on the pane, and short enough that the cases with
// no dialog to find give up instead of idling out the script's 5s ceiling.
const CONFIRM_TIMEOUT_ONE_CAPTURE_MS = '250';
// A case that only reveals the dialog on a later capture needs several polls, and
// on a contended runner a single spawn can eat the whole 250ms window. Give those
// the ceiling: the assertion is about which keys get sent, never about speed.
const CONFIRM_TIMEOUT_MULTI_CAPTURE_MS = '5000';

async function drain(dir: string, bin: string, confirmTimeoutMs = CONFIRM_TIMEOUT_ONE_CAPTURE_MS) {
  return runScript('stop-pipeline.ts', {
    stdin: '{}',
    cwd: dir,
    env: {
      AGENT_HOOK_PROFILE: 'minimal',
      HERMIT_HARNESS_CONFIRM_TIMEOUT_MS: confirmTimeoutMs,
      PATH: `${bin}:${process.env.PATH}`,
    },
  });
}

async function waitForVerifierExit(helperPid: string, timeoutMs = POLL_DEADLINE_MS): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let pid: number | null = null;
  while (Date.now() < deadline) {
    if (pid === null && fs.existsSync(helperPid)) {
      const parsed = Number(fs.readFileSync(helperPid, 'utf-8'));
      if (Number.isInteger(parsed) && parsed > 0) pid = parsed;
    }
    if (pid !== null && !pidAlive(pid)) return;
    await Bun.sleep(25);
  }
  throw new Error('detached harness-switch verifier did not exit before the test deadline');
}

describe('harness-switch confirmation matcher', () => {
  test('accepts wrapped cached-context model and effort prompts', () => {
    expect(isHarnessSwitchConfirmation('/model', MODEL_SWITCH_PANE)).toBe(true);
    expect(isHarnessSwitchConfirmation('/effort', EFFORT_SWITCH_PANE)).toBe(true);
  });

  test('accepts cached-context prompts above blank terminal rows', () => {
    for (const { command, pane } of SWITCH_CASES) {
      expect(isHarnessSwitchConfirmation(command, `${pane}${'\n'.repeat(20)}`)).toBe(true);
    }
  });

  test('rejects unrelated or incomplete dialogs', () => {
    expect(isHarnessSwitchConfirmation('/model', `
Permission required
❯ 1. Yes, allow once
  2. No, go back
`)).toBe(false);
    expect(isHarnessSwitchConfirmation('/model', `
Switch model?
❯ 1. Yes, switch to Opus 5
  2. No, go back
`)).toBe(false);
  });

  test('requires anchors for the delivered command', () => {
    expect(isHarnessSwitchConfirmation('/model', EFFORT_SWITCH_PANE)).toBe(false);
    expect(isHarnessSwitchConfirmation('/effort', MODEL_SWITCH_PANE)).toBe(false);
    expect(isHarnessSwitchConfirmation('/clear', MODEL_SWITCH_PANE)).toBe(false);
  });

  test('accepts a model switch with chrome below the dialog', () => {
    expect(isHarnessSwitchConfirmation('/model', MODEL_SWITCH_PANE_WITH_CHROME)).toBe(true);
    expect(isHarnessSwitchConfirmation('/effort', MODEL_SWITCH_PANE_WITH_CHROME)).toBe(false);
  });

  // The matcher has no geometry condition, so anything visible carrying all five
  // anchors matches. These two pin where that line actually falls: prose or source
  // quoting the dialog's headings is rejected because the option rows are missing,
  // while a verbatim echo of a whole dialog is accepted. The second is a known,
  // accepted cost of dropping the tail window, not an oversight. Narrow the
  // anchors rather than restoring geometry if it ever needs closing.
  test('rejects source or prose quoting only the dialog headings', () => {
    expect(isHarnessSwitchConfirmation('/model', `
const SWITCH_CONFIRMATION_ANCHORS: Record<string, readonly string[]> = {
  '/model': [
    'Switch model?',
    'This conversation is cached for the current model.',
  ],
`)).toBe(false);
  });

  test('accepts a verbatim echo of the dialog, geometry being deliberately absent', () => {
    expect(isHarnessSwitchConfirmation('/model', `
$ cat pane-capture.txt
${MODEL_SWITCH_PANE}
`)).toBe(true);
  });
});

describe('Stop hook harness-switch delivery', () => {
  test('model then effort: one Stop sends and confirms both switches once', withDir(async (dir) => {
    seedPendingSwitch(dir, '/model', 'sonnet');
    writePendingCommand(hermit(dir), {
      command: '/model', arg: 'sonnet', by: 'terminal',
      then: { command: '/effort', arg: 'low' },
      requested_at: new Date().toISOString(),
    });
    // The model dialog outlives its Enter by two captures, so the helper's dismiss wait
    // has to loop. Swapping the pane on Enter alone would let the follow-up be typed
    // against a fixture that was never showing the dialog in the first place.
    const { bin, log, helperPid } = installFakeTmux(dir, MODEL_SWITCH_PANE_WITH_CHROME, {
      paneAfterEnter: SWITCH_CASES[1].pane,
      swapAfterCaptures: 2,
    });
    const result = await drain(dir, bin, CONFIRM_TIMEOUT_MULTI_CAPTURE_MS);
    await waitForVerifierExit(helperPid);
    expect(result.exitCode).toBe(0);
    const calls = fs.readFileSync(log, 'utf-8').trim().split('\n');
    expect(calls.filter((line) => line.includes('-l -- /model sonnet'))).toHaveLength(1);
    expect(calls.filter((line) => line.includes('-l -- /effort low'))).toHaveLength(1);
    expect(calls.filter((line) => line.includes('-l --'))).toHaveLength(2);
    expect(calls.filter((line) => line.endsWith(' Enter'))).toHaveLength(4);
    // The effort text is typed only after the model dialog is answered and gone: at least
    // one capture separates the confirming Enter from the follow-up send.
    const effortSend = calls.findIndex((line) => line.includes('-l -- /effort low'));
    const confirmEnter = calls.slice(0, effortSend).findLastIndex((line) => line.endsWith(' Enter'));
    expect(calls.slice(confirmEnter + 1, effortSend).filter((l) => l.startsWith('capture-pane')))
      .toHaveLength(2);
    expect(fs.existsSync(pendingMarker(dir))).toBe(false);
    expect(JSON.parse(fs.readFileSync(switchVerifyMarker(dir), 'utf-8')).arg).toBe('sonnet');
    const before = fs.readFileSync(log, 'utf-8');
    await drain(dir, bin);
    expect(fs.readFileSync(log, 'utf-8')).toBe(before);
  }));

  test('model: confirmation with chrome below the dialog still receives Enter', withDir(async (dir) => {
    seedPendingSwitch(dir, '/model', 'opus');
    const { bin, log, helperPid } = installFakeTmux(dir, MODEL_SWITCH_PANE_WITH_CHROME, { revealAfterCapture: 2 });

    const result = await drain(dir, bin, CONFIRM_TIMEOUT_MULTI_CAPTURE_MS);
    await waitForVerifierExit(helperPid);

    expect(result.exitCode).toBe(0);
    const calls = fs.readFileSync(log, 'utf-8').trim().split('\n');
    expect(calls.filter((line) => line.includes('-l -- /model opus'))).toHaveLength(1);
    expect(calls.filter((line) => line.endsWith(' Enter'))).toHaveLength(2);
  }));

  for (const { label, command, arg, pane } of SWITCH_CASES) {
    const text = `${command} ${arg}`;

    test(`${label}: cached context submits once and confirms the selected Yes`, withDir(async (dir) => {
      seedPendingSwitch(dir, command, arg);
      // The real TUI cannot render this dialog until the Stop hook exits. Make the
      // first detached capture miss so a one-shot synchronous implementation fails.
      const { bin, log, helperPid } = installFakeTmux(dir, pane, { revealAfterCapture: 2 });

      const result = await drain(dir, bin, CONFIRM_TIMEOUT_MULTI_CAPTURE_MS);
      await waitForVerifierExit(helperPid);

      expect(result.exitCode).toBe(0);
      const calls = fs.readFileSync(log, 'utf-8').trim().split('\n');
      expect(calls.filter((line) => line.includes(`-l -- ${text}`))).toHaveLength(1);
      expect(calls.filter((line) => line.endsWith(' Enter'))).toHaveLength(2);
      expect(calls).toContain('capture-pane -p -t hermit-test');
      expect(fs.existsSync(hermit(dir, 'state', 'pending-harness-command.json'))).toBe(false);
    }));

    test(`${label}: direct switch does not receive an extra Enter`, withDir(async (dir) => {
      seedPendingSwitch(dir, command, arg);
      const { bin, log, helperPid } = installFakeTmux(dir, 'Claude ready');

      const result = await drain(dir, bin);
      await waitForVerifierExit(helperPid);

      expect(result.exitCode).toBe(0);
      const calls = fs.readFileSync(log, 'utf-8').trim().split('\n');
      expect(calls.filter((line) => line.endsWith(' Enter'))).toHaveLength(1);
      expect(fs.existsSync(hermit(dir, 'state', 'pending-harness-command.json'))).toBe(false);
    }));

    test(`${label}: unrelated dialog is never answered`, withDir(async (dir) => {
      seedPendingSwitch(dir, command, arg);
      const { bin, log, helperPid } = installFakeTmux(dir, `
Permission required
❯ 1. Yes, allow once
  2. No, go back
`);

      const result = await drain(dir, bin);
      await waitForVerifierExit(helperPid);

      expect(result.exitCode).toBe(0);
      const calls = fs.readFileSync(log, 'utf-8').trim().split('\n');
      expect(calls.filter((line) => line.endsWith(' Enter'))).toHaveLength(1);
    }));

    test(`${label}: failed submission retains the marker for retry`, withDir(async (dir) => {
      seedPendingSwitch(dir, command, arg);
      const { bin } = installFakeTmux(dir, pane, { failLiteral: true });

      const result = await drain(dir, bin);

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toContain('marker kept for retry');
      expect(fs.existsSync(hermit(dir, 'state', 'pending-harness-command.json'))).toBe(true);
      // Nothing was delivered, so there is nothing to verify against the transcript.
      expect(fs.existsSync(switchVerifyMarker(dir))).toBe(false);
    }));

    test(`${label}: a delivered switch leaves a verify marker for the prompt path`, withDir(async (dir) => {
      seedPendingSwitch(dir, command, arg);
      const { bin, helperPid } = installFakeTmux(dir, 'Claude ready');

      const result = await drain(dir, bin);
      await waitForVerifierExit(helperPid);

      expect(result.exitCode).toBe(0);
      const verify = JSON.parse(fs.readFileSync(switchVerifyMarker(dir), 'utf-8'));
      expect(verify.command).toBe(command);
      expect(verify.arg).toBe(arg);
      expect(verify.by).toBe('operator');
      expect(Number.isNaN(Date.parse(verify.delivered_at))).toBe(false);
    }));

    test(`${label}: failed confirmation does not reissue the command`, withDir(async (dir) => {
      seedPendingSwitch(dir, command, arg);
      const { bin, log, helperPid } = installFakeTmux(dir, pane, { failSecondEnter: true });

      const result = await drain(dir, bin);
      await waitForVerifierExit(helperPid);

      expect(result.exitCode).toBe(0);
      const calls = fs.readFileSync(log, 'utf-8').trim().split('\n');
      expect(calls.filter((line) => line.includes(`-l -- ${text}`))).toHaveLength(1);
      expect(calls.filter((line) => line.endsWith(' Enter'))).toHaveLength(2);
      expect(fs.existsSync(hermit(dir, 'state', 'pending-harness-command.json'))).toBe(false);
    }));
  }
});

// The reset commands take a different tail than the switch commands: no detached
// confirmation, and /clear alone carries the hermit-owned bookkeeping.
describe('Stop hook reset-command delivery', () => {
  const marker = (dir: string) => hermit(dir, 'state', 'pending-harness-command.json');
  const readRuntime = (dir: string) =>
    JSON.parse(fs.readFileSync(hermit(dir, 'state', 'runtime.json'), 'utf-8'));

  test('/clear applies the context-reset bookkeeping after a confirmed send', withDir(async (dir) => {
    seedPendingSwitch(dir, '/clear', null);
    const statusCache = hermit(dir, 'sessions', '.status.json');
    fs.writeFileSync(statusCache, '{}');
    const { bin, log } = installFakeTmux(dir, 'Claude ready');

    const result = await drain(dir, bin);

    expect(result.exitCode).toBe(0);
    expect(fs.readFileSync(log, 'utf-8')).toContain('-l -- /clear');
    expect(fs.existsSync(marker(dir))).toBe(false);
    expect(readRuntime(dir).context_cleared).toBe(true);
    expect(fs.existsSync(statusCache)).toBe(false);
  }));

  test('/compact delivers but deliberately leaves the reset bookkeeping alone', withDir(async (dir) => {
    seedPendingSwitch(dir, '/compact', null);
    const statusCache = hermit(dir, 'sessions', '.status.json');
    fs.writeFileSync(statusCache, '{}');
    const { bin, log } = installFakeTmux(dir, 'Claude ready');

    const result = await drain(dir, bin);

    expect(result.exitCode).toBe(0);
    expect(fs.readFileSync(log, 'utf-8')).toContain('-l -- /compact');
    expect(fs.existsSync(marker(dir))).toBe(false);
    expect(readRuntime(dir).context_cleared).toBeUndefined();
    expect(fs.existsSync(statusCache)).toBe(true);
  }));

  // /advisor delivers through the same generic sendKeys path as /clear and /compact —
  // it has no cached-context dialog to confirm and no self-perception gap to correct
  // (live-probed CC 2.1.240: every argument form renders inline), so it must leave no
  // switch-verify marker and spawn no confirm-harness-switch.ts helper.
  test('/advisor opus delivers and leaves no switch-verify marker', withDir(async (dir) => {
    seedPendingSwitch(dir, '/advisor', 'opus');
    const { bin, log } = installFakeTmux(dir, 'Claude ready');

    const result = await drain(dir, bin);

    expect(result.exitCode).toBe(0);
    expect(fs.readFileSync(log, 'utf-8')).toContain('-l -- /advisor opus');
    expect(fs.existsSync(marker(dir))).toBe(false);
    expect(fs.existsSync(switchVerifyMarker(dir))).toBe(false);
  }));

  // Only /model and /effort change something the session then misreports about itself.
  for (const command of ['/clear', '/compact']) {
    test(`${command} leaves no switch-verify marker`, withDir(async (dir) => {
      seedPendingSwitch(dir, command, null);
      const { bin } = installFakeTmux(dir, 'Claude ready');

      const result = await drain(dir, bin);

      expect(result.exitCode).toBe(0);
      expect(fs.existsSync(switchVerifyMarker(dir))).toBe(false);
    }));
  }

  test('a refused /clear send leaves no reset trace and keeps the marker', withDir(async (dir) => {
    seedPendingSwitch(dir, '/clear', null);
    const { bin } = installFakeTmux(dir, 'Claude ready', { failLiteral: true });

    const result = await drain(dir, bin);

    expect(result.exitCode).toBe(0);
    expect(fs.existsSync(marker(dir))).toBe(true);
    expect(readRuntime(dir).context_cleared).toBeUndefined();
  }));

  test('a dead tmux session is probed but never typed into', withDir(async (dir) => {
    seedPendingSwitch(dir, '/clear', null);
    const { bin, log } = installFakeTmux(dir, 'Claude ready', { deadSession: true });

    const result = await drain(dir, bin);

    expect(result.exitCode).toBe(0);
    const calls = fs.readFileSync(log, 'utf-8');
    expect(calls).toContain('has-session');
    expect(calls).not.toContain('send-keys');
    expect(fs.existsSync(marker(dir))).toBe(true);
    expect(readRuntime(dir).context_cleared).toBeUndefined();
  }));

  // hermitDir() walks up, so a drifted hook cwd still resolves the real hermit root
  // (cc-compat.ts, #384). The runtime read has to be anchored to that root the same
  // way the context-reset write already is — a cwd-relative read would find nothing
  // here and silently decline every turn until the marker's TTL expired.
  test('delivers from a drifted hook cwd', withDir(async (dir) => {
    seedPendingSwitch(dir, '/clear', null);
    const sub = path.join(dir, 'nested', 'deeper');
    fs.mkdirSync(sub, { recursive: true });
    const { bin, log } = installFakeTmux(dir, 'Claude ready');

    const result = await drain(sub, bin);

    expect(result.exitCode).toBe(0);
    expect(fs.readFileSync(log, 'utf-8')).toContain('-l -- /clear');
    expect(fs.existsSync(marker(dir))).toBe(false);
    expect(readRuntime(dir).context_cleared).toBe(true);
  }));
});

describe('permission-mode status-bar parsing', () => {
  test('reads every mode off its live status bar', () => {
    for (const [mode, bar] of Object.entries(MODE_STATUS_BARS)) {
      expect(paneModeLine(`❯ \n${bar}`)).toBe(mode);
    }
  });

  // A production hermit renders artifact links under the status bar, so the mode is not
  // on the final row — the reason this scans a window instead of the last line.
  test('reads the mode on a hermit that renders rows below the status bar', () => {
    expect(paneModeLine(FLEET_PANE)).toBe('auto');
  });

  // Null is the guard the cycler depends on: no mode read, no keystrokes.
  test('reports nothing rather than guessing when the status bar is absent', () => {
    expect(paneModeLine(MODEL_SWITCH_PANE)).toBeNull();
    expect(paneModeLine('')).toBeNull();
    expect(paneModeLine('❯ some prompt text\nno status bar here')).toBeNull();
  });

  test('reports nothing when the window contradicts itself', () => {
    expect(paneModeLine(`${MODE_STATUS_BARS.auto}\n${MODE_STATUS_BARS.plan}`)).toBeNull();
  });

  // Scrollback above the window must not be mistaken for the current mode.
  test('ignores a stale status bar scrolled out of the window', () => {
    const stale = [MODE_STATUS_BARS.plan, 'a', 'b', 'c', 'd', 'e'].join('\n');
    expect(paneModeLine(stale)).toBeNull();
  });
});

describe('Stop hook permission-mode delivery', () => {
  test('cycles the pane to the requested mode and records where it landed', withDir(async (dir) => {
    seedPendingSwitch(dir, '/permission-mode', 'acceptEdits');
    const { bin, log, modeFile } = installCyclingTmux(dir, 'auto');

    await drain(dir, bin);
    await waitForMode(modeFile, 'acceptEdits');

    // Typed text would reach Claude as a prompt — this command is keystrokes only.
    expect(fs.readFileSync(log, 'utf-8')).not.toContain('-l --');
    expect(fs.readFileSync(log, 'utf-8')).toContain('BTab');

    await waitForVerify(dir, 'acceptEdits');
    expect(fs.existsSync(pendingMarker(dir))).toBe(false);
  }));

  test('presses nothing when the session is already in the requested mode', withDir(async (dir) => {
    seedPendingSwitch(dir, '/permission-mode', 'auto');
    const { bin, log } = installCyclingTmux(dir, 'auto');

    await drain(dir, bin);
    await waitForVerify(dir, 'auto');

    expect(fs.readFileSync(log, 'utf-8')).not.toContain('BTab');
    // A satisfied request is consumed even though no key was pressed — otherwise every
    // later Stop hook re-delivers it and re-announces the switch until the TTL expires.
    expect(fs.existsSync(pendingMarker(dir))).toBe(false);
  }));

  // The prompt stage refuses these, so a marker naming one can only come from somewhere
  // else. `plan` is in the cycle, so the actuator has to refuse it too.
  test('drops a marker naming a mode no channel may set, without pressing', withDir(async (dir) => {
    seedPendingSwitch(dir, '/permission-mode', 'plan');
    const { bin, log } = installCyclingTmux(dir, 'auto');

    const result = await drain(dir, bin);
    await Bun.sleep(300);

    expect(result.stderr).toContain('not settable from a channel');
    expect(fs.readFileSync(log, 'utf-8')).not.toContain('BTab');
    expect(fs.existsSync(pendingMarker(dir))).toBe(false);
    expect(fs.existsSync(switchVerifyMarker(dir))).toBe(false);
  }));

  // While a dialog is up the status bar is off-screen. Pressing blind from there could
  // land anywhere, including somewhere more permissive than the operator asked for.
  test('refuses to press while a dialog covers the status bar, and keeps the request', withDir(async (dir) => {
    seedPendingSwitch(dir, '/permission-mode', 'default');
    const { bin, log } = installCyclingTmux(dir, 'auto', { dialogPane: MODEL_SWITCH_PANE });

    await drain(dir, bin);

    expect(fs.readFileSync(log, 'utf-8')).not.toContain('BTab');
    expect(fs.existsSync(pendingMarker(dir))).toBe(true);
    expect(fs.existsSync(switchVerifyMarker(dir))).toBe(false);
  }));

  // The marker records what was ASKED for, never where the pane ended up. Recording the
  // landed mode would make the prompt path compare that mode against itself and report
  // every stuck switch as a success — the one failure this feature must never produce.
  test('records the requested mode, so a stuck cycle cannot report itself as success', withDir(async (dir) => {
    seedPendingSwitch(dir, '/permission-mode', 'default');
    // A pane whose mode never changes, however many times BTab is pressed.
    const { bin } = installCyclingTmux(dir, 'auto');
    fs.writeFileSync(path.join(bin, 'tmux'), `#!/usr/bin/env bash
case "$1" in
  has-session) exit 0 ;;
  capture-pane) printf '%s\\n' "❯ " "${MODE_STATUS_BARS.auto}"; exit 0 ;;
  send-keys) exit 0 ;;
esac
exit 1
`);
    fs.chmodSync(path.join(bin, 'tmux'), 0o755);

    await drain(dir, bin);
    await waitForVerify(dir, 'default');

    const verify = JSON.parse(fs.readFileSync(switchVerifyMarker(dir), 'utf-8'));
    expect(verify.arg).toBe('default');
    expect(verify.arg).not.toBe('auto');
  }));

  // Dying before the first keystroke lands must leave the request retryable, the same
  // contract a refused sendKeys gives the typed commands.
  test('keeps the request when tmux refuses the first keystroke', withDir(async (dir) => {
    seedPendingSwitch(dir, '/permission-mode', 'default');
    const { bin } = installCyclingTmux(dir, 'auto', { refuseKeys: true });

    await drain(dir, bin);
    await Bun.sleep(600);

    expect(fs.existsSync(pendingMarker(dir))).toBe(true);
  }));
});
