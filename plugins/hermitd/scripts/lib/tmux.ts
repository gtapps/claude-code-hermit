/**
 * Shared tmux helpers for the lifecycle scripts
 * (hermitd-start, hermitd-stop, hermitd-watchdog) and the harness-command drain.
 *
 * Two transports, one implementation. `docker` prefixes the same tmux argv with
 * `docker compose … exec -T <service>`; nothing else differs, because tmux
 * send-keys talks to the tmux server socket rather than the exec's TTY, so
 * `-T` (no TTY allocation) is irrelevant to delivery. Every call builds an argv
 * array — never a shell string — so a session name or message body can't be
 * read as shell syntax.
 */

import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { PERMISSION_MODE } from './settings/enums';

type Json = any;

export type Transport =
  | { kind: 'host' }
  | { kind: 'docker'; composeFile: string; service: string };

export const HOST: Transport = { kind: 'host' };

/** Build the full argv for a tmux invocation under the given transport. */
export function tmuxArgv(transport: Transport, args: string[]): { cmd: string; argv: string[] } {
  if (transport.kind === 'host') return { cmd: 'tmux', argv: args };
  return {
    cmd: 'docker',
    argv: ['compose', '-f', transport.composeFile, 'exec', '-T', transport.service, 'tmux', ...args],
  };
}

function runTmux(transport: Transport, args: string[]): { status: number | null; error: unknown } {
  const { cmd, argv } = tmuxArgv(transport, args);
  const r = spawnSync(cmd, argv, { stdio: 'ignore' });
  return { status: r.status, error: r.error };
}

/** Return true when the named tmux session exists. `=` forces an exact match: a bare
 *  target also matches a session whose name merely starts with `name`. */
export function tmuxSessionAlive(name: string, transport: Transport = HOST): boolean {
  return runTmux(transport, ['has-session', '-t', `=${name}`]).status === 0;
}

/** Capture the visible pane as text, or null when tmux cannot read it. */
export function capturePane(name: string, transport: Transport = HOST): string | null {
  if (!name) return null;
  const { cmd, argv } = tmuxArgv(transport, ['capture-pane', '-p', '-t', name]);
  try {
    const r = spawnSync(cmd, argv, { encoding: 'utf-8', timeout: 5000 });
    if (r.error || r.status !== 0 || typeof r.stdout !== 'string') return null;
    return r.stdout;
  } catch {
    return null;
  }
}

/**
 * Return a bounded pane window only when its required footer is the final
 * nonblank row.
 *
 * tmux preserves unused blank renderer rows below short dialogs. Ignoring those
 * rows is safe only when the dialog footer still terminates the visible content;
 * otherwise a matching dialog may be stale scrollback above a newer prompt.
 */
export function anchoredPaneTail(
  paneContent: string,
  maxLines: number,
  terminalAnchor: string,
): string | null {
  if (maxLines < 1 || !terminalAnchor) return null;

  const lines = paneContent.split('\n');
  let lastContentLine = lines.length - 1;
  while (lastContentLine >= 0 && lines[lastContentLine].trim() === '') {
    lastContentLine--;
  }
  if (lastContentLine < 0 || !lines[lastContentLine].includes(terminalAnchor)) {
    return null;
  }

  const firstLine = Math.max(0, lastContentLine - maxLines + 1);
  return lines.slice(firstLine, lastContentLine + 1).join('\n');
}

/** Send a single Enter key, returning whether tmux accepted it. */
export function sendEnter(sessionName: string, transport: Transport = HOST): boolean {
  if (!sessionName) return false;
  const submitted = runTmux(transport, ['send-keys', '-t', sessionName, 'Enter']);
  return !submitted.error && submitted.status === 0;
}

/**
 * Send one named key (tmux key-name form, e.g. `BTab`) with no trailing Enter.
 *
 * sendKeys below cannot express this: it forces `-l` (literal), so a key name would be
 * typed as its own characters, and it always submits afterwards. Callers here are
 * driving the TUI's own keybindings rather than typing a prompt.
 *
 * The letters-only shape check is the barrier, not a key allow-list: it keeps the value
 * from carrying an escape sequence or literal text into the pane, and callers are trusted
 * internal code (channel-supplied values never reach this).
 */
export function sendKey(sessionName: string, keyName: string, transport: Transport = HOST): boolean {
  if (!sessionName || !/^[A-Za-z]+$/.test(keyName)) return false;
  const sent = runTmux(transport, ['send-keys', '-t', sessionName, keyName]);
  return !sent.error && sent.status === 0;
}

