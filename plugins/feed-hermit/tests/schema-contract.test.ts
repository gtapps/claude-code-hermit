import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// docs/schema.md is the product's spine — the archive-frontmatter and registry
// contracts the pipeline depends on. Guard against silent drift, especially the
// sources_skipped vs sources_quiet distinction that powers source-health.
const schema = readFileSync(join(import.meta.dir, "..", "docs", "schema.md"), "utf8");

const DAILY_ARCHIVE_KEYS = [
  "date",
  "type",
  "title",
  "created",
  "tags",
  "top_categories",
  "item_count",
  "sources_used",
  "sources_skipped",
  "sources_quiet",
  "fetch_log",
];

for (const key of DAILY_ARCHIVE_KEYS) {
  test(`schema.md documents daily-archive key: ${key}`, () => {
    expect(schema).toContain(key);
  });
}

test("schema.md keeps sources_skipped vs sources_quiet distinct", () => {
  expect(schema).toContain("sources_skipped");
  expect(schema).toContain("sources_quiet");
});

test("schema.md documents the source Type enum", () => {
  for (const t of ["web", "rss", "chrome", "reddit", "reddit-home", "x"]) {
    expect(schema).toContain(t);
  }
});
