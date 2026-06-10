'use strict';

const fs = require('fs');
const path = require('path');

// Kill thresholds (match the values documented in capability-brainstorm and reflect kill criteria)
const MIN_SAMPLE = 8;
const KILL_SURVIVAL_PCT = 25;
const KILL_ACCEPT_PCT = 30;

// Segment registry: discriminators for triage-survival and acceptance by autonomous source.
// triage: filter applied to `triage-verdict` events.
// accept: filter applied to `created` events (source, tags). null = not separately trackable.
// This is the single source of truth for segmentation; kill-criteria skills invoke this script
// and contract tests verify these discriminators match what the emitters write.
const SEGMENTS = [
  {
    key: 'reflect',
    triage: e => e.caller === 'reflect',
    // Ordinary reflect proposals: auto-detected but not tagged as a sub-segment
    accept: (src, tags) =>
      src === 'auto-detected' &&
      !tags.includes('capability-brainstorm') &&
      !tags.includes('procedure-capture'),
  },
  {
    key: 'capability-brainstorm',
    triage: e => e.evidence_source === 'capability-brainstorm',
    accept: (src, tags) => tags.includes('capability-brainstorm'),
  },
  {
    key: 'procedure-capture',
    triage: e => Array.isArray(e.tags) && e.tags.includes('procedure-capture'),
    accept: (src, tags) => tags.includes('procedure-capture'),
  },
  {
    key: 'scheduled-check',
    triage: e => e.caller === 'scheduled-checks',
    accept: null, // not separately tagged on created events
  },
];