/**
 * Claude Code's status-bar phrase for each permission mode, keyed by config value.
 *
 * All six probed live on CC 2.1.238 — the phrase is stable but what surrounds it is not:
 * the suffix varies with session state (`(shift+tab to cycle)` is absent on manual mode,
 * and trailing segments like `· 2 monitors · ← for agents` appear on a busy hermit), so
 * only the phrase itself may be matched. The apostrophe in `don't ask on` is ASCII
 * U+0027, not the typographic U+2019 — verified by hexdump of the rendered pane, because
 * a curly one here would fail closed for exactly the most permissive sessions.
 */
const MODE_PHRASES: Record<(typeof PERMISSION_MODE)[number], string> = {
  auto: 'auto mode on',
  default: 'manual mode on',
  acceptEdits: 'accept edits on',
  plan: 'plan mode on',
  bypassPermissions: 'bypass permissions on',
  dontAsk: "don't ask on",
};

const MODE_SCAN_LINES = 4;

/**
 * Read the session's active permission mode out of a captured pane, or null.
 *
 * Scans the last few nonblank rows rather than the final one: on a production hermit an
 * artifact-links footer renders BELOW the status bar (probed on the fleet), so a
 * last-line-only match reports nothing there. Null on no match and on a contradictory
 * one — a caller acting on a misread mode would cycle the session somewhere the operator
 * did not ask for, which is strictly worse than reporting that the pane was unreadable.
 *
 * Null is also the guard against acting while a dialog is up: a dialog terminates the
 * visible content, so the status bar falls outside the scan window and no mode is
 * returned (same property anchoredPaneTail relies on).
 */
/**
 * The pane's last `maxLines` non-blank rows, rejoined. The unanchored counterpart to
 * anchoredPaneTail, for callers scanning for text that has no dialog footer to anchor on.
 */
export function nonBlankTail(paneContent: string, maxLines: number): string {
  return paneContent
    .split('\n')
    .filter((line) => line.trim() !== '')
    .slice(-maxLines)
    .join('\n');
}

export function paneModeLine(paneContent: string): string | null {
  const tail = nonBlankTail(paneContent, MODE_SCAN_LINES).toLowerCase();

  const matched = Object.entries(MODE_PHRASES)
    .filter(([, phrase]) => tail.includes(phrase))
    .map(([mode]) => mode);

  return matched.length === 1 ? matched[0] : null;
}

/**
 * Expand the configured session-name template against an explicit project dir.
 *
 * Callers that know the project directory (rather than assuming it is the CWD)
 * must use this — the doctor, for one, is routinely run from elsewhere.
 */
export function expandSessionName(config: Json, projectDir: string): string {
  const name = config.tmux_session_name ?? 'hermit-{project_name}';
  return String(name).replaceAll('{project_name}', path.basename(projectDir));
}

/** Derive the tmux session name from config (CWD-relative project name). */
export function getSessionName(config: Json): string {
  return expandSessionName(config, process.cwd());
}

/**
 * True when the string contains a C0/C7F control character.
 *
 * Last-resort barrier before text reaches a pane. A newline is the dangerous one:
 * send-keys would submit early and the remainder would land as its own prompt.
 * Deliberately a deny-list of control characters rather than an allow-list of
 * punctuation — existing callers send prose (the watchdog's `/compact` steering
 * messages, and localized operator-facing restart/wedge/pause text: commas, hyphens,
 * accents, no control chars) and an allow-list would silently break them. Callers
 * handling UNTRUSTED input apply their own strict grammar on top (see
 * lib/prompt-stages/harness-command.ts).
 */
function hasControlChars(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c < 0x20 || c === 0x7f) return true;
  }
  return false;
}

/**
 * Send text then Enter as two separate calls, returning whether tmux accepted both.
 *
 * The split with a pause between is a workaround for Claude Code's TUI treating
 * text+Enter in one burst as a bracketed paste, which turns Enter into a literal
 * newline instead of a submit (same fix as bin/hermitd-docker).
 *
 * The boolean means "tmux accepted the keystrokes", NOT "Claude Code applied the
 * command" — nothing here can observe whether the harness accepted or rejected it.
 * Callers keeping retry state must read false as "not delivered" and true as
 * "delivered, outcome unknown".
 */
export function sendKeys(sessionName: string, text: string, transport: Transport = HOST): boolean {
  if (!sessionName || !text || hasControlChars(text)) return false;
  const typed = runTmux(transport, ['send-keys', '-t', sessionName, '-l', '--', text]);
  if (typed.error || typed.status !== 0) return false;
  Bun.sleepSync(500);
  return sendEnter(sessionName, transport);
}
