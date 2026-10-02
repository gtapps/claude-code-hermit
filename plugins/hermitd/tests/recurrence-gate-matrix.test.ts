// Static consistency test (bun test port of recurrence-gate-matrix.sh): verifies
// that every recurrence gate file contains the scheduled-check / operator-request
// bypass phrases and that each gate documents the canonical suppress codes it
// can emit.
//
// What this catches: the ROP-001 class of bug where a bypass is added to one
// gate file but not the others.
//
// Usage: bun test tests/recurrence-gate-matrix.test.ts   (from the plugin root)

import { describe, test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';

import { PLUGIN_ROOT } from './helpers/run';

const read = (...p: string[]) => fs.readFileSync(path.join(PLUGIN_ROOT, ...p), 'utf-8');

const judge = read('agents', 'reflection-judge.md');
const triage = read('agents', 'proposal-triage.md');
const proposalCreate = read('skills', 'proposal-create', 'SKILL.md');
const reflect = read('skills', 'reflect', 'SKILL.md');

// label mirrors the bash script: basename(dirname)/basename
const GATE_FILES = [
  { label: 'agents/reflection-judge.md', content: judge },
  { label: 'agents/proposal-triage.md', content: triage },
  { label: 'proposal-create/SKILL.md', content: proposalCreate },
];

// ── 1. Exception coverage ────────────────────────────────────────────────────

describe('recurrence gate: exception coverage', () => {
  for (const { label, content } of GATE_FILES) {
    test(`[${label}]: 'scheduled-check' bypass phrase present`, () => {
      expect(content).toContain('scheduled-check');
    });

    test(`[${label}]: 'operator-request' bypass phrase present`, () => {
      expect(content).toContain('operator-request');
    });
  }

  // proposal-triage must also document the current-session upstream-trust rule
  test("[agents/proposal-triage.md]: 'current-session' upstream-trust phrase present", () => {
    expect(triage).toContain('current-session');
  });
});

// ── 2. Canonical suppress code vocabulary ───────────────────────────────────

describe('recurrence gate: canonical suppress code vocabulary', () => {
  // reflection-judge owns the session-evidence codes
  for (const code of ['no-evidence', 'no-sessions']) {
    test(`[agents/reflection-judge.md]: canonical suppress code '${code}' documented`, () => {
      expect(judge).toContain(code);
    });
  }

  // proposal-triage owns the three-condition codes
  for (const code of ['weak-recurrence', 'weak-consequence', 'not-actionable']) {
    test(`[agents/proposal-triage.md]: canonical suppress code '${code}' documented`, () => {
      expect(triage).toContain(code);
    });
  }

  // proposal-triage status-aware dedup (#159): closed-status branch must demote
  // accepted/resolved matches to closest_prop and never to DUPLICATE; the
  // "same problem" guard must explicitly reject shared-infrastructure suppression.
  test('[agents/proposal-triage.md]: closed-status (accepted/resolved) dedup branch present', () => {
    expect(triage).toContain('`accepted` or `resolved`');
  });

  test("[agents/proposal-triage.md]: 'Shared infrastructure' same-problem guard present", () => {
    expect(triage).toContain('Shared infrastructure');
  });
});

// ── 3. DOWNGRADE grammar ────────────────────────────────────────────────────

describe('recurrence gate: DOWNGRADE grammar', () => {
  // Only reflection-judge emits DOWNGRADE; proposal-triage output is CREATE|SUPPRESS|DUPLICATE
  test('[agents/reflection-judge.md]: DOWNGRADE example in verdict grammar', () => {
    expect(judge).toContain('DOWNGRADE');
  });

  for (const term of ['closed_via', 'auto-closed-evidence']) {
    test(`[agents/reflection-judge.md]: '${term}' provenance token present`, () => {
      expect(judge).toContain(term);
    });
  }
});

// ── 4. Verdict-tag coverage in judge output examples ────────────────────────

describe('recurrence gate: verdict-tag coverage', () => {
  for (const tag of ['current-session', 'scheduled-check', 'operator-request']) {
    test(`[agents/reflection-judge.md]: example verdict line with source tag '(${tag})'`, () => {
      expect(judge).toContain(`(${tag})`);
    });
  }
});

// ── 5. External-origin quarantine vocabulary ─────────────────────────────────

describe('external-origin quarantine: vocabulary coverage', () => {
  // reflect is the tagging site — must define external-content and own-work
  test("[skills/reflect/SKILL.md]: 'external-content' quarantine vocabulary present", () => {
    expect(reflect).toContain('external-content');
  });

  // All gate files must document Evidence Origin / external-content
  for (const { label, content } of GATE_FILES) {
    test(`[${label}]: 'external-content' quarantine vocabulary present`, () => {
      expect(content).toContain('external-content');
    });

    test(`[${label}]: 'Evidence Origin' field documentation present`, () => {
      expect(content).toContain('Evidence Origin');
    });
  }

  test("[agents/reflection-judge.md]: 'quarantine' escalation reason in verdict examples", () => {
    expect(judge).toContain('quarantine');
  });
});

// ── 6. Artifact-cited evidence vocabulary ────────────────────────────────────

describe('artifact-cited evidence: vocabulary coverage', () => {
  // reflect (ledger graduation + candidate format) and judge (verification +
  // covered-by-memory exemption) must share the Artifact: grammar and the
  // observations.jsonl path. Note: 'Artifact:' is NOT a new Evidence Source value —
  // do not add it to the source-value checks above.
  const SHARED = [
    { label: 'skills/reflect/SKILL.md', content: reflect },
    { label: 'agents/reflection-judge.md', content: judge },
  ];

  for (const { label, content } of SHARED) {
    test(`[${label}]: 'Artifact:' candidate-line grammar present`, () => {
      expect(content).toContain('Artifact:');
    });

    test(`[${label}]: 'observations.jsonl' ledger path present`, () => {
      expect(content).toContain('observations.jsonl');
    });

    test(`[${label}]: 'machine-written state file' valid-artifact rule present`, () => {
      expect(content).toContain('machine-written state file');
    });
  }

  test('[agents/proposal-triage.md]: covered-by-memory exemption for ledger-graduated candidates', () => {
    expect(triage).toContain('never suppressed `covered-by-memory`');
  });

  test('[agents/reflection-judge.md]: skips §1 when Artifact cites observations.jsonl', () => {
    expect(judge).toContain('Skip §§ 0.5, 1, and 1.6');
  });

  test('[agents/reflection-judge.md]: ledger §1.4 is a bounded Grep, not a whole-file Read', () => {
    expect(judge).toContain('Never `Read` the ledger whole');
  });

  // artifact-cited vocabulary must appear in every gate file (reflect + judge
  // are also covered by the block above)
  for (const { label, content } of GATE_FILES) {
    test(`[${label}]: 'machine-written state file' artifact-cited vocabulary present`, () => {
      expect(content).toContain('machine-written state file');
    });
  }

  // procedure-capture ephemerality exception: defined in reflect, mirrored in
  // proposal-create. Triage and the judge need no clause of their own: such
  // candidates carry `Evidence Source: current-session`, and triage's condition 1
  // re-checks recurrence only for `archived-session`.
  const EPHEMERALITY_FILES = [
    { label: 'skills/reflect/SKILL.md', content: reflect },
    { label: 'proposal-create/SKILL.md', content: proposalCreate },
  ];

  test('[agents/proposal-triage.md]: condition 1 re-checks recurrence only for archived-session', () => {
    expect(triage).toContain('required only when `Evidence Source` is `archived-session`');
  });

  for (const { label, content } of EPHEMERALITY_FILES) {
    test(`[${label}]: 'ephemerality exception' procedure-capture vocabulary present`, () => {
      // bash: grep -qi (case-insensitive)
      expect(content.toLowerCase()).toContain('ephemerality exception');
    });
  }
});
