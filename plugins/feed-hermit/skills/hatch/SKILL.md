---
name: hatch
description: One-time feed hermit setup. Seeds the source registry and FEEDS.md tone spec, configures brief slots/tone/enrichments, drops routine prompts, and wires routines + a source-scout scheduled check into config.json. Run once per project after /claude-code-hermit:hatch.
---

# Hatch — feed-hermit

Idempotent setup wizard for the feed plugin. Run **after** `/claude-code-hermit:hatch` has already completed.

---

## Step 1 — Prerequisite check

Read `.claude-code-hermit/config.json`.

If the file does not exist or `_hermit_versions["claude-code-hermit"]` is absent or empty:

> "The base hermit is not set up in this project yet. Run `/claude-code-hermit:hatch` first, then return here."

Use `AskUserQuestion`: "Would you like to run `/claude-code-hermit:hatch` now? (yes / no)"

- **yes** → Follow the domain hatch continuation protocol (documented in `claude-code-hermit:hatch`):
  1. Write `.claude-code-hermit/state/hatch-resume.json` with `{ "skill": "feed-hermit:hatch" }`.
  2. Print: "(If setup doesn't continue automatically when core finishes, re-run `/feed-hermit:hatch`.)"
  3. Invoke `/claude-code-hermit:hatch` **via the Skill tool** — terminal action, stop after the call.
- **no** → stop.

If `_hermit_versions["claude-code-hermit"]` is present but the version string is earlier than `1.2.22` (compare major.minor.patch numerically), warn:

> "Base hermit version is {version}; this plugin requires ≥1.2.22. Run `/claude-code-hermit:hermit-evolve` to upgrade, then re-run this hatch."

Stop.

---

## Step 2 — Idempotency check

Read `_hermit_versions["feed-hermit"]` from `.claude-code-hermit/config.json`, and `version` from `${CLAUDE_PLUGIN_ROOT}/.claude-plugin/plugin.json`.

If they match:

> "feed-hermit {version} is already installed. Skip to Step 7 to re-verify, or reply 'full' to re-run the full wizard."

Use `AskUserQuestion`: "(verify / full)"

- **verify** → skip to Step 7.
- **full** → continue from Step 3.

If absent or stale: continue from Step 3.

---

## Step 3 — Seed the registries and tone spec

The operator owns three files at the **project root**: `feed-sources.md`, `feed-categories.md`, `FEEDS.md`. Seed each from the plugin template **only if it does not already exist** (never overwrite operator content).

For each of:
- `${CLAUDE_PLUGIN_ROOT}/state-templates/feed-sources.md` → `feed-sources.md`
- `${CLAUDE_PLUGIN_ROOT}/state-templates/feed-categories.md` → `feed-categories.md`
- `${CLAUDE_PLUGIN_ROOT}/state-templates/FEEDS.md` → `FEEDS.md`

Read the destination first: if it exists, skip (report `⊘ skipped <file> (already present)`); if not, Read the template and Write it to the root (report `✓ seeded <file>`).

**Starter pack (opt-in).** If `feed-sources.md` and `feed-categories.md` were freshly seeded (both empty), offer the starter pack with `AskUserQuestion` (header: "Starter sources"): **Start empty** (recommended — add your own with `/feed-hermit:add-source`) / **Seed a small generic tech/AI starter pack**. If the operator opts in, Read `${CLAUDE_PLUGIN_ROOT}/state-templates/starter-pack.md` and merge its Categories rows into `feed-categories.md` and its Sources rows into the `## Active Sources` table in `feed-sources.md`. Never seed the starter pack over a non-empty registry.

**gitignore.** Read the project `.gitignore`. Ensure `tmp/` is present (the fetch scratch dir); append it if missing. (`feed-sources.md`/`feed-categories.md`/`FEEDS.md` are operator content — do NOT gitignore them.)

---

## Step 4 — Brief configuration wizard

Ask the operator (use `AskUserQuestion`, one prompt per decision or batched):

