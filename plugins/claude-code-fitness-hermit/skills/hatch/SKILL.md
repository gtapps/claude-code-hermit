---
name: hatch
description: One-time fitness hermit setup. Configures Strava MCP access, drops routine prompt templates, and wires routines into config.json. Run once per project after /claude-code-hermit:hatch.
---

# Hatch — claude-code-fitness-hermit

Idempotent setup wizard for the fitness plugin. Run **after** `/claude-code-hermit:hatch` has already been completed.

---

## Step 1 — Prerequisite check

Read `.claude-code-hermit/config.json`.

If the file does not exist or `_hermit_versions["claude-code-hermit"]` is absent or empty:

> "The base hermit is not set up in this project yet. Run `/claude-code-hermit:hatch` first, then return here."

Use `AskUserQuestion`: "Would you like to run `/claude-code-hermit:hatch` now? (yes / no)"

- **yes** → Follow the domain hatch continuation protocol (documented in `claude-code-hermit:hatch`):
  1. Write `.claude-code-hermit/state/hatch-resume.json` with `{ "skill": "claude-code-fitness-hermit:hatch" }`.
  2. Print: "(If setup doesn't continue automatically when core finishes, re-run `/claude-code-fitness-hermit:hatch`.)"
  3. Invoke `/claude-code-hermit:hatch` **via the Skill tool** — terminal action, stop after the call.
- **no** → stop.

If `_hermit_versions["claude-code-hermit"]` is present but the version string is earlier than `1.0.26` (compare major.minor.patch numerically), warn:

> "Base hermit version is {version}; this plugin requires ≥1.0.26. Run `/claude-code-hermit:hermit-evolve` to upgrade, then re-run this hatch."

Stop.

---

## Step 2 — Idempotency check

Read `_hermit_versions["claude-code-fitness-hermit"]` from `.claude-code-hermit/config.json`.

Read `version` from `${CLAUDE_PLUGIN_ROOT}/.claude-plugin/plugin.json`.

If the versions match, say:

> "claude-code-fitness-hermit {version} is already installed. Skip to Step 8 to re-verify the installation, or reply 'full' to re-run the full wizard."

Use `AskUserQuestion`: "(verify / full)"

- **verify** → skip to Step 8.
- **full** → continue from Step 3.

If absent or stale: continue from Step 3.

---

## Step 3 — .env verification

**IMPORTANT: Do NOT use `grep`, `cat`, `echo`, or any Bash command to read `.env`. Three of the four required variables contain the literal string `TOKEN` in their name, which triggers the base hermit's deny-patterns hook on any Bash command argument. Use the `Read` tool only.**

Tell the operator:

> "This plugin needs four Strava OAuth credentials in `.env`. If you haven't done this yet:
>
> 1. `cp .env.example .env` (or copy the file manually)
> 2. Open `.env` and fill in all four values from your Strava developer app:
>    - `STRAVA_CLIENT_ID` — numeric app ID
>    - `STRAVA_CLIENT_SECRET` — app secret
>    - `STRAVA_ACCESS_TOKEN` — initial access token
>    - `STRAVA_REFRESH_TOKEN` — refresh token
>
> See https://developers.strava.com/docs/authentication/ to create a Strava app if you haven't.
> Reply 'done' when the file is filled in, or 'abort' to stop."

Use `AskUserQuestion`: "(done / abort)"

- **abort** → stop.
- **done** → continue.

Use the **Read tool** to read `.env`. Parse each line of the form `KEY=VALUE`. Verify that all four of these keys are present and their values are not empty and not `replace_me`:

- `STRAVA_CLIENT_ID`
- `STRAVA_CLIENT_SECRET`
- `STRAVA_ACCESS_TOKEN`
- `STRAVA_REFRESH_TOKEN`

If any value is missing or still set to `replace_me`, report which ones and loop back to the `AskUserQuestion` above. Do not proceed until all four are valid.

---

## Step 4 — MCP registration

**Step 4.0 — Detect an ambient Strava MCP server.** The operator may already run a Strava MCP server (user-scoped, or configured by another tool). Run `claude mcp list` (Bash) and scan for a server that talks to Strava — a name containing `strava`, or an entry whose command/args reference a Strava MCP package (e.g. `strava-mcp-server`). 

