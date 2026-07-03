// Unit + CLI integration tests for the Sentry/GlitchTip client.
// Offline: a Bun.serve fixture server stands in for the tracker; the CLI is
// spawned as a child process pointed at it via ERROR_HERMIT_BASE_URL.
// Run with: bun test tests/error-api.test.ts

import { test, expect, describe, beforeAll, afterAll } from 'bun:test';
import path from 'node:path';
import {
  summarizeIssue,
  summarizeEvent,
  buildIssueQuery,
  isoMinus,
  redact,
} from '../scripts/error-api-lib';
import { loadFixture, jsonResponse } from './test-utils';

const CLI = path.join(import.meta.dir, '..', 'scripts', 'error-api.ts');
const load = loadFixture;

const GOOD_TOKEN = 'good-secret-token-value-xyz';

type Recorded = { method: string; path: string; search: string; body: string };
const requests: Recorded[] = [];

let server: ReturnType<typeof Bun.serve> | undefined;
let baseUrl = '';

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const body = req.method === 'GET' ? '' : await req.text();
      requests.push({ method: req.method, path: url.pathname, search: url.search, body });

      const auth = req.headers.get('authorization') ?? '';
      if (!auth.includes(GOOD_TOKEN)) {
        return jsonResponse(load('error-401.json'), 401);
      }

      const p = url.pathname;
      if (p === '/api/0/organizations/acme/') return jsonResponse(load('org.json'));
      if (p === '/api/0/projects/acme/web/issues/') {
        if (url.searchParams.get('limit') === '1') return jsonResponse([load('issues-list.json')[0]]);
        return jsonResponse(load('issues-list.json'));
      }
      if (p === '/api/0/issues/1001/') {
        if (req.method === 'PUT') return jsonResponse({ status: JSON.parse(body || '{}').status });
        return jsonResponse(load('issue-detail.json'));
      }
      if (p === '/api/0/issues/1001/events/latest/') return jsonResponse(load('event-latest.json'));
      return new Response('not found', { status: 404 });
    },
  });
  baseUrl = `http://127.0.0.1:${server.port}`;
});

afterAll(() => server?.stop(true));

