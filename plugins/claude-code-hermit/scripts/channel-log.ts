#!/usr/bin/env bun
// channel-log.ts — CLI for the weekly-review consolidation step over the
// episodic channel-message log (see scripts/lib/channel-log.ts).
//
// Usage: bun channel-log.ts <hermit-state-dir> <subcommand> [args...]
//   list-unconsolidated [--before=ISO]   print unconsolidated rows as JSON
//   mark-consolidated <id,id,...>        stamp consolidated_at on the given ids
//   prune <days>                         delete consolidated rows older than <days>
//
// Exit codes: 0 on success (including "no DB yet" — nothing to do, not a
// failure). Nonzero only on a genuine error against an existing DB, so
// weekly-review can't mistake a no-op for completed work.

import path from 'node:path';
import { unconsolidated, markConsolidated, prune } from './lib/channel-log';

function fail(message: string): never {
  process.stderr.write(`channel-log: ${message}\n`);
  process.exit(1);
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.length < 2) {
    process.stderr.write(
      'Usage: bun channel-log.ts <hermit-state-dir> <list-unconsolidated|mark-consolidated|prune> [args...]\n'
    );
    process.exit(1);
  }

  const hermitDir = path.resolve(args[0]);
  const subcommand = args[1];
  const rest = args.slice(2);

  if (subcommand === 'list-unconsolidated') {
    const beforeArg = rest.find((a) => a.startsWith('--before='));
    const before = beforeArg ? beforeArg.slice('--before='.length) : undefined;
    const result = unconsolidated(hermitDir, before);
    if (!result.ok) fail(result.error || 'list-unconsolidated failed');
    process.stdout.write(JSON.stringify(result.rows) + '\n');
    process.exit(0);
  }

  if (subcommand === 'mark-consolidated') {
    const idsArg = rest[0];
    if (!idsArg) fail('mark-consolidated requires a comma-separated list of ids');
    const ids = idsArg
      .split(',')
      .map((s) => parseInt(s.trim(), 10))
      .filter((n) => !isNaN(n));
    const result = markConsolidated(hermitDir, ids);
    if (!result.ok) fail(result.error || 'mark-consolidated failed');
    process.exit(0);
  }

  if (subcommand === 'prune') {
    const days = parseInt(rest[0], 10);
    if (isNaN(days)) fail('prune requires a numeric day count');
    const result = prune(hermitDir, days);
    if (!result.ok) fail(result.error || 'prune failed');
    process.stdout.write(`pruned ${result.deleted} consolidated row(s)\n`);
    process.exit(0);
  }

  fail(`unknown subcommand '${subcommand}'`);
}
