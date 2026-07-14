// heartbeat-precheck default proposal-scan resolution (Phase 2 token-efficiency).
//
// The default HEARTBEAT.md item scans `proposals/` for review-worthy proposals.
// Its alerts are keyed `proposal-pending:<PROP-NNN>`, which never matched the
// generic `checklist:<hash>` key the item loop used — so the item always forced
// an LLM EVALUATE and the 6h clean-recheck damper was the only cap on wasted
// dispatches. heartbeat-precheck now resolves that item against real proposal
// frontmatter. These tests pin the resolution matrix AND prove the three
// OK-blocking invariants (self-eval tick, pending micro-proposal, generic items)
// still run before the item loop.
//
// Usage: bun test tests/heartbeat-default-scan.test.ts   (from the plugin root)

import { describe, test, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { runScript, PLUGIN_ROOT } from './helpers/run';
import { isProposalScanItem } from '../scripts/lib/heartbeat-items';

const hermit = (dir: string, ...p: string[]) => path.join(dir, '.claude-code-hermit', ...p);

const NOW = '2026-07-03T12:00:00Z';
// heartbeat-precheck's suppressed-digest gate compares last_digest_date against
// todayYMD('UTC'), which uses real wall-clock (not HERMIT_NOW). Compute "today"
// the same way so the gate is a no-op and these tests exercise the item loop.
const TODAY = new Intl.DateTimeFormat('en-CA', { timeZone: 'UTC' }).format(new Date());

// Default checklist item (verbatim shape from HEARTBEAT.md.template): references
// `proposals/` so the precheck classifies it as the proposal-scan item.
const HEARTBEAT_DEFAULT =
  '# Heartbeat Checklist\n\n## Standing Checks\n' +
  '- Review `proposals/` for any with `status: proposed` needing operator review.\n';

// clean_recheck_cooldown: null disables the damper so these tests isolate the
// item-loop resolution (the damper has its own coverage in auto-close.test.ts).
const CONFIG = JSON.stringify({ timezone: 'UTC', heartbeat: { clean_recheck_cooldown: null } });

interface Fixture {
  heartbeat?: string;
  alertState?: object;
  proposals?: Array<{ id: string; status: string }>;
  legacyProposal?: string; // filename → written with NO frontmatter
  microPending?: boolean;
  totalTicks?: number;
  noProposalsDir?: boolean;  // don't create proposals/ at all (ENOENT readdir path)
  proposalsAsFile?: boolean; // proposals is a regular file, not a dir (ENOTDIR readdir path)
}

function build(fix: Fixture): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hermit-hbscan-'));
  fs.mkdirSync(hermit(dir, 'state'), { recursive: true });
  if (fix.proposalsAsFile) {
    fs.writeFileSync(hermit(dir, 'proposals'), 'not a directory\n');
  } else if (!fix.noProposalsDir) {
    fs.mkdirSync(hermit(dir, 'proposals'), { recursive: true });
  }
  fs.writeFileSync(hermit(dir, 'config.json'), CONFIG);
  fs.writeFileSync(hermit(dir, 'HEARTBEAT.md'), fix.heartbeat ?? HEARTBEAT_DEFAULT);
  const alert = {
    alerts: {},
    last_digest_date: TODAY, // avoid the suppressed-digest gate pre-empting the item loop
    self_eval: {},
    total_ticks: fix.totalTicks ?? 0,
    ...(fix.alertState ?? {}),
  };
  fs.writeFileSync(hermit(dir, 'state', 'alert-state.json'), JSON.stringify(alert));
  for (const p of fix.proposals ?? []) {
    fs.writeFileSync(
      hermit(dir, 'proposals', `${p.id}-test-120000.md`),
      `---\nid: ${p.id}\nstatus: ${p.status}\ntitle: Test ${p.id}\n---\nbody\n`,
    );
  }
  if (fix.legacyProposal) {
    fs.writeFileSync(hermit(dir, 'proposals', fix.legacyProposal), 'Just a bullet, no frontmatter.\n');
  }
  if (fix.microPending) {
    fs.writeFileSync(
      hermit(dir, 'state', 'micro-proposals.json'),
      JSON.stringify({ pending: [{ id: 'MP-1', status: 'pending', tier: 1 }] }),
    );
  }
  return dir;
}

async function verdict(dir: string, peek = false): Promise<string> {
  const r = await runScript('heartbeat-precheck.ts', {
    args: [...(peek ? ['--peek'] : []), '.claude-code-hermit'],
    cwd: dir,
    env: { HERMIT_NOW: NOW },
  });
  return r.stdout.trim();
}

