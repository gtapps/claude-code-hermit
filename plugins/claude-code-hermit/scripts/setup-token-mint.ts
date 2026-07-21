#!/usr/bin/env bun
/**
 * Drives `claude setup-token` to mint a fresh long-lived credential, with two
 * front doors over one state machine:
 *
 *   - terminal: the operator is at a shell (`hermit-docker setup-token`), so
 *     the URL prints to stdout and the login code is read from stdin.
 *   - relay:    nobody has box access, so the URL goes out over the operator's
 *     channel and the login code is polled back from the channel log. Fully
 *     deterministic — the watchdog spawns it with no model in the loop.
 *
 * The skill (/claude-code-hermit:relogin) drives the same machine one step at a
 * time via the stepwise verbs, so the model can relay through its own channel
 * reply without the token ever entering its context.
 *
 * Security shape: the one-time OAuth URL and the login code cross the channel;
 * the token never does. It goes tmux pane stream -> installToken() -> 0600 file,
 * and is never printed, logged, or returned to a caller. cleanupMint() destroys
 * both places it lands (the capture file and the tmux scrollback) on every exit
 * path, including aborts.
 *
 * Usage: bun scripts/setup-token-mint.ts <verb> [args]
 *   terminal                  attended end-to-end mint (stdin/stdout)
 *   relay                     ack-first channel-relayed mint (watchdog-spawned)
 *   start                     begin a mint session
 *   await-url                 print the OAuth URL once it appears
 *   submit-code <code>        paste a login code into the running mint
 *   await-token-and-install   capture the token, install it, print the digest
 *   finish                    restart the session so the new token takes effect
 *   abort                     tear down a running mint
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import {
  defaultConfigDir,
  installToken,
  isPlausibleToken,
  readTokenRecord,
  tokenModeActive,
} from './lib/setup-token';
import { sendToChannel } from './lib/channel-send';
import { inboundSince } from './lib/channel-log';
import { tmuxSessionAlive } from './lib/tmux';

const HERMIT_DIR = process.env.HERMIT_DIR || '.claude-code-hermit';
const MINT_SESSION = 'hermit-reauth-mint';
const CAPTURE_FILE = path.join(os.tmpdir(), '.hermit-mint-capture');
const MARKER_FILE = path.join(HERMIT_DIR, 'state', 'reauth-relay.json');

// A tmux pane hard-wraps its output, and both artifacts we scrape are long: the
// OAuth URL (~250 chars) and the minted token (~110). A wrapped token would be
// silently truncated by the extractor and installed as garbage, taking the
// hermit dark with no obvious cause — so the mint pane is created far wider
// than either can be. This width is load-bearing, not cosmetic.
const MINT_COLS = 400;
const MINT_ROWS = 50;

const URL_TIMEOUT_MS = 90_000;
const TOKEN_TIMEOUT_MS = 180_000;
const ACK_TIMEOUT_MS = 24 * 3600_000;
const CODE_TIMEOUT_MS = 30 * 60_000;
const POLL_MS = 2_000;

// ---------- pane-stream parsing (shapes confirmed live against CC 2.1.216) ----------

const OSC8_TARGET_RE = /\x1b\]8;;(https:\/\/[^\x07\x1b]+)(?:\x07|\x1b\\)/g;
const PLAIN_URL_RE = /https:\/\/[^\s\x07"'<>]+/g;
const TOKEN_RE = /sk-ant-[A-Za-z0-9_-]{20,}/g;
const CODE_PROMPT_RE = /Paste code here/i;

function stripAnsi(s: string): string {
  return s
    .replace(/\x1b\][0-9]*;[^\x07\x1b]*(?:\x07|\x1b\\)/g, '') // OSC (incl. hyperlinks)
    .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '') // CSI
    .replace(/\x1b[()][A-Za-z0-9]/g, ''); // charset selects
}

/**
 * The OAuth URL from a pipe-pane stream.
 *
 * The visible pane text is hard-wrapped and elided mid-URL, so scraping what a
 * human sees yields a broken link — capture-pane is unusable here even with -J
 * (confirmed live). The complete URL survives as the OSC-8 hyperlink target,
 * which is why this reads the escape sequence rather than the rendered text.
 * Longest candidate wins, so a truncated visible copy can never outrank it.
 */
