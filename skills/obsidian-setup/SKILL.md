---
name: obsidian-setup
description: Set up the Hermit Cortex — an Obsidian vault surface over your hermit's state. Creates the obsidian/ directory with Brain, Cortex, Evolution, System Health, Connections, and Cortex Portal pages. Run once per project.
---
# Obsidian Setup

Sets up the Hermit Cortex in the current project. Safe to re-run — existing pages are not overwritten unless `--force` is passed.

## Step 1 — Check prerequisites

1. Read `.claude-code-hermit/config.json` to confirm the hermit is hatched.
2. If `.claude-code-hermit/` does not exist, stop: "Run `/claude-code-hermit:hatch` first."
3. Check whether an `obsidian/` directory already exists in the project root.
   - If it exists and `--force` was NOT passed: list existing pages and ask: "Obsidian Cortex already set up. Use `--force` to overwrite existing pages."
   - If `--force` was passed: proceed (existing pages will be replaced).

## Step 2 — Detect path mode

Ask (or detect from existing `.gitignore`):

> **How does your Obsidian vault access `.claude-code-hermit/`?**
> 1. Symlink (`hermit-state -> .claude-code-hermit`) — recommended, simpler Dataview paths
> 2. Folder Bridge plugin — no symlink, use `.claude-code-hermit` paths directly

Set `HERMIT_PATH`:
- Symlink: `hermit-state`
- Folder Bridge: `.claude-code-hermit`

If choosing symlink: create `hermit-state -> .claude-code-hermit` in the project root (skip if already exists).

## Step 3 — Copy templates

For each template in `${CLAUDE_PLUGIN_ROOT}/state-templates/obsidian/`:
- Replace `{{HERMIT_PATH}}` with the resolved `HERMIT_PATH`
- Replace `{{GENERATED_AT}}` with current ISO timestamp
- Write to `obsidian/<template-name-without-.template>` in the project root
- Skip files that already exist (unless `--force`)

Templates to copy:
- `Brain.md.template` → `obsidian/Brain.md`
- `Cortex.md.template` → `obsidian/Cortex.md`
- `Evolution.md.template` → `obsidian/Evolution.md`
- `System Health.md.template` → `obsidian/System Health.md`
- `Connections.md.template` → `obsidian/Connections.md` (header only — body generated in step 4)
- `Cortex Portal.md.template` → `obsidian/Cortex Portal.md` (header only — body generated in step 4)

## Step 4 — Generate dynamic pages

Run:
```
node ${CLAUDE_PLUGIN_ROOT}/scripts/build-cortex.js .claude-code-hermit obsidian .
```

This overwrites `obsidian/Connections.md` and `obsidian/Cortex Portal.md` with generated content based on current session, proposal, and artifact data.

## Step 4b — Generate cortex-manifest.json

If `.claude-code-hermit/cortex-manifest.json` does not exist:

1. Scan the project root for candidate artifact paths using these heuristics:
   - Directories containing 2+ `.md` files (exclude `.git`, `node_modules`, `.claude-code-hermit`, `.claude`, `obsidian`, `.vscode`, `.github`)
   - Root-level `.md` files with existing YAML frontmatter (stronger signal than bare `.md`)
   - Root-level `.md` files matching date-like patterns (e.g. `*-2026-*.md`, `*-YYYY-*.md`)
2. If candidates found, present them to the operator:
   > **Artifact paths for Cortex indexing**
   > These directories and files look like hermit-produced content.
   > Files in these paths will appear in Connections.md and the Obsidian graph.
   > Confirm, edit, or skip:
   > - `relatorios/` (4 .md files)
   > - `templates/captions/` (3 .md files)
   > - `calendario-*.md` (3 files at root)
3. Let the operator confirm, add, remove, or skip entirely.
4. Write `.claude-code-hermit/cortex-manifest.json`:
   ```json
   {
     "version": 1,
     "artifact_paths": ["relatorios", "templates/captions", "calendario-*.md"]
   }
   ```
5. If operator skips: write the manifest with an empty `artifact_paths` array.

If the file already exists: skip (no overwrite).

## Step 5 — Add connections-refresh routine

Read `.claude-code-hermit/config.json`. Check if a routine with `id: "connections-refresh"` already exists.
- If not: append to the `routines` array:
  ```json
  {"id": "connections-refresh", "time": "23:30", "skill": "claude-code-hermit:connections-refresh", "enabled": true}
  ```
- If it exists: skip (no duplicate).

Write the updated config.json back atomically (write to `state/.config.json.tmp`, rename to `config.json`).

## Step 6 — Update .gitignore

Check the project root `.gitignore`. If `obsidian/` is not already present, append:
```
obsidian/
hermit-state
```

## Step 7 — Print first-run instructions

```
Hermit Cortex created in obsidian/

  Operator view into your hermit's current state and evolution.

  First look:
  1. Open your repo root as an Obsidian vault (if not already)
  2. Open obsidian/Brain.md — live session, fragile zones, what needs attention
  3. Open obsidian/Cortex.md — uncertainty, stability, regressions, operator dependence
  4. Open obsidian/Cortex Portal.md → right-click tab → Open local graph
     Session and proposal nodes radiate from the cortex pages at center.

  Pages:
    Brain.md            — live session, fragile zones, what needs attention
    Cortex.md           — uncertainty, stability, regressions, operator dependence
    Evolution.md        — first vs latest, cost trends, autonomy trajectory
    System Health.md    — agent state, alerts, incomplete sessions
    Connections.md      — relationship map: sessions ↔ proposals ↔ artifacts
    Cortex Portal.md    — graph center: links everything

  Artifact tracking:
    Files declared in cortex-manifest.json appear in Connections.md.
    Add title + created frontmatter to connect them to the graph.

  Connections refresh nightly at 23:30.
```

Note: At session 1, Brain.md shows your live session and empty Dataview tables.
By session 10, Cortex.md starts showing fragile zones. By session 20, Evolution.md tells a real story.
The cortex gets more useful the longer your hermit runs.
