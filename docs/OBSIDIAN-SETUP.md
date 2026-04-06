# Obsidian Setup (Optional)

An optional read-mostly companion dashboard. Your hermit works without it.

## Quick Start

1. Open Obsidian -> "Open folder as vault" -> select the repo root
2. Add `.obsidian/` to `.gitignore`
3. **Install Folder Bridge and add .claude and .claude-code-hermit folder:** plugin (Community plugins -> Browse -> "FolderBridge")(https://github.com/tescolopio/Obsidian_FolderBridge)
4. Install the **Dataview** plugin (Community plugins -> Browse -> "Dataview")
5. Create `dashboard.md` at the repo root (add to `.gitignore`) and paste:

````markdown
## Sessions

```dataview
TABLE status, date, duration, cost_usd AS "Cost", tags
FROM ".claude-code-hermit/sessions"
WHERE id
SORT date DESC
```

## Proposals

```dataview
TABLE status, source, category, session, created
FROM ".claude-code-hermit/proposals"
WHERE id
SORT created DESC
```

## Agent Health

```dataview
TABLE active_alerts, suppressed_alerts, micro_pending, response_rate, last_reflection
FROM ".claude-code-hermit/state"
WHERE file.name = "state-summary"
```
````

7. Pin SHELL.md in the right pane for live updates (right-click tab -> "Pin")

That's it. You now have a queryable dashboard of all sessions and proposals.

---

## Two Hard Rules

### 1. No duplicate truth

The **repo is the single source of truth**. Obsidian reads from it via live queries. If Obsidian and the repo disagree, the repo wins.

### 2. Canonical flows come from the plugin

Sessions: `session-start`, `session-close`. Proposals: `proposal-create`, `proposal-act`. Reflection: `reflect`. **Never** use Obsidian's Templater or "New note" to create session or proposal files — this bypasses lifecycle tracking.

---

## Dashboard Queries

All session reports and proposals include YAML frontmatter with structured metadata. Dataview reads these fields directly — no wikilinks needed.

### Session History

````markdown
```dataview
TABLE status, date, duration, cost_usd AS "Cost", tags
FROM ".claude-code-hermit/sessions"
WHERE id
SORT date DESC
```
````

### Proposal Pipeline

````markdown
```dataview
TABLE status, source, category, session, created
FROM ".claude-code-hermit/proposals"
WHERE id AND (status = "proposed" OR status = "accepted")
SORT source DESC, created ASC
```
````

### All Proposals (including dismissed/resolved)

````markdown
```dataview
TABLE status, source, category, session, created
FROM ".claude-code-hermit/proposals"
WHERE id
SORT created DESC
```
````

### Sessions That Generated Proposals

````markdown
```dataview
TABLE date, status, proposals_created
FROM ".claude-code-hermit/sessions"
WHERE id AND length(proposals_created) > 0
SORT date DESC
```
````

### Cost Dashboard

````markdown
```dataview
TABLE date, cost_usd AS "Cost", duration, tags
FROM ".claude-code-hermit/sessions"
WHERE id AND date >= date(today) - dur(7 days)
SORT date DESC
```
````

For aggregated cost data, embed the cost summary file:

```markdown
![[.claude-code-hermit/cost-summary]]
```

### Live Session Embed

```markdown
![[.claude-code-hermit/tasks-snapshot]]
![[.claude-code-hermit/sessions/SHELL]]
```

The tasks snapshot shows the plan steps (from native Claude Code Tasks), updated automatically by the cost-tracker hook. SHELL.md shows the narrative — progress log, blockers, findings.

### Agent Health

````markdown
```dataview
TABLE active_alerts, suppressed_alerts, micro_pending, micro_approval_rate AS "Micro Rate", response_rate, last_reflection
FROM ".claude-code-hermit/state"
WHERE file.name = "state-summary"
```
````

The `state-summary.md` file is auto-generated after every heartbeat tick, proposal action, and reflection. Embed it directly for a quick glance:

```markdown
![[.claude-code-hermit/state/state-summary]]
```

### Current Progress (from Tasks)

````markdown
```dataview
TABLE progress, updated
FROM ".claude-code-hermit"
WHERE file.name = "tasks-snapshot"
```
````

One-row table showing task progress (e.g., "3/5") and last update time. Lightweight dashboard widget.

---

## Suggested Layout

- **Left pane:** `tasks-snapshot.md` — what steps are planned, what's done
- **Right pane (pinned):** SHELL.md — what's happening, blockers, findings
- **Bottom:** `dashboard.md` — Dataview tables for history and proposals

Or embed both into your dashboard with the live session embeds above. Pin a pane: right-click tab -> "Pin".

---

## Editing OPERATOR.md in Obsidian

This is encouraged. OPERATOR.md is human-curated — no lifecycle tracking, no sequential IDs. Edit freely. Your hermit reads it fresh at every session start.

---

## Advanced: Canvas Planning

Obsidian Canvas lets you spatially arrange notes and draw connections. You can create a strategic planning surface by:

1. Create a new Canvas file (File -> New Canvas)
2. Drag OPERATOR.md priorities onto the canvas as cards
3. Drag relevant proposals (PROP-NNN.md) and link them to the priorities they address
4. Add session reports to trace "what I asked for" vs. "what actually happened"

This is a manual, operator-curated view. The hermit does not generate or modify canvas files.

---

## Advanced: Multi-Hermit Setup

If you run multiple hermit instances, you can create a cross-hermit observatory:

```
observatory/
  dev-hermit/        -> symlink to project-a/.claude-code-hermit/
  accountant-hermit/ -> symlink to project-b/.claude-code-hermit/
  dashboard.md       -> cross-hermit Dataview queries
```

Open the `observatory/` directory as an Obsidian vault. Dataview queries work across symlinked directories:

````markdown
## All Hermits — Recent Sessions

```dataview
TABLE id, status, date, cost_usd AS "Cost"
FROM ""
WHERE id AND regexmatch("^S-", id)
SORT date DESC
LIMIT 20
```
````

### Fleet Progress (from Task Snapshots)

Each hermit writes its own `tasks-snapshot.md` with structured frontmatter. Query across all of them:

````markdown
```dataview
TABLE progress, updated
FROM ""
WHERE file.name = "tasks-snapshot"
```
````

One row per hermit, live progress across the fleet.

### Fleet Health

````markdown
```dataview
TABLE active_alerts, suppressed_alerts, micro_pending, micro_approval_rate AS "Micro Rate", response_rate
FROM ""
WHERE file.name = "state-summary"
```
````

One row per hermit. Shows which agent is noisy, which is healthy, which has low proposal engagement.

For Docker always-on mode, mount the hermit state directory as a volume and symlink into the observatory vault.

---

## What NOT to Do

- Don't create session/proposal files from Obsidian (Rule 2)
- Don't edit YAML frontmatter in session reports or proposals — use skills (`/proposal-act`, `/session-close`) instead
- Don't edit `tasks-snapshot.md` — it's auto-generated by the cost-tracker hook every turn
- Don't edit `config.json` in Obsidian — use `/hermit-settings`
- Don't use `[[wikilinks]]` or `%%comments%%` in tracked files — your hermit reads standard markdown only
- Don't install plugins that modify markdown on save (Linter, Auto Link Title) — creates phantom diffs and breaks frontmatter
- Don't rename/move tracked files — your hermit expects specific paths (`S-001-REPORT.md`, `PROP-001.md`)
