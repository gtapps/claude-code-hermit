#!/usr/bin/env node
// build-cortex.js — generates obsidian/Connections.md and obsidian/Cortex Portal.md
// Scans .claude-code-hermit/ session and proposal frontmatter to build the relationship map.
// Zero npm dependencies. Node stdlib only.
// Usage: node build-cortex.js <hermit-state-dir> [obsidian-output-dir]
//   hermit-state-dir: path to .claude-code-hermit/ in the target project (default: .claude-code-hermit)
//   obsidian-output-dir: where to write generated files (default: obsidian)

'use strict';

const fs = require('fs');
const path = require('path');
const { readFrontmatter, globDir } = require('./lib/frontmatter');

// --- Args ---
const hermitDir = process.argv[2] || '.claude-code-hermit';
const obsidianDir = process.argv[3] || 'obsidian';
const now = new Date().toISOString();

// --- Load sessions ---
const sessionsDir = path.join(hermitDir, 'sessions');
const sessionFiles = globDir(sessionsDir, /^S-\d+-REPORT\.md$/);
const sessions = sessionFiles
  .map(f => ({ file: f, fm: readFrontmatter(f) }))
  .filter(s => s.fm && s.fm.id)
  .sort((a, b) => (b.fm.date || '').localeCompare(a.fm.date || ''));

// --- Load proposals ---
const proposalsDir = path.join(hermitDir, 'proposals');
const proposalFiles = globDir(proposalsDir, /^PROP-\d+\.md$/);
const proposals = proposalFiles
  .map(f => ({ file: f, fm: readFrontmatter(f) }))
  .filter(p => p.fm && p.fm.id)
  .sort((a, b) => (a.fm.id || '').localeCompare(b.fm.id || ''));

// --- Build relationship maps ---

// sessions_to_proposals: session id -> proposal ids it created
const sessionToProps = {};
for (const s of sessions) {
  const created = s.fm.proposals_created;
  if (Array.isArray(created) && created.length > 0) {
    sessionToProps[s.fm.id] = created.filter(Boolean);
  }
}

// proposals_to_sessions: proposal id -> { origin, accepted_in }
const propToSessions = {};
for (const p of proposals) {
  const entry = {};
  // origin: from session's proposals_created or proposal's session field
  if (p.fm.session) entry.origin = p.fm.session;
  if (p.fm.accepted_in_session) entry.accepted_in = p.fm.accepted_in_session;
  // Find which session resolved this proposal (session that closed after resolved_date — heuristic)
  if (Object.keys(entry).length > 0) propToSessions[p.fm.id] = entry;
}

// Also index: for each session in proposals_created, map proposals to that session as origin
for (const [sessId, propIds] of Object.entries(sessionToProps)) {
  for (const propId of propIds) {
    if (!propToSessions[propId]) propToSessions[propId] = {};
    if (!propToSessions[propId].origin) propToSessions[propId].origin = sessId;
  }
}

// Active proposals
const activeProposals = proposals.filter(p =>
  p.fm.status === 'proposed' || p.fm.status === 'accepted'
);

// --- Generate Connections.md ---

let connectionsBody = `---
generated: true
updated: ${now}
---
# Connections

> Relationship map — how sessions and proposals connect.
> Open **local graph** (right-click this tab → Open local graph) for a visual view.

`;

// Sessions → Proposals
const sessionPropLines = Object.entries(sessionToProps)
  .sort(([a], [b]) => a.localeCompare(b));

if (sessionPropLines.length > 0) {
  connectionsBody += `## Sessions → Proposals\n`;
  for (const [sessId, propIds] of sessionPropLines) {
    const propLinks = propIds.map(p => `[[${p}]]`).join(', ');
    connectionsBody += `- [[${sessId}-REPORT]] created ${propLinks}\n`;
  }
  connectionsBody += '\n';
} else {
  connectionsBody += `## Sessions → Proposals\n_No session-proposal links yet._\n\n`;
}

// Proposals → Sessions
const propSessionEntries = Object.entries(propToSessions)
  .sort(([a], [b]) => a.localeCompare(b));

if (propSessionEntries.length > 0) {
  connectionsBody += `## Proposals → Sessions\n`;
  for (const [propId, rel] of propSessionEntries) {
    const parts = [];
    if (rel.origin) parts.push(`originated in [[${rel.origin}-REPORT]]`);
    if (rel.accepted_in) parts.push(`accepted in [[${rel.accepted_in}-REPORT]]`);
    if (parts.length > 0) {
      connectionsBody += `- [[${propId}]] — ${parts.join(', ')}\n`;
    }
  }
  connectionsBody += '\n';
} else {
  connectionsBody += `## Proposals → Sessions\n_No proposal-session links yet._\n\n`;
}

// Active proposals
if (activeProposals.length > 0) {
  connectionsBody += `## Active Proposals\n`;
  for (const p of activeProposals) {
    connectionsBody += `- [[${p.fm.id}]] — ${p.fm.status}`;
    if (p.fm.title) connectionsBody += `, ${p.fm.title}`;
    connectionsBody += '\n';
  }
  connectionsBody += '\n';
} else {
  connectionsBody += `## Active Proposals\n_No active proposals._\n\n`;
}

// --- Generate Cortex Portal.md ---

const recentSessions = sessions.slice(0, 5);
const portalSessionLinks = recentSessions.length > 0
  ? recentSessions.map(s => `- [[${s.fm.id}-REPORT]]`).join('\n')
  : '_No sessions yet._';

const portalProposalLinks = activeProposals.length > 0
  ? activeProposals.map(p => `- [[${p.fm.id}]] — ${p.fm.status}${p.fm.title ? ', ' + p.fm.title : ''}`).join('\n')
  : '_No active proposals._';

const portalBody = `---
generated: true
updated: ${now}
---
# Cortex Portal

> Graph center — links all cortex pages, recent sessions, and active proposals.
> Open **graph view** (Ctrl+G / Cmd+G) or **local graph** for the best visual.

## Cortex Pages
- [[Brain]] — live session, fragile zones, needs attention
- [[Cortex]] — mindstate: uncertainty, stability, regressions, operator dependence
- [[Evolution]] — first vs latest, cost trend, autonomy trajectory
- [[System Health]] — agent state, alerts, incomplete sessions
- [[Connections]] — relationship map: sessions ↔ proposals

## Latest Weekly Review
- [[Latest Review]]

## Recent Sessions
${portalSessionLinks}

## Active Proposals
${portalProposalLinks}
`;

// --- Write output ---
fs.mkdirSync(obsidianDir, { recursive: true });

const connectionsPath = path.join(obsidianDir, 'Connections.md');
const portalPath = path.join(obsidianDir, 'Cortex Portal.md');

fs.writeFileSync(connectionsPath, connectionsBody, 'utf8');
fs.writeFileSync(portalPath, portalBody, 'utf8');

console.log(`Connections updated: ${connectionsPath}`);
console.log(`Cortex Portal updated: ${portalPath}`);
