---
name: story-arcs
description: >-
  Manage developing story arcs tracked across briefs — add, resolve, and list active
  arcs in compiled/story-arcs-*.md. Arc Watch keywords drive the news-brief arc-tagging
  enrichment. Invoke with /briefing-hermit:story-arcs add|resolve|list.
---

# Story Arcs

Manage the developing-story-arcs file that feeds the `news-brief` arc-tagging enrichment.

## Usage

```
/story-arcs add "<name>" [--started <YYYY-MM-DD>] [--watch "<keywords>"] [--context "<text>"]
/story-arcs resolve "<name>" [--reason "<resolution note>"]
/story-arcs list
```

## Steps

### 1. Find the active arcs file

Glob `compiled/story-arcs-*.md`. Sort by filename date suffix descending (newest first). Read the most
recent. If none exists, create `compiled/story-arcs-<today>.md` with the standard template
(frontmatter + `## Active` + `## Recently Resolved` sections).

### 2. Execute subcommand

#### add

Parse: `name` (required), `--started` (default: today, prefixed with `~`), `--watch` (optional keyword list), `--context` (optional description).

1. Check `## Active` — if an arc with the same name already exists (case-insensitive), say so and stop.
2. Append a new arc block at the end of `## Active`:
   ```
   **<name>** (started: ~<YYYY-MM-DD>)
   <context text, or "Newly surfaced — add context as it develops.">
   Watch: <watch keywords separated by semicolons, or "TBD">.
   ```
3. Write the file in-place. Reply: `Arc added: **<name>**. Update the Watch clause with /story-arcs if needed.`

#### resolve

Parse: `name` (required, case-insensitive substring match), `--reason` (optional).

1. Find the arc block in `## Active`. If not found, list close matches and stop.
2. Remove the full arc block (the `**Name** (started:...)` line + context line + Watch line).
3. Insert a one-line entry at the top of `## Recently Resolved`:
   ```
   **<name>** — <reason, or "resolved">. <today's date>
   ```
4. Write the file in-place. Reply: `Arc resolved: **<name>**. It will no longer be matched in future briefs.`

#### list

1. Display all arcs under `## Active` as a compact table: Name, start date, Watch keywords.
2. Show the count of `## Recently Resolved` entries.
3. If `## Active` is empty, say "No active arcs."

## File format reference

```markdown
---
title: Developing Story Arcs
type: story-arcs
created: <ISO 8601>
tags: [briefing, foundational]
---
Ongoing stories to track across briefs. Updated when arc status changes.

## Active

**Arc Name** (started: ~YYYY-MM-DD)
Context description. Pattern being tracked.
Watch: keyword1; keyword2; keyword3.

## Recently Resolved

**Arc Name** — resolution note. YYYY-MM-DD
```

## Notes

- Edit in-place — do not create a new dated file per edit. The brief pipeline picks the newest file by
  filename date suffix; a new file would drift from the one being actively referenced.
- Arc names are matched case-insensitively for `resolve` and `list`.
- When an arc is resolved, the `news-brief` arc cross-reference stops matching items against it
  automatically (it only reads `## Active`).
- Watch keywords drive arc-tagging in briefs — keep them specific (entity + context, not just entity alone).