function run() {
  const rawArgs = process.argv.slice(2);
  const posArgs = rawArgs.filter(a => !a.startsWith('--'));
  const stateDir = posArgs[0] || '.claude-code-hermit';
  const sourceArg = (rawArgs.find(a => a.startsWith('--source=')) || '').slice('--source='.length) || null;

  const metricsFile = path.join(stateDir, 'state', 'proposal-metrics.jsonl');
  let content;
  try {
    content = fs.readFileSync(metricsFile, 'utf-8').trim();
  } catch (err) {
    if (err.code === 'ENOENT') {
      process.stdout.write(sourceArg ? `${sourceArg}: no proposal metrics yet\n` : 'No proposal metrics yet.\n');
      return;
    }
    throw err;
  }
  if (!content) {
    process.stdout.write(sourceArg ? `${sourceArg}: no proposal metrics yet\n` : 'No proposal metrics yet.\n');
    return;
  }

  // Accumulators
  const proposalSource = {};          // proposal_id -> source string
  const proposalTags = {};            // proposal_id -> tags array
  const accepted = new Set();         // proposal_ids with action=accept
  const triageCount = {};             // key -> { create: n, total: n }
  const createdCount = {};            // key -> n
  const acceptedCount = {};           // key -> n
  for (const seg of SEGMENTS) {
    triageCount[seg.key] = { create: 0, total: 0 };
    createdCount[seg.key] = 0;
    acceptedCount[seg.key] = 0;
  }

  // Single pass over the JSONL
  for (const line of content.split('\n')) {
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    if (!e || typeof e !== 'object') continue;

    if (e.type === 'created' && e.proposal_id) {
      const src = e.source || 'unknown';
      const tags = Array.isArray(e.tags) ? e.tags : [];
      proposalSource[e.proposal_id] = src;
      proposalTags[e.proposal_id] = tags;
      for (const seg of SEGMENTS) {
        if (seg.accept && seg.accept(src, tags)) createdCount[seg.key]++;
      }
    }

    if (e.type === 'responded' && e.action === 'accept' && e.proposal_id) {
      accepted.add(e.proposal_id);
    }

    if (e.type === 'triage-verdict') {
      for (const seg of SEGMENTS) {
        if (seg.triage(e)) {
          triageCount[seg.key].total++;
          if (e.verdict === 'CREATE') triageCount[seg.key].create++;
        }
      }
    }
  }

  // Tally accepted per segment (after full pass so proposalSource/Tags are populated)
  for (const id of accepted) {
    const src = proposalSource[id] || 'unknown';
    const tags = proposalTags[id] || [];
    for (const seg of SEGMENTS) {
      if (seg.accept && seg.accept(src, tags)) acceptedCount[seg.key]++;
    }
  }

  function statsFor(seg) {
    const t = triageCount[seg.key];
    const c = createdCount[seg.key];
    const a = acceptedCount[seg.key];
    const survivalPct = t.total > 0 ? Math.round((t.create / t.total) * 100) : null;
    const acceptPct = seg.accept ? (c > 0 ? Math.round((a / c) * 100) : null) : null;
    return { survivalPct, sN: t.create, sD: t.total, acceptPct, aN: a, aD: c };
  }

  function gateLabel(seg, s) {
    if (s.sD < MIN_SAMPLE) return `n<${MIN_SAMPLE}`;
    const kills = [];
    if (s.survivalPct !== null && s.survivalPct < KILL_SURVIVAL_PCT) kills.push(`survival<${KILL_SURVIVAL_PCT}%`);
    if (seg.accept && s.acceptPct !== null && s.acceptPct < KILL_ACCEPT_PCT) kills.push(`acceptance<${KILL_ACCEPT_PCT}%`);
    return kills.length > 0 ? `! ${kills.join(', ')}` : '-';
  }

  // --source=<key>: terse one-line verdict for kill-criteria callers
  if (sourceArg) {
    const seg = SEGMENTS.find(s => s.key === sourceArg);
    if (!seg) {
      process.stdout.write(`Unknown source key: ${sourceArg}. Valid keys: ${SEGMENTS.map(s => s.key).join(', ')}\n`);
      return;
    }
    const s = statsFor(seg);
    const survStr = s.sD === 0 ? 'triage-survival -' : `triage-survival ${s.survivalPct}% (${s.sN}/${s.sD})`;
    const accStr = seg.accept === null
      ? 'acceptance n/a'
      : (s.aD === 0 ? 'acceptance -' : `acceptance ${s.acceptPct}% (${s.aN}/${s.aD})`);
    if (s.sD < MIN_SAMPLE) {
      process.stdout.write(`${sourceArg}: ${survStr}, ${accStr}, sample ${s.sD} — INSUFFICIENT (need >=${MIN_SAMPLE} triage-verdicts to evaluate)\n`);
    } else {
      const kills = [];
      if (s.survivalPct !== null && s.survivalPct < KILL_SURVIVAL_PCT) kills.push(`triage-survival < ${KILL_SURVIVAL_PCT}%`);
      if (seg.accept && s.acceptPct !== null && s.acceptPct < KILL_ACCEPT_PCT) kills.push(`acceptance < ${KILL_ACCEPT_PCT}%`);
      const verdict = kills.length > 0 ? `KILL (${kills.join(', ')})` : 'OK';
      process.stdout.write(`${sourceArg}: ${survStr}, ${accStr}, sample ${s.sD} — ${verdict}\n`);
    }
    return;
  }

  // Default: markdown table across all segments
  const rows = SEGMENTS.map(seg => {
    const s = statsFor(seg);
    const surv = s.sD === 0 ? '-' : `${s.survivalPct}% (${s.sN}/${s.sD})`;
    const acc = seg.accept === null ? 'n/a' : (s.aD === 0 ? '-' : `${s.acceptPct}% (${s.aN}/${s.aD})`);
    return `| ${seg.key} | ${surv} | ${acc} | ${s.sD} | ${gateLabel(seg, s)} |`;
  });

  process.stdout.write(
    `### Proposal acceptance by source\n\n` +
    `| Source | Survival (CREATE/total) | Acceptance (accepted/created) | n | Gate |\n` +
    `|---|---|---|---|---|\n` +
    rows.join('\n') + '\n'
  );
}

try {
  run();
} catch (err) {
  process.stdout.write(`proposal-metrics-report: error — ${err.message}\n`);
  process.exit(0);
}
