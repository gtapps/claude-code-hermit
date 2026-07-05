// bun test for scripts/report-export.ts — bundle assembly, redaction,
// spool/retry/alert, and the CLI transport path (mock webhook via Bun.serve).
//
// Usage: bun test tests/report-export.test.ts   (from the plugin root)

import { describe, test, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { runScript } from './helpers/run';
import {
  buildBundle,
  telemetryDue,
  writeExportState,
  spoolWrite,
  spoolList,
  drainSpool,
  runTelemetryExport,
  postBundle,
} from '../scripts/report-export';

describe('postBundle: bearer scheme guard', () => {
  test('refuses to send a bearer token over http to a non-loopback host', async () => {
    process.env.HERMIT_TEST_TELE_TOKEN = 'secret';
    try {
      const r = await postBundle('http://collector.example.com/hook', 'HERMIT_TEST_TELE_TOKEN', { x: 1 });
      expect(r.ok).toBe(false);
      expect((r as any).classification).toContain('insecure');
    } finally {
      delete process.env.HERMIT_TEST_TELE_TOKEN;
    }
  });

  test('allows a bearer token over http to loopback (local collector)', async () => {
    process.env.HERMIT_TEST_TELE_TOKEN = 'secret';
    const seen: any[] = [];
    const server = Bun.serve({ port: 0, fetch: async (req) => { seen.push(req.headers.get('authorization')); return new Response('ok'); } });
    try {
      const r = await postBundle(`http://127.0.0.1:${server.port}/hook`, 'HERMIT_TEST_TELE_TOKEN', { x: 1 });
      expect(r.ok).toBe(true);
      expect(seen[0]).toBe('Bearer secret');
    } finally {
      server.stop(true);
      delete process.env.HERMIT_TEST_TELE_TOKEN;
    }
  });
});

type Json = any;

// ---------- fixture scaffolding ----------

function makeHermitDir(): { hermitDir: string; cleanup(): void } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hermit-report-export-'));
  const hermitDir = path.join(root, '.claude-code-hermit');
  fs.mkdirSync(path.join(hermitDir, 'state'), { recursive: true });
  fs.mkdirSync(path.join(hermitDir, 'sessions'), { recursive: true });
  return { hermitDir, cleanup: () => { try { fs.rmSync(root, { recursive: true, force: true }); } catch {} } };
}

function withHermitDir(fn: (hermitDir: string) => Promise<void> | void) {
  return async () => {
    const h = makeHermitDir();
    try { await fn(h.hermitDir); } finally { h.cleanup(); }
  };
}

function statePath(hermitDir: string, ...p: string[]): string {
  return path.join(hermitDir, 'state', ...p);
}

function readState(hermitDir: string, ...p: string[]): Json {
  return JSON.parse(fs.readFileSync(statePath(hermitDir, ...p), 'utf-8'));
}

function writeDoctorReport(hermitDir: string): void {
  fs.writeFileSync(statePath(hermitDir, 'doctor-report.json'), JSON.stringify({
    ts: new Date().toISOString(),
    checks: [
      { id: 'runtime', status: 'ok', detail: 'DOCTOR-DETAIL-MARKER' },
      { id: 'config', status: 'warn', detail: 'something else' },
    ],
  }));
}

function writeCostIndex(hermitDir: string, overrides: Json = {}): void {
  fs.writeFileSync(statePath(hermitDir, 'cost-index.json'), JSON.stringify({
    version: 3,
    byte_offset: 0,
    total_cost_usd: 12.34,
    total_tokens: 500000,
    total_sessions: 7,
    last_session_id: 'S-007',
    by_source: { heartbeat: { cost: 1.5, tokens: 10000 } },
    by_date: {},
    by_week: {},
    by_month: {},
    skipped_corrupt_lines: 0,
    updated_at: new Date().toISOString(),
    ...overrides,
  }));
}

function writeAlertStateFixture(hermitDir: string): void {
  fs.writeFileSync(statePath(hermitDir, 'alert-state.json'), JSON.stringify({
    alerts: {
      'doctor:runtime': { suppressed: false, count: 1 },
      'doctor:config': { suppressed: true, count: 2 },
    },
    last_digest_date: null,
    self_eval: {},
    total_ticks: 42,
  }));
}

