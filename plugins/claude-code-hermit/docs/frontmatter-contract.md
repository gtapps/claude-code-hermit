# Frontmatter Conventions

Artifacts created by hermit skills and operators should include YAML frontmatter.
Conventions for grep-ability and future tooling — not enforced by a validator.

## Core field rules (all artifacts)

| Field | Required | Notes |
|---|---|---|
| `title` | Yes | Human-readable name |
| `created` | Yes | ISO 8601 with timezone offset: `2026-04-08T14:20:00+01:00`. No bare dates. |
| `tags` | Yes | Array of lowercase strings. Reuse existing vocabulary; 1–2 per document. |
| `type` | For `compiled/` and `raw/` | Discriminator — startup injection groups `compiled/` by `type`, newest wins. |
| `source` | If applicable | `session` \| `interactive` \| `routine` \| `manual` |
| `session` | If inside a session | `S-NNN` format |

Field names: lowercase with underscores. Flat only — no nested objects. Use `null` for absent lifecycle fields (e.g., `resolved_date: null`).

## Per-type required fields

**Session report** (`sessions/S-NNN-REPORT.md`): `id`, `status`, `date`, `duration`, `cost_usd`, `tags`, `proposals_created`, `task`, `escalation`, `operator_turns`. Optional: `closed_via` (`operator` | `auto`; absent in legacy reports — treat as `operator`).

**Proposal** (`proposals/PROP-NNN-<slug>-HHMMSS.md`): `id`, `title`, `status`, `source`, `created`, `category`

**Weekly review** (`compiled/review-weekly-YYYY-Www.md`): `type: review`, `title`, `created`, `tags`, `generated: true`, `week`, `sessions_count`, `proposals_created`, `proposals_accepted`, `proposals_resolved`, `total_cost_usd`, `total_tokens`, `avg_session_cost_usd`, `avg_session_tokens`, `self_directed_rate`

**Knowledge artifact** (`raw/` or `compiled/`): `title`, `created`, `type`, `tags`. Add `session` when inside a session. `foundational` tag keeps compiled artifacts injected at every session start regardless of age. Optional `injection_stub` — when set on a `compiled/` artifact, startup injection emits this verbatim string in place of the (truncated) body, and `knowledge-lint` no longer flags the artifact as oversized. Intended for large foundational artifacts where a short pointer ("read compiled/X.md for detail") beats a mid-sentence slice. Keep it short (under the per-type budget) and avoid any `#` preceded by whitespace (the frontmatter parser strips `\s+#...` as an inline comment).

Full per-field schemas are embedded in the scripts and agents that produce each type (`session-mgr`, `proposal-create`, `scripts/weekly-review.js`). Those are authoritative.
