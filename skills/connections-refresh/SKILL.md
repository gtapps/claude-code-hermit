---
name: connections-refresh
description: Regenerate obsidian/Connections.md and obsidian/Cortex Portal.md from current session and proposal data. Runs nightly via routine. Safe to invoke manually.
---
# Connections Refresh

Regenerates the two dynamic Obsidian pages from current hermit state.

## Steps

1. Verify `obsidian/` exists in the project root. If not, stop: "Hermit Cortex not set up. Run `/claude-code-hermit:obsidian-setup` first."

2. Run:
   ```
   node ${CLAUDE_PLUGIN_ROOT}/scripts/build-cortex.js .claude-code-hermit obsidian
   ```

3. Report the result: "Connections updated." (or the error output if the script failed).