function writeSessionReport(hermitDir: string, id = 'S-002'): void {
  const content = `---
id: ${id}
status: completed
date: 2026-07-04
duration: 45m
cost_usd: 1.23
tokens: 45000
tags: [dev, telemetry]
proposals_created: [PROP-001, PROP-002]
task: TASK-TEXT-MARKER
escalation: balanced
operator_turns: 5
closed_via: operator
---
body text
`;
  fs.writeFileSync(path.join(hermitDir, 'sessions', `${id}-REPORT.md`), content);
}

function writeRuntimeFixture(hermitDir: string, overrides: Json = {}): void {
  fs.writeFileSync(statePath(hermitDir, 'runtime.json'), JSON.stringify({
    session_state: 'idle',
    runtime_mode: 'tmux',
    tmux_session: 'TMUX-SESSION-MARKER',
    last_error: 'LAST-ERROR-MARKER',
    ...overrides,
  }));
}

function writePauseFixture(hermitDir: string, opts: { paused: boolean; reason?: string }): void {
  fs.writeFileSync(statePath(hermitDir, 'pause.json'), JSON.stringify({
    paused: opts.paused,
    paused_until: null,
    reason: opts.reason ?? 'PAUSE-REASON-MARKER',
    by: 'tester',
    ts: new Date().toISOString(),
  }));
}

function writeWatchdogStateFixture(hermitDir: string, lastRun: string): void {
  fs.writeFileSync(statePath(hermitDir, 'watchdog-state.json'), JSON.stringify({ last_run: lastRun }));
}

function writeWatchdogEvents(hermitDir: string, events: Json[]): void {
  fs.writeFileSync(statePath(hermitDir, 'watchdog-events.jsonl'), events.map((e) => JSON.stringify(e)).join('\n') + '\n');
}

// ---------- assembly ----------

describe('buildBundle: assembly', () => {
  test('full fixture → every schema field present, never throws', withHermitDir((hermitDir) => {
    writeDoctorReport(hermitDir);
    writeCostIndex(hermitDir);
    writeAlertStateFixture(hermitDir);
    writeSessionReport(hermitDir);
    writeRuntimeFixture(hermitDir);
    writePauseFixture(hermitDir, { paused: true });
    writeWatchdogStateFixture(hermitDir, new Date().toISOString());
    writeWatchdogEvents(hermitDir, [{ ts: new Date().toISOString(), action: 'nudge', reason: 'test' }]);

    const config = { agent_name: 'Atlas', _hermit_versions: { 'claude-code-hermit': '1.2.16' }, timezone: 'UTC' };
    const bundle = buildBundle(hermitDir, config, { redact: true });

    expect(bundle.schema_version).toBe(1);
    expect(typeof bundle.ts).toBe('string');
    expect(bundle.hermit.agent_name).toBe('Atlas');
    expect(bundle.hermit.versions['claude-code-hermit']).toBe('1.2.16');
    expect(bundle.doctor.checks.length).toBe(2);
    expect(bundle.doctor.checks[0].detail).toBeUndefined();
    expect(bundle.cost.all_time.total_cost_usd).toBe(12.34);
    expect(bundle.alerts.active).toBe(1);
    expect(bundle.alerts.suppressed).toBe(1);
    expect(bundle.session.id).toBe('S-002');
    expect(bundle.session.cost_usd).toBe(1.23);
    expect(bundle.session.tokens).toBe(45000);
    expect(bundle.session.proposals_created_count).toBe(2);
    expect(bundle.runtime.paused).toBe(true);
    expect(bundle.runtime.watchdog.events_last_24h.nudge).toBe(1);
  }));

  test('partial fixture → missing artifacts become null, never throws', withHermitDir((hermitDir) => {
    writeRuntimeFixture(hermitDir, { last_error: null });
    const bundle = buildBundle(hermitDir, {});
    expect(bundle.doctor).toBeNull();
    expect(bundle.cost).toBeNull();
    expect(bundle.alerts).toEqual({ active: 0, suppressed: 0, total_ticks: 0 }); // alert-state.json absent = zero alerts, not corrupt
    expect(bundle.session).toBeNull();
    expect(bundle.runtime.session_state).toBe('idle');
  }));

  test('empty state dir → all-null sections, never throws', withHermitDir((hermitDir) => {
    const bundle = buildBundle(hermitDir, {});
    expect(bundle.doctor).toBeNull();
    expect(bundle.cost).toBeNull();
    expect(bundle.alerts).toEqual({ active: 0, suppressed: 0, total_ticks: 0 });
    expect(bundle.session).toBeNull();
    expect(bundle.runtime.session_state).toBeNull();
    expect(bundle.runtime.paused).toBe(false);
  }));

  test('cost-index version mismatch → cost: null', withHermitDir((hermitDir) => {
    writeCostIndex(hermitDir, { version: 2 });
    const bundle = buildBundle(hermitDir, {});
    expect(bundle.cost).toBeNull();
  }));
});

