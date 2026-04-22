# Frontmatter Contract

Stable frontmatter contract for all cortex-relevant files. Flexible body content — this document standardizes only what the cortex, graph, reviews, and tooling actually depend on.

**Scope:** Session reports, proposals, weekly reviews, cortex-connected custom artifacts, generated Obsidian pages. Nothing else.

**Non-scope:** Body prose structure, domain-specific schemas, nested metadata objects, files that never enter the cortex.

---

## A. Universal Field Rules

These apply to every cortex-relevant file regardless of type.

| Rule           | Detail                                                                                                                                      |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Timestamps     | ISO 8601 with timezone offset: `2026-04-08T14:20:00+01:00`. No bare dates for new files.                                                    |
| Field names    | Lowercase with underscores: `accepted_date`, not `AcceptedOn`.                                                                              |
| `tags`         | Array of lowercase strings: `[cortex, obsidian]`.                                                                                           |
| Keys           | Flat only. No nested objects — the parser doesn't support them.                                                                             |
| Unknown extras | Allowed. Core tools ignore keys not listed here. Custom hermits may add domain fields freely.                                               |
| `null`         | Use `null` for absent optional fields that have a defined lifecycle (e.g., `resolved_date: null`). Omitting the key entirely is also valid. |

---

## B. Session Report

**File pattern:** `sessions/S-NNN-REPORT.md`

```yaml
---
id: S-052
status: completed # completed | partial | blocked
date: 2026-04-08T14:20:00+01:00
duration: 1h 12m
cost_usd: 0.42
tags: [cortex, obsidian]
proposals_created: [PROP-011]
task: "Add weekly review generation"
escalation: autonomous # conservative | balanced | autonomous
operator_turns: 0
---
```

### Required fields

| Field               | Type     | Enum values                              | Description                                                      |
| ------------------- | -------- | ---------------------------------------- | ---------------------------------------------------------------- |
| `id`                | string   | `S-NNN` (zero-padded)                    | Session identifier                                               |
| `status`            | enum     | `completed`, `partial`, `blocked`        | Session outcome                                                  |
| `date`              | ISO 8601 | —                                        | When the session happened (not when the file was written)        |
| `duration`          | string   | `~Xh`, `45m`                             | Computed from started → closed timestamps                        |
| `cost_usd`          | float    | —                                        | Total session cost. Default `0.00`                               |
| `tags`              | array    | —                                        | From SHELL.md Tags field. Empty array `[]` if none               |
| `proposals_created` | array    | —                                        | Proposal IDs created during session. Empty `[]` if none          |
| `task`              | string   | —                                        | First non-comment line from SHELL.md Task section. Max 120 chars |
| `escalation`        | enum     | `conservative`, `balanced`, `autonomous` | From config.json                                                 |
| `operator_turns`    | int      | —                                        | Count of human turns in session transcript                       |

### Field lifecycle

| Field               | Writer              | When                                               |
| ------------------- | ------------------- | -------------------------------------------------- |
| `id`                | `session-mgr` agent | Session start (pre-computed), confirmed at archive |
| `status`            | `session-mgr` agent | Session close — extracted from SHELL.md            |
| `date`              | `session-mgr` agent | Session close — session start timestamp            |
| `duration`          | `session-mgr` agent | Session close — computed from timestamps           |
| `cost_usd`          | `session-mgr` agent | Session close — parsed from Cost section           |
| `tags`              | `session-mgr` agent | Session close — split from SHELL.md Tags           |
| `proposals_created` | `session-mgr` agent | Session close — scanned from Proposals section     |
| `task`              | `session-mgr` agent | Session close — first line of Task section         |
| `escalation`        | `session-mgr` agent | Session close — read from config.json              |
| `operator_turns`    | `session-mgr` agent | Session close — counted from transcript            |

---

## C. Proposal

**File pattern:** `proposals/PROP-NNN.md`

```yaml
---
id: PROP-011
title: "Add weekly review generation"
status: accepted
source: manual
session: S-052
created: 2026-04-08T13:00:00+01:00
accepted_date: 2026-04-08T13:20:00+01:00
resolved_date: null
related_sessions: []
category: improvement
responded: false
self_eval_key: null
accepted_in_session: S-052
---
```

