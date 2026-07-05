#!/usr/bin/env bun

import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const SCRIPT = path.join(import.meta.dir, "..", "scripts", "automode-env.ts");

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

function assertEqual(actual: any, expected: any, label: string) {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function assertMatch(actual: string, pattern: RegExp, label: string) {
  if (!pattern.test(actual)) {
    throw new Error(`${label}: ${JSON.stringify(actual)} does not match ${pattern}`);
  }
}

function run(env: Record<string, string>, target: string) {
  return spawnSync(process.execPath, [SCRIPT, target], {
    env: { PATH: process.env.PATH || "", ...env },
    encoding: "utf8",
  });
}

function freshDir(): string {
  return mkdtempSync(path.join(tmpdir(), "hermit-scribe-automode-env-"));
}

test("seeds an api.github.com entry with the default repo", () => {
  const dir = freshDir();
  const target = path.join(dir, ".claude", "settings.local.json");
  const r = run({}, target);
  assertEqual(r.status, 0, "exit code");
  const settings = JSON.parse(readFileSync(target, "utf8"));
  assertEqual(settings.autoMode.environment[0], "$defaults", "starts with $defaults");
  assertMatch(
    settings.autoMode.environment.join("\n"),
    /api\.github\.com.*gtapps\/claude-code-hermit/,
    "entry mentions api.github.com and the default repo",
  );
  rmSync(dir, { recursive: true, force: true });
});

test("honors HERMIT_GH_REPO override", () => {
  const dir = freshDir();
  const target = path.join(dir, ".claude", "settings.local.json");
  const r = run({ HERMIT_GH_REPO: "acme/widgets" }, target);
  assertEqual(r.status, 0, "exit code");
  const settings = JSON.parse(readFileSync(target, "utf8"));
  assertMatch(settings.autoMode.environment.join("\n"), /acme\/widgets/, "entry mentions overridden repo");
  rmSync(dir, { recursive: true, force: true });
});

test("is idempotent", () => {
  const dir = freshDir();
  const target = path.join(dir, ".claude", "settings.local.json");
  run({}, target);
  const first = readFileSync(target, "utf8");
  run({}, target);
  const second = readFileSync(target, "utf8");
  assertEqual(second, first, "file unchanged on second run");
  rmSync(dir, { recursive: true, force: true });
});

test("refuses a target not named settings.local.json", () => {
  const dir = freshDir();
  mkdirSync(path.join(dir, ".claude"), { recursive: true });
  const target = path.join(dir, ".claude", "settings.json");
  writeFileSync(target, "{}");
  const r = run({}, target);
  assertEqual(r.status, 1, "exit code");
  assertMatch(r.stderr, /settings\.local\.json/, "stderr mentions settings.local.json");
  rmSync(dir, { recursive: true, force: true });
});

test("never touches sibling keys", () => {
  const dir = freshDir();
  const target = path.join(dir, ".claude", "settings.local.json");
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, JSON.stringify({ permissions: { allow: ["Bash(bun */scripts/*)"] } }));
  run({}, target);
  const settings = JSON.parse(readFileSync(target, "utf8"));
  assertEqual(JSON.stringify(settings.permissions.allow), JSON.stringify(["Bash(bun */scripts/*)"]), "permissions.allow untouched");
  rmSync(dir, { recursive: true, force: true });
});

console.log("");
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
