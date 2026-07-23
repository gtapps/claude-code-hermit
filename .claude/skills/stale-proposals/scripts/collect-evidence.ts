#!/usr/bin/env bun
/**
 * Builds a bounded evidence bundle for the /stale-proposals audit.
 *
 * The matching step is semantic and has to see both the open proposals and
 * everything that shipped after them. Read naively that is thousands of lines
 * of CHANGELOG in the operator's session. This script collects it into one
 * file instead and prints only counts, so the corpus reaches a subagent by
 * path and never enters the calling context.
 *
 * Usage: bun collect-evidence.ts [--hermit-dir DIR] [--out FILE]
 * Prints: OK|<out-path>|<open-count>|<bullet-count>|<commit-count>|<cutoff>
 *         NONE|no-open-proposals
 */

import { readFileSync, readdirSync, writeFileSync, existsSync } from "node:fs";
import { join, basename } from "node:path";
import { execSync } from "node:child_process";
import { tmpdir } from "node:os";

const OPEN_STATUSES = new Set(["proposed", "deferred", "accepted"]);
const EXCERPT_CHARS = 700;
const BULLET_CHARS = 500;

function arg(flag: string, fallback: string): string {
  const i = process.argv.indexOf(flag);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const repoRoot = execSync("git rev-parse --show-toplevel").toString().trim();
const hermitDir = arg("--hermit-dir", join(repoRoot, ".claude-code-hermit"));
const outPath = arg(
  "--out",
  join(process.env.CLAUDE_JOB_DIR || tmpdir(), "stale-proposals-evidence.md"),
);

// ---------- proposals ----------

type Proposal = {
  id: string;
  file: string;
  title: string;
  status: string;
  created: string;
  category: string;
  tags: string;
  excerpt: string;
};

/** Frontmatter here is flat scalars written by proposal.ts — a line reader is
 *  sufficient and avoids a YAML dependency in a repo that ships none. */
function frontmatter(text: string): Record<string, string> {
  const end = text.indexOf("\n---", 4);
  if (!text.startsWith("---") || end === -1) return {};
  const out: Record<string, string> = {};
  for (const line of text.slice(4, end).split("\n")) {
    const m = line.match(/^([a-z_]+):\s*(.*)$/);
    if (m) out[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
  }
  return out;
}

/** The Problem section states what the proposal wants changed, which is what a
 *  changelog bullet would echo. Context is the fallback; it describes the
 *  incident rather than the fix, so it matches less cleanly. */
function excerpt(text: string): string {
  const body = text.slice(text.indexOf("\n---", 4) + 4);
  for (const heading of ["## Problem", "## Proposed Solution", "## Context"]) {
    const i = body.indexOf(heading);
    if (i === -1) continue;
    const section = body.slice(i + heading.length).split(/\n## /)[0];
    const prose = section.replace(/\s+/g, " ").trim();
    if (prose.length > 40) return prose.slice(0, EXCERPT_CHARS);
  }
  return body.replace(/\s+/g, " ").trim().slice(0, EXCERPT_CHARS);
}

const proposalsDir = join(hermitDir, "proposals");
if (!existsSync(proposalsDir)) {
  console.log("NONE|no-proposals-dir");
  process.exit(0);
}

const open: Proposal[] = [];
for (const name of readdirSync(proposalsDir).sort()) {
  if (!name.endsWith(".md")) continue;
  const text = readFileSync(join(proposalsDir, name), "utf8");
  const fm = frontmatter(text);
  if (!OPEN_STATUSES.has(fm.status)) continue;
  open.push({
    id: (fm.id || basename(name, ".md")).replace(/-\d{6}$/, "").slice(0, 8),
    file: name,
    title: fm.title || "(untitled)",
    status: fm.status,
    created: (fm.created || "").slice(0, 10),
    category: fm.category || "",
    tags: fm.tags || "",
    excerpt: excerpt(text),
  });
}

if (open.length === 0) {
  console.log("NONE|no-open-proposals");
  process.exit(0);
}

// Nothing can have shipped before the oldest open proposal existed, so this is
// the true floor for every evidence source.
const cutoff = open
  .map((p) => p.created)
  .filter(Boolean)
  .sort()[0];

// ---------- changelog bullets ----------

type Entry = { plugin: string; version: string; date: string; bullets: string[] };

const entries: Entry[] = [];
for (const dir of readdirSync(join(repoRoot, "plugins")).sort()) {
  const path = join(repoRoot, "plugins", dir, "CHANGELOG.md");
  if (!existsSync(path)) continue;

  let current: Entry | null = null;
  let kind = "";
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const header = line.match(/^## \[([^\]]+)\](?:\s*-\s*(\d{4}-\d{2}-\d{2}))?/);
    if (header) {
      const [, version, date] = header;
      const unreleased = version.toLowerCase() === "unreleased";
      // Unreleased is always in scope: it is what shipped most recently and
      // carries no date to compare against.
      current =
        unreleased || (date && date >= cutoff)
          ? { plugin: dir, version, date: date || "unreleased", bullets: [] }
          : null;
      if (current) entries.push(current);
      kind = "";
      continue;
    }
    const sub = line.match(/^### (.+)/);
    if (sub) {
      kind = sub[1].trim();
      continue;
    }
    // Upgrade Instructions are imperative migration steps for the operator,
    // not claims about what changed — they add bulk without adding signal.
    if (!current || kind.startsWith("Upgrade")) continue;
    if (line.startsWith("- ")) {
      current.bullets.push(`(${kind}) ${line.slice(2).trim()}`.slice(0, BULLET_CHARS));
    }
  }
}

// ---------- first-parent history ----------

const commits = execSync(
  `git log --first-parent --since=${cutoff} --pretty=%cs%x09%s`,
  { cwd: repoRoot, maxBuffer: 8 * 1024 * 1024 },
)
  .toString()
  .trim()
  .split("\n")
  .filter(Boolean);

// ---------- bundle ----------

const today = new Date().toISOString().slice(0, 10);
const lines: string[] = [
  "# Stale-proposal evidence bundle",
  "",
  `Generated ${today}. Evidence floor: ${cutoff} (oldest open proposal).`,
  "",
  `## Open proposals (${open.length})`,
  "",
];

for (const p of open) {
  const age = Math.round(
    (Date.parse(today) - Date.parse(p.created || today)) / 86_400_000,
  );
  lines.push(
    `### ${p.id} — ${p.title}`,
    `status: ${p.status} | created: ${p.created} | age: ${age}d | category: ${p.category} | tags: ${p.tags}`,
    "",
    p.excerpt,
    "",
  );
}

const bulletCount = entries.reduce((n, e) => n + e.bullets.length, 0);
lines.push(`## Shipped changelog entries (${bulletCount} bullets)`, "");
for (const e of entries) {
  if (e.bullets.length === 0) continue;
  lines.push(`### ${e.plugin} ${e.version} — ${e.date}`);
  lines.push(...e.bullets.map((b) => `- ${b}`), "");
}

lines.push(`## First-parent history since ${cutoff} (${commits.length})`, "");
lines.push(...commits.map((c) => `- ${c.replace(/\t/, " | ")}`));

writeFileSync(outPath, lines.join("\n"));
console.log(
  `OK|${outPath}|${open.length}|${bulletCount}|${commits.length}|${cutoff}`,
);