// Spawn the CLI ASYNCHRONOUSLY. spawnSync would block this thread, and the
// fixture Bun.serve above runs on this same event loop — a blocked parent can't
// answer the child's request, deadlocking every server-backed call.
async function runCli(args: string[], envOverride: Record<string, string> = {}) {
  const proc = Bun.spawn(['bun', CLI, ...args], {
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      ...process.env,
      ERROR_HERMIT_BASE_URL: baseUrl,
      ERROR_HERMIT_TOKEN: GOOD_TOKEN,
      ERROR_HERMIT_ORG: 'acme',
      ERROR_HERMIT_PROJECT: 'web',
      // Force projectRoot()'s first branch to miss so no stray .env is loaded;
      // process.env values above take precedence over any file anyway.
      CLAUDE_PROJECT_DIR: '/nonexistent-error-hermit-test',
      ...envOverride,
    },
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const code = await proc.exited;
  return { code, stdout, stderr };
}

describe('lib parsers', () => {
  test('summarizeIssue pulls the fields the triage skill keys on', () => {
    const s = summarizeIssue(load('issues-list.json')[0]);
    expect(s.shortId).toBe('ACME-7');
    expect(s.level).toBe('error');
    expect(s.count).toBe('42');
    expect(s.firstSeen).toBe('2026-07-02T23:10:00Z');
  });

  test('summarizeEvent extracts the release tag', () => {
    const s = summarizeEvent(load('event-latest.json'));
    expect(s.release).toBe('web@2026.7.2-a1b2c3d');
    expect(s.culprit).toContain('applyCoupon');
  });

  test('buildIssueQuery composes free-form query and the firstSeen bound', () => {
    expect(buildIssueQuery({ since: '2026-07-03T00:00:00Z' })).toBe('firstSeen:>=2026-07-03T00:00:00Z');
    expect(buildIssueQuery({ query: 'is:unresolved', since: 'X' })).toBe('is:unresolved firstSeen:>=X');
    expect(buildIssueQuery({})).toBe('');
  });

  test('isoMinus subtracts the lookback and leaves bad input untouched', () => {
    expect(isoMinus('2026-07-03T06:00:00Z', 6 * 60 * 60 * 1000)).toBe('2026-07-03T00:00:00.000Z');
    expect(isoMinus('not-a-date', 1000)).toBe('not-a-date');
  });

  test('redact scrubs the token and bearer-shaped substrings', () => {
    const scrubbed = redact(`Authorization: Bearer ${GOOD_TOKEN}`, GOOD_TOKEN);
    expect(scrubbed).not.toContain(GOOD_TOKEN);
    expect(scrubbed).toContain('[REDACTED]');
  });
});

describe('CLI: check', () => {
  test('ok branch reports connected org/project', async () => {
    const r = await runCli(['check']);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('ok: connected to acme/web');
  });

  test('invalid token reports 401 without leaking the token', async () => {
    const r = await runCli(['check'], { ERROR_HERMIT_TOKEN: 'badtoken' });
    expect(r.code).toBe(1);
    expect(r.stdout).toContain('invalid: token rejected (401)');
  });

  test('missing config reports which keys are absent', async () => {
    const r = await runCli(['check'], { ERROR_HERMIT_TOKEN: '', ERROR_HERMIT_ORG: '' });
    expect(r.code).toBe(1);
    expect(r.stdout).toContain('missing:');
    expect(r.stdout).toContain('ERROR_HERMIT_TOKEN');
  });
});

describe('CLI: issues', () => {
  test('table output lists issue groups', async () => {
    const r = await runCli(['issues']);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('ACME-7');
    expect(r.stdout).toContain('ACME-8');
  });

  test('--json emits a parseable summarized array', async () => {
    const r = await runCli(['issues', '--json']);
    expect(r.code).toBe(0);
    const parsed = JSON.parse(r.stdout);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed).toHaveLength(2);
    expect(parsed[0].shortId).toBe('ACME-7');
  });

  test('--since is sent as a firstSeen query param', async () => {
    await runCli(['issues', '--since', '2026-07-03T00:00:00Z']);
    const listReq = requests.filter((q) => q.path === '/api/0/projects/acme/web/issues/').pop();
    expect(listReq).toBeDefined();
    const query = new URLSearchParams(listReq!.search).get('query');
    expect(query).toBe('firstSeen:>=2026-07-03T00:00:00Z');
  });
});

describe('CLI: issue + latest-event', () => {
  test('issue detail --json returns the summary', async () => {
    const r = await runCli(['issue', '1001', '--json']);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout).shortId).toBe('ACME-7');
  });

  test('latest-event --json includes the release for regression correlation', async () => {
    const r = await runCli(['latest-event', '1001', '--json']);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout).summary.release).toBe('web@2026.7.2-a1b2c3d');
  });
});

describe('CLI: write gating', () => {
  test('resolve without --confirm refuses and sends NO request', async () => {
    const before = requests.filter((q) => q.method === 'PUT').length;
    const r = await runCli(['resolve', '1001']);
    const after = requests.filter((q) => q.method === 'PUT').length;
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('refused');
    expect(after).toBe(before);
  });

  test('resolve --confirm sends PUT {status: resolved}', async () => {
    const r = await runCli(['resolve', '1001', '--confirm']);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('set to resolved');
    const put = requests.filter((q) => q.method === 'PUT' && q.path === '/api/0/issues/1001/').pop();
    expect(put).toBeDefined();
    expect(JSON.parse(put!.body).status).toBe('resolved');
  });

  test('mute --confirm sends PUT {status: ignored}', async () => {
    const r = await runCli(['mute', '1001', '--confirm']);
    expect(r.code).toBe(0);
    const put = requests.filter((q) => q.method === 'PUT').pop();
    expect(JSON.parse(put!.body).status).toBe('ignored');
  });
});

describe('CLI: token never leaks', () => {
  test('token absent from all output across read commands', async () => {
    const results = await Promise.all(
      [['check'], ['issues'], ['issue', '1001'], ['latest-event', '1001']].map((args) => runCli(args)),
    );
    for (const r of results) {
      expect(r.stdout).not.toContain(GOOD_TOKEN);
      expect(r.stderr).not.toContain(GOOD_TOKEN);
    }
  });
});