### Required fields

| Field      | Type     | Enum values                                                 | Description                                                                   |
| ---------- | -------- | ----------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `id`       | string   | `PROP-NNN` (zero-padded)                                    | Proposal identifier                                                           |
| `title`    | string   | —                                                           | Must match H1 heading title                                                   |
| `status`   | enum     | `proposed`, `accepted`, `resolved`, `dismissed`             | Current lifecycle state                                                       |
| `source`   | enum     | `manual`, `auto-detected`, `operator-request`               | **Origin only** — how the proposal was initiated. Does not control gate behavior; gate bypass is governed by the candidate-level `Evidence Source:` documented in `skills/reflect/SKILL.md` § Evidence Validation. Values: `manual` = operator invoked `/proposal-create` directly; `auto-detected` = pipeline-initiated (reflect, heartbeat, cadence-driven callers); `operator-request` = operator consent flow (baseline audit accepted at hatch, or direct "propose X" ask). |
| `session`  | string   | `S-NNN`                                                     | Session where proposal was created. Optional for `operator-request` proposals (structural legacy: `scripts/validate-frontmatter.js:112` exempts this field when `source === 'operator-request'` because baseline-audit proposals can be created outside a session — this is a structural rule, not a semantic claim about origin types) |
| `created`  | ISO 8601 | —                                                           | When the proposal was created                                                 |
| `category` | enum     | `improvement`, `routine`, `capability`, `constraint`, `bug` | Guides operator review. Custom hermits may extend with domain-specific values |

### Optional fields

| Field                 | Type             | Enum values | Description                                              |
| --------------------- | ---------------- | ----------- | -------------------------------------------------------- |
| `accepted_date`       | ISO 8601 \| null | —           | When operator accepted. `null` until accepted            |
| `resolved_date`       | ISO 8601 \| null | —           | When implementation was completed. `null` until resolved |
| `related_sessions`    | array            | —           | Session IDs where evidence was found (used by reflect)   |
| `responded`           | bool             | —           | Whether operator has given feedback                      |
| `self_eval_key`       | string \| null   | —           | Metric tracking hint                                     |
| `accepted_in_session` | string \| null   | `S-NNN`     | Session where proposal was accepted                      |

### Field lifecycle

| Field                                                               | Writer                              | When                                      |
| ------------------------------------------------------------------- | ----------------------------------- | ----------------------------------------- |
| `id`, `title`, `status`, `source`, `session`, `created`, `category` | `session-mgr` via `proposal-create` | Proposal creation                         |
| `accepted_date`                                                     | `proposal-act` skill                | Operator accepts proposal                 |
| `accepted_in_session`                                               | `proposal-act` skill                | Operator accepts during an active session |
| `resolved_date`                                                     | `reflect` skill                     | Pattern absent from last 3 sessions       |
| `responded`                                                         | `proposal-act` skill                | Operator gives feedback                   |
| `related_sessions`                                                  | `reflect` skill                     | Auto-detection links evidence sessions    |
| `self_eval_key`                                                     | `session-mgr` via `proposal-create` | Creation (if metric hint applicable)      |

---

## D. Weekly Review

**File pattern:** `reviews/W-YYYY-WNN.md`

```yaml
---
generated: true
week: 2026-W15
sessions_count: 12
proposals_created: 3
proposals_accepted: 1
proposals_resolved: 2
total_cost_usd: 4.82
avg_session_cost_usd: 0.40
self_directed_rate: 0.75
---
```

### Fields

| Field                  | Type   | Description                                     |
| ---------------------- | ------ | ----------------------------------------------- |
| `generated`            | bool   | Always `true` — marks file as machine-generated |
| `week`                 | string | ISO week: `YYYY-Www`                            |
| `sessions_count`       | int    | Sessions in this week                           |
| `proposals_created`    | int    | Proposals created this week                     |
| `proposals_accepted`   | int    | Proposals accepted this week                    |
| `proposals_resolved`   | int    | Proposals resolved this week                    |
| `total_cost_usd`       | float  | Sum of all session costs                        |
| `avg_session_cost_usd` | float  | Mean cost per session                           |
| `self_directed_rate`   | float  | Fraction of sessions with `operator_turns=0`    |

