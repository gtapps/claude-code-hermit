// Coverage for the inbox-socket client (scripts/lib/peer-post.ts) and its CLI
// wrapper (scripts/peer-post.ts). A throwaway Unix socket server stands in for
// a Claude Code session's inbox: what the harness actually asserts on is the
// bytes on the wire, so the tests read the received frames verbatim rather than
// trusting the return value alone.
//
// Every fixture is created and torn down INSIDE its own test. bunfig.toml sets
// concurrentTestGlob, and a module-level fixture reaped by afterEach is torn
// down while sibling tests are still mid-connect — servers closed underneath
// them, every CLI case reading `dead`.

import { test, expect, describe } from 'bun:test';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { postToSession, userMessageLine } from '../scripts/lib/peer-post';
import { SCRIPTS_DIR, runScript } from './helpers/run';

type Inbox = { socketPath: string; lines: string[]; close: () => void };

/** A Unix socket server that records every line it receives. */
async function inboxServer(opts: { read?: boolean } = {}): Promise<Inbox> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'peer-post-'));
  const socketPath = path.join(dir, 'inbox.sock');
  const lines: string[] = [];
  const server = net.createServer((conn) => {
    if (opts.read === false) return; // accepts the connection, never reads
    let buf = '';
    conn.on('data', (chunk) => {
      buf += chunk.toString();
      let nl: number;
      while ((nl = buf.indexOf('\n')) !== -1) {
        lines.push(buf.slice(0, nl));
        buf = buf.slice(nl + 1);
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  return {
    socketPath,
    lines,
    close: () => {
      server.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** A path in a real directory with nothing listening on it. */
function deadSocketPath(): { socketPath: string; close: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'peer-post-'));
  return {
    socketPath: path.join(dir, 'absent.sock'),
    close: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

/** Poll until the server has recorded `n` lines — the write is async on both
 *  sides, so `sent` means flushed to the kernel, not yet parsed by the peer. */
async function waitForLines(lines: string[], n: number, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (lines.length < n && Date.now() < deadline) await Bun.sleep(10);
}

describe('postToSession', () => {
  test('writes one NDJSON user frame and resolves sent', async () => {
    const inbox = await inboxServer();
    try {
      expect(await postToSession(inbox.socketPath, 'HEARTBEAT_EVALUATE')).toBe('sent');

      await waitForLines(inbox.lines, 1);
      expect(inbox.lines).toHaveLength(1);
      // The exact wire shape the harness expects. Drift here breaks every wake.
      expect(inbox.lines[0]).toBe(
        '{"type":"user","message":{"role":"user","content":"HEARTBEAT_EVALUATE"}}',
      );
    } finally {
      inbox.close();
    }
  });

  test('a token prepends the auth line before the message', async () => {
    const inbox = await inboxServer();
    try {
      expect(await postToSession(inbox.socketPath, 'hello', { token: 'deadbeef' })).toBe('sent');

      await waitForLines(inbox.lines, 2);
      expect(JSON.parse(inbox.lines[0])).toEqual({ type: 'auth', token: 'deadbeef' });
      expect(JSON.parse(inbox.lines[1]).message.content).toBe('hello');
    } finally {
      inbox.close();
    }
  });

  test('no token → no auth line, message frame only', async () => {
    const inbox = await inboxServer();
    try {
      await postToSession(inbox.socketPath, 'hello');

      await waitForLines(inbox.lines, 1);
      expect(inbox.lines).toHaveLength(1);
      expect(JSON.parse(inbox.lines[0]).type).toBe('user');
    } finally {
      inbox.close();
    }
  });

  test('no listener at the path → dead, without throwing', async () => {
    const dead = deadSocketPath();
    try {
      expect(await postToSession(dead.socketPath, 'x', { timeoutMs: 500 })).toBe('dead');
    } finally {
      dead.close();
    }
  });

  test('a socket that accepts but never reads still resolves, never hangs', async () => {
    // Connect succeeds and the write flushes; the peer ignores it. The client
    // must not wait on a response it never gets.
    const inbox = await inboxServer({ read: false });
    try {
      expect(await postToSession(inbox.socketPath, 'x', { timeoutMs: 1000 })).toBe('sent');
    } finally {
      inbox.close();
    }
  });

  test('userMessageLine is newline-terminated', () => {
    expect(userMessageLine('x').endsWith('\n')).toBe(true);
  });
});

describe('peer-post CLI', () => {
  async function runCli(args: string[]) {
    const { stdout, exitCode } = await runScript('peer-post.ts', {
      args,
      // The token is inherited from the ambient session when Claude Code runs
      // the suite; blank it so the frame count is the same on CI and locally.
      env: { CLAUDE_CODE_MESSAGING_TOKEN: '' },
    });
    return { stdout: stdout.trim(), exitCode };
  }

  test('text argument → exit 0, prints sent, frame on the wire', async () => {
    const inbox = await inboxServer();
    try {
      const { stdout, exitCode } = await runCli([inbox.socketPath, 'HEARTBEAT_EVALUATE']);

      expect(exitCode).toBe(0);
      expect(stdout).toBe('sent');
      await waitForLines(inbox.lines, 1);
      expect(JSON.parse(inbox.lines[0]).message.content).toBe('HEARTBEAT_EVALUATE');
    } finally {
      inbox.close();
    }
  });

  test('CLAUDE_CODE_MESSAGING_TOKEN in the environment becomes the auth line', async () => {
    const inbox = await inboxServer();
    try {
      const proc = Bun.spawn({
        cmd: [process.execPath, path.join(SCRIPTS_DIR, 'peer-post.ts'), inbox.socketPath, 'x'],
        env: { ...process.env, CLAUDE_CODE_MESSAGING_TOKEN: 'cafebabe' },
        stdin: 'ignore',
        stdout: 'pipe',
        stderr: 'pipe',
      });
      expect(await proc.exited).toBe(0);

      await waitForLines(inbox.lines, 2);
      expect(JSON.parse(inbox.lines[0])).toEqual({ type: 'auth', token: 'cafebabe' });
    } finally {
      inbox.close();
    }
  });

  test('dead socket → exit 1, prints dead', async () => {
    const dead = deadSocketPath();
    try {
      const { stdout, exitCode } = await runCli([dead.socketPath, 'x']);

      expect(exitCode).toBe(1);
      expect(stdout).toBe('dead');
    } finally {
      dead.close();
    }
  });

  test('no socket path → usage error, exit 1', async () => {
    const { exitCode } = await runCli([]);
    expect(exitCode).toBe(1);
  });

  test('no text argument → exit 1, nothing on the wire', async () => {
    const inbox = await inboxServer();
    try {
      const { stdout, exitCode } = await runCli([inbox.socketPath]);
      expect(exitCode).toBe(1);
      expect(stdout).toBe('');
      expect(inbox.lines).toHaveLength(0);
    } finally {
      inbox.close();
    }
  });
});