export function extractUrl(stream: string): string | null {
  const candidates: string[] = [];
  for (const m of stream.matchAll(OSC8_TARGET_RE)) candidates.push(m[1]);
  for (const m of stripAnsi(stream).matchAll(PLAIN_URL_RE)) candidates.push(m[0]);

  const oauth = candidates
    .map((u) => u.trim().replace(/[)\],.]+$/, ''))
    .filter((u) => u.includes('oauth'));
  if (oauth.length === 0) return null;
  return oauth.sort((a, b) => b.length - a.length)[0];
}

/** True once the mint is waiting for a login code. */
export function needsCode(stream: string): boolean {
  return CODE_PROMPT_RE.test(stripAnsi(stream));
}

/** The minted token, or null. Last match wins — the token is the final thing printed. */
export function extractToken(stream: string): string | null {
  const matches = [...stripAnsi(stream).matchAll(TOKEN_RE)].map((m) => m[0]);
  for (let i = matches.length - 1; i >= 0; i--) {
    if (isPlausibleToken(matches[i])) return matches[i];
  }
  return null;
}

/** First inbound channel message after `sinceIso` that looks like an ack. */
export function findAck(rows: { text: string }[]): boolean {
  return rows.some((r) => /\breauth\b/i.test(r.text || ''));
}

/**
 * First inbound message after `sinceIso` that looks like a login code. The code
 * is an opaque string the operator pastes, so this takes the first non-ack
 * message and trims it rather than pattern-matching a format that may change.
 */
export function findCode(rows: { text: string }[]): string | null {
  for (const r of rows) {
    const t = (r.text || '').trim();
    if (!t || /\breauth\b/i.test(t)) continue;
    if (t.split(/\s+/).length > 3) continue; // prose, not a pasted code
    return t;
  }
  return null;
}

// ---------- tmux mint session ----------

function tmux(args: string[]): { status: number; stdout: string } {
  const r = spawnSync('tmux', args, { encoding: 'utf-8', timeout: 10_000 });
  return { status: r.status ?? 1, stdout: typeof r.stdout === 'string' ? r.stdout : '' };
}

function mintSessionAlive(): boolean {
  return tmuxSessionAlive(MINT_SESSION);
}

function readStream(): string {
  try {
    return fs.readFileSync(CAPTURE_FILE, 'utf8');
  } catch {
    return '';
  }
}

export function readMarker(): any | null {
  try {
    return JSON.parse(fs.readFileSync(MARKER_FILE, 'utf8'));
  } catch {
    return null;
  }
}

function writeMarker(stage: string, mode: string): void {
  try {
    fs.mkdirSync(path.dirname(MARKER_FILE), { recursive: true });
    const existing = readMarker();
    fs.writeFileSync(
      MARKER_FILE,
      JSON.stringify(
        {
          pid: process.pid,
          mode,
          stage,
          started_at: existing?.started_at ?? new Date().toISOString(),
          updated_at: new Date().toISOString(),
        },
        null,
        2
      ) + '\n'
    );
  } catch {}
}

function clearMarker(): void {
  try {
    fs.unlinkSync(MARKER_FILE);
  } catch {}
}

/** Start `claude setup-token` in a wide detached pane, streaming to a 0600 capture file. */
function startMint(mode: string): void {
  cleanupMint();
  fs.writeFileSync(CAPTURE_FILE, '', { mode: 0o600 });
  fs.chmodSync(CAPTURE_FILE, 0o600);

  // Linger briefly after the CLI exits so the token stays streamable even if the
  // poller is between ticks when the process ends.
  const r = tmux([
    'new-session', '-d', '-s', MINT_SESSION,
    '-x', String(MINT_COLS), '-y', String(MINT_ROWS),
    'claude setup-token; sleep 20',
  ]);
  if (r.status !== 0) throw new Error('failed to start mint session');
  tmux(['pipe-pane', '-o', '-t', MINT_SESSION, `cat >> ${CAPTURE_FILE}`]);
  writeMarker('started', mode);
}