describe('buildBundle: redaction', () => {
  test('redact on (default) drops free text; redact off adds it back', withHermitDir((hermitDir) => {
    writeDoctorReport(hermitDir);
    writeSessionReport(hermitDir);
    writeRuntimeFixture(hermitDir);
    writePauseFixture(hermitDir, { paused: true });

    const redacted = buildBundle(hermitDir, {}, { redact: true });
    const unredacted = buildBundle(hermitDir, {}, { redact: false });
    const redactedStr = JSON.stringify(redacted);
    const unredactedStr = JSON.stringify(unredacted);

    for (const marker of ['DOCTOR-DETAIL-MARKER', 'TASK-TEXT-MARKER', 'LAST-ERROR-MARKER', 'PAUSE-REASON-MARKER', 'TMUX-SESSION-MARKER']) {
      expect(redactedStr).not.toContain(marker);
      expect(unredactedStr).toContain(marker);
    }
  }));

  test('by_source routine ids collapse to a single "routine" bucket under redact', withHermitDir((hermitDir) => {
    writeCostIndex(hermitDir, {
      by_source: {
        heartbeat: { cost: 1.5, tokens: 10 },
        'routine:client-acme-audit': { cost: 2.0, tokens: 20 },
        'routine:reflect': { cost: 0.5, tokens: 5 },
      },
    });

    const redacted = buildBundle(hermitDir, {}, { redact: true });
    // Default: operator-chosen routine ids never leave; their cost/tokens sum into one bucket.
    expect(JSON.stringify(redacted)).not.toContain('client-acme-audit');
    expect(redacted.cost.by_source).toEqual({
      heartbeat: { cost: 1.5, tokens: 10 },
      routine: { cost: 2.5, tokens: 25 },
    });

    // Opt-out (redact:false): per-routine keys are preserved verbatim.
    const unredacted = buildBundle(hermitDir, {}, { redact: false });
    expect(unredacted.cost.by_source['routine:client-acme-audit']).toEqual({ cost: 2.0, tokens: 20 });
  }));
});

// ---------- telemetryDue ----------

describe('telemetryDue', () => {
  const ref = new Date('2026-07-05T12:00:00Z');

  test('disabled or absent block → false', withHermitDir((hermitDir) => {
    expect(telemetryDue({}, hermitDir, ref)).toBe(false);
    expect(telemetryDue({ telemetry_export: { enabled: false, destination: { url: 'https://x' } } }, hermitDir, ref)).toBe(false);
  }));

  test('enabled but no destination url → false', withHermitDir((hermitDir) => {
    expect(telemetryDue({ telemetry_export: { enabled: true } }, hermitDir, ref)).toBe(false);
  }));

  test('enabled + never exported → true', withHermitDir((hermitDir) => {
    const cfg = { telemetry_export: { enabled: true, destination: { url: 'https://x' }, interval_hours: 24 } };
    expect(telemetryDue(cfg, hermitDir, ref)).toBe(true);
  }));

  test('last_success_at 1h old @24h interval → false; 25h old → true', withHermitDir((hermitDir) => {
    const cfg = { telemetry_export: { enabled: true, destination: { url: 'https://x' }, interval_hours: 24 } };
    writeExportState(hermitDir, { version: 1, last_success_at: new Date(ref.getTime() - 3600_000).toISOString(), last_attempt_at: null, consecutive_failures: 0 });
    expect(telemetryDue(cfg, hermitDir, ref)).toBe(false);

    writeExportState(hermitDir, { version: 1, last_success_at: new Date(ref.getTime() - 25 * 3600_000).toISOString(), last_attempt_at: null, consecutive_failures: 0 });
    expect(telemetryDue(cfg, hermitDir, ref)).toBe(true);
  }));

  test('retry floor: failing attempt 5min ago blocks retry, 20min ago allows it', withHermitDir((hermitDir) => {
    const cfg = { telemetry_export: { enabled: true, destination: { url: 'https://x' }, interval_hours: 24 } };
    writeExportState(hermitDir, { version: 1, last_success_at: null, last_attempt_at: new Date(ref.getTime() - 5 * 60_000).toISOString(), consecutive_failures: 1 });
    expect(telemetryDue(cfg, hermitDir, ref)).toBe(false);

    writeExportState(hermitDir, { version: 1, last_success_at: null, last_attempt_at: new Date(ref.getTime() - 20 * 60_000).toISOString(), consecutive_failures: 1 });
    expect(telemetryDue(cfg, hermitDir, ref)).toBe(true);
  }));
});

