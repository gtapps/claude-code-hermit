#!/usr/bin/env node
// build-cortex.js — generates obsidian/Connections.md
// Scans .claude-code-hermit/ session and proposal frontmatter to build the relationship map.
// Zero npm dependencies. Node stdlib only.
// Usage: node build-cortex.js <hermit-state-dir> [obsidian-output-dir] [project-root]
//   hermit-state-dir: path to .claude-code-hermit/ in the target project (default: .claude-code-hermit)
//   obsidian-output-dir: where to write generated files (default: obsidian)
//   project-root: project root for resolving artifact paths in cortex-manifest.json (default: .)

'use strict';

const fs = require('fs');
const path = require('path');
const { readFrontmatter, globDir, resolveArtifactPath } = require('./lib/frontmatter');

// --- Args ---
const hermitDir = process.argv[2] || '.claude-code-hermit';
const obsidianDir = process.argv[3] || 'obsidian';
const projectRoot = process.argv[4] || '.';
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

// --- Load artifacts from cortex-manifest.json ---
const manifestPath = path.join(hermitDir, 'cortex-manifest.json');
let artifactsBySession = {};   // session id -> [{file, fm}]
let artifactsByProposal = {};  // proposal id -> [{file, fm}]
let domainArtifacts = [];      // frontmatter but no session/proposal
let unlinkedFiles = [];        // no frontmatter at all

try {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  if (Array.isArray(manifest.artifact_paths) && manifest.artifact_paths.length > 0) {
    const seen = new Set();
    for (const entry of manifest.artifact_paths) {
      const files = resolveArtifactPath(projectRoot, entry);
      for (const f of files) {
        const abs = path.resolve(f);
        if (seen.has(abs)) continue;
        seen.add(abs);
        const fm = readFrontmatter(f);
        if (!fm) {
          unlinkedFiles.push({ file: f });
          continue;
        }
        const artifact = { file: f, fm };
        let linked = false;
        if (fm.session) {
          const sid = fm.session;
          if (!artifactsBySession[sid]) artifactsBySession[sid] = [];
          artifactsBySession[sid].push(artifact);
          linked = true;
        }
        if (fm.proposal) {
          const pid = fm.proposal;
          if (!artifactsByProposal[pid]) artifactsByProposal[pid] = [];
          artifactsByProposal[pid].push(artifact);
          linked = true;
        }
        if (!linked) domainArtifacts.push(artifact);
      }
    }
  }
} catch { /* no manifest or invalid json — skip artifact scanning */ }

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

function wikilink(artifact) {
  const stem = path.basename(artifact.file, '.md');
  const title = artifact.fm && artifact.fm.title;
  return title ? `[[${stem}]] — ${title}` : `[[${stem}]]`;
}

// --- Generate Connections.md ---

let connectionsBody = `---
generated: true
updated: ${now}
---
# Connections

> Relationship map — how sessions, proposals, and artifacts connect.
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

// Sessions → Artifacts
const sessionArtLines = Object.entries(artifactsBySession)
  .sort(([a], [b]) => a.localeCompare(b));

if (sessionArtLines.length > 0) {
  connectionsBody += `## Sessions → Artifacts\n`;
  for (const [sessId, arts] of sessionArtLines) {
    const links = arts.map(a => wikilink(a)).join(', ');
    connectionsBody += `- [[${sessId}-REPORT]] produced ${links}\n`;
  }
  connectionsBody += '\n';
}

// Proposals → Artifacts
const propArtLines = Object.entries(artifactsByProposal)
  .sort(([a], [b]) => a.localeCompare(b));

if (propArtLines.length > 0) {
  connectionsBody += `## Proposals → Artifacts\n`;
  for (const [propId, arts] of propArtLines) {
    const links = arts.map(a => wikilink(a)).join(', ');
    connectionsBody += `- [[${propId}]] produced ${links}\n`;
  }
  connectionsBody += '\n';
}

// Domain Artifacts (frontmatter but no session/proposal link)
if (domainArtifacts.length > 0) {
  connectionsBody += `## Domain Artifacts\n`;
  for (const a of domainArtifacts) {
    connectionsBody += `- ${wikilink(a)}\n`;
  }
  connectionsBody += '\n';
}

// Unlinked Files (no frontmatter at all)
if (unlinkedFiles.length > 0) {
  connectionsBody += `## Unlinked Files\n`;
  connectionsBody += `_Files in artifact paths without frontmatter — add \`title\` and \`created\` to connect them._\n`;
  for (const u of unlinkedFiles) {
    connectionsBody += `- ${wikilink(u)}\n`;
  }
  connectionsBody += '\n';
}

// --- Write output ---
fs.mkdirSync(obsidianDir, { recursive: true });

const connectionsPath = path.join(obsidianDir, 'Connections.md');

fs.writeFileSync(connectionsPath, connectionsBody, 'utf8');

console.log(`Connections updated: ${connectionsPath}`);