/** Paste a login code into the mint pane (text then Enter — bracketed-paste bug). */
function submitCode(code: string): void {
  tmux(['send-keys', '-t', MINT_SESSION, code]);
  Bun.sleepSync(500);
  tmux(['send-keys', '-t', MINT_SESSION, 'Enter']);
}

/**
 * Destroy every copy of the token: the capture file and the pane scrollback it
 * was printed into. Safe to call when nothing is running.
 */
export function cleanupMint(): void {
  tmux(['kill-session', '-t', MINT_SESSION]);
  try {
    fs.unlinkSync(CAPTURE_FILE);
  } catch {}
}

async function waitFor<T>(
  probe: () => T | null,
  timeoutMs: number,
  onTick?: () => void
): Promise<T | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const got = probe();
    if (got !== null && got !== undefined) return got;
    onTick?.();
    await Bun.sleep(POLL_MS);
  }
  return null;
}

// ---------- operator I/O adapters ----------

/** notify() reports delivery: an unreachable operator must stop the flow, not stall it. */
type OperatorIO = {
  notify(text: string): Promise<boolean>;
  awaitAck(sinceIso: string): Promise<boolean>;
  awaitCode(sinceIso: string): Promise<string | null>;
};

const terminalIO: OperatorIO = {
  async notify(text) {
    console.log(text);
    return true;
  },
  async awaitAck() {
    return true; // the operator is already here
  },
  async awaitCode() {
    process.stdout.write('Paste the login code (or press Enter to skip): ');
    for await (const line of console) return line.trim() || null;
    return null;
  },
};

const channelIO: OperatorIO = {
  async notify(text) {
    const r = await sendToChannel(HERMIT_DIR, text);
    return r.ok === true;
  },
  async awaitAck(sinceIso) {
    const got = await waitFor(
      () => (findAck(inboundSince(HERMIT_DIR, sinceIso)) ? true : null),
      ACK_TIMEOUT_MS
    );
    return got === true;
  },
  async awaitCode(sinceIso) {
    return await waitFor(() => findCode(inboundSince(HERMIT_DIR, sinceIso)), CODE_TIMEOUT_MS);
  },
};

// ---------- the shared flow ----------

async function runMintFlow(io: OperatorIO, mode: string, requireAck: boolean): Promise<number> {
  const startedAt = new Date().toISOString();

  if (requireAck) {
    writeMarker('awaiting-ack', mode);
    const reached = await io.notify(
      "Your hermit's Claude login has expired, so it can't work until it's renewed. " +
        "Reply 'reauth' when you're at a browser and I'll send you a one-time sign-in link."
    );
    // No way to reach the operator means no way to finish: bail now rather than
    // minting a link nobody will see and then waiting on a reply that can't come.
    if (!reached) {
      clearMarker();
      return fail('operator unreachable — no channel to relay the sign-in link');
    }
    const acked = await io.awaitAck(startedAt);
    if (!acked) {
      clearMarker();
      return fail('no acknowledgement — nothing minted');
    }
  }

  const ackAt = new Date().toISOString();
  writeMarker('minting', mode);
  startMint(mode);

  const url = await waitFor(() => extractUrl(readStream()), URL_TIMEOUT_MS);
  if (!url) return abortMint('sign-in link never appeared');

  writeMarker('awaiting-code', mode);
  await io.notify(`Open this link to sign in, then send me the code it gives you:\n${url}`);

  // Poll for the token throughout: if the browser flow completes on its own, no
  // code is ever needed and asking for one would strand the flow.
  let token = await waitFor(() => extractToken(readStream()), 15_000);
  if (!token) {
    const code = await io.awaitCode(ackAt);
    if (code) submitCode(code);
    token = await waitFor(() => extractToken(readStream()), TOKEN_TIMEOUT_MS);
  }

  if (!token) {
    cleanupMint();
    clearMarker();
    await io.notify("That sign-in didn't complete. Nothing changed — we can try again whenever you're ready.");
    return fail('no token captured');
  }

  const record = installToken(HERMIT_DIR, defaultConfigDir(), token);
  cleanupMint();
  writeMarker('installed', mode);

  await io.notify(
    `You're signed back in. Nothing else to do — the next renewal is due ${friendlyDate(record.expires_at)}, and I'll ask you then.`
  );
  console.log(JSON.stringify({ ok: true, expires_at: record.expires_at }));
  return 0;
}

