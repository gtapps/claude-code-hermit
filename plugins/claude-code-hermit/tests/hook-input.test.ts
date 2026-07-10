// Unit tests for scripts/lib/hook-input.ts — the shared stdin-drain +
// profile-parsing helper for PreToolUse hooks. Pure exported helpers, so
// tested in-process (not via runScript) per the repo convention (see
// tests/hooks.contract.test.ts header). readHookInput takes an injectable
// source since the real process.stdin isn't mockable in-process.
//
// Usage: bun test tests/hook-input.test.ts   (from the plugin root)

import { describe, test, expect } from 'bun:test';
import { readHookInput, hookProfile, isStrictProfile, MAX_HOOK_STDIN, OVERSIZE } from '../scripts/lib/hook-input';

async function* chunksOf(...parts: string[]): AsyncIterable<string> {
  for (const p of parts) yield p;
}

describe('readHookInput', () => {
  test('valid JSON — parses', async () => {
    const result = await readHookInput(MAX_HOOK_STDIN, chunksOf('{"tool_name":"Bash"}'));
    expect(result).toEqual({ tool_name: 'Bash' });
  });

  test('split across chunks — reassembles', async () => {
    const result = await readHookInput(MAX_HOOK_STDIN, chunksOf('{"tool_name"', ':"Bash"}'));
    expect(result).toEqual({ tool_name: 'Bash' });
  });

  test('empty stdin — null', async () => {
    const result = await readHookInput(MAX_HOOK_STDIN, chunksOf());
    expect(result).toBeNull();
  });

  test('whitespace-only stdin — null', async () => {
    const result = await readHookInput(MAX_HOOK_STDIN, chunksOf('   \n  '));
    expect(result).toBeNull();
  });

  test('malformed JSON — null', async () => {
    const result = await readHookInput(MAX_HOOK_STDIN, chunksOf('{not json'));
    expect(result).toBeNull();
  });

  test('payload exactly at cap — parses', async () => {
    const payload = JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'x'.repeat(50) } });
    const result = await readHookInput(payload.length, chunksOf(payload));
    expect(result).toEqual(JSON.parse(payload));
  });

  test('payload over cap — OVERSIZE sentinel, but generator fully drained', async () => {
    let yielded = 0;
    async function* oversized(): AsyncIterable<string> {
      yielded++; yield 'x'.repeat(50);
      yielded++; yield 'y'.repeat(50);
    }
    const result = await readHookInput(10, oversized());
    expect(result).toBe(OVERSIZE);
    expect(yielded).toBe(2); // drained to completion despite exceeding cap early
  });

  test('source throws mid-stream — null (fail-open)', async () => {
    async function* throwing(): AsyncIterable<string> {
      yield '{"tool_name"';
      throw new Error('boom');
    }
    const result = await readHookInput(MAX_HOOK_STDIN, throwing());
    expect(result).toBeNull();
  });
});

describe('hookProfile / isStrictProfile', () => {
  const ORIGINAL = process.env.AGENT_HOOK_PROFILE;
  function withProfile(value: string | undefined, fn: () => void) {
    if (value === undefined) delete process.env.AGENT_HOOK_PROFILE;
    else process.env.AGENT_HOOK_PROFILE = value;
    try { fn(); } finally {
      if (ORIGINAL === undefined) delete process.env.AGENT_HOOK_PROFILE;
      else process.env.AGENT_HOOK_PROFILE = ORIGINAL;
    }
  }

  test('unset — standard, not strict', () => {
    withProfile(undefined, () => {
      expect(hookProfile()).toBe('standard');
      expect(isStrictProfile()).toBe(false);
    });
  });

  test('"strict" — strict', () => {
    withProfile('strict', () => {
      expect(isStrictProfile()).toBe(true);
    });
  });

  test('"Strict" (capitalized) — still strict (case-insensitive)', () => {
    withProfile('Strict', () => {
      expect(isStrictProfile()).toBe(true);
    });
  });

  test('" strict  " (whitespace) — still strict', () => {
    withProfile(' strict  ', () => {
      expect(isStrictProfile()).toBe(true);
    });
  });

  test('"minimal" — not strict', () => {
    withProfile('minimal', () => {
      expect(isStrictProfile()).toBe(false);
    });
  });
});