// ---------- spool + alert (in-process against a mock Bun.serve webhook) ----------

describe('runTelemetryExport: spool + alert', () => {
  test('3 consecutive failures raise a deduped alert (absent after only 2)', withHermitDir(async (hermitDir) => {
    const server = Bun.serve({ port: 0, fetch: () => new Response('fail', { status: 500 }) });
    try {
      const config = { telemetry_export: { enabled: true, destination: { url: `http://127.0.0.1:${server.port}` } } };

      await runTelemetryExport(config, hermitDir);
      await runTelemetryExport(config, hermitDir);
      // Below ALERT_THRESHOLD, telemetry-alert.json may not even exist yet — that's fine.
      let alerts = fs.existsSync(statePath(hermitDir, 'telemetry-alert.json')) ? readState(hermitDir, 'telemetry-alert.json').alerts : {};
      expect(alerts['telemetry:export-failed']).toBeUndefined();

      const r3 = await runTelemetryExport(config, hermitDir);
      expect(r3.ok).toBe(false);
      alerts = readState(hermitDir, 'telemetry-alert.json').alerts;
      expect(alerts['telemetry:export-failed'].count).toBe(3);
      expect(spoolList(hermitDir).length).toBe(3);
    } finally {
      server.stop(true);
    }
  }));

  test('success resolves the alert and drains the spool oldest-first', withHermitDir(async (hermitDir) => {
    writeExportState(hermitDir, { version: 1, last_success_at: null, last_attempt_at: new Date().toISOString(), consecutive_failures: 3 });
    fs.writeFileSync(statePath(hermitDir, 'telemetry-alert.json'), JSON.stringify({
      alerts: { 'telemetry:export-failed': { first_seen: new Date().toISOString(), message: 'x', count: 3, suppressed: false } },
    }));
    spoolWrite(hermitDir, { marker: 'first' }, new Date(Date.now() - 3000));
    spoolWrite(hermitDir, { marker: 'second' }, new Date(Date.now() - 2000));
    spoolWrite(hermitDir, { marker: 'third' }, new Date(Date.now() - 1000));
    expect(spoolList(hermitDir).length).toBe(3);

    const seenBodies: Json[] = [];
    const server = Bun.serve({
      port: 0,
      fetch: async (req) => { seenBodies.push(await req.json()); return new Response('ok', { status: 200 }); },
    });
    try {
      const config = { telemetry_export: { enabled: true, destination: { url: `http://127.0.0.1:${server.port}` } } };
      const r = await runTelemetryExport(config, hermitDir);
      expect(r.ok).toBe(true);
      expect(spoolList(hermitDir).length).toBe(0);
      expect(seenBodies.length).toBe(4); // fresh bundle + 3 drained
      expect(seenBodies[1].marker).toBe('first');
      expect(seenBodies[2].marker).toBe('second');
      expect(seenBodies[3].marker).toBe('third');

      const alerts = readState(hermitDir, 'telemetry-alert.json').alerts;
      expect(alerts['telemetry:export-failed']).toBeUndefined();
    } finally {
      server.stop(true);
    }
  }));

  test('spool retention: pruned to newest 7', withHermitDir((hermitDir) => {
    for (let i = 0; i < 9; i++) spoolWrite(hermitDir, { n: i }, new Date(Date.now() + i * 1000));
    expect(spoolList(hermitDir).length).toBe(7);
  }));

  test('mid-drain failure stops and leaves the remainder', withHermitDir(async (hermitDir) => {
    spoolWrite(hermitDir, { n: 0 }, new Date(Date.now() - 3000));
    spoolWrite(hermitDir, { n: 1 }, new Date(Date.now() - 2000));
    spoolWrite(hermitDir, { n: 2 }, new Date(Date.now() - 1000));
    let calls = 0;
    const server = Bun.serve({
      port: 0,
      fetch: () => { calls++; return calls === 2 ? new Response('fail', { status: 500 }) : new Response('ok', { status: 200 }); },
    });
    try {
      await drainSpool(hermitDir, `http://127.0.0.1:${server.port}`, null);
      expect(spoolList(hermitDir).length).toBe(2); // first drained, second failed + kept, third never attempted
    } finally {
      server.stop(true);
    }
  }));
});