- **None found** → proceed to install the bundled server below (the default path).
- **One found** → ask with `AskUserQuestion` (header: "Strava MCP"): **Reuse the existing `<name>` server** (recommended — no duplicate) / **Install the bundled `@r-huijts/strava-mcp-server`**. 
  - **Reuse** → skip the `.mcp.json` write entirely. Record which server key the skills should target (if it is not `strava`, note in the final report that skill/settings matchers assume the key `strava`, so the operator should either rename their server to `strava` or accept that the fitness skills call `mcp__strava__*`). Continue to Step 5.
  - **Install bundled** → proceed below.

This is a local reuse-vs-install choice only — do not attempt to reconcile or edit the operator's other MCP configs.

Using the four values you parsed from `.env` in Step 3 (held in working context — do not re-read .env), write the Strava MCP server entry into the project's `.mcp.json`.

**Do not embed `${VAR}` placeholders — substitute literal values.** Claude Code passes MCP `env` blocks as literal environment variables to the child process; it does not expand shell variable syntax.

Read the project root `.mcp.json` (use the Read tool; treat as `{ "mcpServers": {} }` if the file does not exist).

Check if a `strava` key already exists under `mcpServers`:
- **Absent** → add the entry.
- **Present with `${...}` placeholders** → rewrite just the `strava` entry with literal values.
- **Present with literal values** → skip (already configured).

The `strava` entry shape:

```json
{
  "strava": {
    "command": "npx",
    "args": ["-y", "@r-huijts/strava-mcp-server"],
    "env": {
      "STRAVA_CLIENT_ID": "<literal STRAVA_CLIENT_ID from .env>",
      "STRAVA_CLIENT_SECRET": "<literal STRAVA_CLIENT_SECRET from .env>",
      "STRAVA_ACCESS_TOKEN": "<literal STRAVA_ACCESS_TOKEN from .env>",
      "STRAVA_REFRESH_TOKEN": "<literal STRAVA_REFRESH_TOKEN from .env>"
    }
  }
}
```

Write the updated `.mcp.json` using the Write tool.

**Add `.mcp.json` and `.env` to `.gitignore`** if not already present. Read the project `.gitignore`, check for each entry; append any that are missing on new lines using Edit.

---

## Step 5 — Drop routine prompt files

Copy the four routine prompt templates from the plugin's `state-templates/compiled/` into the consumer's `.claude-code-hermit/compiled/`.

For each of the four files:
- `${CLAUDE_PLUGIN_ROOT}/state-templates/compiled/routine-fitness-brief-morning.md`
- `${CLAUDE_PLUGIN_ROOT}/state-templates/compiled/routine-fitness-brief-evening.md`
- `${CLAUDE_PLUGIN_ROOT}/state-templates/compiled/routine-weekly-load-review.md`
- `${CLAUDE_PLUGIN_ROOT}/state-templates/compiled/routine-monday-planning.md`

Read the source file (using Read tool), then check if the destination exists (`.claude-code-hermit/compiled/<filename>`):
- **Does not exist** → write it using Write tool. Report: `✓ dropped <filename>`.
- **Already exists** → skip (do not overwrite operator edits). Report: `⊘ skipped <filename> (already present)`.

---

## Step 6 — CLAUDE.md / CLAUDE.local.md inject

**Resolve target file:** Read `.claude-code-hermit/state/hatch-options.json`. Use the `"target"` field:
- `"local"` → `target_file = CLAUDE.local.md`
- `"committed"` or absent → `target_file = CLAUDE.md`
- If the file doesn't exist (no `hatch-options.json` yet — operator's core hermit predates 1.1.1): detect `core_install_scope` from `claude plugin list --json` using the same precedence rules as core hatch Step 1.5 item 2 (filter entries where plugin name is `claude-code-hermit` and `enabled == true`; precedence `local` > `project` (both require `projectPath == project root`) > `user` (any `projectPath`) > `null`; map `project` → `committed`, `local`/`user`/`null` → `local`). Ask with `AskUserQuestion` (header: "Visibility") — scope-derived default at position 0 with `(recommended)`: **`.local` files** (gitignored — operator-personal) / **Committed files** (shared with teammates). Write the canonical 5-field schema to `.claude-code-hermit/state/hatch-options.json`:

  ```json
  {
    "target": "<choice>",
    "core_install_scope": "<project|local|user|null>",
    "stamped_at": "<current ISO 8601 timestamp with timezone offset>",
    "stamped_by": "claude-code-fitness-hermit:hatch",
    "version": "<current fitness-hermit plugin version from ${CLAUDE_PLUGIN_ROOT}/.claude-plugin/plugin.json>"
  }
  ```

