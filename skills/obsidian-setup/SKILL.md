---
name: obsidian-setup
description: Set up the Hermit Cortex — an Obsidian vault surface over your hermit's state. Creates the obsidian/ directory with Brain, Cortex, Evolution, System Health, Connections, and Cortex Portal pages. Run once per project.
---

# Obsidian Setup

Sets up the Hermit Cortex in the current project. Safe to re-run — see `--force` scope below.

Pass `--reconfigure-manifest` to re-run only the artifact path discovery wizard (updates `cortex-manifest.json` and rebuilds Connections.md).

## Step 1 — Check prerequisites

1. Read `.claude-code-hermit/config.json` to confirm the hermit is hatched.
2. If `.claude-code-hermit/` does not exist, stop: "Run `/claude-code-hermit:hatch` first."
3. Check whether an `obsidian/` directory already exists by using `Glob("obsidian/*.md")` — if it returns results, the Cortex is already set up.
   - If it exists and neither `--force` nor `--reconfigure-manifest` was passed: list existing pages and ask: "Obsidian Cortex already set up. Use `--force` to overwrite static pages, or `--reconfigure-manifest` to update artifact paths."
   - If `--force` was passed: proceed (static pages will be replaced).
   - If `--reconfigure-manifest` was passed: skip to **Step 4** directly.

**`--force` scope:**

| Component                                              | Default            | `--force`                                |
| ------------------------------------------------------ | ------------------ | ---------------------------------------- |
| Static pages (Brain, Cortex, Evolution, System Health) | Skip if exists     | Overwrite                                |
| `cortex-manifest.json`                                 | Skip if exists     | Skip (operator-managed, never overwrite) |
| Connections.md / Cortex Portal.md                      | Always regenerated | Always regenerated                       |

## Step 2 — Set path mode

Set `HERMIT_PATH = .claude-code-hermit`.

## Step 3 — Copy templates

For each template in `${CLAUDE_PLUGIN_ROOT}/state-templates/obsidian/`:

- Replace `{{GENERATED_AT}}` with current ISO timestamp
- Write to `obsidian/<template-name-without-.template>` in the project root
- Skip files that already exist (unless `--force`)

Templates to copy:

- `Brain.md.template` → `obsidian/Brain.md`
- `Cortex.md.template` → `obsidian/Cortex.md`
- `Evolution.md.template` → `obsidian/Evolution.md`
- `System Health.md.template` → `obsidian/System Health.md`
- `Connections.md.template` → `obsidian/Connections.md` (header only — body generated in step 5)
- `Cortex Portal.md.template` → `obsidian/Cortex Portal.md` (header only — body generated in step 5)

## Step 4 — Generate cortex-manifest.json

If `.claude-code-hermit/cortex-manifest.json` does not exist (first run):

1. Scan the project root for candidate artifact paths using these heuristics:
   - Directories containing 2+ `.md` files (exclude `.git`, `node_modules`, `.claude-code-hermit`, `.claude`, `obsidian`, `.vscode`, `.github`)
   - Root-level `.md` files with existing YAML frontmatter (stronger signal than bare `.md`)
   - Root-level `.md` files matching date-like patterns (e.g. `*-2026-*.md`, `*-YYYY-*.md`)
   - Always include `.claude-code-hermit/compiled` as a default path — this is where durable domain outputs live and should always be indexed.
2. If candidates found, present them to the operator:
   ```
   questions: [
     {
       header: "Artifacts",
       question: "These directories and files look like hermit-produced content. Files in these paths will appear in Connections.md and the Obsidian graph:\n{candidate_list}\nConfirm, edit, or skip.",
       options: [
         { label: "Confirm as-is", description: "Use all listed paths" },
         { label: "Skip", description: "Empty artifact_paths — add later via --reconfigure-manifest" }
       ]
     }
   ]
   ```

   - If "Confirm as-is": use all candidates
   - If free text typed via Other: parse as the operator's edited list
   - If "Skip": write empty `artifact_paths: []`
3. Let the operator confirm, add, remove, or skip entirely.
4. Write `.claude-code-hermit/cortex-manifest.json` with confirmed paths. If operator skips: write with an empty `artifact_paths` array.

If `.claude-code-hermit/cortex-manifest.json` already exists and `--reconfigure-manifest` was passed:

1. Read the current file and show the operator the existing `artifact_paths` as the starting point.
2. Re-run the scan for any new candidate paths not already in the manifest.
3. Present existing + new candidates:
   ```
   questions: [
     {
       header: "Artifacts",
       question: "Current paths: {existing}\nNew candidates found: {new_candidates}\nConfirm, edit, or reset.",
       options: [
         { label: "Confirm all", description: "Keep existing paths and add new candidates" },
         { label: "Keep current", description: "Ignore new candidates, keep only existing" },
         { label: "Reset", description: "Clear all artifact paths and start fresh" }
       ]
     }
   ]
   ```
4. Write the updated manifest. Then skip to **Step 5** (generate dynamic pages) and stop after — skip steps 6–7.

If file already exists and `--reconfigure-manifest` was NOT passed: skip this step.

## Step 5 — Generate dynamic pages

Run:

```
node ${CLAUDE_PLUGIN_ROOT}/scripts/build-cortex.js .claude-code-hermit obsidian .
```

This overwrites `obsidian/Connections.md` and `obsidian/Cortex Portal.md` with generated content based on current session, proposal, and artifact data.

## Step 5b — Create Latest Review placeholder

If `obsidian/Latest Review.md` does not exist, write a placeholder:

```markdown
# Latest Review

> No weekly review has run yet. Run `/claude-code-hermit:weekly-review` manually, or enable the `weekly-review` routine in config.json.
```

This file is overwritten by `scripts/weekly-review.js` on first run — the placeholder simply prevents dangling wikilinks in Cortex.md and Cortex Portal.md.

## Step 6 — Add cortex-refresh routine

Read `.claude-code-hermit/config.json`. Check if a routine with `id: "cortex-refresh"` already exists.

- If not: append to the `routines` array:
  ```json
  {
    "id": "cortex-refresh",
    "schedule": "30 23 * * *",
    "skill": "claude-code-hermit:cortex-refresh",
    "enabled": true
  }
  ```
- If it exists: skip (no duplicate).

Write the updated config.json back atomically (write to `state/.config.json.tmp`, rename to `config.json`).

## Step 7 — Print first-run instructions

```
Hermit Cortex created in obsidian/

  Operator view into your hermit's current state and evolution.

  First look:
  1. Open your repo root as an Obsidian vault (if not already)
  2. Install the FolderBridge community plugin — required for Dataview to read .claude-code-hermit/
     https://github.com/tescolopio/Obsidian_FolderBridge
  3. Open obsidian/Brain.md — live session, fragile zones, what needs attention
  4. Open obsidian/Cortex.md — uncertainty, stability, regressions, operator dependence
  5. Open obsidian/Cortex Portal.md → right-click tab → Open local graph
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
    Update paths anytime: /claude-code-hermit:obsidian-setup --reconfigure-manifest

  Connections refresh nightly at 23:30.

  To enrich existing content with frontmatter and tags:
    /claude-code-hermit:cortex-sync
```

Note: At session 1, Brain.md shows your live session and empty Dataview tables.
By session 10, Cortex.md starts showing fragile zones. By session 20, Evolution.md tells a real story.
The cortex gets more useful the longer your hermit runs.