// ---------- CLI transport (subprocess — env-gated timeout constant needs a fresh process) ----------

describe('report-export CLI: transport', () => {
  function seedTelemetryConfig(hermitDir: string, url: string): void {
    fs.writeFileSync(path.join(hermitDir, 'config.json'), JSON.stringify({
      telemetry_export: {
        enabled: true,
        destination: { type: 'webhook', url, bearer_env: 'RE_TEST_TOKEN' },
        interval_hours: 24,
        redact_operator_text: true,
      },
    }));
  }

  test('200 → success, state stamped, bearer token sent', withHermitDir(async (hermitDir) => {
    let seenAuth: string | null = null;
    const server = Bun.serve({ port: 0, fetch: (req) => { seenAuth = req.headers.get('authorization'); return new Response('ok', { status: 200 }); } });
    try {
      seedTelemetryConfig(hermitDir, `http://127.0.0.1:${server.port}`);
      const r = await runScript('report-export.ts', { args: [hermitDir], env: { RE_TEST_TOKEN: 'secret-token-xyz' } });
      expect(r.exitCode).toBe(0);
      expect(seenAuth as string | null).toBe('Bearer secret-token-xyz');
      const state = readState(hermitDir, 'telemetry', 'last-export.json');
      expect(state.consecutive_failures).toBe(0);
      expect(typeof state.last_success_at).toBe('string');
    } finally {
      server.stop(true);
    }
  }), 20000);

  test('401 → failure, spooled, token/url never in stderr', withHermitDir(async (hermitDir) => {
    const server = Bun.serve({ port: 0, fetch: () => new Response('unauthorized', { status: 401 }) });
    try {
      seedTelemetryConfig(hermitDir, `http://127.0.0.1:${server.port}`);
      const r = await runScript('report-export.ts', { args: [hermitDir], env: { RE_TEST_TOKEN: 'secret-token-xyz' } });
      expect(r.exitCode).toBe(1);
      expect(r.stderr).toContain('HTTP 401');
      expect(r.stderr).not.toContain('secret-token-xyz');
      expect(r.stderr).not.toContain('127.0.0.1');
      expect(fs.readdirSync(statePath(hermitDir, 'telemetry', 'spool')).length).toBe(1);
    } finally {
      server.stop(true);
    }
  }), 20000);

  test('timeout → failure classified as timeout', withHermitDir(async (hermitDir) => {
    const server = Bun.serve({ port: 0, fetch: () => new Promise(() => {}) });
    try {
      seedTelemetryConfig(hermitDir, `http://127.0.0.1:${server.port}`);
      const r = await runScript('report-export.ts', {
        args: [hermitDir],
        env: { RE_TEST_TOKEN: 'secret-token-xyz', HERMIT_TELEMETRY_TIMEOUT_MS: '250' },
      });
      expect(r.exitCode).toBe(1);
      expect(r.stderr).toContain('timeout');
    } finally {
      server.stop(true);
    }
  }), 20000);

  test('--print builds the bundle without posting or stamping state', withHermitDir(async (hermitDir) => {
    seedTelemetryConfig(hermitDir, 'https://example.invalid/webhook');
    const r = await runScript('report-export.ts', { args: [hermitDir, '--print'] });
    expect(r.exitCode).toBe(0);
    const bundle = JSON.parse(r.stdout);
    expect(bundle.schema_version).toBe(1);
    expect(fs.existsSync(statePath(hermitDir, 'telemetry', 'last-export.json'))).toBe(false);
  }), 20000);

  test('not enabled/configured → exits 1 without spooling or raising an alert', withHermitDir(async (hermitDir) => {
    fs.writeFileSync(path.join(hermitDir, 'config.json'), JSON.stringify({ telemetry_export: { enabled: false } }));
    const r = await runScript('report-export.ts', { args: [hermitDir] });
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain('not enabled/configured');
    expect(fs.existsSync(statePath(hermitDir, 'telemetry'))).toBe(false);
    expect(fs.existsSync(statePath(hermitDir, 'alert-state.json'))).toBe(false);
  }), 20000);
});
