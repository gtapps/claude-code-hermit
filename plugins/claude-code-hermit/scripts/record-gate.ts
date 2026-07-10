// record-gate.ts — parses one proposal/reflect gate-agent verdict line, appends the
// corresponding metric event, and returns a routing token.
// Usage: bun record-gate.ts <hermit-state-dir> --gate <triage|judge> --caller <caller>
//        [--evidence-source <value>] [--tags <json-array>] <<'HERMIT_GATE'
//        Title: <candidate title>
//        Verdict: <the gate agent's verdict line, verbatim>
//        HERMIT_GATE
// Output (stdout, one line):
//   PROCEED|CREATE                (triage)
//   DROP|SUPPRESS:<code>          (triage or judge)
//   DROP|DUPLICATE:<PROP-ID>      (triage)
//   PROCEED|ACCEPT                (judge)
//   PROCEED|DOWNGRADE:<N>         (judge)
//   GATE_FAILED                   (either gate — unrecognized/empty verdict)
// Exit 0 always.
//
// Fail-closed by design — the opposite stance from the fail-open *-precheck.ts
// scripts: an unrecognized verdict never PROCEEDs. Recognized triage verdicts
// append a `triage-verdict` event to state/proposal-metrics.jsonl (matches the
// existing prose contract in proposal-create/SKILL.md and reflect/branches.md).
// Judge verdicts are not separately logged today — only a judge gate *failure*
// appends `gate-failed`; this script preserves that rather than introducing a
// new judge-verdict metric type. Verdict grammars: agents/proposal-triage.md
// § Output, agents/reflection-judge.md § Verdicts.

import fs from 'node:fs';
import path from 'node:path';
import { appendJsonlLine } from './lib/append-jsonl';
import { utcISOStamp } from './lib/time';
import { emit, readStdin } from './lib/cli';

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      out[argv[i].slice(2)] = argv[i + 1];
      i++;
    }
  }
  return out;
}

(async () => {
  const stateDir = process.argv[2];
  const flags = parseArgs(process.argv.slice(3));
  const gate = flags.gate; // 'triage' | 'judge'
  const caller = flags.caller ?? 'unknown';
  const evidenceSource = flags['evidence-source'] ?? 'archived-session';
  let tags: string[] = [];
  if (flags.tags) {
    try { tags = JSON.parse(flags.tags); } catch { tags = []; }
  }

  const input = await readStdin();
  const titleMatch = input.match(/^Title:\s*(.*)$/m);
  const verdictMatch = input.match(/^Verdict:\s*(.*)$/m);
  const title = titleMatch ? titleMatch[1].trim() : '';
  const verdictLine = verdictMatch ? verdictMatch[1].trim() : '';

  const agent = gate === 'judge' ? 'reflection-judge' : 'proposal-triage';

  if (stateDir) {
    try { fs.mkdirSync(path.join(stateDir, 'state'), { recursive: true }); } catch { /* appendJsonlLine below reports the real failure */ }
  }

  function failClosed(): never {
    if (stateDir) {
      appendJsonlLine(
        path.join(stateDir, 'state', 'proposal-metrics.jsonl'),
        JSON.stringify({ ts: utcISOStamp(), type: 'gate-failed', agent, title }),
      );
    }
    emit('GATE_FAILED');
  }

  if (!stateDir || (gate !== 'triage' && gate !== 'judge') || !verdictLine) failClosed();

  const ledger = path.join(stateDir, 'state', 'proposal-metrics.jsonl');

  if (gate === 'triage') {
    const create = verdictLine.match(/^CREATE:\s*.+$/);
    const suppress = verdictLine.match(/^SUPPRESS:\s*.+?—\s*([a-z-]+):/);
    const duplicate = verdictLine.match(/^DUPLICATE:\s*.+?—\s*(PROP-[\w-]+):/);

    if (create) {
      appendJsonlLine(ledger, JSON.stringify({ ts: utcISOStamp(), type: 'triage-verdict', verdict: 'CREATE', caller, evidence_source: evidenceSource, tags }));
      emit('PROCEED|CREATE');
    }
    if (suppress) {
      appendJsonlLine(ledger, JSON.stringify({ ts: utcISOStamp(), type: 'triage-verdict', verdict: 'SUPPRESS', caller, evidence_source: evidenceSource, tags }));
      emit(`DROP|SUPPRESS:${suppress[1]}`);
    }
    if (duplicate) {
      appendJsonlLine(ledger, JSON.stringify({ ts: utcISOStamp(), type: 'triage-verdict', verdict: 'DUPLICATE', caller, evidence_source: evidenceSource, tags }));
      emit(`DROP|DUPLICATE:${duplicate[1]}`);
    }
    failClosed();
  }

  // gate === 'judge'
  const accept = verdictLine.match(/^ACCEPT(?:\s*\([^)]+\))?:/);
  const downgrade = verdictLine.match(/^DOWNGRADE:(\d+)(?:\s*\([^)]+\))?:/);
  const suppress = verdictLine.match(/^SUPPRESS(?:\s*\([^)]+\))?:\s*.+?—\s*([a-z-]+):/);

  if (accept) emit('PROCEED|ACCEPT');
  if (downgrade) emit(`PROCEED|DOWNGRADE:${downgrade[1]}`);
  if (suppress) emit(`DROP|SUPPRESS:${suppress[1]}`);
  failClosed();
})();