const suppressed = (id: string, consecutive_clean = 0) => ({
  [`proposal-pending:${id}`]: { suppressed: true, consecutive_clean, count: 6 },
});

describe('default proposal-scan resolution', () => {
  test('1. proposed proposal with no alert → EVALUATE', async () => {
    const dir = build({ proposals: [{ id: 'PROP-001', status: 'proposed' }] });
    expect(await verdict(dir)).toBe('EVALUATE');
  });

  test('2. proposed + suppressed alert (digest sent today) → OK', async () => {
    const dir = build({
      proposals: [{ id: 'PROP-001', status: 'proposed' }],
      alertState: { alerts: suppressed('PROP-001') },
    });
    expect(await verdict(dir)).toBe('OK');
  });

  test('3. suppressed but consecutive_clean > 0 (resolving) → EVALUATE', async () => {
    const dir = build({
      proposals: [{ id: 'PROP-001', status: 'proposed' }],
      alertState: { alerts: suppressed('PROP-001', 1) },
    });
    expect(await verdict(dir)).toBe('EVALUATE');
  });

  test('4. no proposed proposals, no alerts → OK (the headline win)', async () => {
    const dir = build({ proposals: [{ id: 'PROP-001', status: 'accepted' }] });
    expect(await verdict(dir)).toBe('OK');
  });

  test('5. no proposed but stale proposal-pending alert → EVALUATE (resolution cleanup)', async () => {
    const dir = build({
      proposals: [{ id: 'PROP-002', status: 'accepted' }],
      alertState: { alerts: suppressed('PROP-002') },
    });
    expect(await verdict(dir)).toBe('EVALUATE');
  });

  test('6. clean scan but a tier-1 micro-proposal is pending → EVALUATE (gate precedes item loop)', async () => {
    const dir = build({ microPending: true });
    expect(await verdict(dir)).toBe('EVALUATE');
  });

  test('7. clean scan but 20-tick self-eval is due → EVALUATE (gate precedes item loop)', async () => {
    const dir = build({ totalTicks: 19 }); // non-peek increments to 20 → self-eval
    expect(await verdict(dir)).toBe('EVALUATE');
  });

  test('8. legacy proposal file with no frontmatter → EVALUATE (fail-open)', async () => {
    const dir = build({ legacyProposal: 'PROP-006.md' });
    expect(await verdict(dir)).toBe('EVALUATE');
  });

  test('9. custom non-proposal item without a suppressed entry → EVALUATE (generic rule intact)', async () => {
    const dir = build({ heartbeat: '# Heartbeat\n\n- Check disk usage under 90%\n' });
    expect(await verdict(dir)).toBe('EVALUATE');
  });

  test('10. --peek writes nothing to alert-state.json', async () => {
    const dir = build({ proposals: [{ id: 'PROP-001', status: 'accepted' }] });
    const p = hermit(dir, 'state', 'alert-state.json');
    const before = fs.readFileSync(p, 'utf8');
    await verdict(dir, true);
    expect(fs.readFileSync(p, 'utf8')).toBe(before);
  });

  test('empty proposals dir with no alerts → OK', async () => {
    const dir = build({});
    expect(await verdict(dir)).toBe('OK');
  });

  test('11. missing proposals/ dir, no lingering alert → OK (ENOENT is not ambiguous)', async () => {
    const dir = build({ noProposalsDir: true });
    expect(await verdict(dir)).toBe('OK');
  });

  test('12. proposals/ is a regular file (ENOTDIR readdir error) → EVALUATE (fail-open, never a false OK)', async () => {
    const dir = build({ proposalsAsFile: true });
    expect(await verdict(dir)).toBe('EVALUATE');
  });
});

// Coherence guard: the whole optimization hinges on isProposalScanItem matching
// the item shipped in HEARTBEAT.md.template. If a future template reword drops the
// `proposed` keyword (or the `proposals/` reference), the classifier stops matching
// the default, the item silently falls back to the generic alert path, and the
// wasted-dispatch bug returns with only the 6h damper capping it. Pin them together
// so a template edit that breaks the match fails here instead of shipping silently.
describe('shipped HEARTBEAT.md.template ↔ classifier coherence', () => {
  test('the shipped default proposal-scan item matches isProposalScanItem', () => {
    const tpl = fs.readFileSync(
      path.join(PLUGIN_ROOT, 'state-templates', 'HEARTBEAT.md.template'), 'utf8',
    );
    const bullets = tpl.split('\n').map(l => l.trim()).filter(l => /^[-*+]\s/.test(l));
    const proposalItem = bullets.find(l => /proposals/i.test(l));
    expect(proposalItem).toBeDefined();
    expect(isProposalScanItem(proposalItem!)).toBe(true);
  });
});
