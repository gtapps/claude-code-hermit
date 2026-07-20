import { test, expect } from "bun:test";
import { join } from "node:path";
import { validateSourcesTable } from "../scripts/validate-sources";

const SCRIPT = join(import.meta.dir, "..", "scripts", "validate-sources.ts");

const GOOD = `# Sources

| Name | Type | URL |
| ---- | ---- | --- |
| Hacker News | \`web\` | https://news.ycombinator.com |
| r/programming | reddit | https://reddit.com/r/programming |
`;

test("well-formed table has no violations", () => {
  expect(validateSourcesTable(GOOD)).toEqual([]);
});

test("invalid Type value is a violation", () => {
  const md = `| Name | Type | URL |
| ---- | ---- | --- |
| Bad | bogus | https://x.com |
`;
  const v = validateSourcesTable(md);
  expect(v.length).toBe(1);
  expect(v[0]).toContain("invalid Type");
});

test("column-count mismatch is a violation", () => {
  const md = `| Name | Type | URL |
| ---- | ---- | --- |
| Missing | web |
`;
  const v = validateSourcesTable(md);
  expect(v.length).toBe(1);
  expect(v[0]).toContain("expected 3 columns");
});

test("empty Name is a violation", () => {
  const md = `| Name | Type | URL |
| ---- | ---- | --- |
|  | web | https://x.com |
`;
  const v = validateSourcesTable(md);
  expect(v.length).toBe(1);
  expect(v[0]).toContain("Name column is empty");
});

test("hook passes through (exit 0) for a foreign sources.md edit", async () => {
  const proc = Bun.spawn(["bun", SCRIPT], { stdin: "pipe", stdout: "ignore", stderr: "ignore" });
  proc.stdin.write(JSON.stringify({ tool_input: { file_path: "/tmp/sources.md" } }));
  await proc.stdin.end();
  expect(await proc.exited).toBe(0);
});
