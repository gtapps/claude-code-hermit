# Knowledge Schema

What this plugin writes to `.claude-code-hermit/raw/` and `.claude-code-hermit/compiled/`, and when.

For the canonical four-bucket convention (`raw/`, `compiled/`, `state/`, `proposals/`) and general frontmatter requirements, see `docs/artifact-naming.md` in `claude-code-hermit`.

## Frontmatter

All Markdown artifacts must include these fields (in this order):

```yaml
title: <human-readable title>
type: <see tables below>
created: <ISO 8601 with offset, e.g. 2026-04-24T09:00:00+00:00>
session: <S-NNN from runtime.json, or null when no active session>
tags: [<comma-separated list>]
```

Additional domain-specific fields (e.g. `entity_count`, `violations`) follow after `tags`.

## raw/

Ephemeral inputs and rolling snapshots. Archived after `knowledge.raw_retention_days`.

| Filename pattern | type frontmatter | Produced by | When |
|---|---|---|---|
| `snapshot-ha-context-<date>.json` | `snapshot` | `ha-refresh-context` | On demand or daily routine |
| `snapshot-ha-normalized-latest.json` | `snapshot` | `ha-refresh-context` | Same run; overwritten each refresh (fixed name) |
| `automation-<slug>-<date>.yaml` | `automation` | `ha-build-automation` | Each automation draft |
| `script-<slug>-<date>.yaml` | `script` | `ha-build-automation` | Each script draft |
| `audit-ha-safety-<date>.md` | `audit` | `ha-safety-audit` | Weekly scheduled check |
| `audit-ha-integration-health-<date>.md` | `audit` | `ha-integration-health` | Daily scheduled check |
| `audit-ha-automation-errors-<date>.md` | `audit` | `ha-automation-error-review` | Daily scheduled check |
| `audit-ha-context-refresh-<date>.md` | `audit` | `ha-refresh-context` | Each context refresh |
| `audit-ha-simulation-<slug>-<date>.md` | `simulation` | `ha-simulate` | Each simulation run |
| `audit-ha-apply-<slug>-<date>.md` | `apply` | `ha-apply-change` | Each apply run |
| `patterns-<date>.md` | `analysis` | `ha-analyze-patterns` | Weekly scheduled check |
| `snapshot-ha-pattern-analysis-<date>.json` | `snapshot` | `ha-analyze-patterns` | Weekly scheduled check |

## compiled/

Durable outputs. Injected into session context at startup within `compiled_budget_chars`.

| Filename pattern | type frontmatter | foundational | Produced by | When |
|---|---|---|---|---|
| `brief-morning-<date>.md` | `brief` | no | `ha-morning-brief` | Daily routine |
| `context-house-profile-<date>.md` | `context` | yes | First `ha-refresh-context` + operator input | Once; updated when house profile changes |

## Notes

- `snapshot-ha-normalized-latest.json` uses a fixed name (no date) so the safety reviewer and other tools always find the current inventory without globbing.
- `-latest.{md,json}` siblings (e.g. `audit-ha-safety-latest.md`) are fixed-name copies of the most recent dated file. Readers that want the latest use the fixed name; the dated file is the archival record.
- Mark a compiled artifact `foundational: true` in its frontmatter to pin it to every session start regardless of age.
- Staged automation YAML lives in `raw/` until applied; after `ha-apply-change` succeeds it stays in `raw/` as the source-of-truth record (not moved to `compiled/`).
- JSON artifacts do not carry frontmatter.
