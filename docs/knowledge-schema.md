# Knowledge Schema

What this plugin writes to `.claude-code-hermit/raw/` and `.claude-code-hermit/compiled/`, and when.

## raw/

Ephemeral inputs. Archived after `knowledge.raw_retention_days`.

| Filename pattern | type frontmatter | Produced by | When |
|---|---|---|---|
| `snapshot-ha-context-<date>.json` | `snapshot` | `ha-refresh-context` | On demand or daily routine |
| `snapshot-ha-normalized-latest.json` | `snapshot` | `ha-refresh-context` | Same run; overwritten each refresh |
| `automation-<slug>-<date>.yaml` | `automation` | `ha-build-automation` | Each automation draft |
| `script-<slug>-<date>.yaml` | `script` | `ha-build-automation` | Each script draft |
| `audit-safety-<date>.md` | `audit` | `ha-safety-audit` | Weekly plugin_check |
| `audit-integration-health-<date>.md` | `audit` | `ha-integration-health` | Daily plugin_check |
| `audit-automation-errors-<date>.md` | `audit` | `ha-automation-error-review` | Daily plugin_check |
| `patterns-<date>.md` | `analysis` | `ha-analyze-patterns` | Weekly plugin_check |

## compiled/

Durable outputs. Injected into session context at startup within `compiled_budget_chars`.

| Filename pattern | type frontmatter | foundational | Produced by | When |
|---|---|---|---|---|
| `brief-morning-<date>.md` | `brief` | no | `ha-morning-brief` | Daily routine |
| `context-house-profile-<date>.md` | `context` | yes | First `ha-refresh-context` + operator input | Once; updated by hatch if house profile changes |

## Notes

- `snapshot-ha-normalized-latest.json` uses a fixed name (no date) so the safety reviewer and other tools always find the current inventory without globbing.
- Mark a compiled artifact `foundational: true` in its frontmatter to pin it to every session start regardless of age.
- Staged automation YAML lives in `raw/` until applied; after `ha-apply-change` succeeds it stays in `raw/` as the source-of-truth record (not moved to `compiled/`).
