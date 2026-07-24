// CLAUDE-APPEND budget + relocation-anchor test.
//
// The CLAUDE-APPEND block is injected into every hatched operator project's
// CLAUDE.md / CLAUDE.local.md, so it is re-paid on every session load AND every
// subagent dispatch (subagents inherit CLAUDE.md). This test locks in the
// token-efficiency trim (v-token-efficiency): it caps the block size, guards the
// per-skill description tax against creep, and — critically — asserts that every
// load-bearing anchor and every relocation target still exists. If a pointer in
// the trimmed APPEND ever dangles (e.g. the notification protocol was removed
// from channel-responder), this fails instead of silently losing behavior.
//
// Usage: bun test tests/claude-append-budget.test.ts   (from the plugin root)

import { describe, test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';

import { PLUGIN_ROOT } from './helpers/run';

const APPEND_PATH = path.join(PLUGIN_ROOT, 'state-templates', 'CLAUDE-APPEND.md');
const CHANNEL_RESPONDER = path.join(PLUGIN_ROOT, 'skills', 'channel-responder', 'SKILL.md');
const WATCH_SKILL = path.join(PLUGIN_ROOT, 'skills', 'watch', 'SKILL.md');
const SKILLS_DIR = path.join(PLUGIN_ROOT, 'skills');

const append = fs.readFileSync(APPEND_PATH, 'utf8');

describe('CLAUDE-APPEND size budget', () => {
  test('block stays under the post-trim ceiling', () => {
    // Pre-trim was 10,632 B. Trimmed to ~6,836 B, then held near 7,000 until the
    // auto-mode classifier's "Sanctioned egress" safety bullet (~7,164 B). Raised
    // to 7,600 for the "Channel voice" rule (~7,532 B), then to 7,700 for the
    // `ROUTINE_DUE` notification-handler line (~7,638 B), then to 7,850 for the
    // unified `channel-send.ts --notice` proactive-notify mechanism replacing the
    // model-side resolver + reply-tool instruction (~7,795 B) — all deliberate,
    // reviewed additions, not creep. Keep a small margin above the current size
    // without reopening the door to unbounded re-bloat.
    expect(Buffer.byteLength(append, 'utf8')).toBeLessThanOrEqual(7850);
  });
});

describe('CLAUDE-APPEND load-bearing anchors', () => {
  // These strings are referenced by other skills/scripts by name, or are the
  // literal invocation an operator-notification path executes. Removing any of
  // them breaks a cross-reference — the trim must preserve all of them.
  const anchors = [
    '<!-- claude-code-hermit: Session Discipline -->', // evolve marker (block replace)
    '## Operator Notification',                        // referenced by reflect + hermit-evolve
    '## Watches',
    '## Knowledge Discipline',
    '## Rules',
    'channel-send.ts .claude-code-hermit --notice', // the unified proactive-notify invocation
    'HEARTBEAT_EVALUATE',                              // heartbeat notification trigger
    'ROUTINE_DUE',                                      // routine-monitor notification trigger
    'covered-by-memory',                               // canonical memory-suppression code
  ];
  for (const a of anchors) {
    test(`contains anchor: ${a}`, () => {
      expect(append.includes(a)).toBe(true);
    });
  }
});

describe('relocation targets received the moved content', () => {
  test('channel-responder carries the outbound notification protocol', () => {
    const cr = fs.readFileSync(CHANNEL_RESPONDER, 'utf8');
    expect(cr.includes('Outbound notification protocol')).toBe(true);
    // the protocol body must route through the unified --notice mechanism, not a
    // model-side resolver + reply-tool call.
    expect(cr.includes('channel-send.ts')).toBe(true);
    expect(cr.includes('--notice')).toBe(true);
  });

  test('watch skill carries the authoring rules (Monitor params)', () => {
    const w = fs.readFileSync(WATCH_SKILL, 'utf8');
    expect(w.includes('Monitor tool params are required')).toBe(true);
    expect(w.includes('|| true')).toBe(true); // poll-loop resilience rule relocated in
  });

  test('APPEND points to channel-responder for the full protocol', () => {
    expect(append.includes('channel-responder')).toBe(true);
  });
});

describe('per-skill description tax (creep guard)', () => {
  test('sum of frontmatter description bytes stays bounded', () => {
    let total = 0;
    for (const dir of fs.readdirSync(SKILLS_DIR)) {
      const skillPath = path.join(SKILLS_DIR, dir, 'SKILL.md');
      if (!fs.existsSync(skillPath)) continue;
      const body = fs.readFileSync(skillPath, 'utf8');
      const m = body.match(/^description:\s*(.*)$/m);
      if (m) total += Buffer.byteLength(m[1], 'utf8');
    }
    // Current post-trim total ~7,586 B. Ceiling guards against re-bloating
    // descriptions (which are always-loaded and inherited by every subagent).
    expect(total).toBeLessThanOrEqual(7800);
  });
});
