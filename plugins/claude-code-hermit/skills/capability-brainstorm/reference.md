# Capability Brainstorm — Evaluation Reference

This file is the instruction spec for the isolated-context subagent dispatched by SKILL.md.
The subagent reads files in a fresh context (no inherited session state) and generates brainstorm
ideas. All side effects — proposal creation, channel send, artifact write — are deferred to the
calling main session, which applies them after receiving this structured return value.

The calling skill passes the following in the dispatch prompt (do not re-read or re-derive these):
- `plugin_root`: the resolved absolute plugin path. Substitute it for `<plugin_root>` below — do not use the `${CLAUDE_PLUGIN_ROOT}` token, which is not substituted in this file's content and is empty as a Bash variable.
- `skills_list`: the authoritative harness available-skills list (string — one line per skill)
- `mcp_tools`: enumerated MCP tools currently online (string from ListMcpResourcesTool)
- `channels_keys`: `config.json` `channels` key list (string)

## Inputs (read fresh — do not reuse cached values)

Read all sources concurrently — they are independent.

**Memory**
Read `MEMORY.md` (the index). For each entry whose title or description keyword-matches the
current project domain or recent session topics, read that topic file. Aim for 3–5 relevant
files; don't read the full corpus. The project domain and recent topics are the `recent_topics`
and `project_domain` fields passed in the dispatch prompt if present; otherwise infer from
`README.md` and `CLAUDE.md`.

**Capabilities** — use the values from the dispatch prompt (do not re-derive):
- `skills_list`: authoritative available-skills list.
- `mcp_tools`: enumerated MCP output.
- `channels_keys`: channels key list.
- Sibling-scan `<plugin_root>/../*/.claude-plugin/plugin.json` for plugin presence and
  version metadata only (not skill lists).

**Compiled artifacts**
Glob `.claude-code-hermit/compiled/*.md`. For files modified within the last 30 days, read the
first 15 lines only (covers frontmatter + opening paragraph). Skip files older than 30 days.

**Codebase shape**
Read repo `README.md`, `CLAUDE.md`, and `ls` of the repo root (one level deep, no recursion).

## Idea generation (max 2)

Think across all four inputs simultaneously. For each candidate idea, apply both constraints
before including it:

1. **Concrete friction** — state the operator pain in one sentence: what happens today that this
   would fix or prevent. If you cannot name a specific pain (not "combines A and B usefully"),
   discard the idea.
2. **≥2 named grounding items** — cite at least two specific items by name (e.g.,
   `memory:user_dev_workflow.md`, `mcp:Hassio.executar_bom_dia`, `skill:weekly-review`,
   `plugin:claude-code-fitness-hermit`). These are supporting evidence, not a checklist — the
   friction is the bar.

Cap at 2 ideas that pass both constraints. Return zero ideas if none do. Record discarded ideas
(one line each) in `discarded`.

Do NOT call proposal-create, write files, or send channel messages — the calling session applies
all side effects after receiving this return value.

## Return Value

Return a single JSON object — no prose, no markdown wrapping. Every field is required; use `[]`
for empty arrays, never omit a key.

The `evidence_summary` per idea is what the main session passes to `/proposal-create` (one
paragraph: friction + grounding items). The `inputs_scanned` list is for the compiled artifact
(titles/paths only, no content).

<!-- brainstorm-eval-schema:start -->
```json
{
  "ideas": [
    {
      "title": "<short idea title>",
      "description": "<one-line description>",
      "friction": "<one-sentence operator pain>",
      "grounding": ["<item 1>", "<item 2>"],
      "effort": "hours|days",
      "evidence_summary": "<one-paragraph friction + grounding for proposal-create>"
    }
  ],
  "discarded": ["<one-line discarded idea>"],
  "inputs_scanned": ["<title or path of each source scanned>"]
}
```
<!-- brainstorm-eval-schema:end -->
