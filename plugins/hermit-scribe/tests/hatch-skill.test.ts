#!/usr/bin/env bun

// Structural lint for skills/hatch/SKILL.md — grep-level checks, no runtime
// skill execution. Regression coverage for the refresh-path fix: the hatch
// used to skip on marker-presence alone, with no config write anywhere in the
// skill, so its own frontmatter promise ("re-run to refresh after an
// upgrade") was never true. It now stamps _hermit_versions and version-gates
// the block refresh the same way the other domain hatches do.

import { readFileSync } from "node:fs";
import path from "node:path";

const HATCH_SKILL = path.join(import.meta.dir, "..", "skills", "hatch", "SKILL.md");

let pass = 0;
let fail = 0;

function test(name: string, fn: () => void) {
  try {
    fn();
    pass++;
    console.log(`  ok    ${name}`);
  } catch (err: any) {
    fail++;
    console.log(`  FAIL  ${name}`);
    console.log(`        ${err.message}`);
  }
}

function assertTrue(actual: boolean, label: string) {
  if (!actual) throw new Error(`${label}: expected true`);
}

const text = readFileSync(HATCH_SKILL, "utf8");

test("stamps _hermit_versions[\"hermit-scribe\"] into config.json", () => {
  assertTrue(text.includes('_hermit_versions["hermit-scribe"]'), 'contains the stamp key');
});

test("version-gates the block refresh instead of skipping on marker-presence alone", () => {
  assertTrue(
    /stamped version equals plugin version/.test(text),
    'gate compares plugin.json version against the config stamp',
  );
});

test("re-renders on marker absent, stamp null, or stamp stale (not marker-presence-only)", () => {
  assertTrue(
    /marker absent, stamped version null, OR stamped version stale/.test(text),
    'all three refresh conditions are documented',
  );
});

test("replace case bounds the block through the closing marker", () => {
  assertTrue(
    text.includes('<!-- /hermit-scribe: Issue Filing -->'),
    'closing marker is referenced for the replace-branch bound',
  );
});

// ── CLAUDE-APPEND block ─────────────────────────────────────────────────────
// The block the hatch injects is the fleet's smallest and is the shape the rest
// should converge to. These pin the three rules it carries: skill-only filing,
// native operator approval and sanitization.

const APPEND = readFileSync(
  path.join(import.meta.dir, "..", "state-templates", "CLAUDE-APPEND.md"),
  "utf8",
);

test("APPEND routes all filing through the skill", () => {
  assertTrue(APPEND.includes("/hermit-scribe:hermit-scribe"), "names the skill as the only path");
});

test("APPEND keeps the operator-confirmation rule", () => {
  assertTrue(
    /complete sanitized preview/.test(APPEND) && /native permission approval/.test(APPEND) && /Denial cancels publication/.test(APPEND),
    "preview, native approval, and denial handling present",
  );
});

test("APPEND states sanitization as a rule, not as internal mechanism", () => {
  assertTrue(/sanitized of operator-machine and project specifics/.test(APPEND), "rule form present");
  assertTrue(!APPEND.includes("issue-sanitizer subagent"), "internal component name not leaked");
});

test("APPEND names no internal env vars in operator-facing prose", () => {
  assertTrue(!APPEND.includes("HERMIT_GH_REPO"), "env var replaced by 'the configured target repo'");
});

console.log("");
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
