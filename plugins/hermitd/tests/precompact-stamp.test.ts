// PreCompact stamps the resident reset boundary without writing task prose.

import { describe, test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { runScript } from './helpers/run';
import { markGuest } from '../scripts/lib/guest-marker';

function makeDir(): string {
  const hermitDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hermit-precompact-'));
  fs.mkdirSync(path.join(hermitDir, 'state'), { recursive: true });
  fs.writeFileSync(path.join(hermitDir, 'state', 'runtime.json'), JSON.stringify({ cc_session_id: 'resident' }));
  fs.writeFileSync(path.join(hermitDir, 'config.json'), JSON.stringify({ timezone: 'UTC' }), 'utf-8');
  return hermitDir;
}

async function runHook(stdin: string, hermitDir: string) {
  return runScript('precompact-stamp.ts', { stdin, env: { AGENT_DIR: hermitDir } });
}

describe('precompact-stamp: valid PreCompact payloads', () => {
  test('trigger:"auto" stamps the reset boundary, empty stdout, exit 0', async () => {
    const hermitDir = makeDir();
    try {
      const runtimeFile = path.join(hermitDir, 'state', 'runtime.json');
      const result = await runHook(JSON.stringify({ hook_event_name: 'PreCompact', trigger: 'auto' }), hermitDir);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe('');
      const runtimeText = fs.readFileSync(runtimeFile, 'utf-8');
      expect(JSON.parse(runtimeText).last_context_reset_at).toBeDefined();
    } finally {
      fs.rmSync(hermitDir, { recursive: true, force: true });
    }
  });

  test('trigger:"manual" stamps the reset boundary, empty stdout, exit 0', async () => {
    const hermitDir = makeDir();
    try {
      const runtimeFile = path.join(hermitDir, 'state', 'runtime.json');
      const result = await runHook(JSON.stringify({ hook_event_name: 'PreCompact', trigger: 'manual' }), hermitDir);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe('');
      const runtimeText = fs.readFileSync(runtimeFile, 'utf-8');
      expect(JSON.parse(runtimeText).last_context_reset_at).toBeDefined();
    } finally {
      fs.rmSync(hermitDir, { recursive: true, force: true });
    }
  });
});

// This stamp stops the watchdog
// acting on a cost entry that describes the context this compaction just replaced. For an
// operator-typed or native-auto compaction it is the ONLY signal — the watchdog's own
// stamps cover the compactions it initiated.
describe('precompact-stamp: machine-readable reset stamp', () => {
  function runtimePath(hermitDir: string): string {
    return path.join(hermitDir, 'state', 'runtime.json');
  }

  function seedRuntime(hermitDir: string): void {
    fs.mkdirSync(path.join(hermitDir, 'state'), { recursive: true });
    fs.writeFileSync(runtimePath(hermitDir),
      JSON.stringify({ cc_session_id: 'resident' }), 'utf-8');
  }

  test('a real compaction stamps last_context_reset_at without disturbing runtime state', async () => {
    const hermitDir = makeDir();
    try {
      seedRuntime(hermitDir);
      const before = new Date().toISOString();
      const result = await runHook(JSON.stringify({ hook_event_name: 'PreCompact', trigger: 'manual' }), hermitDir);
      expect(result.exitCode).toBe(0);
      const runtime = JSON.parse(fs.readFileSync(runtimePath(hermitDir), 'utf-8'));
      expect(runtime.last_context_reset_at >= before).toBe(true);
      expect(runtime.cc_session_id).toBe('resident');
    } finally {
      fs.rmSync(hermitDir, { recursive: true, force: true });
    }
  });

  test('an unrecognized payload writes no reset stamp', async () => {
    const hermitDir = makeDir();
    try {
      seedRuntime(hermitDir);
      await runHook(JSON.stringify({ hook_event_name: 'PreCompact', trigger: 'bogus' }), hermitDir);
      const runtime = JSON.parse(fs.readFileSync(runtimePath(hermitDir), 'utf-8'));
      expect(runtime.last_context_reset_at).toBeUndefined();
    } finally {
      fs.rmSync(hermitDir, { recursive: true, force: true });
    }
  });

  test('a missing runtime.json fails open with exit 0', async () => {
    const hermitDir = makeDir();
    fs.unlinkSync(runtimePath(hermitDir));
    try {
      const result = await runHook(JSON.stringify({ hook_event_name: 'PreCompact', trigger: 'auto' }), hermitDir);
      expect(result.exitCode).toBe(0);
      expect(fs.existsSync(runtimePath(hermitDir))).toBe(false);
    } finally {
      fs.rmSync(hermitDir, { recursive: true, force: true });
    }
  });
});

describe('precompact-stamp: no-op on anything that is not a genuine PreCompact payload', () => {
  test('malformed stdin: no write, no stdout, exit 0', async () => {
    const hermitDir = makeDir();
    try {
      const runtimeFile = path.join(hermitDir, 'state', 'runtime.json');
      const before = fs.readFileSync(runtimeFile, 'utf-8');
      const result = await runHook('not json{{{', hermitDir);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe('');
      expect(fs.readFileSync(runtimeFile, 'utf-8')).toBe(before);
    } finally {
      fs.rmSync(hermitDir, { recursive: true, force: true });
    }
  });

  test('empty stdin: no write, no stdout, exit 0', async () => {
    const hermitDir = makeDir();
    try {
      const runtimeFile = path.join(hermitDir, 'state', 'runtime.json');
      const before = fs.readFileSync(runtimeFile, 'utf-8');
      const result = await runHook('', hermitDir);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe('');
      expect(fs.readFileSync(runtimeFile, 'utf-8')).toBe(before);
    } finally {
      fs.rmSync(hermitDir, { recursive: true, force: true });
    }
  });

  test('wrong hook_event_name: no write', async () => {
    const hermitDir = makeDir();
    try {
      const runtimeFile = path.join(hermitDir, 'state', 'runtime.json');
      const before = fs.readFileSync(runtimeFile, 'utf-8');
      const result = await runHook(JSON.stringify({ hook_event_name: 'SessionStart', trigger: 'auto' }), hermitDir);
      expect(result.exitCode).toBe(0);
      expect(fs.readFileSync(runtimeFile, 'utf-8')).toBe(before);
    } finally {
      fs.rmSync(hermitDir, { recursive: true, force: true });
    }
  });

  test('invalid trigger value: no write', async () => {
    const hermitDir = makeDir();
    try {
      const runtimeFile = path.join(hermitDir, 'state', 'runtime.json');
      const before = fs.readFileSync(runtimeFile, 'utf-8');
      const result = await runHook(JSON.stringify({ hook_event_name: 'PreCompact', trigger: 'bogus' }), hermitDir);
      expect(result.exitCode).toBe(0);
      expect(fs.readFileSync(runtimeFile, 'utf-8')).toBe(before);
    } finally {
      fs.rmSync(hermitDir, { recursive: true, force: true });
    }
  });

  test('missing trigger: no write', async () => {
    const hermitDir = makeDir();
    try {
      const runtimeFile = path.join(hermitDir, 'state', 'runtime.json');
      const before = fs.readFileSync(runtimeFile, 'utf-8');
      const result = await runHook(JSON.stringify({ hook_event_name: 'PreCompact' }), hermitDir);
      expect(result.exitCode).toBe(0);
      expect(fs.readFileSync(runtimeFile, 'utf-8')).toBe(before);
    } finally {
      fs.rmSync(hermitDir, { recursive: true, force: true });
    }
  });
});

// Guests must not stamp the resident context.
describe('precompact-stamp: guest session', () => {
  function seedRuntime(hermitDir: string): void {
    fs.mkdirSync(path.join(hermitDir, 'state'), { recursive: true });
    fs.writeFileSync(path.join(hermitDir, 'state', 'runtime.json'),
      JSON.stringify({ cc_session_id: 'resident' }), 'utf-8');
  }

  test('a guest compaction never stamps the resident runtime', async () => {
    const hermitDir = makeDir();
    try {
      seedRuntime(hermitDir);
      markGuest(path.join(hermitDir, 'state'), 'sess-guest');
      const result = await runHook(
        JSON.stringify({ hook_event_name: 'PreCompact', trigger: 'auto', session_id: 'sess-guest' }),
        hermitDir,
      );
      expect(result.exitCode).toBe(0);
      const runtime = JSON.parse(fs.readFileSync(path.join(hermitDir, 'state', 'runtime.json'), 'utf-8'));
      expect(runtime.last_context_reset_at).toBeUndefined();
    } finally {
      fs.rmSync(hermitDir, { recursive: true, force: true });
    }
  });

  test('a marker for another session leaves this resident stamped', async () => {
    const hermitDir = makeDir();
    try {
      seedRuntime(hermitDir);
      markGuest(path.join(hermitDir, 'state'), 'sess-somebody-else');
      const result = await runHook(
        JSON.stringify({ hook_event_name: 'PreCompact', trigger: 'auto', session_id: 'sess-resident' }),
        hermitDir,
      );
      expect(result.exitCode).toBe(0);
      const runtime = JSON.parse(fs.readFileSync(path.join(hermitDir, 'state', 'runtime.json'), 'utf-8'));
      expect(runtime.last_context_reset_at).toBeDefined();
    } finally {
      fs.rmSync(hermitDir, { recursive: true, force: true });
    }
  });
});
