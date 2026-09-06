// Shared primitives for the scripts/*.ts verdict-line CLI contract (see
// CLAUDE.md § Token discipline): emit() writes the single stdout verdict line
// and exits 0; readStdin() reads a heredoc payload to completion untrimmed
// (callers trim where the original per-script behavior trimmed); readJson()
// is a tolerant JSON-file reader for optional state files (null if missing
// or invalid); flagValue() reads one `--flag value` pair out of an argv slice.

import fs from 'node:fs';

type Json = any;

function emit(verdict: string): never {
  process.stdout.write(verdict + '\n');
  process.exit(0);
}

function readStdin(): Promise<string> {
  return new Promise(resolve => {
    let buf = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', c => { buf += c; });
    process.stdin.on('error', () => {});
    process.stdin.on('end', () => resolve(buf));
  });
}

// A TTY never emits 'end' without Ctrl-D, so the flag alone is not enough to read.
function readStdinIfFlagged(argv: string[], flag: string): Promise<string> {
  return argv.includes(flag) && !process.stdin.isTTY ? readStdin() : Promise.resolve('');
}

function readJson(p: string): Json {
  try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { return null; }
}

function flagValue(argv: string[], flag: string): string | undefined {
  const i = argv.indexOf(flag);
  return i === -1 ? undefined : argv[i + 1];
}

// `--flag=value` (equals form), as distinct from flagValue's `--flag value`.
// Both forms are in use: the equals form reads better in skill prose, where the
// call is written by hand.
function flagEq(argv: string[], name: string): string | undefined {
  const hit = argv.find(a => a.startsWith(`--${name}=`));
  return hit === undefined ? undefined : hit.slice(name.length + 3);
}

export { emit, readStdin, readStdinIfFlagged, readJson, flagValue, flagEq };
