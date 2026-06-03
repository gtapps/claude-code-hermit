#!/usr/bin/env node
"use strict";

const { spawnSync } = require("child_process");
const { mkdtempSync, writeFileSync } = require("fs");
const { tmpdir } = require("os");
const { generateKeyPairSync } = require("crypto");
const path = require("path");

const SCRIPT = path.join(__dirname, "..", "skills", "hermit-scribe", "file-issue.js");
const { buildLabels } = require(SCRIPT);

let pass = 0;
let fail = 0;

function test(name, fn) {
  try {
    fn();
    pass++;
    console.log(`  ok    ${name}`);
  } catch (err) {
    fail++;
    console.log(`  FAIL  ${name}`);
    console.log(`        ${err.message}`);
  }
}

function run(env, args) {
  return spawnSync("node", [SCRIPT, ...args], {
    env: { PATH: process.env.PATH, ...env },
    encoding: "utf8",
  });
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function assertMatch(actual, pattern, label) {
  if (!pattern.test(actual)) {
    throw new Error(`${label}: ${JSON.stringify(actual)} does not match ${pattern}`);
  }
}

function assertFails(env, args, pattern) {
  const r = run(env, args);
  assertEqual(r.status, 1, "exit code");
  assertMatch(r.stderr, pattern, "stderr");
}

const fixtures = mkdtempSync(path.join(tmpdir(), "hermit-scribe-test-"));
const keyFile = path.join(fixtures, "key.pem");
const titleFile = path.join(fixtures, "title");
const emptyTitleFile = path.join(fixtures, "empty");
const wsTitleFile = path.join(fixtures, "ws");
const bodyFile = path.join(fixtures, "body.md");

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
writeFileSync(keyFile, privateKey.export({ type: "pkcs1", format: "pem" }));
writeFileSync(titleFile, "valid issue title\n");
writeFileSync(emptyTitleFile, "");
writeFileSync(wsTitleFile, "   \n\t\n  ");
writeFileSync(bodyFile, "issue body content\n");

const fullEnv = {
  HERMIT_GH_APP_ID: "1",
  HERMIT_GH_APP_INSTALL_ID: "2",
  HERMIT_GH_APP_KEY_FILE: keyFile,
};

console.log("hermit-scribe CLI tests");

test("no args prints usage and exits 1", () => {
  assertFails({}, [], /Usage: node file-issue\.js/);
});

test("one arg prints usage and exits 1", () => {
  assertFails({}, [titleFile], /Usage: node file-issue\.js/);
});

test("missing HERMIT_GH_APP_ID is named in error", () => {
  assertFails({}, [titleFile, bodyFile], /Missing env var: HERMIT_GH_APP_ID/);
});

test("missing HERMIT_GH_APP_INSTALL_ID is named in error", () => {
  assertFails(
    { HERMIT_GH_APP_ID: "1" },
    [titleFile, bodyFile],
    /Missing env var: HERMIT_GH_APP_INSTALL_ID/
  );
});

test("missing HERMIT_GH_APP_KEY_FILE is named in error", () => {
  assertFails(
    { HERMIT_GH_APP_ID: "1", HERMIT_GH_APP_INSTALL_ID: "2" },
    [titleFile, bodyFile],
    /Missing env var: HERMIT_GH_APP_KEY_FILE/
  );
});

test("HERMIT_GH_REPO with too many slashes is rejected", () => {
  assertFails(
    { ...fullEnv, HERMIT_GH_REPO: "a/b/c" },
    [titleFile, bodyFile],
    /HERMIT_GH_REPO must be "owner\/repo"/
  );
});

test("HERMIT_GH_REPO with no slash is rejected", () => {
  assertFails(
    { ...fullEnv, HERMIT_GH_REPO: "single" },
    [titleFile, bodyFile],
    /HERMIT_GH_REPO must be "owner\/repo"/
  );
});

test("missing key file shows labeled error with var name and path", () => {
  assertFails(
    { ...fullEnv, HERMIT_GH_APP_KEY_FILE: "/nonexistent/key.pem" },
    [titleFile, bodyFile],
    /HERMIT_GH_APP_KEY_FILE=.*does not exist/
  );
});

test("--check with no proposal id prints usage and exits 1", () => {
  assertFails({}, ["--check"], /Usage: node file-issue\.js --check/);
});

test("--check with missing env var reports the var name", () => {
  assertFails({}, ["--check", "PROP-001"], /Missing env var: HERMIT_GH_APP_ID/);
});

test("--check with missing key file shows labeled error", () => {
  assertFails(
    { ...fullEnv, HERMIT_GH_APP_KEY_FILE: "/nonexistent/key.pem" },
    ["--check", "PROP-001"],
    /HERMIT_GH_APP_KEY_FILE=.*does not exist/
  );
});

// Requires real GitHub App credentials. Set HERMIT_GH_CHECK_LIVE=1 to run.
if (process.env.HERMIT_GH_CHECK_LIVE) {
  test("--check with unknown proposal id exits 2 with no match message", () => {
    const liveEnv = {
      HERMIT_GH_APP_ID: process.env.HERMIT_GH_APP_ID,
      HERMIT_GH_APP_INSTALL_ID: process.env.HERMIT_GH_APP_INSTALL_ID,
      HERMIT_GH_APP_KEY_FILE: process.env.HERMIT_GH_APP_KEY_FILE,
    };
    const r = run(liveEnv, ["--check", "PROP-NOTREAL-99999"]);
    assertEqual(r.status, 2, "exit code");
    assertMatch(r.stderr, /no match/, "stderr");
  });
}

test("empty title file is rejected", () => {
  assertFails(fullEnv, [emptyTitleFile, bodyFile], /Title file is empty/);
});

test("whitespace-only title file is rejected after trim", () => {
  assertFails(fullEnv, [wsTitleFile, bodyFile], /Title file is empty/);
});

// --- buildLabels unit tests ---

function assertDeepEqual(actual, expected, label) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) {
    throw new Error(`${label}: expected ${e}, got ${a}`);
  }
}

test("buildLabels([]) returns [hermit-filed]", () => {
  assertDeepEqual(buildLabels([]), ["hermit-filed"], "labels");
});

test("buildLabels(undefined) returns [hermit-filed]", () => {
  assertDeepEqual(buildLabels(undefined), ["hermit-filed"], "labels");
});

test("buildLabels with extra labels puts hermit-filed first", () => {
  assertDeepEqual(
    buildLabels(["bug", "homeassistant-hermit"]),
    ["hermit-filed", "bug", "homeassistant-hermit"],
    "labels"
  );
});

test("buildLabels deduplicates hermit-filed if passed explicitly", () => {
  assertDeepEqual(buildLabels(["hermit-filed", "bug"]), ["hermit-filed", "bug"], "labels");
});

// --- trailing label args CLI test ---

test("trailing label args do not break arg parsing (reaches token acquisition)", () => {
  assertFails(
    { ...fullEnv, HERMIT_GH_APP_KEY_FILE: "/nonexistent/key.pem" },
    [titleFile, bodyFile, "bug", "homeassistant-hermit"],
    /HERMIT_GH_APP_KEY_FILE=.*does not exist/
  );
});

console.log("");
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
