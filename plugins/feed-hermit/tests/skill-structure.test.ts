import { test, expect } from "bun:test";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");

// Every skill shipped by this plugin. `name:` frontmatter must equal the dir.
const SKILLS = [
  "hatch",
  "feed-brief",
  "weekly-digest",
  "add-source",
  "source-scout",
  "source-health",
  "story-arcs",
  "deep-dive",
];

function frontmatter(md: string): Record<string, string> {
  const m = md.match(/^---\n([\s\S]*?)\n---/);
  if (!m) return {};
  const out: Record<string, string> = {};
  const lines = m[1].split("\n");
  for (let i = 0; i < lines.length; i++) {
    const kv = lines[i].match(/^([A-Za-z_]+):\s*(.*)$/);
    if (!kv) continue;
    let value = kv[2].trim();
    // Fold YAML block scalars (`>`, `>-`, `|`, `|-`): collect the following indented lines.
    if (/^[|>][+-]?$/.test(value)) {
      const folded: string[] = [];
      while (i + 1 < lines.length && /^\s+\S/.test(lines[i + 1])) {
        folded.push(lines[++i].trim());
      }
      value = folded.join(" ");
    }
    out[kv[1]] = value.replace(/^["']|["']$/g, "");
  }
  return out;
}

for (const name of SKILLS) {
  test(`skill ${name} has valid frontmatter`, () => {
    const path = join(ROOT, "skills", name, "SKILL.md");
    expect(existsSync(path)).toBe(true);
    const fm = frontmatter(readFileSync(path, "utf8"));
    expect(fm.name).toBe(name);
    expect((fm.description ?? "").length).toBeGreaterThanOrEqual(10);
  });
}

test("source-fetcher agent has name/model frontmatter", () => {
  const path = join(ROOT, "agents", "source-fetcher.md");
  expect(existsSync(path)).toBe(true);
  const raw = readFileSync(path, "utf8");
  const fm = frontmatter(raw);
  expect(fm.name).toBe("source-fetcher");
  expect(fm.model).toBe("haiku");
  // tools is a YAML list — assert the block names the three required tools
  expect(raw).toContain("WebFetch");
  expect(raw).toContain("Read");
  expect(raw).toContain("Write");
});

test("CLAUDE-APPEND has matched block markers", () => {
  const raw = readFileSync(join(ROOT, "state-templates", "CLAUDE-APPEND.md"), "utf8");
  expect(raw).toContain("<!-- feed-hermit: Feed Workflow -->");
  expect(raw).toContain("<!-- /feed-hermit: Feed Workflow -->");
});

test("hatch idempotently registers the plugin-owned brief archive", () => {
  const raw = readFileSync(join(ROOT, "skills", "hatch", "SKILL.md"), "utf8");
  expect(raw).toContain("config.storage_drift.ignore");
  expect(raw).toMatch(/`"briefs"`[\s\S]{0,80}absent/);
  expect(raw).toMatch(/already present[\s\S]{0,60}leave the array\s+unchanged/);
});

for (const f of [
  "routine-feed-brief-morning.md",
  "routine-feed-brief-evening.md",
  "routine-weekly-digest.md",
]) {
  test(`routine prompt ${f} is a routine-prompt`, () => {
    const path = join(ROOT, "state-templates", "compiled", f);
    expect(existsSync(path)).toBe(true);
    expect(frontmatter(readFileSync(path, "utf8")).type).toBe("routine-prompt");
  });
}
