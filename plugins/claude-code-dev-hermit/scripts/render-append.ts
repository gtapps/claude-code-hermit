#!/usr/bin/env bun
// Renders the single-source CLAUDE-APPEND template for a given hatch mode.
// The template is annotated with paired HTML-comment mode markers:
//   <!-- mode:standard-only -->…<!-- /mode:standard-only -->  → kept only in standard
//   <!-- mode:safety-only -->…<!-- /mode:safety-only -->      → kept only in safety
// Markers always sit on their own line and are stripped from every rendering,
// so standard output is byte-identical to the pre-collapse CLAUDE-APPEND.md and
// safety output is byte-identical to the pre-collapse CLAUDE-APPEND-SAFETY.md.

import fs from 'node:fs';
import path from 'node:path';

export type Mode = 'standard' | 'safety';

const TEMPLATE = path.join(import.meta.dir, '..', 'state-templates', 'CLAUDE-APPEND.md');

// Pure renderer — exported for tests.
export function render(mode: Mode, template: string): string {
  const keep = mode === 'standard' ? 'standard-only' : 'safety-only';
  const drop = mode === 'standard' ? 'safety-only' : 'standard-only';

  // Remove dropped regions whole, including their own-line markers and trailing newline.
  const dropRe = new RegExp(
    `^[ \\t]*<!-- mode:${drop} -->[ \\t]*\\n[\\s\\S]*?^[ \\t]*<!-- /mode:${drop} -->[ \\t]*\\n`,
    'gm',
  );
  let out = template.replace(dropRe, '');

  // Strip the kept region's marker lines, preserving the content between them.
  out = out
    .replace(new RegExp(`^[ \\t]*<!-- mode:${keep} -->[ \\t]*\\n`, 'gm'), '')
    .replace(new RegExp(`^[ \\t]*<!-- /mode:${keep} -->[ \\t]*\\n`, 'gm'), '');

  return out;
}

if (import.meta.main) {
  const mode = process.argv[2];
  if (mode !== 'standard' && mode !== 'safety') {
    process.stderr.write(`render-append: unknown mode "${mode ?? ''}" (expected: standard|safety)\n`);
    process.exit(1);
  }
  // No process.exit() here: process.stdout.write() to a pipe is async in Bun,
  // and exiting before it drains truncates output at the pipe buffer (~64 KB).
  // Letting the module return exits 0 naturally once stdout has flushed.
  process.stdout.write(render(mode, fs.readFileSync(TEMPLATE, 'utf-8')));
}
