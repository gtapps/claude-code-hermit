// Shared test helpers — TS equivalents of the pytest conftest.py fixtures
// (make_ha_root, make_ha_config, make_mock_config) and helpers.py
// (write_artifact), plus a capsys equivalent for CLI tests.
//
// Each test file that uses tmpPath()/makeHaRoot()/... must register
// `afterAll(cleanupTmp)` — afterEach would drain dirs still in use by
// sibling tests running concurrently under `bun test --concurrent`.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AppConfig } from '../src/config';

const tmpDirs: string[] = [];

export function tmpPath(prefix = 'ha-test-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

export function cleanupTmp(): void {
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
}

/** conftest make_ha_root: a minimal HA snapshot root. */
export function makeHaRoot(inventory: Record<string, any> | null = null): string {
  const root = tmpPath();
  const raw = join(root, '.claude-code-hermit', 'raw');
  mkdirSync(raw, { recursive: true });
  const snapshot = inventory || {
    entity_index: {
      'light.living_room': { entity_id: 'light.living_room', state: 'off' },
    },
  };
  writeFileSync(join(raw, 'snapshot-ha-normalized-latest.json'), JSON.stringify(snapshot), 'utf8');
  return root;
}

/** conftest make_ha_config: writes ha_safety_mode to .claude-code-hermit/config.json. */
export function makeHaConfig(mode: string, root: string | null = null): string {
  const base = root ?? tmpPath();
  const cfgDir = join(base, '.claude-code-hermit');
  mkdirSync(cfgDir, { recursive: true });
  writeFileSync(join(cfgDir, 'config.json'), `{"ha_safety_mode": "${mode}"}`, 'utf8');
  return base;
}

export function makeHaConfigWith(mode: string, extra: Record<string, unknown>): string {
  const base = tmpPath();
  const cfgDir = join(base, '.claude-code-hermit');
  mkdirSync(cfgDir, { recursive: true });
  writeFileSync(join(cfgDir, 'config.json'), JSON.stringify({ ha_safety_mode: mode, ...extra }), 'utf8');
  return base;
}

/** conftest make_mock_config: a real AppConfig rooted at a fresh tmp dir. */
export function makeMockConfig(url = 'http://homeassistant.local:8123'): AppConfig {
  return new AppConfig(tmpPath(), url, null, null, 'fake-token', 5, 0);
}

/** helpers.py write_artifact. */
export function writeArtifact(directory: string, content: string, name = 'automation.yaml'): string {
  const path = join(directory, name);
  writeFileSync(path, content, 'utf8');
  return path;
}

export interface FakeCalls {
  get: string[];
  post: Array<[string, unknown]>;
  delete: string[];
}

export interface FakeClientHandlers {
  get?: (path: string) => any;
  post?: (path: string, payload: unknown) => any;
  del?: (path: string) => any;
  postText?: (path: string, payload: unknown) => string;
  getText?: (path: string) => string;
  getStates?: () => any;
  getHistory?: (entityIds: string[], start: Date, end: Date) => any;
}

/**
 * MagicMock-style client: records calls, delegates to optional handlers
 * (handlers may throw to emulate side_effect exceptions).
 */
export function fakeClient(handlers: FakeClientHandlers = {}) {
  const calls: FakeCalls = { get: [], post: [], delete: [] };
  return {
    baseUrlSource: 'single',
    calls,
    async get(path: string): Promise<any> {
      calls.get.push(path);
      return handlers.get ? handlers.get(path) : {};
    },
    async post(path: string, payload: Record<string, unknown> | null = null): Promise<any> {
      calls.post.push([path, payload]);
      return handlers.post ? handlers.post(path, payload) : {};
    },
    async delete(path: string): Promise<any> {
      calls.delete.push(path);
      return handlers.del ? handlers.del(path) : {};
    },
    async getText(path: string): Promise<string> {
      calls.get.push(path);
      return handlers.getText ? handlers.getText(path) : '';
    },
    async postText(path: string, payload: Record<string, unknown> | null = null): Promise<string> {
      calls.post.push([path, payload]);
      return handlers.postText ? handlers.postText(path, payload) : '';
    },
    async getStates(): Promise<Array<Record<string, any>>> {
      if (handlers.getStates) return handlers.getStates();
      return this.get('/api/states');
    },
    async callService(domain: string, service: string, data: Record<string, unknown>): Promise<any> {
      return this.post(`/api/services/${domain}/${service}`, data);
    },
    async getHistory(
      entityIds: string[],
      start: Date,
      end: Date,
    ): Promise<Record<string, Array<Record<string, any>>>> {
      return handlers.getHistory ? handlers.getHistory(entityIds, start, end) : {};
    },
  };
}

export type FakeClient = ReturnType<typeof fakeClient>;

/** Minimal subprocess env for hook-runner tests — keeps only PATH/HOME/TMPDIR/LANG/LC_ALL. */
export function cleanEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of ['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL']) {
    const v = process.env[key];
    if (v !== undefined) env[key] = v;
  }
  return env;
}

export interface CapturedRun {
  code: number;
  out: string;
  err: string;
}

/** capsys equivalent: capture console.log/console.error around an async run. */
export async function captureOutput(run: () => Promise<number>): Promise<CapturedRun> {
  const outLines: string[] = [];
  const errLines: string[] = [];
  const origLog = console.log;
  const origErr = console.error;
  console.log = (...parts: unknown[]) => outLines.push(parts.join(' '));
  console.error = (...parts: unknown[]) => errLines.push(parts.join(' '));
  try {
    const code = await run();
    return {
      code,
      out: outLines.length ? outLines.join('\n') + '\n' : '',
      err: errLines.length ? errLines.join('\n') + '\n' : '',
    };
  } finally {
    console.log = origLog;
    console.error = origErr;
  }
}
