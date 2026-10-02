// Tests for lib/context-signal.ts — the shared prompt-token signal selection used
// by hermitd-watchdog's hygiene tiers and doctor-check's context tripwire. Pure
// functions, so in-process import is safe (no load-time path resolution).

import { describe, test, expect } from 'bun:test';
import { promptTokensOf, isEstimateOnly, compactibleTokens, ASSUMED_SURFACE_TOKENS } from '../scripts/lib/context-signal';

describe('promptTokensOf preference order', () => {
  test('prefers last_call_prompt_tokens over max_prompt_tokens', () => {
    expect(promptTokensOf({ last_call_prompt_tokens: 90_000, max_prompt_tokens: 170_000 })).toBe(90_000);
  });

  test('falls back to max_prompt_tokens when last_call is absent', () => {
    expect(promptTokensOf({ max_prompt_tokens: 170_000 })).toBe(170_000);
  });

  test('legacy multi-call entry averages the summed total', () => {
    const entry = { input_tokens: 6000, cache_write_tokens: 0, cache_read_tokens: 0, api_calls: 3 };
    expect(promptTokensOf(entry)).toBe(2000);
  });

  test('legacy single-call entry uses the raw sum', () => {
    const entry = { input_tokens: 100, cache_write_tokens: 200, cache_read_tokens: 700, api_calls: 1 };
    expect(promptTokensOf(entry)).toBe(1000);
  });
});

describe('isEstimateOnly', () => {
  test('true only for multi-call entries lacking max_prompt_tokens', () => {
    expect(isEstimateOnly({ api_calls: 3 })).toBe(true);
    expect(isEstimateOnly({ api_calls: 1 })).toBe(false);
    expect(isEstimateOnly({ api_calls: 3, max_prompt_tokens: 5 })).toBe(false);
  });
});

describe('compactibleTokens', () => {
  test('subtracts a recorded surface upper bound', () => {
    expect(compactibleTokens({ last_call_prompt_tokens: 160_000 }, 65_000)).toBe(95_000);
  });

  test('null surface subtracts the 50k cold-start assumption', () => {
    expect(ASSUMED_SURFACE_TOKENS).toBe(50_000);
    expect(compactibleTokens({ last_call_prompt_tokens: 160_000 }, null)).toBe(110_000);
  });

  test('clamps at zero when the prompt is smaller than the recorded surface', () => {
    // Normal right after a /clear or on a fresh session. A raw negative would reach the
    // doctor digest and watchdog telemetry as apparent corruption; both gates compare
    // with < / <=, so clamping cannot change a decision.
    expect(compactibleTokens({ last_call_prompt_tokens: 40_000 }, 65_000)).toBe(0);
    expect(compactibleTokens({ last_call_prompt_tokens: 1_000 }, null)).toBe(0);
  });

  test('cold-start parity: old 150k absolute default == 100k threshold + assumed surface', () => {
    // A fresh hermit (no surface recorded) must cross the new 100k compactible
    // threshold at the same absolute size the old 150k total default fired at.
    expect(compactibleTokens({ last_call_prompt_tokens: 150_000 }, null)).toBe(100_000);
    expect(compactibleTokens({ last_call_prompt_tokens: 150_001 }, null)).toBeGreaterThan(100_000);
  });
});
