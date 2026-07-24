#!/usr/bin/env bun
// CLI wrapper around lib/channel-send.ts's sendToChannel — the seam
// synchronous callers (hermit-watchdog.ts, single-shot, no async conversion)
// reach the deterministic channel send through via spawnSync, instead of
// importing the lib directly the way async callers (cost-tracker.ts,
// channel-status-responder.ts) do.
//
// Usage: bun channel-send.ts <hermit-dir> [--tier client|maintainer] <text|- >
//   --tier     client (default) sends to the primary chat as today; maintainer
//              routes through sendOperatorNotice to channels.<p>.maintainer_channel_id,
//              falling back to the primary chat when none is configured.
//   <text|- >  literal text, or "-" to read the message from stdin (avoids
//              argv length/newline edges — the form spawnSync callers use).

import { sendToChannel, sendOperatorNotice } from './lib/channel-send';

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

// Pull `--tier <value>` out from anywhere in argv (position-independent), leaving
// the hermit-dir and text positionals in order.
function parseArgs(argv: string[]): { tier: 'client' | 'maintainer'; positionals: string[] } | { error: string } {
  const positionals: string[] = [];
  let tier: 'client' | 'maintainer' = 'client';
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--tier') {
      const v = argv[i + 1];
      if (v !== 'client' && v !== 'maintainer') return { error: `invalid --tier value: ${v ?? '(missing)'}` };
      tier = v;
      i++;
    } else {
      positionals.push(argv[i]);
    }
  }
  return { tier, positionals };
}

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2));
  if ('error' in parsed) {
    process.stderr.write(`channel-send: ${parsed.error}\n`);
    process.exit(1);
  }
  const [hermitDir, textArg] = parsed.positionals;
  if (!hermitDir || !textArg) {
    process.stderr.write('Usage: bun channel-send.ts <hermit-dir> [--tier client|maintainer] <text|->\n');
    process.exit(1);
  }

  const text = textArg === '-' ? (await readStdin()).trim() : textArg;
  if (!text) {
    process.stderr.write('channel-send: empty text\n');
    process.exit(1);
  }

  if (parsed.tier === 'maintainer') {
    const res = await sendOperatorNotice(hermitDir, { maintainer: { text, fallback: 'client' } });
    const m = res.maintainer;
    if (!m || !m.ok) {
      process.stderr.write(`channel-send: ${m?.error ?? 'no_delivery'}\n`);
      process.exit(1);
    }
    process.exit(0);
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
