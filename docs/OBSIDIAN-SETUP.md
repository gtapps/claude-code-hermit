# Obsidian Setup (Optional)

You can use Obsidian as a read-mostly companion dashboard for claude-code-hermit. This is entirely optional -- the agent works without it.

---

## Hard Rules

Before anything else, internalize these two rules. They are non-negotiable.

### Rule 1: No duplicate truth

The **repo is the single source of truth** for all state: sessions, proposals, OPERATOR.md, CLAUDE.md, templates, and agent/skill definitions.

Obsidian reads from the repo via live queries. It does not own any data. If Obsidian and the repo disagree, **the repo wins**. Do not manually edit session files, proposal files, or templates through Obsidian in ways that bypass the agent's lifecycle tracking.

### Rule 2: Canonical creation flows come from the plugin, not Obsidian

- Sessions are created by the `session-start` skill or the `session-mgr` agent.
- Proposals are created by the `proposal-create` skill.
- Proposals are triaged via `proposal-act` (accept, defer, dismiss).
- Patterns are detected by `pattern-detect` at session close.

**Never** use Obsidian's Templater plugin, "New note" button, or any other Obsidian mechanism to create session or proposal files. Doing so bypasses the sequential ID assignment, lifecycle hooks, and state tracking that the plugin relies on. The files will exist, but the agent will not recognize them as legitimate.

---

## Opening the Repo as an Obsidian Vault

Point Obsidian directly at the repo root:

1. Open Obsidian
2. Choose "Open folder as vault"
3. Select the repo directory (the one containing `CLAUDE.md`, `OPERATOR.md`, etc.)

That's it. Obsidian will create its `.obsidian/` config folder inside the repo -- add it to `.gitignore`:

```
# .gitignore
.obsidian/
```

> **Note:** The plugin's `init` skill already appends some entries to `.gitignore` (see `state-templates/GITIGNORE-APPEND.txt`). Verify `.obsidian/` and `dashboard.md` are covered after running init.

---

## Recommended Plugins

**Install Dataview. That is the only plugin you need.**

Dataview lets you write live queries over your markdown files, which is the backbone of the dashboard experience.

Do not install other community plugins unless you are certain they do not modify markdown files on save (see the "What NOT to Do" section below).

---

## Dataview Dashboard Snippets

Create a file called `dashboard.md` at the repo root (add it to `.gitignore` so it stays local). Paste these snippets in.

> **Important:** Session reports and proposals use inline markdown fields (`**Key:** Value`), not YAML frontmatter. Dataview parses these automatically, but field names are case-sensitive and must match the bold text exactly.

### Session Table

Lists all archived session reports, sorted by ID descending:

````markdown
```dataview
TABLE
  Status as "Status",
  Date as "Date",
  Duration as "Duration",
  Mission as "Mission",
  Cost as "Cost"
FROM ".claude/.claude-code-hermit/sessions"
WHERE file.name != "ACTIVE" AND file.name != ".gitkeep"
SORT file.name DESC
```
````

### Proposal Table

Lists all proposals with their status and source:

````markdown
```dataview
TABLE
  Status as "Status",
  Source as "Source",
  Session as "Session",
  Created as "Created"
FROM ".claude/.claude-code-hermit/proposals"
WHERE file.name != ".gitkeep"
SORT file.name ASC
```
````

### Active Session Embed

Embeds the current active session directly in the dashboard:

```markdown
![[.claude/.claude-code-hermit/sessions/ACTIVE]]
```

This updates live as the agent modifies `ACTIVE.md`.

### Config Quick-View (Optional)

If you want a glance at the project's hermit config:

```markdown
![[.claude/.claude-code-hermit/config.json]]
```

---

## Suggested Layout

A practical two-pane layout:

- **Right pane (pinned):** `.claude/.claude-code-hermit/sessions/ACTIVE.md` -- updates live as the agent works (including heartbeat ticks and monitoring in always-on mode).
- **Left pane:** `dashboard.md` -- the Dataview tables showing session history and proposal status.

To pin a pane in Obsidian: right-click the tab and select "Pin". Pinned tabs stay open when you navigate elsewhere.

### Alternative: Three-pane layout

- **Left:** `dashboard.md`
- **Center:** Whatever file you're reading or editing (`OPERATOR.md`, a proposal, a session report)
- **Right (pinned):** `.claude/.claude-code-hermit/sessions/ACTIVE.md`

---

## What NOT to Do

These will cause problems:

- **Do not create session or proposal files from Obsidian.** Use the plugin skills: `session-start`, `session-close`, `proposal-create`, `proposal-act`, `pattern-detect`. (This is Rule 2.)
- **Do not edit `config.json` in Obsidian.** Use `/claude-code-hermit:hermit-settings` or `/claude-code-hermit:upgrade` to modify configuration. Manual edits risk malformed JSON or missing required fields.
- **Do not create notes outside the plugin's directory structure.** The agent expects files in `.claude/.claude-code-hermit/sessions/`, `.claude/.claude-code-hermit/proposals/`, `.claude/.claude-code-hermit/templates/`, and `.claude/`. Random notes at the repo root or in custom folders will not be tracked and may confuse the agent's orientation.
- **Do not use Obsidian-specific syntax in tracked files.** Obsidian supports `[[wikilinks]]`, `%%comments%%`, callouts, and other non-standard markdown. Do not add these to files the agent reads (`CLAUDE.md`, `OPERATOR.md`, session files, proposals). The agent processes standard markdown only.
- **Do not install plugins that modify markdown on save.** Some plugins (Linter, Auto Link Title, various formatters) rewrite markdown files when you save them. This creates phantom git diffs, can break the inline field format (`**Key:** Value`) that Dataview and the agent rely on, and will conflict with the agent's own edits. If you must use such plugins, configure them to exclude `.claude/.claude-code-hermit/`.
- **Do not use Obsidian's rename/move functionality on tracked files.** The agent expects files at specific paths with specific naming conventions (e.g., `S-001-REPORT.md`, `PROP-001.md`). Moving or renaming them in Obsidian will break references.

---

## Editing OPERATOR.md in Obsidian

This IS encouraged.

`OPERATOR.md` is a human-curated file -- it is meant to be edited by you, not by the agent. Obsidian provides a comfortable editing experience with live preview, and since `OPERATOR.md` has no lifecycle tracking or sequential IDs, there is no risk of bypassing the plugin's creation flows.

Edit it freely. The agent reads it fresh at every session start.