Read `target_file`. Search for the opening marker `<!-- claude-code-fitness-hermit: Fitness Workflow -->`. The matching closing marker is `<!-- /claude-code-fitness-hermit: Fitness Workflow -->`.

- **`target_file` does not exist** (greenfield `CLAUDE.local.md` is common) → treat as marker-absent and proceed to the append branch; Edit will create the file.
- **Marker absent** → append the full contents of `${CLAUDE_PLUGIN_ROOT}/state-templates/CLAUDE-APPEND.md` to `target_file` using Edit.
- **Marker present** → skip (up-to-date; `hermit-evolve` handles block replacement on upgrade).

Stray-block migration (block stranded in the non-target file after a target flip) is handled one-shot by the Upgrade Instructions in this version's CHANGELOG entry, executed by `hermit-evolve` Step 7. Hatch itself stays focused on target-aware setup.

---

## Step 7 — Knowledge-schema extension

Read `.claude-code-hermit/knowledge-schema.md`.

Check if `activity-streams:` is present in the file. This string only appears in the Raw Captures section, which is the last thing written — so its presence means both blocks were fully written on a prior run.

If **absent**, append the following block under `## Work Products` (create the section header if the base schema only has a template stub):

```
- weekly-plan: weekly training structure suggestion (7-day breakdown). Triggered by monday-planning routine (Mon 09:30). location: compiled/weekly-plan-<YYYY-MM-DD>.md
- weekly-summary: week-over-week training load review. Triggered by weekly-load-review routine (Sun 18:00). location: compiled/weekly-summary-<YYYY-MM-DD>.md
- recovery-assessment: recovery indicators from recent activity data. Triggered by operator request or an evening-brief flag. location: compiled/recovery-assessment-<YYYY-MM-DD>.md
- fitness-snapshot: current fitness state snapshot. Triggered by operator request. location: compiled/fitness-snapshot-<YYYY-MM-DD>.md
- activity-note: per-activity coaching analysis. Triggered by activity-deep-dive skill. location: compiled/activity-<id>-<YYYY-MM-DD>.md
```

And under `## Raw Captures` (create if absent):

```
- activity-fetch: raw activity list from Strava. Feeds weekly-plan, weekly-summary, recovery-assessment. Retention: 3 days. location: raw/activity-fetch-<date>.json
- activity-streams: HR/pace/power time-series for a specific activity. Feeds recovery-assessment, activity-note, fitness-snapshot. Retention: 7 days. location: raw/activity-streams-<id>-<date>.json
```

If already present: skip (idempotent).

Use Edit to make the changes.

---

## Step 8 — Stamp and register in config.json

Use the `config.json` content already loaded in Step 1. (Do not re-read the file.)

### 8a — Stamp version

Set `_hermit_versions["claude-code-fitness-hermit"]` to the plugin version retrieved in Step 2.

If the key already exists: update the value. If absent: add it alongside the existing `_hermit_versions["claude-code-hermit"]` entry.

### 8b — Merge routines

In the `routines` array, check for each of these four IDs. For any that are **absent**, add the entry. For any that are **present** (by `id`), skip (do not clobber existing operator edits).

```json
{
  "id": "morning-brief",
  "schedule": "30 7 * * *",
  "skill": "claude-code-hermit:session-start",
  "enabled": true,
  "run_during_waiting": true,
  "prompt_file": "compiled/routine-fitness-brief-morning.md"
},
{
  "id": "evening-brief",
  "schedule": "30 21 * * *",
  "skill": "claude-code-hermit:session-start",
  "enabled": true,
  "run_during_waiting": true,
  "prompt_file": "compiled/routine-fitness-brief-evening.md"
},
{
  "id": "weekly-load-review",
  "schedule": "0 18 * * 0",
  "skill": "claude-code-hermit:session-start",
  "enabled": true,
  "run_during_waiting": true,
  "prompt_file": "compiled/routine-weekly-load-review.md"
},
{
  "id": "monday-planning",
  "schedule": "30 9 * * 1",
  "skill": "claude-code-hermit:session-start",
  "enabled": true,
  "run_during_waiting": true,
  "prompt_file": "compiled/routine-monday-planning.md"
}
```

