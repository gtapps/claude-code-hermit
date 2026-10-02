import { describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  auditConfigChange,
  diffLeaves,
  isSecretPath,
  ledgerPath,
  readHistory,
  SNAPSHOT_FILE,
} from '../scripts/lib/config-audit';
import { setupWorkdir } from './helpers/workdir';

function rows(stateDir: string): any[] {
  const file = ledgerPath(stateDir);
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, 'utf-8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

function withDir(fn: (stateDir: string) => void): void {
  const wd = setupWorkdir();
  try {
    fn(path.join(wd.dir, '.hermit'));
  } finally {
    wd.cleanup();
  }
}

describe('diffLeaves', () => {
  test('reports nested scalar changes by dotted path', () => {
    const changes = diffLeaves({ heartbeat: { every: '2h', enabled: true } }, { heartbeat: { every: '30m', enabled: true } });
    expect(changes).toEqual([{ path: 'heartbeat.every', old: '2h', new: '30m' }]);
  });

  test('reports additions and removals', () => {
    const changes = diffLeaves({ a: 1 }, { b: 2 });
    expect(changes.map((c) => c.path).sort()).toEqual(['a', 'b']);
    expect(changes.find((c) => c.path === 'a')!.new).toBeUndefined();
    expect(changes.find((c) => c.path === 'b')!.old).toBeUndefined();
  });

  test('treats arrays atomically', () => {
    const changes = diffLeaves({ routines: [{ id: 'a' }] }, { routines: [{ id: 'a' }, { id: 'b' }] });
    expect(changes).toHaveLength(1);
    expect(changes[0].path).toBe('routines');
  });

  test('no-op returns nothing', () => {
    expect(diffLeaves({ a: { b: 1 } }, { a: { b: 1 } })).toEqual([]);
  });
});

describe('isSecretPath', () => {
  test('redacts credential-bearing segments and all of env', () => {
    expect(isSecretPath('channels.discord.bot_token')).toBe(true);
    expect(isSecretPath('env.ANYTHING')).toBe(true);
    expect(isSecretPath('DISCORD_BOT_TOKEN')).toBe(true);
    expect(isSecretPath('api_secret')).toBe(true);
  });

  test('does not redact ordinary names that merely contain key-ish substrings', () => {
    expect(isSecretPath('turnkey')).toBe(false);
    expect(isSecretPath('keyboard.layout')).toBe(false);
    expect(isSecretPath('heartbeat.every')).toBe(false);
  });
});

describe('auditConfigChange', () => {
  test('writes one row per changed leaf with attribution', () => {
    withDir((stateDir) => {
      auditConfigChange(stateDir, { heartbeat: { every: '2h' } }, { heartbeat: { every: '30m' } }, 'settings-edit');
      const written = rows(stateDir);
      expect(written).toHaveLength(1);
      expect(written[0]).toMatchObject({
        actor: 'settings-edit',
        target: 'config.json',
        path: 'heartbeat.every',
        old: '2h',
        new: '30m',
      });
      expect(written[0].ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
      expect(written[0].session_id).toBeDefined();
    });
  });

  test('a no-op write appends nothing', () => {
    withDir((stateDir) => {
      auditConfigChange(stateDir, { always_on: true }, { always_on: true }, 'hermitd-start');
      expect(rows(stateDir)).toHaveLength(0);
    });
  });

  test('file creation records a single row, not one per default', () => {
    withDir((stateDir) => {
      auditConfigChange(stateDir, undefined, { a: 1, b: 2, c: { d: 3 } }, 'hatch-config');
      const written = rows(stateDir);
      expect(written).toHaveLength(1);
      expect(written[0]).toMatchObject({ path: '*', new: 'config created', actor: 'hatch-config' });
    });
  });

  test('secret values never reach the ledger — presence markers only', () => {
    withDir((stateDir) => {
      auditConfigChange(
        stateDir,
        { env: { DISCORD_BOT_TOKEN: 'super-secret-value' } },
        { env: {} },
        'apply-settings',
        '.claude/settings.local.json',
      );
      const written = rows(stateDir);
      expect(written).toHaveLength(1);
      expect(written[0]).toMatchObject({ path: 'env.DISCORD_BOT_TOKEN', old: '[set]', new: '[cleared]' });
      expect(fs.readFileSync(ledgerPath(stateDir), 'utf-8')).not.toContain('super-secret-value');
    });
  });

  test('long values are capped', () => {
    withDir((stateDir) => {
      auditConfigChange(stateDir, { note: 'x' }, { note: 'y'.repeat(500) }, 'settings-edit');
      expect(String(rows(stateDir)[0].new).length).toBeLessThanOrEqual(121);
    });
  });

  test('creates the ledger with owner-only permissions', () => {
    withDir((stateDir) => {
      auditConfigChange(stateDir, { a: 1 }, { a: 2 }, 'settings-edit');
      const mode = fs.statSync(ledgerPath(stateDir)).mode & 0o777;
      expect(mode).toBe(0o600);
    });
  });

  test('prunes rows past the retention window once the head row ages out', () => {
    withDir((stateDir) => {
      const file = ledgerPath(stateDir);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const old = new Date(Date.now() - 200 * 86_400_000).toISOString().slice(0, 19) + 'Z';
      const recent = new Date(Date.now() - 2 * 86_400_000).toISOString().slice(0, 19) + 'Z';
      fs.writeFileSync(
        file,
        `${JSON.stringify({ ts: old, path: 'ancient' })}\n${JSON.stringify({ ts: recent, path: 'recent' })}\n`,
      );
      auditConfigChange(stateDir, { a: 1 }, { a: 2 }, 'settings-edit');
      const paths = rows(stateDir).map((r) => r.path);
      expect(paths).not.toContain('ancient');
      expect(paths).toContain('recent');
      expect(paths).toContain('a');
    });
  });

  test('never throws when the state dir cannot be written', () => {
    expect(() =>
      auditConfigChange('/proc/nonexistent-hermit-state', { a: 1 }, { a: 2 }, 'settings-edit'),
    ).not.toThrow();
  });

  test('does not create a hermit state dir where none exists', () => {
    const probe = fs.mkdtempSync(path.join(os.tmpdir(), 'hermit-audit-absent-'));
    try {
      const absent = path.join(probe, '.hermit');
      auditConfigChange(absent, { a: 1 }, { a: 2 }, 'apply-settings', '.claude/settings.json');
      expect(fs.existsSync(absent)).toBe(false);
    } finally {
      fs.rmSync(probe, { recursive: true, force: true });
    }
  });

  test('id-keyed arrays record added ids', () => {
    withDir((stateDir) => {
      auditConfigChange(stateDir, { routines: [{ id: 'a' }] }, { routines: [{ id: 'a' }, { id: 'b' }] }, 'settings-edit');
      const written = rows(stateDir);
      expect(written).toHaveLength(1);
      expect(written[0].path).toBe('routines');
      expect(written[0].diff).toEqual({ added: ['b'], removed: [], changed: {} });
    });
  });

  test('id-keyed arrays record removed ids', () => {
    withDir((stateDir) => {
      auditConfigChange(stateDir, { routines: [{ id: 'a' }, { id: 'b' }] }, { routines: [{ id: 'a' }] }, 'settings-edit');
      expect(rows(stateDir)[0].diff).toEqual({ added: [], removed: ['b'], changed: {} });
    });
  });

  test('id-keyed arrays record changed field names per id', () => {
    withDir((stateDir) => {
      auditConfigChange(
        stateDir,
        { routines: [{ id: 'a', schedule: '0 9 * * *' }] },
        { routines: [{ id: 'a', schedule: '0 8 * * *' }] },
        'settings-edit',
      );
      expect(rows(stateDir)[0].diff).toEqual({ added: [], removed: [], changed: { a: ['schedule'] } });
    });
  });

  test('id-keyed array reorder records no changed entries', () => {
    withDir((stateDir) => {
      auditConfigChange(
        stateDir,
        { routines: [{ id: 'a', n: 1 }, { id: 'b', n: 2 }] },
        { routines: [{ id: 'b', n: 2 }, { id: 'a', n: 1 }] },
        'settings-edit',
      );
      const written = rows(stateDir);
      expect(written).toHaveLength(1);
      expect(written[0].diff).toEqual({ added: [], removed: [], changed: {} });
    });
  });

  test('arrays without string ids get no diff', () => {
    withDir((stateDir) => {
      auditConfigChange(stateDir, { tags: ['a'] }, { tags: ['a', 'b'] }, 'settings-edit');
      expect(rows(stateDir)[0].diff).toBeUndefined();
    });
  });

  test('a member field named token never puts its value in the row', () => {
    withDir((stateDir) => {
      const secret = 'NEVER-LEAK-THIS-TOKEN-VALUE';
      auditConfigChange(
        stateDir,
        { routines: [{ id: 'a', blob: 'x'.repeat(200), token: 'before' }] },
        { routines: [{ id: 'a', blob: 'x'.repeat(200), token: secret }] },
        'settings-edit',
      );
      const row = rows(stateDir)[0];
      expect(row.diff).toEqual({ added: [], removed: [], changed: { a: ['token'] } });
      expect(JSON.stringify(row)).not.toContain(secret);
    });
  });

  function plantSnapshot(stateDir: string, ts: string): string {
    const file = path.join(stateDir, 'state', SNAPSHOT_FILE);
    fs.writeFileSync(file, JSON.stringify({ ts, to: '1.2.6', config: {} }));
    return file;
  }

  test('a live upgrade snapshot prefixes the actor on config.json writes', () => {
    withDir((stateDir) => {
      const file = plantSnapshot(stateDir, new Date().toISOString());
      auditConfigChange(stateDir, { a: 1 }, { a: 2 }, 'settings-edit');
      auditConfigChange(stateDir, { a: 2 }, { a: 3 }, 'settings-migrate:1.4.0');
      expect(rows(stateDir)[0].actor).toBe('upgrade:settings-edit');
      expect(rows(stateDir)[1].actor).toBe('upgrade:settings-migrate:1.4.0');
      expect(fs.existsSync(file)).toBe(true);
    });
  });

  test('a 25h-old snapshot does not prefix the actor', () => {
    withDir((stateDir) => {
      plantSnapshot(stateDir, new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString());
      auditConfigChange(stateDir, { a: 1 }, { a: 2 }, 'settings-edit');
      expect(rows(stateDir)[0].actor).toBe('settings-edit');
    });
  });

  test('a live snapshot does not prefix a non-config.json target', () => {
    withDir((stateDir) => {
      plantSnapshot(stateDir, new Date().toISOString());
      auditConfigChange(stateDir, { a: 1 }, { a: 2 }, 'apply-settings', '.claude/settings.json');
      expect(rows(stateDir)[0].actor).toBe('apply-settings');
    });
  });
});

describe('readHistory', () => {
  test('filters by dotted-path prefix and bounds the result', () => {
    withDir((stateDir) => {
      auditConfigChange(stateDir, { heartbeat: { every: '2h' } }, { heartbeat: { every: '30m' } }, 'settings-edit');
      auditConfigChange(stateDir, { model: 'sonnet' }, { model: 'opus' }, 'settings-edit');
      expect(readHistory(stateDir).map((r) => r.path)).toEqual(['heartbeat.every', 'model']);
      expect(readHistory(stateDir, 'heartbeat').map((r) => r.path)).toEqual(['heartbeat.every']);
      expect(readHistory(stateDir, undefined, 1)).toHaveLength(1);
    });
  });

  test('returns nothing when the ledger is absent', () => {
    withDir((stateDir) => {
      expect(readHistory(stateDir)).toEqual([]);
    });
  });
});
