import { test, expect } from "bun:test";
import { join } from "node:path";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAllowed, parseAllowlist } from "../hooks/fetch-guard";

const SCRIPT = join(import.meta.dir, "..", "hooks", "fetch-guard.ts");

const INFRA = ["raw.githubusercontent.com", "api.github.com", "registry.npmjs.org", "pypi.org", "codeload.github.com"];

test("exact domain match is allowed", () => {
  expect(isAllowed("news.ycombinator.com", ["news.ycombinator.com"])).toBe(true);
});

test("subdomain of an allowlist entry is allowed", () => {
  expect(isAllowed("api.example.com", ["example.com"])).toBe(true);
});

test("infra-list domain is allowed", () => {
  expect(isAllowed("raw.githubusercontent.com", INFRA)).toBe(true);
});

test("off-allowlist domain is denied", () => {
  expect(isAllowed("evil.com", ["example.com", ...INFRA])).toBe(false);
});

test("parseAllowlist extracts hostnames from a sources.md table", () => {
  const md = `| Name | Type | URL |
| ---- | ---- | --- |
| HN | web | https://news.ycombinator.com |
| Example | web | http://www.example.com/path |
`;
  const hosts = parseAllowlist(md);
  expect(hosts).toContain("news.ycombinator.com");
  expect(hosts).toContain("example.com");
});

test("hook fails open (exit 0) on malformed stdin", async () => {
  const proc = Bun.spawn(["bun", SCRIPT], { stdin: "pipe", stdout: "ignore", stderr: "ignore" });
  proc.stdin.write("not json");
  await proc.stdin.end();
  expect(await proc.exited).toBe(0);
});

test("hook blocks (exit 2) an off-allowlist URL", async () => {
  const dir = mkdtempSync(join(tmpdir(), "fetch-guard-"));
  writeFileSync(join(dir, "sources.md"), "| Name | Type | URL |\n| - | - | - |\n| HN | web | https://news.ycombinator.com |\n");
  const proc = Bun.spawn(["bun", SCRIPT], {
    stdin: "pipe",
    stdout: "ignore",
    stderr: "ignore",
    cwd: dir,
  });
  proc.stdin.write(JSON.stringify({ tool_input: { url: "https://evil.example.org" } }));
  await proc.stdin.end();
  expect(await proc.exited).toBe(2);
});
