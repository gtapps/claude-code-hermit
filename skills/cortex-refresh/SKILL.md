---
name: cortex-refresh
description: Regenerate obsidian/Connections.md from current hermit state. Runs nightly via routine and after each turn that mutates sessions/proposals. Safe to invoke manually. Cortex Portal.md is live Dataview — no rebuild needed.
---
# Cortex Refresh

Regenerates `obsidian/Connections.md` from current hermit state. `Cortex Portal.md` is a static Dataview template that updates live in Obsidian — this skill does not touch it.

## Steps

1. Verify the Cortex is set up via `Glob("obsidian/*.md")`. If it returns no results, stop: "Hermit Cortex not set up. Run `/claude-code-hermit:obsidian-setup` first."

2. Run:
   ```
   node ${CLAUDE_PLUGIN_ROOT}/scripts/build-cortex.js .claude-code-hermit obsidian .
   ```

3. Report the result: "Connections.md refreshed." (or the error output if the script failed).
