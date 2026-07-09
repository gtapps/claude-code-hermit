// Channel-ask contract test (PROP-017).
//
// Every core skill is reachable from channel-responder's §2 classification
// table (slash-command passthrough alone makes any skill reachable), so a
// channel-tagged turn must never strand on a terminal-shaped ask. A skill
// either carries the Step-0 "channel reply" marker (and routes its asks
// through the reply tool / channel-safe ask bridge accordingly), or it must
// contain no AskUserQuestion call and no interactive "Ask" line (both the
// colon form `Ask:` and the imperative prose form `Ask the operator …`).
//
// Fails the build the moment a new skill adds an ask (in any of those spellings)
// without also adding the Step-0 marker — the drift guard this proposal's item 5
// asks for. Coverage note: this is a static string/regex scan, so an ask phrased
// without a leading `Ask` token or the literal `AskUserQuestion` (e.g. "prompt the
// operator …") would slip through; it also asserts only that the marker is
// present, not that every ask is wired through the bridge.
//
// Usage: bun test tests/channel-ask-contract.test.ts   (from the plugin root)

import { describe, test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';

import { PLUGIN_ROOT } from './helpers/run';

const SKILLS_DIR = path.join(PLUGIN_ROOT, 'skills');
const STEP0_MARKER = 'Step 0 — Channel reply';
const CHANNEL_TAG_FRAGMENT = '<channel source="';
// Matches a line-leading ask in either the colon form (`Ask:`) or the imperative
// prose form (`Ask what to add`, `Ask the operator …`). The `(?::|\s)` after `Ask`
// keeps `Asking`/`Asks` from matching.
const UNGUARDED_ASK_RE = /^\s*(?:\d+\.\s*|[a-z]\d*\.\s*|-\s*)?Ask(?::|\s)/m;

// Skills exempt from the "must bridge or have no ask" rule, with the reason
// each is exempt spelled out — this list is a deliberate exception, not a
// default, and every entry is re-verified below to still exist.
const TERMINAL_ONLY: Record<string, string> = {
  hatch: 'first-run setup wizard; channels do not exist yet when this runs',
  'channel-setup': 'configures channels; runs before any channel is usable',
  'docker-setup': 'one-time container scaffolding wizard, terminal by nature',
  'docker-security': 'one-time container hardening wizard, terminal by nature',
  'hermit-evolve': 'plugin upgrade wizard, run interactively by the maintainer',
  'channel-responder': 'owns the reply protocol itself (see its own §0 / §6)',
  // Pre-existing gap, out of scope for PROP-017 (which scoped de-strand work
  // to proposal-act + hermit-settings only). Both already have a distinct
  // non-interactive bypass (session-start's `--task` flag) that a future
  // proposal should wire channel-responder through, rather than retrofitting
  // the options[]/on_resolve bridge onto open-ended "what should I work on"
  // prompts.
  session: 'pre-existing gap — tracked as a follow-up, not PROP-017 scope',
  'session-start': 'pre-existing gap — has its own --task bypass, not PROP-017 scope',
};

function listSkillNames(): string[] {
  return fs
    .readdirSync(SKILLS_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .filter((name) => fs.existsSync(path.join(SKILLS_DIR, name, 'SKILL.md')));
}

const skillNames = listSkillNames();
const skillContent = new Map(
  skillNames.map((name) => [name, fs.readFileSync(path.join(SKILLS_DIR, name, 'SKILL.md'), 'utf-8')]),
);

describe('channel-ask contract: every channel-reachable skill guards its asks', () => {
  for (const name of skillNames) {
    if (name in TERMINAL_ONLY) continue;

    test(`${name}/SKILL.md has no unguarded ask (or carries the Step-0 marker)`, () => {
      const content = skillContent.get(name)!;
      const hasAskUserQuestion = content.includes('AskUserQuestion');
      const hasUnguardedAskLine = UNGUARDED_ASK_RE.test(content);
      const hasMarker = content.includes(STEP0_MARKER);

      if (hasAskUserQuestion || hasUnguardedAskLine) {
        expect(hasMarker).toBe(true);
      }
    });
  }
});

describe('channel-ask contract: Step-0 marker is canonical, not just a heading', () => {
  for (const name of skillNames) {
    const content = skillContent.get(name)!;
    if (!content.includes(STEP0_MARKER)) continue;

    test(`${name}/SKILL.md's Step-0 marker names the <channel source="..."> tag test`, () => {
      expect(content).toContain(CHANNEL_TAG_FRAGMENT);
    });
  }
});

describe('channel-ask contract: allowlist stays honest', () => {
  for (const name of Object.keys(TERMINAL_ONLY)) {
    test(`allowlisted skill '${name}' still exists`, () => {
      expect(fs.existsSync(path.join(SKILLS_DIR, name, 'SKILL.md'))).toBe(true);
    });
  }
});

// Suggestion cards (PROP audit §8 item 2): a static drift guard for the
// three markers a channel-facing proposal flow depends on. Same caveat as
// above — proves the text is present, not that the model obeys it at runtime.
describe('suggestion cards: channel-facing proposal vocabulary stays plain', () => {
  test('proposal-list/SKILL.md carries the Step-0 marker and a Suggestion-cards path', () => {
    const content = skillContent.get('proposal-list')!;
    expect(content).toContain(STEP0_MARKER);
    expect(content).toContain('Suggestion cards');
  });

  test('channel-responder/SKILL.md maps YES/LATER/NO replies to accept/defer/dismiss', () => {
    const content = skillContent.get('channel-responder')!;
    expect(content).toContain('`YES`');
    expect(content).toContain('`LATER`');
    expect(content).toMatch(/`NO`.*dismiss/);
  });

  test('proposal-act/SKILL.md confirms accept/defer/dismiss in plain voice on a channel-tagged turn', () => {
    const content = skillContent.get('proposal-act')!;
    expect(content).toContain('Got it — starting on Suggestion #N.');
    expect(content).toContain('Held Suggestion #N for later.');
    expect(content).toContain('Dropped Suggestion #N.');
  });
});
