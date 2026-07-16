#!/usr/bin/env bun
/**
 * PostToolUse hook: validate sources.md table format.
 * Passes through (exit 0) unless the edited file's basename is sources.md.
 * Exits 1 with violations on stderr when the table is malformed.
 */

import { basename } from "node:path";

const VALID_TYPES = new Set(["web", "rss", "chrome", "reddit", "reddit-home", "x"]);
const SOURCES_FILE = "sources.md";

function parseRow(line: string): string[] | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("|") || !trimmed.endsWith("|")) return null;
  return trimmed
    .slice(1, -1)
    .split("|")
    .map((c) => c.trim());
}

function isSeparator(cells: string[]): boolean {
  return cells.filter((c) => c).every((c) => /^-+$/.test(c.replace(/ /g, "")));
}

export function validateSourcesTable(markdown: string): string[] {
  const lines = markdown.split("\n");
  const violations: string[] = [];

  let inTable = false;
  let headerSeen = false;
  let nameIdx = -1;
  let typeIdx = -1;
  let expectedCols = 0;

  lines.forEach((line, idx) => {
    const lineNo = idx + 1;
    const cells = parseRow(line);
    if (cells === null) {
      inTable = false;
      headerSeen = false;
      return;
    }

    if (isSeparator(cells)) return;

    if (!headerSeen && cells.includes("Name") && cells.includes("Type")) {
      inTable = true;
      headerSeen = true;
      nameIdx = cells.indexOf("Name");
      typeIdx = cells.indexOf("Type");
      expectedCols = cells.length;
      return;
    }

    if (!inTable) return;

    if (cells.length !== expectedCols) {
      violations.push(`Line ${lineNo}: expected ${expectedCols} columns, got ${cells.length}: ${line.trimEnd()}`);
      return;
    }

    const rowType = cells[typeIdx].replace(/`/g, "").trim();
    if (rowType && !VALID_TYPES.has(rowType)) {
      violations.push(
        `Line ${lineNo}: invalid Type '${rowType}' (valid: ${[...VALID_TYPES].sort().join(", ")})`,
      );
    }

    if (!cells[nameIdx]) {
      violations.push(`Line ${lineNo}: Name column is empty`);
    }
  });

  return violations;
}

async function readStdin(): Promise<string> {
  return Bun.stdin.text();
}

function editedPath(data: unknown): string | undefined {
  if (typeof data !== "object" || data === null) return undefined;
  const rec = data as Record<string, unknown>;
  const fromInput = (rec.tool_input as Record<string, unknown> | undefined)?.file_path;
  if (typeof fromInput === "string") return fromInput;
  const fromResponse = (rec.tool_response as Record<string, unknown> | undefined)?.file_path;
  if (typeof fromResponse === "string") return fromResponse;
  if (typeof rec.file_path === "string") return rec.file_path;
  return undefined;
}

async function main(): Promise<void> {
  let data: unknown;
  try {
    const raw = await readStdin();
    data = JSON.parse(raw);
  } catch {
    process.exit(0); // fail open on unparseable stdin
  }

  const path = editedPath(data);
  if (!path || basename(path) !== SOURCES_FILE) {
    process.exit(0); // not a sources.md edit — pass through
  }

  let markdown: string;
  try {
    markdown = await Bun.file(SOURCES_FILE).text();
  } catch {
    process.exit(0); // missing sources.md — skip
  }

  const violations = validateSourcesTable(markdown);
  if (violations.length > 0) {
    process.stderr.write("sources.md validation failed:\n");
    for (const v of violations) process.stderr.write(`  ${v}\n`);
    process.exit(1);
  }
  process.exit(0);
}

if (import.meta.main) {
  void main();
}
