#!/usr/bin/env bun
// CLI wrapper around lib/channel-send.ts's sendToChannel — the seam
// synchronous callers (hermit-watchdog.ts, single-shot, no async conversion)
// reach the deterministic channel send through via spawnSync, instead of
// importing the lib directly the way async callers (cost-tracker.ts,
// channel-status-responder.ts) do.
//
// Usage: bun channel-send.ts <hermit-dir> <text|- >
//   <text|- >  literal text, or "-" to read the message from stdin (avoids
//              argv length/newline edges — the form spawnSync callers use).

import { sendToChannel } from './lib/channel-send';

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

async function main(): Promise<void> {
  const hermitDir = process.argv[2];
  const textArg = process.argv[3];
  if (!hermitDir || !textArg) {
    process.stderr.write('Usage: bun channel-send.ts <hermit-dir> <text|->\n');
    process.exit(1);
  }

  const text = textArg === '-' ? (await readStdin()).trim() : textArg;
  if (!text) {
    process.stderr.write('channel-send: empty text\n');
    process.exit(1);
  }

  const result = await sendToChannel(hermitDir, text);
  if (!result.ok) {
    process.stderr.write(`channel-send: ${result.error}\n`);
    process.exit(1);
  }
  process.exit(0);
}

if (import.meta.main) {
  main().catch((e: any) => {
    process.stderr.write(`channel-send: ${e?.message || e}\n`);
    process.exit(1);
  });
}
