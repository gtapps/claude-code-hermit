#!/usr/bin/env bun
import { readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';

function main(args: string[]): void {
  if (args.length === 1 && args[0] === 'new-run') {
    console.log(crypto.randomUUID());
    return;
  }

  const [command, path, runId] = args;
  if (args.length !== 3 || command !== 'verify' || !path || !isAbsolute(path) || !runId?.trim()) {
    throw new Error('Usage: source-fetch-result.ts new-run | verify <absolute-output-path> <expected-run-id>');
  }

  const result: unknown = JSON.parse(readFileSync(path, 'utf8'));
  if (typeof result !== 'object' || result === null || Array.isArray(result)
    || !('run_id' in result) || result.run_id !== runId
    || !('sources' in result) || !Array.isArray(result.sources)) {
    throw new Error('Expected current-run source output with matching run_id and a sources array.');
  }
  console.log(JSON.stringify(result));
}

if (import.meta.main) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(`Source fetch verification failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
