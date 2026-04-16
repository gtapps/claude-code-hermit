---
name: knowledge
model: haiku
description: Knowledge base maintenance — lint raw/ and compiled/ for stale, unreferenced, missing-type, and oversized artifacts. Read-only report with actionable advice. Activates on messages like "check knowledge", "lint knowledge", "knowledge health".
---
# Knowledge Maintenance

Read-only lint of the hermit's knowledge directories. Reports findings without modifying any files.

## Subcommands

```
/claude-code-hermit:knowledge          — lint (default)
/claude-code-hermit:knowledge lint     — same
```

## lint

Run the shared lint script:

```bash
node scripts/knowledge-lint.js .claude-code-hermit
```

The script path is relative to the plugin install directory. Use `Bash` to execute it.

Present the script output to the operator as-is — it already formats findings grouped by type with file paths, ages, and actionable advice.

If the script exits cleanly with "Knowledge base is clean", relay that message. If it reports findings, relay the full output.

## Scope

Never touches: OPERATOR.md, knowledge-schema.md, config.json, proposals/, sessions/, state/

This skill is strictly read-only. It does not move, delete, or modify any files.
