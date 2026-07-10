// Shared primitives for the scripts/*.ts verdict-line CLI contract (see
// CLAUDE.md § Token discipline): emit() writes the single stdout verdict line
// and exits 0; readStdin() reads a heredoc payload to completion untrimmed
// (callers trim where the original per-script behavior trimmed); readJson()
// is a tolerant JSON-file reader for optional state files (null if missing
// or invalid).

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

function readJson(p: string): Json {
  try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { return null; }
}

export { emit, readStdin, readJson };