1. **Slots** — morning brief time and evening brief time (24h `HH:MM`, operator's local timezone). Defaults: morning `09:00`, evening `21:30`. Either slot can be disabled.
2. **Weekly digest** — day + time. Default: Sunday `10:30`. Can be disabled.
3. **Tone preset** — free-form label stored for the `feed-brief` skill (e.g. `default`, `concise`, `deep`). Default `default`. (The full voice lives in `FEEDS.md`; this is a coarse dial.)
4. **Enrichments** — `story_arcs` (cross-reference developing stories into briefs) on/off; `follow_up_cta` (append a `/deep-dive` reply prompt to top-tier items) on/off. Defaults: both off.
5. **Reaction feedback** — track 👍/👎 reactions on delivered briefs for the weekly source signal, on/off. Default off. (Note: the reaction→feedback-line producer is a channel-layer concern; enabling this only turns on the message-registry write and weekly aggregation — see `docs/schema.md`.)

Convert each `HH:MM` to a cron expression for Step 7 (`M H * * *` for daily slots; `M H * * 0` for a Sunday weekly). Hold the answers in context.

---

## Step 5 — Drop routine prompt files

Copy the three routine prompt templates from `${CLAUDE_PLUGIN_ROOT}/state-templates/compiled/` into the consumer's `.claude-code-hermit/compiled/`:

- `routine-feed-brief-morning.md`
- `routine-feed-brief-evening.md`
- `routine-weekly-digest.md`

For each: Read the source, check the destination (`.claude-code-hermit/compiled/<filename>`). If absent → Write it (`✓ dropped <filename>`). If present → skip (`⊘ skipped <filename> (already present)`).

---

## Step 6 — CLAUDE.md / CLAUDE.local.md inject

**Resolve target file:** Read `.claude-code-hermit/state/hatch-options.json`. Use the `"target"` field: `"local"` → `CLAUDE.local.md`; `"committed"` or absent → `CLAUDE.md`. If `hatch-options.json` doesn't exist (operator's core hermit predates the field): detect `core_install_scope` from `claude plugin list --json` (filter entries where plugin name is `claude-code-hermit` and `enabled == true`; precedence `local` > `project` > `user` > `null`; map `project` → `committed`, else → `local`). Ask with `AskUserQuestion` (header: "Visibility") — scope-derived default at position 0 with `(recommended)`: **`.local` files** / **Committed files**. Write the canonical 5-field schema to `.claude-code-hermit/state/hatch-options.json`:

```json
{
  "target": "<choice>",
  "core_install_scope": "<project|local|user|null>",
  "stamped_at": "<current ISO 8601 timestamp with timezone offset>",
  "stamped_by": "feed-hermit:hatch",
  "version": "<current feed-hermit plugin version from ${CLAUDE_PLUGIN_ROOT}/.claude-plugin/plugin.json>"
}
```

Read `target_file`. Search for the opening marker `<!-- feed-hermit: Feed Workflow -->` (closing `<!-- /feed-hermit: Feed Workflow -->`).

- **`target_file` does not exist** → treat as marker-absent; the append (via Edit) creates it.
- **Marker absent** → append the full contents of `${CLAUDE_PLUGIN_ROOT}/state-templates/CLAUDE-APPEND.md` to `target_file` using Edit.
- **Marker present** → skip (`hermit-evolve` handles block replacement on upgrade).

---

## Step 7 — Stamp and register in config.json

Use the `config.json` content already loaded in Step 1 (do not re-read).

### 7a — Stamp version

Set `_hermit_versions["feed-hermit"]` to the plugin version from Step 2.

### 7b — Write the feed config block

Set `config.feed` from the Step 4 answers:

```json
{
  "slots": [
    {"name": "morning", "cron": "<morning cron>", "enabled": <bool>},
    {"name": "evening", "cron": "<evening cron>", "enabled": <bool>}
  ],
  "weekly": {"cron": "<weekly cron>", "enabled": <bool>},
  "tone_preset": "<preset>",
  "enrichments": {"story_arcs": <bool>, "follow_up_cta": <bool>},
  "reaction_feedback": <bool>
}
```

If `config.feed` already exists, merge (keep operator edits; only fill absent keys).

### 7c — Merge routines

In the `routines` array, for each of these IDs that is **absent** (by `id`), add it using the crons from Step 4; skip any already present. Set `enabled` from the slot/weekly enable answers.

```json
{
  "id": "feed-brief-morning",
  "schedule": "<morning cron>",
  "skill": "claude-code-hermit:session-start",
  "enabled": <morning enabled>,
  "run_during_waiting": true,
  "prompt_file": "compiled/routine-feed-brief-morning.md"
},
{
  "id": "feed-brief-evening",
  "schedule": "<evening cron>",
  "skill": "claude-code-hermit:session-start",
  "enabled": <evening enabled>,
  "run_during_waiting": true,
  "prompt_file": "compiled/routine-feed-brief-evening.md"
},
{
  "id": "weekly-digest",
  "schedule": "<weekly cron>",
  "skill": "claude-code-hermit:session-start",
  "enabled": <weekly enabled>,
  "run_during_waiting": true,
  "prompt_file": "compiled/routine-weekly-digest.md"
}
```

