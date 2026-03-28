# Obsidian Setup (Optional)

An optional read-mostly companion dashboard. Your hermit works without it.

---

## Two Hard Rules

### 1. No duplicate truth

The **repo is the single source of truth**. Obsidian reads from it via live queries. If Obsidian and the repo disagree, the repo wins.

### 2. Canonical flows come from the plugin

Sessions: `session-start`, `session-close`. Proposals: `proposal-create`, `proposal-act`. Reflection: `reflect`. **Never** use Obsidian's Templater or "New note" to create session or proposal files — this bypasses lifecycle tracking.

---

## Setup

1. Open Obsidian -> "Open folder as vault" -> select the repo root
2. Add `.obsidian/` to `.gitignore`
3. Install the **Dataview** plugin — the only plugin you need

---

## Dashboard

Create `dashboard.md` at the repo root (add to `.gitignore`).

### Session table

````markdown
```dataview
TABLE Status, Date, Duration, Task, Cost
FROM ".claude/.claude-code-hermit/sessions"
WHERE file.name != "SHELL" AND file.name != ".gitkeep"
SORT file.name DESC
```
````

### Proposal table

````markdown
```dataview
TABLE Status, Source, Session, Created
FROM ".claude/.claude-code-hermit/proposals"
WHERE file.name != ".gitkeep"
SORT file.name ASC
```
````

### Live session embed

```markdown
![[.claude/.claude-code-hermit/sessions/SHELL]]
```

---

## Suggested Layout

- **Right pane (pinned):** SHELL.md — updates live as your hermit works
- **Left pane:** `dashboard.md` — Dataview tables for history and proposals

Pin a pane: right-click tab -> "Pin".

---

## Editing OPERATOR.md in Obsidian

This is encouraged. OPERATOR.md is human-curated — no lifecycle tracking, no sequential IDs. Edit freely. Your hermit reads it fresh at every session start.

---

## What NOT to Do

- Don't create session/proposal files from Obsidian (Rule 2)
- Don't edit `config.json` in Obsidian — use `/hermit-settings`
- Don't use `[[wikilinks]]` or `%%comments%%` in tracked files — your hermit reads standard markdown only
- Don't install plugins that modify markdown on save (Linter, Auto Link Title) — creates phantom diffs and breaks inline field format
- Don't rename/move tracked files — your hermit expects specific paths (`S-001-REPORT.md`, `PROP-001.md`)