All fields are required. All fields are written by a single script.

### Field lifecycle

| Field      | Writer                     | When                                         |
| ---------- | -------------------------- | -------------------------------------------- |
| All fields | `scripts/weekly-review.js` | Weekly review generation (routine or manual) |

---

## E. Cortex-Connected Custom Artifact

**File pattern:** Any `.md` file in a path declared in `cortex-manifest.json`

```yaml
---
title: "Calendário Semanal de Conteúdo"
created: 2026-04-10T09:00:00+01:00
source: interactive
session: S-052
proposal: PROP-011
tags: [calendar, content]
---
```

### Required fields

| Field     | Type     | Description                                             |
| --------- | -------- | ------------------------------------------------------- |
| `title`   | string   | Display name in Connections.md and Cortex Portal.md     |
| `created` | ISO 8601 | When the artifact was created. Used for recency sorting |

### Optional fields

| Field      | Type   | Enum values                                   | Description                                          |
| ---------- | ------ | --------------------------------------------- | ---------------------------------------------------- |
| `source`   | enum   | `session`, `interactive`, `routine`, `manual` | How the artifact was created. Default: `interactive` |
| `session`  | string | `S-NNN`                                       | Links artifact to a session in the graph             |
| `proposal` | string | `PROP-NNN`                                    | Links artifact to a proposal in the graph            |
| `tags`     | array  | —                                             | Enables Dataview grouping                            |

Custom hermits may add any additional domain fields (e.g., `platform`, `week_start`, `pillar`). Core tools ignore them.

#### Knowledge artifacts (`raw/` and `compiled/`)

Knowledge artifacts — files in `.claude-code-hermit/raw/` and `.claude-code-hermit/compiled/` — use this same Section E contract, with `type` as a recommended extension:

| Field | Required | Notes |
| ----- | -------- | ----- |
| `title` | Yes | Human-readable name for the artifact |
| `created` | Yes | ISO 8601 with timezone offset |
| `type` | Recommended | Free-form, schema-guided (e.g., `briefing`, `source`, `snapshot`, `architecture-decision`). Startup injection groups by `type` and injects only the newest of each. |
| `session` | Required for compiled, optional for raw | Many raw captures happen outside sessions |
| `tags` | Yes | At least one. `foundational` is the only reserved tag — marks artifacts that should be injected at every session start regardless of age. Lint warns on near-miss variants (`foundation`, `core`, `important`). |

Filename convention: `<type>-<YYYYMMDD>-<HHMMSS>.md` (e.g., `briefing-20260413-093000.md`). The filename serves as the identifier — no `id` field needed.

### Field lifecycle

| Field              | Writer                               | When                                                 |
| ------------------ | ------------------------------------ | ---------------------------------------------------- |
| `title`, `created` | Any skill or operator                | Artifact creation                                    |
| `source`           | Any skill or operator                | Artifact creation (omit to default to `interactive`) |
| `session`          | Any skill (if inside a session)      | Artifact creation — optional                         |
| `proposal`         | Any skill (if related to a proposal) | Artifact creation — optional                         |
| `tags`             | Any skill or operator                | Artifact creation or later update                    |

---

## F. Generated Obsidian Page

**File pattern:** `obsidian/*.md` (the six cortex pages)

```yaml
---
generated: true
updated: 2026-04-10T23:30:00+01:00
---
```

### Fields

| Field       | Type     | Description                 |
| ----------- | -------- | --------------------------- |
| `generated` | bool     | Always `true`               |
| `updated`   | ISO 8601 | Last regeneration timestamp |

### Field lifecycle

| Field       | Writer                   | When                                 |
| ----------- | ------------------------ | ------------------------------------ |
| `generated` | `create-cortex-pages.js` | Page creation                        |
| `updated`   | `build-cortex.js`        | Nightly cortex-refresh at 23:30 |

---

## What This Contract Does Not Cover

- Body prose structure in any file type
- Domain-specific fields beyond what's listed (custom hermits own those)
- Nested metadata objects
- Files that never enter the cortex (random notes, scratch files, `.gitignore`, etc.)
- Per-domain schemas — those belong in the custom hermit's own docs, not here