function friendlyDate(iso: string): string {
  const d = new Date(iso);
  return isNaN(d.getTime())
    ? 'in about a year'
    : d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
}

function fail(reason: string): number {
  console.log(JSON.stringify({ ok: false, error: reason }));
  return 1;
}

/** Give up: tear down the mint, drop the marker, report the failure. */
function abortMint(reason: string): number {
  cleanupMint();
  clearMarker();
  return fail(reason);
}

/**
 * Bounce the claude process so it picks up the new token (credentials are read
 * at process start).
 *
 * Detached and unawaited, because the proactive path runs this from inside the
 * very session being restarted: anything that waited would be killed mid-call,
 * and the caller must be free to exit immediately.
 */
function requestRestart(): boolean {
  const bin = path.join(HERMIT_DIR, 'bin', 'hermit-watchdog');
  if (!fs.existsSync(bin)) return false;
  const child = spawn(bin, ['restart', 'reauth'], { detached: true, stdio: 'ignore' });
  child.unref();
  return true;
}

// ---------- verbs ----------

async function main(): Promise<void> {
  const verb = process.argv[2] ?? '';
  let code = 0;

  switch (verb) {
    case 'terminal':
      code = await runMintFlow(terminalIO, 'terminal', false);
      break;

    case 'relay':
      try {
        code = await runMintFlow(channelIO, 'relay', true);
        if (code === 0) requestRestart();
      } finally {
        cleanupMint();
        if (code !== 0) clearMarker();
      }
      break;

    case 'start':
      startMint('skill');
      console.log(JSON.stringify({ ok: true, stage: 'started' }));
      break;

    case 'await-url': {
      const url = await waitFor(() => extractUrl(readStream()), URL_TIMEOUT_MS);
      if (!url) {
        code = abortMint('sign-in link never appeared');
      } else {
        writeMarker('awaiting-code', 'skill');
        console.log(JSON.stringify({ ok: true, url }));
      }
      break;
    }

    case 'submit-code': {
      const value = process.argv[3];
      if (!value) {
        code = fail('no code given');
      } else if (!mintSessionAlive()) {
        code = fail('no mint in progress');
      } else {
        submitCode(value);
        console.log(JSON.stringify({ ok: true, stage: 'code-submitted' }));
      }
      break;
    }

    case 'await-token-and-install': {
      const token = await waitFor(() => extractToken(readStream()), TOKEN_TIMEOUT_MS);
      if (!token) {
        code = abortMint('no token captured');
      } else {
        const record = installToken(HERMIT_DIR, defaultConfigDir(), token);
        cleanupMint();
        clearMarker();
        console.log(JSON.stringify({ ok: true, expires_at: record.expires_at }));
      }
      break;
    }

    case 'abort':
      cleanupMint();
      clearMarker();
      console.log(JSON.stringify({ ok: true, stage: 'aborted' }));
      break;

    // Final step of the proactive (/relogin) path. A verb rather than the skill
    // shelling out to the watchdog directly, so the whole flow stays inside one
    // sealed permission entry — a skill that runs over a channel can't afford a
    // command that prompts, since an unanswerable prompt is a denial.
    case 'finish':
      console.log(JSON.stringify({ ok: requestRestart(), stage: 'restarting' }));
      break;

    case 'status': {
      // token_mode keys on the credential itself, not the expiry record — a
      // leftover record on a hermit that no longer uses token auth must not
      // report as token mode. Same definition the watchdog and entrypoint use.
      const record = readTokenRecord(HERMIT_DIR);
      console.log(
        JSON.stringify({
          ok: true,
          token_mode: tokenModeActive(defaultConfigDir()),
          expires_at: record?.expires_at ?? null,
          in_progress: readMarker()?.stage ?? null,
        })
      );
      break;
    }

    default:
      process.stderr.write(
        'Usage: setup-token-mint.ts <terminal|relay|start|await-url|submit-code|await-token-and-install|finish|abort|status>\n'
      );
      code = 1;
  }

  process.exit(code);
}

if (import.meta.main) {
  main().catch((e) => {
    cleanupMint();
    process.stderr.write(`[setup-token-mint] ${e}\n`);
    process.exit(1);
  });
}