### 8c — Merge scheduled_checks

In `config.scheduled_checks`, check for an entry with `id: "weekly-coaching-patterns"`. If absent, append it. If present (by `id`), skip — do not clobber existing operator edits.

```json
{"id": "weekly-coaching-patterns", "plugin": "claude-code-fitness-hermit", "skill": "claude-code-fitness-hermit:weekly-coaching-patterns", "enabled": true, "trigger": "interval", "interval_days": 7}
```

No prompt needed — this is a read-only analysis. The core daily `scheduled-checks` routine picks it up; `interval_days: 7` gates cadence. Findings surface as proposals automatically via the existing pipeline.

Write the updated `config.json` using Write tool (full file replacement to ensure valid JSON).

### 8d — Auto-mode environment seed

Run `bun ${CLAUDE_PLUGIN_ROOT}/scripts/automode-env.ts .claude/settings.local.json` — **always `.claude/settings.local.json`, regardless of `hatch_target`**: Claude Code's auto-mode classifier reads `autoMode` config only from local/user scope, never a committed project `.claude/settings.json`. This names `www.strava.com` as a trusted external service, so the classifier stops treating the nightly `evening-brief` routine's read-only fetches as unrecognized outbound calls. Additive and idempotent; safe to re-run on every hatch. No prompt needed.

---

## Step 9 — Final report

Print a structured summary:

```
claude-code-fitness-hermit {version} setup complete.

Installation summary:
  ✓ Prerequisite: claude-code-hermit {base_version} confirmed
  ✓ .env: all four Strava credentials present
  ✓ .mcp.json: strava server entry written (or was already present)
  ✓ .gitignore: .mcp.json and .env covered
  ✓ Routine prompts: {N}/6 dropped, {M}/6 already present
  ✓ CLAUDE.md: Fitness Workflow block injected (or was already present)
  ✓ knowledge-schema.md: fitness types added (or were already present)
  ✓ config.json: _hermit_versions stamped, {K}/6 routines added, weekly-coaching-patterns check registered

Manual steps remaining:
  - Restart Claude Code so the `strava` MCP server loads from .mcp.json
  - Approve the `strava` server when prompted on first use
  - Run /mcp to confirm `strava` is connected
  - Verify connectivity: call mcp__strava__check-strava-connection

Go always-on (recommended):
  - Docker:     /claude-code-hermit:docker-setup
      Builds the container and walks you through channel pairing in one go.
  - Bare tmux:  .claude-code-hermit/bin/hermit-start
      For channels (Discord/Telegram) with tmux, run
      /claude-code-hermit:channel-setup first.

Prefer to test interactively first? After restarting, run:
  /claude-code-hermit:hermit-routines load
    — activates the four fitness routines in the current Claude session.

The always-on runtime activates routines automatically — the interactive
steps are only for a test drive before handing over to the runtime.

Installed skills:
  /claude-code-fitness-hermit:fitness-brief             — daily morning/evening brief (--morning|--evening|--slot)
  /claude-code-fitness-hermit:activity-deep-dive        — per-activity coaching analysis
  /claude-code-fitness-hermit:weekly-coaching-patterns  — weekly cardiac-drift trend check (scheduled, interval_days: 7)

Installed subagent:
  @claude-code-fitness-hermit:strava-data-cruncher — bulk Strava data aggregation (Haiku)

Security reminder: .env and .mcp.json contain real Strava credentials. Both are gitignored — verify before any git push.
```

---

## Docker network requirements

Read by `/claude-code-hermit:docker-security` when the operator enables LAN containment + DNS policy. Each entry is surfaced as a per-entry confirmation prompt; nothing here is auto-applied.

### Domains (DNS allowlist)

- strava.com

`server=/strava.com/...` matches both `www.strava.com` (web) and `api.strava.com` (API) via dnsmasq's subdomain-match semantics. The Strava MCP server (`@r-huijts/strava-mcp-server` via `npx`) also needs `npmjs.org`, but that's already in the wizard's seed allowlist for npm/plugin installs.

### LAN allowlist suggestions

(none — Strava is a cloud service)