### 7d — Merge scheduled_checks

In `config.scheduled_checks`, check for `id: "source-scout"`. If absent, append; if present, skip.

```json
{"id": "source-scout", "plugin": "feed-hermit", "skill": "feed-hermit:source-scout", "enabled": true, "trigger": "interval", "interval_days": 30}
```

Write the updated `config.json` using the Write tool (full-file replacement to keep valid JSON).

---

## Step 8 — Knowledge-schema extension

Read `.claude-code-hermit/knowledge-schema.md`. If the string `brief-summary:` is absent, append under `## Work Products` (create the header if only a stub exists):

```
- brief: a delivered morning/evening brief. Triggered by feed-brief-morning/evening routines. location: briefs/YYYY-MM-DD-<slot>.md
- weekly-brief: weekly synthesis over the week's briefs. Triggered by weekly-digest routine. location: briefs/weekly/YYYY-WNN.md
- brief-summary: one-line last-brief summary injected at session start. Triggered by feed-brief. location: compiled/brief-summary-last-<YYYY-MM-DD>.md
- story-arcs: developing-story tracker. Triggered by story-arcs skill. location: compiled/story-arcs-<YYYY-MM-DD>.md
- pending-delivery: queued brief awaiting redelivery. Triggered by feed-brief on send failure. location: compiled/pending-delivery.md
```

And under `## Raw Captures` (create if absent):

```
- source-items: raw fetched items from the source-fetcher agent. Feeds feed-brief scoring. Retention: 3 days. location: tmp/feed-source-items-<slot>.json
```

If already present: skip. Use Edit.

---

## Step 9 — Final report

Print a structured summary:

```
feed-hermit {version} setup complete.

Installation summary:
  ✓ Prerequisite: claude-code-hermit {base_version} confirmed
  ✓ Registries: feed-sources.md / feed-categories.md / FEEDS.md seeded (or already present){; starter pack applied if opted in}
  ✓ .gitignore: tmp/ covered
  ✓ config.json: feed block written, _hermit_versions stamped, {K}/3 routines added, source-scout check registered
  ✓ Routine prompts: {N}/3 dropped, {M}/3 already present
  ✓ CLAUDE.md: Feed Workflow block injected (or already present)
  ✓ knowledge-schema.md: brief types added (or already present)

Next steps:
  - Add your sources:    /feed-hermit:add-source   (or edit feed-sources.md directly)
  - Run a brief now:     /feed-hermit:feed-brief --morning
  - Optional Chrome:     chrome/reddit-home/x sources need a running Chrome; they skip gracefully when it's down.
  - Optional reddit auth: see docs/reddit.md (works unauthenticated by default).

Suggested HEARTBEAT check (add to HEARTBEAT.md if you run heartbeats):
  - If .claude-code-hermit/compiled/pending-delivery.md exists and is older than 30 min, a brief failed to deliver — retry or alert.

Go always-on (recommended):
  - Docker:     /claude-code-hermit:docker-setup
  - Bare tmux:  .claude-code-hermit/bin/hermit-start
  Interactive test drive: /claude-code-hermit:hermit-routines load

Installed skills:
  /feed-hermit:feed-brief      — the 7-phase brief pipeline (--morning|--evening|--slot)
  /feed-hermit:weekly-digest   — weekly synthesis + source performance
  /feed-hermit:add-source      — add a source (type inference + validation)
  /feed-hermit:source-scout    — gap-driven source discovery (scheduled, interval_days: 30)
  /feed-hermit:source-health   — dead-source + cost-efficiency audit
  /feed-hermit:story-arcs      — track developing stories
  /feed-hermit:deep-dive       — follow-up analysis on a briefed item

Installed subagent:
  @feed-hermit:source-fetcher  — Haiku web/RSS raw-collection fetcher
```

---

## Docker network requirements

Read by `/claude-code-hermit:docker-security` when the operator enables LAN containment + DNS policy. Each entry is surfaced as a per-entry confirmation prompt; nothing here is auto-applied.

### Domains (DNS allowlist)

- Every domain the operator lists in `feed-sources.md` (the fetch targets). Re-run `/docker-security` after adding sources so new domains are allowlisted.
- `reddit.com` and `oauth.reddit.com` — only if any `reddit`-typed source uses the bundled `reddit-fetch.ts`.

### LAN allowlist suggestions

(none — all sources are public cloud endpoints)
