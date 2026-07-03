// Tests for error-precheck.ts — the zero-token watch gate.
// Offline: a Bun.serve fixture server; a temp project dir supplies the cursor.
// Run with: bun test tests/precheck.test.ts

import { test, expect, describe, beforeAll, afterAll } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadFixture, jsonResponse } from './test-utils';

const PRECHECK = path.join(import.meta.dir, '..', 'scripts', 'error-precheck.ts');
const load = loadFixture;

let server: ReturnType<typeof Bun.serve> | undefined;
let baseUrl = '';

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      // Project slug selects the canned response so a single server drives
      // both the "quiet" and "new groups" cases.
      if (url.pathname === '/api/0/projects/acme/empty/issues/') return jsonResponse(load('issues-empty.json'));
      if (url.pathname === '/api/0/projects/acme/web/issues/') return jsonResponse(load('issues-list.json'));
      return new Response('not found', { status: 404 });
    },
  });
  baseUrl = `http://127.0.0.1:${server.port}`;
});

afterAll(() => server?.stop(true));

function makeProjectDir(cursor?: Record<string, unknown>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'err-precheck-'));
  fs.mkdirSync(path.join(dir, '.claude-code-hermit', 'state'), { recursive: true });
  if (cursor) {
    fs.writeFileSync(
      path.join(dir, '.claude-code-hermit', 'state', 'error-cursor.json'),
      JSON.stringify(cursor),
    );
  }
  return dir;
}

async function runPrecheck(projectDir: string, project: string, envOverride: Record<string, string> = {}) {
  const proc = Bun.spawn(['bun', PRECHECK], {
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      ...process.env,
      CLAUDE_PROJECT_DIR: projectDir,
      ERROR_HERMIT_BASE_URL: baseUrl,
      ERROR_HERMIT_TOKEN: 'precheck-token',
      ERROR_HERMIT_ORG: 'acme',
      ERROR_HERMIT_PROJECT: project,
      ...envOverride,
    },
  });
  const stdout = await new Response(proc.stdout).text();
  const code = await proc.exited;
  return { code, verdict: stdout.trim() };
}

const cursorPath = (dir: string) => path.join(dir, '.claude-code-hermit', 'state', 'error-cursor.json');

describe('error-precheck verdicts', () => {
  test('no cursor file → bootstrap EVALUATE', async () => {
    const dir = makeProjectDir();
    const r = await runPrecheck(dir, 'web');
    expect(r.code).toBe(0);
    expect(r.verdict).toBe('EVALUATE|no cursor — bootstrap');
  });

  test('cursor set, tracker quiet → SKIP', async () => {
    const dir = makeProjectDir({ last_seen_first_seen: '2026-07-01T00:00:00Z' });
    const r = await runPrecheck(dir, 'empty');
    expect(r.code).toBe(0);
    expect(r.verdict).toBe('SKIP|no new error groups');
  });

  test('cursor set, new groups present → EVALUATE with count', async () => {
    const dir = makeProjectDir({ last_seen_first_seen: '2026-07-01T00:00:00Z' });
    const r = await runPrecheck(dir, 'web');
    expect(r.code).toBe(0);
    expect(r.verdict).toBe('EVALUATE|2 new groups');
  });

  test('all returned groups already in seen_ids → SKIP (boundary does not re-trigger)', async () => {
    const dir = makeProjectDir({
      last_seen_first_seen: '2026-07-03T00:20:00Z',
      seen_ids: ['1001', '1002'],
    });
    const r = await runPrecheck(dir, 'web');
    expect(r.code).toBe(0);
    expect(r.verdict).toBe('SKIP|no new error groups');
  });

  test('seen_ids covers only some groups → EVALUATE counts the fresh ones', async () => {
    const dir = makeProjectDir({
      last_seen_first_seen: '2026-07-03T00:20:00Z',
      seen_ids: ['1001'],
    });
    const r = await runPrecheck(dir, 'web');
    expect(r.code).toBe(0);
    expect(r.verdict).toBe('EVALUATE|1 new groups');
  });

  test('missing config → ERROR, exit 0 (verdict is the protocol)', async () => {
    const dir = makeProjectDir({ last_seen_first_seen: '2026-07-01T00:00:00Z' });
    const r = await runPrecheck(dir, 'web', { ERROR_HERMIT_TOKEN: '' });
    expect(r.code).toBe(0);
    expect(r.verdict).toContain('ERROR|config incomplete');
    expect(r.verdict).toContain('ERROR_HERMIT_TOKEN');
  });
});

describe('error-precheck never mutates the cursor', () => {
  test('SKIP leaves the cursor file byte-identical', async () => {
    const dir = makeProjectDir({ last_seen_first_seen: '2026-07-01T00:00:00Z', consecutive_failures: 0 });
    const before = fs.readFileSync(cursorPath(dir), 'utf8');
    await runPrecheck(dir, 'empty');
    const after = fs.readFileSync(cursorPath(dir), 'utf8');
    expect(after).toBe(before);
  });

  test('EVALUATE leaves the cursor file byte-identical', async () => {
    const dir = makeProjectDir({ last_seen_first_seen: '2026-07-01T00:00:00Z', consecutive_failures: 0 });
    const before = fs.readFileSync(cursorPath(dir), 'utf8');
    await runPrecheck(dir, 'web');
    const after = fs.readFileSync(cursorPath(dir), 'utf8');
    expect(after).toBe(before);
  });
});
