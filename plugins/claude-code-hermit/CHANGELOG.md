# Changelog

## [Unreleased]

### Added
- **channel-log: episodic DM capture (PROP-010)** — hook-level capture of Discord/Telegram DM text into `state/channel-log.sqlite` (FTS5), gated by the existing operator allowlist and `knowledge.channel_log_enabled`. Feature-detected: inert until a channel delivers a message.
- **recall: channel log as a fourth source** — `/recall` and `search.ts` now search past DM text alongside sessions/compiled/proposals, labelled `[channel]` and flagged as untrusted external input.
- **weekly-review: channel-log consolidation step** — distills durable decisions from the week's DM log into memory/compiled via a read-only skill-eval-runner dispatch; prunes only already-consolidated rows past `knowledge.channel_log_retention_days`.
- **startup-context: post-compaction state pointers (PROP-011)** — a new capped section injects `runtime.json` session_state/waiting_reason, pending micro-approvals, and outbound channel routing on every `SessionStart` with `source: "compact"`, so both native and driver-sent compaction stop silently dropping hermit state.
- **watchdog: routine-hygiene context compaction (PROP-011)** — `context_hygiene.compact` (on by default, 150k/4h) sends `/compact` at a much lower threshold than the existing 700k emergency `/clear`, so cold-cache wakes stop re-paying the full accumulated context. A boundary marker (`state/compact-requested.json`, written by `session` and `proposal-act` at arc-end moments) waives the interval cooldown but never the 60k token floor.
### Changed
- **hatch: config.json assembly is now deterministic (`hatch-config.ts`)** — Step 5's ~40-line hand-merge of the template with wizard answers is now a single script call; the model builds an answers payload instead of hand-transcribing cron strings, `scheduled_checks` entries, and channel objects. Re-init merges by id (routines, `scheduled_checks`) and per-field (channels), never advances `_hermit_versions`, and preserves any key the payload doesn't mention. Fixes a pre-existing bug where Step 3/Quick Turn 1 read `hermit.boot_skill` from a sibling's `plugin.json` instead of `hermit-meta.json` (always resolved to `null`). `validate-config.ts` gained `remote` (boolean) and `idle_behavior` (`wait`/`discover`) checks it was missing. Hardened payload handling: a malformed `activated_hermit` (missing slug/version) is refused rather than stamping a phantom `_hermit_versions` entry; null `channels`/`scheduled_checks_plugins` payloads fail cleanly instead of crashing; a duplicate plugin in `scheduled_checks_plugins` no longer produces duplicate ids; and `morning_brief_time: null` disables an existing channel brief on re-init.

### Fixed
- **suggest-compact: removed dead `context_usage` branch (PROP-011)** — the Stop hook never receives a `context_usage` field, so the 60%-based suggestion has never fired. The tool-call counter is now the sole suggestion path; docs no longer describe it as a fallback.

## [1.2.13] - 2026-06-29

### Added
- **proposal template: optional `## References` section** — backward-looking sources for agent-authored proposals. Placed after `## Verification`; required — cite real sources, or write `n/a — <reason>` for operator-requested or qualitative proposals. `proposal-create` is updated to fill it.

### Changed
- **proposal-triage, reflection-judge, skill-eval-runner: removed `maxTurns` cap** — fixed caps caused turn-exhaustion failures on mature deployments where proposals, sessions, and memory accumulate over time; any static number eventually becomes too small. Empirically confirmed: omitting the cap gives generous harness-default headroom rather than a trap.

### Fixed
- **proposal-triage, reflection-judge: gates now fail closed on missing verdict** — a no-verdict result (cap hit, error, or malformed output) previously failed open, letting candidates bypass dedup/suppression. All callers (`proposal-create`, `reflect`, `reflect-scheduled-checks`) now fail closed and append a `gate-failed` row to `state/proposal-metrics.jsonl` plus a Progress Log note. The candidate re-surfaces on the next reflect cycle.
- **hermit-evolve: domain (sibling) hermits now upgrade reliably** — `evolve-plan.ts` computes sibling plans deterministically (registry-driven from `_hermit_versions`), `plan.work_pending` replaces the core-only short-circuit so sibling-only gaps still run, and the `hermit-update`/`hermit-docker update` wrappers chain evolve on any registered hermit gap.

### Upgrade Instructions

Run `/claude-code-hermit:hermit-evolve`. The evolve skill handles:

1. **Refresh PROPOSAL.md template** — copy `${CLAUDE_PLUGIN_ROOT}/state-templates/PROPOSAL.md.template` to `.claude-code-hermit/templates/PROPOSAL.md.template` so the new `## References` section reaches the next generated proposal. Past PROP-NNN files are not retroactively rewritten.
2. **Refresh bin wrappers** — `bin/hermit-update` and `bin/hermit-docker` in `.claude-code-hermit/bin/` ship new sibling-gap detection logic. The evolve skill replaces them automatically via the standard bin-wrapper refresh (Step 5b).

## [1.2.12] - 2026-06-26

### Added
- **config: `storage_drift.ignore`** — allowlist of top-level `.claude-code-hermit/` dirs exempt from storage-drift alerts. Domain plugins register hermit-owned runtime trees (Composer vendor installs, SDK caches) so the drift check never false-flags them as stray archive content. See `docs/plugin-hermit-storage.md`.
- **session-close: Completed-vs-Artifacts closeout check** — a quality-check item flags when `## Completed` claims a deliverable a skill persists to `compiled/` but it's absent from `## Artifacts`, catching silently-dropped outputs at close instead of in a later session. Report template now labels `## Completed` as narrative. (#465)

### Changed
- **judge subagents: state terse-output rationale explicitly** — `proposal-triage`, `reflection-judge`, and `quality-gate-judge` now say their final message lands verbatim in the caller's long-lived context and re-read from cache each turn, so reasoning belongs in thinking, not the response (#468).

### Fixed
- **drift: storage-drift no longer false-flags allowlisted runtime dirs** — `findStorageDrift` reads `config.storage_drift.ignore` and skips declared dirs in both the session-start Storage Drift block and the reflect observations ledger. Fail-open: absent or invalid config defaults to no exemptions.
- **heartbeat/alert-state: atomic writes + corrupt-file quarantine** — `heartbeat-precheck.ts` and `update-alert-state.ts` write `alert-state.json` via temp+rename and quarantine an unparseable existing file to `alert-state.json.corrupt-<ts>` instead of reinitializing skill-owned `alerts`/`self_eval` to empty. Reads split the file read from the JSON parse (shared `scripts/lib/alert-state.ts`), so a transient read error (EACCES/EMFILE/EIO) on a healthy file is never mistaken for corruption and never quarantined or reset. Stops silent loss of accumulated alert/self-eval telemetry on an interrupted or partial write (#463).
- **hermit-settings: reconcile the heartbeat monitor on change** — after writing a `heartbeat` change, auto-runs `/heartbeat start` (if enabled) or `/heartbeat stop` (if disabled) so the live Monitor's cadence and `config.json` can't silently desync. (#452)
- **routines: suppress duplicate `fired` metric** — heartbeat-restart's self-re-arm (`hermit-routines load` at its own prompt tail) could log a second `fired` with no intervening `started` (#464); `log-routine-event.sh` now skips a `fired` that immediately follows another `fired` for the same routine.

### Files affected

| File | Change |
|------|--------|
| `scripts/lib/alert-state.ts` | New: shared read/parse helper for alert-state.json |
| `scripts/lib/drift.ts` | Read `storage_drift.ignore`; skip allowlisted dirs |
| `scripts/heartbeat-precheck.ts` | Atomic write via temp+rename; corrupt-file quarantine |
| `scripts/update-alert-state.ts` | Atomic write via temp+rename; corrupt-file quarantine |
| `scripts/hermit-start.ts` | Pass `storage_drift.ignore` to drift check |
| `scripts/log-routine-event.sh` | Skip `fired` immediately following another `fired` |
| `skills/session-close/SKILL.md` | Completed-vs-Artifacts quality-check item |
| `skills/hermit-settings/SKILL.md` | Auto-reconcile heartbeat monitor after config write |
| `agents/proposal-triage.md` | State terse-output rationale |
| `agents/reflection-judge.md` | State terse-output rationale |
| `agents/quality-gate-judge.md` | State terse-output rationale |
| `state-templates/config.json.template` | Added `storage_drift: {ignore: []}` key |
| `state-templates/SESSION-REPORT.md.template` | `## Completed` labeled as narrative |

### Upgrade Instructions

Run `/claude-code-hermit:hermit-evolve`. The evolve skill handles:

1. **Refresh SESSION-REPORT.md template** — copy `${CLAUDE_PLUGIN_ROOT}/state-templates/SESSION-REPORT.md.template` to `.claude-code-hermit/templates/SESSION-REPORT.md.template`.

No `config.json` changes required. (`storage_drift.ignore` is additive and fail-open; domain plugins register their own dirs via their hatch steps.)

## [1.2.11] - 2026-06-24

### Added
- **hatch: idle_behavior choice in Quick** — Quick Turn 3 now asks proactive (`discover`) vs reactive (`wait`) instead of silently defaulting to `discover`, so operators pick deliberately.
- **cost-reflect: per-model cost breakdown** — adds a "Cost by model" section so mixed-model (Sonnet main + Haiku subagent) operators can attribute spend per model without reading raw logs. Section is omitted for single-model windows.
- **scripts/docker-preflight.ts** — single-call probe for docker-setup Step 1 (docker presence, config/WSL/existing-file checks, host gitconfig, auto-memory seed) returned as one JSON blob, replacing fanned-out Bash round-trips.
- **scripts/hatch-scaffold.ts** — deterministic state-tree scaffolder for hatch Step 2 (dirs, templates, `bin/` chmod, state files with a live `reflection-state.since`). Mode-aware: `--reinit=true` refreshes hermit-owned pristine files only and never clobbers operator/state artifacts.

### Changed
- **docker-setup: copy the static entrypoint with `cp`** — `docker-entrypoint.hermit.sh` (26 KB, no placeholders) is copied verbatim from the template instead of regenerated line-by-line through the model — cuts the slowest step of every docker-setup with zero transcription risk. Manifest baseline unchanged (cp is byte-identical).
- **docker-setup: Step 1 prerequisites via docker-preflight.ts** — one probe call; Steps 4/5 reuse its `gitconfig`/`memory` fields instead of re-probing.
- **hatch: Step 2 state tree via hatch-scaffold.ts** — replaces the enumerated mkdir/cp/chmod/init prose with one scaffold call; reasoned artifacts (config.json, OPERATOR.md content, CLAUDE block) keep their own steps.
- **hatch: append the session-discipline block with `cat`** — the placeholder-free CLAUDE-APPEND template is appended/created via `cat` instead of LLM regeneration (the replace path still removes the prior block first).
- **hatch: Phase 3/5 question specs as tables** — the verbose `questions: [...]` JSON examples collapse to compact, content-identical tables, trimming the resident SKILL.md. Verified a live Haiku run still builds the batched AskUserQuestion correctly from the table form.

### Fixed
- **docker: bash sandbox set off in containers** — `/hatch` and `/docker-setup` set `sandbox.enabled:false` for container deployments. The container is the isolation boundary Anthropic recommends for unattended runs; the nested bwrap sandbox is optional and, on Ubuntu 24.04+ hosts, can't start in-container and silently kills the heartbeat and `/watch` Monitors. `hermit-start` no longer manages the key at runtime; `/hermit-evolve` migrates existing installs. (https://code.claude.com/docs/en/sandbox-environments)
- **hatch: domain auto-resume** — domain hatch writes a state marker before delegating to core; core terminus reads, deletes, and invokes the pending domain hatch via the Skill tool. Removes the dead printed-command return hop and the competing-signal freeze. Adds the domain hatch continuation protocol doc.
- **hermit-docker login: re-authenticate on expired token** — gate the "already authenticated" short-circuit on credential freshness (`claudeAiOauth.expiresAt < Date.now()`), not just presence; an expired OAuth token now opens the login REPL instead of falsely reporting success.
- **hatch: init gate keys on `config.json`** — Step 1 now treats `config.json` (not bare directory content) as the "already initialized" signal, so a pre-core resume marker, an empty `state/` tree, or a half-written aborted run no longer trips the reinit prompt on a genuine first hatch.
- **hatch: Quick auto-chain vs resume** — the Quick auto-chain is suppressed when a resume marker is present, so it and the resume terminus can't both fire and drop each other. Resume marker no longer carries an unused `requested_at` field.

### Upgrade Instructions

Run `/claude-code-hermit:hermit-evolve`. The evolve skill handles:

**Step 1 — Docker sandbox posture (Docker hermits only).** Check for `docker-entrypoint.hermit.sh` at the project root — skip this step entirely if absent (non-Docker deployment). Otherwise determine the effective `sandbox.enabled`: read `.claude/settings.json` then `.claude/settings.local.json`, the last file to declare it wins (Claude Code's merge order). If it is not `true`, skip (already off). If it is `true`, this overrides an operator-set key with no safe default, so **defer to the step-10 operator prompt**:

- **question:** "This hermit runs in Docker with the bash sandbox on. Inside a container the container itself is the isolation boundary (Anthropic's recommended posture for unattended runs), and on Ubuntu 24.04+ hosts the nested sandbox can't start and silently kills the heartbeat and `/watch` monitors. Set `sandbox.enabled:false`?"
- **options:** `Set sandbox off (recommended)` → resolve the target settings file (`.claude-code-hermit/state/hatch-options.json` key `"target"`: `"local"` → `.claude/settings.local.json`, else `.claude/settings.json`) and run `bun ${CLAUDE_PLUGIN_ROOT}/scripts/apply-settings.ts <target-file> sandbox off`, then note "Rebuild to apply: `.claude-code-hermit/bin/hermit-docker update`." · `Keep sandbox on` → no change.

## [1.2.10] - 2026-06-23

### Added

- **scripts/manifest-seed.ts** — deterministic sha256-baseline writer for `template-manifest.json`; used by `hatch`, `docker-setup`, and `hermit-evolve`. Replaces model-computed hashes (LLM sha256 is unreliable), fixing silent drift misclassification. Fail-loud; refuses to overwrite a present-but-corrupt manifest; preserves foreign keys.
- **scripts/apply-settings.ts** — fixed-operation settings helper; hatch and docker-setup write settings via Bash (not Edit/Write tools), letting both succeed inside a running strict-profile hermit. Operations: `task-id`, `allow`, `deny`, `sandbox`.

### Changed

- **hatch: settings operations via apply-settings.ts** — Steps 5-task, 8, 9, 9a and docker-setup Step 6.4 call `apply-settings.ts` instead of the Edit/Write tools directly; the `always_on` guard on `.claude/settings.json` is intentionally left intact.
- **hatch: manifest-seed call deferred to Step 8** — seeding runs after the permission merge so `Bash(bun */scripts/manifest-seed.ts*)` is in the allow-list before the script executes.
- **docker-setup: batch read-only prerequisite probes** — Step 1's read-only shell checks (docker version, config/WSL checks, gitconfig) batched into one Bash call; write-paths remain sequential.

### Fixed

- **docker-entrypoint: marketplace registration via `list --json`** — `marketplace_registered()` reads `known_marketplaces.json`; fixes "No marketplaces configured" on a fresh named volume or partial prior add where the dir exists but isn't registered.
- **docker-entrypoint: plugin-enable failures now logged** — `enable_plugin()` suppresses only the benign "already enabled" exit; any other non-zero exit surfaces as a warning in `docker compose logs`. Previously `|| true` swallowed all failures.
- **hatch: apply-settings.ts aborts on malformed target settings file** — strict read prevents silent data-loss if the operator's settings file is present-but-corrupt.
- **docker-setup: manifest-seed call anchored to absolute PROJECT_ROOT path** — was cwd-relative; cwd can drift after `docker compose`/`tmux` calls earlier in the skill.

### Files affected

| File | Change |
|------|--------|
| `scripts/manifest-seed.ts` | New: deterministic template-manifest.json seeder |
| `scripts/apply-settings.ts` | New: fixed-op settings helper (task-id, allow, deny, sandbox) |
| `skills/hatch/SKILL.md` | apply-settings.ts integration; manifest-seed deferred to Step 8 |
| `skills/docker-setup/SKILL.md` | apply-settings.ts deny call; cwd-safe manifest-seed path |
| `skills/hermit-evolve/SKILL.md` | Delegates manifest write to manifest-seed.ts; adds manifest-seed.ts to required allow-list |
| `state-templates/docker/docker-entrypoint.hermit.sh.template` | `marketplace_registered()` + `enable_plugin()` helpers |
| `tests/manifest-seed.test.ts` | New: manifest-seed.ts tests |
| `tests/scripts.test.ts` | Tests for apply-settings.ts malformed-file abort |

### Upgrade Instructions

Run `/claude-code-hermit:hermit-evolve`. The evolve skill handles:

**Step 1 — Add apply-settings.ts allow entry.** Read `.claude-code-hermit/state/hatch-options.json` (key `"target"`: `"local"` → `.claude/settings.local.json`, else `.claude/settings.json`). Edit that file: merge `"Bash(bun */scripts/apply-settings.ts*)"` into `permissions.allow` (additive; skip if already present). `hermit-evolve` Step 8 adds `manifest-seed.ts` automatically.

**Step 2 — Re-seed template-manifest.json (after Step 8).** If `.claude-code-hermit/state/template-manifest.json` does not exist, skip. Otherwise run `bun ${CLAUDE_PLUGIN_ROOT}/scripts/manifest-seed.ts .claude-code-hermit` with this JSON on stdin:

```json
{
  "pluginVersion": "1.2.10",
  "entries": [
    { "key": "templates/SHELL.md.template", "file": "${CLAUDE_PLUGIN_ROOT}/state-templates/SHELL.md.template" },
    { "key": "templates/SESSION-REPORT.md.template", "file": "${CLAUDE_PLUGIN_ROOT}/state-templates/SESSION-REPORT.md.template" },
    { "key": "templates/PROPOSAL.md.template", "file": "${CLAUDE_PLUGIN_ROOT}/state-templates/PROPOSAL.md.template" },
    { "keyPrefix": "bin", "dir": "${CLAUDE_PLUGIN_ROOT}/state-templates/bin" }
  ]
}
```

Preserves existing entries for add-on hermit files; re-hashes only the core set.

**Step 3 — Docker entrypoint (Docker hermits only).** Check for `docker-entrypoint.hermit.sh` at the project root. Skip if absent. Skip if it already contains `marketplace_registered()`.

Refresh: copy `${CLAUDE_PLUGIN_ROOT}/state-templates/docker/docker-entrypoint.hermit.sh.template` → `docker-entrypoint.hermit.sh`.

Re-record the entrypoint baseline:

```
bun -e '
  const fs=require("node:fs"), c=require("node:crypto");
  const [tmpl, ver]=process.argv.slice(2);
  const mp=".claude-code-hermit/state/template-manifest.json";
  if(!fs.existsSync(mp)) process.exit(0);
  const m=JSON.parse(fs.readFileSync(mp,"utf8")); m.files ??= {};
  const h=c.createHash("sha256").update(fs.readFileSync(tmpl)).digest("hex");
  m.files["docker/docker-entrypoint.hermit.sh"]={sha256:h, plugin_version:ver};
  fs.writeFileSync(mp, JSON.stringify(m,null,2)+"\n");
' "${CLAUDE_PLUGIN_ROOT}/state-templates/docker/docker-entrypoint.hermit.sh.template" "1.2.10"
```

Rebuild (if Docker hermit is running): `.claude-code-hermit/bin/hermit-docker update`.

No `config.json` changes required.

## [1.2.9] - 2026-06-22

### Added

- **CLAUDE-APPEND: auto-mode denial alert** — hermit now notifies the operator (channel-first, per § Operator Notification) with the blocked action and reason when the auto-mode classifier denies a tool call.
- **heartbeat: dedicated update-alert-state.ts** — deterministic alert-state merge replacing the model-performed write; mirrors reflect's update-reflection-state pattern. Payload is delivered on stdin via a quoted heredoc so free-text alert content (apostrophes, quotes) can't break the command.

### Fixed

- **reflect/append-metrics: free-text JSON events delivered via stdin heredoc** — apostrophes in pattern labels and question strings no longer corrupt the metrics ledger (same shell-quoting class as #441). `append-metrics.ts` is now dual-mode: argv for enum/id/count/slug payloads, stdin for free-text. Call sites in reflect, reflect-scheduled-checks, channel-responder, and brief updated accordingly.

### Changed

- **docker: base image bumped to Ubuntu 26.04 LTS** — was 24.04; 26.04 is the current LTS. Existing hermits migrate via a surgical `FROM` patch that preserves Dockerfile customizations; evolve suppresses the now-stale docker-setup drift notice for this release.

### Files affected

| File | Change |
|------|--------|
| `scripts/update-alert-state.ts` | New script: deterministic alert-state merge via stdin |
| `scripts/append-metrics.ts` | Dual-mode: stdin for free-text, argv for enum/id payloads |
| `state-templates/CLAUDE-APPEND.md` | Auto-mode denial alert section added |
| `skills/heartbeat/SKILL.md` | Delegates alert-state write to `update-alert-state.ts` |
| `skills/reflect/SKILL.md` | `append-metrics` call sites updated to stdin heredoc |
| `skills/reflect-scheduled-checks/SKILL.md` | `append-metrics` call sites updated to stdin heredoc |
| `skills/channel-responder/SKILL.md` | `append-metrics` call sites updated to stdin heredoc |
| `skills/brief/SKILL.md` | `append-metrics` call sites updated to stdin heredoc |
| `state-templates/docker/Dockerfile.hermit.template` | `FROM ubuntu:26.04`; version comment updated |
| `docs/always-on.md` | Ubuntu version references updated to 26.04 |
| `docs/troubleshooting.md` | Ubuntu version reference updated to 26.04 |
| `skills/hermit-evolve/SKILL.md` | Step 2b note; Step 10 `base-patched` bullet + suppression rule |
| `agents/evolve-runner.md` | `Docker rebuild: base-patched` contract; delegated-rule note |
| `tests/docker-baseline-content.test.ts` | Add `FROM ubuntu:26.04` regression assertion |
| `tests/scripts.test.ts` | Tests for `update-alert-state.ts` and dual-mode `append-metrics.ts` |

### Upgrade Instructions

**Docker base image bump to Ubuntu 26.04.** Existing hermits with a deployed `Dockerfile.hermit` need a surgical `FROM` patch and rebuild. Non-Docker hermits: nothing to do.

**Step 1 — Existence / idempotency.** Check for `Dockerfile.hermit` at the project root. If it does not exist, skip to Step 4 (Docker not set up). If it already contains `FROM ubuntu:26.04`, skip to Step 3 (already patched; still re-record the baseline so the drift detector clears).

**Step 2 — Surgical patch.** Replace the exact line `FROM ubuntu:24.04` with `FROM ubuntu:26.04` in `Dockerfile.hermit`. If a comment line containing `Ubuntu 24.04 ships a default` is present, update it to `Ubuntu 26.04 ships a default` (cosmetic; tolerate absence). If `FROM ubuntu:24.04` is **not** found (operator changed the base image to something else), this is a genuine either/or with no safe non-destructive default — record a deferred-migration block with the instruction "manually set the base image to `ubuntu:26.04` in `Dockerfile.hermit`, then rebuild", skip this patch, and **continue the remaining evolve steps** (do not abort).

**Step 3 — Re-record the template baseline** so `classifyDockerTemplates` clears the drift and won't nag on future evolves. Run:

```
bun -e '
  const fs=require("node:fs"), c=require("node:crypto");
  const [tmpl, ver]=process.argv.slice(2);
  const mp=".claude-code-hermit/state/template-manifest.json";
  if(!fs.existsSync(mp)) process.exit(0);
  const m=JSON.parse(fs.readFileSync(mp,"utf8")); m.files ??= {};
  const h=c.createHash("sha256").update(fs.readFileSync(tmpl)).digest("hex");
  m.files["docker/Dockerfile.hermit.template"]={sha256:h, plugin_version:ver};
  fs.writeFileSync(mp, JSON.stringify(m,null,2)+"\n");
' "${CLAUDE_PLUGIN_ROOT}/state-templates/docker/Dockerfile.hermit.template" "<to>"
```

(`<to>` is the plan's `to` version string, available from the pre-pass result.)

If `.claude-code-hermit/state/template-manifest.json` does not exist, skip this step — drift was `unknown` and the patch alone is sufficient (docker-setup was never run, so there is no baseline to update).

**Step 4 — Report.** Set the report's `Docker rebuild` field to `base-patched`. Step 10 will emit a rebuild-only notice and suppress the generic "re-run /docker-setup" drift bullet for `Dockerfile.hermit`.

No `config.json` changes required.

## [1.2.8] - 2026-06-20

### Fixed

- **subagent-cost: capture async subagent costs** (#435) — new `scripts/subagent-cost.ts` on `SubagentStop`; reads the agent transcript and logs cost rows only for async-launched dispatches (heartbeat eval runner, routine dispatchers). Sync dispatches remain in cost-tracker; no double-count. Requires CC >= v2.1.143.

### Files affected

| File | Change |
|------|--------|
| `hooks/hooks.json` | Add `SubagentStop` hook entry |
| `scripts/subagent-cost.ts` | New: async subagent cost capture on stop |
| `scripts/lib/cc-compat.ts` | New: centralized accessors for CC-owned transcript formats |
| `scripts/cost-tracker.ts` | Guard to avoid double-counting async-launched agents |
| `tests/subagent-cost.test.ts` | New: 34 tests covering async cost capture contract |

### Upgrade Instructions

Run `/claude-code-hermit:hermit-evolve`. No further migration steps required.

No `config.json` changes required.

## [1.2.7] - 2026-06-19

### Added

- **session-close: third debrief question for skill-correction telemetry** — close debrief now asks whether a skill produced defective output this session; a positive answer appends a `skill-correction:<name>` ledger row to `state/observations.jsonl` (fail-open, gated to operator-close only). The `## Lessons` line carries the what/why; the ledger row is a bare recurrence counter.
- **reflect: `skill-correction:*` graduation routing** — graduated `skill-correction:<name>` ledger patterns resolve to a Tier 2 skill-improvement candidate: brief found → `## Skill Improvement` section with `source_artifact:` pointing to the procedure brief; no brief → plain Tier 2. Both routes carry `Artifact: state/observations.jsonl` and proceed via triage then micro-approval queue.
- **proposal-act: `source_artifact:` anchor for skill-creator improve** — before invoking `skill-creator:skill-creator`, parses the `source_artifact:` line from `## Skill Improvement`; if the brief path is readable, passes its content as input context. Missing or unreadable: proceeds without it (no REJECT).
- **heartbeat: configurable eval model (`heartbeat.model`, default `haiku`)** — cuts the EVALUATE subagent cost ~70% on sonnet sessions. Override to `"sonnet"` or `"opus"` for richer checklist evaluation, or set to `null` to inherit the session model. Dispatch now uses `claude-code-hermit:skill-eval-runner` explicitly with the configured model. Step 5 gains a fail-open JSON guard: malformed or incomplete subagent returns skip the state merge and emit `HEARTBEAT_OK` rather than corrupting `alert-state.json`.

### Fixed

- **session-mgr: report filename is invariant** (#418) — archive steps now explicitly state that the report file is always `${session_id}-REPORT.md`; if it already exists, overwrite in place. Prevents the archiving model from improvising a dated `S-NNN-REPORT-YYYYMMDD-HHMM.md` duplicate when the canonical file is already present (e.g. re-archive of a previously operator-closed session).
- **hermit-evolve: confirm the `_hermit_versions` bump on disk (#426)** — step 9 now performs the version bump via a deterministic `scripts/evolve-finalize.ts` instead of an LLM hand-edit. The runner reports the re-read on-disk version (`core.confirmed`) instead of `plan.to`. A dropped bump now surfaces as `Upgrade: blocked` instead of falsely reporting success and re-nagging the upgrade banner every session.
- **recall: reap stray timestamped report stubs on upgrade** (#430) — existing `S-NNN-REPORT-YYYYMMDD-HHMM.md` stubs (created before #427) bypass strict consumers but pollute `/recall`'s broad scan; hermit-evolve now deletes them on next upgrade.

### Files affected

| File | Change |
|------|--------|
| `skills/session-close/SKILL.md` | Add third debrief question; append `skill-correction:<name>` ledger row on positive answer |
| `skills/reflect/SKILL.md` | `skill-correction:*` graduation routing; Component Health note linking to ledger |
| `skills/proposal-act/SKILL.md` | Parse `source_artifact:` anchor; pass procedure brief to skill-creator improve |
| `docs/architecture.md` | Add `observations.jsonl` state ownership row; startup-drift source value |
| `tests/skill-correction-ledger.test.ts` | New: 25 tests covering capture contract, ledger round-trip, graduation routing, anchor-parse |
| `state-templates/config.json.template` | Add `heartbeat.model: "haiku"` to heartbeat block |
| `skills/heartbeat/SKILL.md` | Step 4: read `heartbeat.model`, dispatch via `skill-eval-runner` with explicit model; step 5: fail-open JSON guard |
| `scripts/validate-config.ts` | Validate `heartbeat.model` against `[opus, sonnet, haiku]` in the heartbeat block |
| `scripts/evolve-finalize.ts` | New: deterministic `_hermit_versions` writer — atomic read-modify-write, on-disk confirm, fail-loud exit |
| `skills/hermit-evolve/SKILL.md` | Step 8: add `evolve-finalize.ts` to required permissions; step 9: run finalizer, report `core.confirmed` |
| `agents/evolve-runner.md` | Step-9 delegated note + version-bump rule; report `vNEW` from `core.confirmed`; blocked on mismatch |
| `skills/hatch/SKILL.md` | Add `Bash(bun */scripts/evolve-finalize.ts*)` to permissions seed list |
| `tests/evolve-finalize.test.ts` | New: 16 tests covering #426 regression, key preservation, sibling gating, mismatch, idempotency, exit codes |

### Upgrade Instructions

Run `/claude-code-hermit:hermit-evolve`. The evolve skill handles:

1. Update the plugin — run `claude plugin update claude-code-hermit`.
2. Add `Bash(bun */scripts/evolve-finalize.ts*)` permission — hermit-evolve step 8 adds it automatically if missing.
3. Add `"model": "haiku"` to the `heartbeat` block in `.claude-code-hermit/config.json` (e.g. after `"clean_recheck_cooldown"`). Cuts EVALUATE subagent cost ~70% on sonnet sessions. To keep prior behavior (session model), set `"model": null` or omit the field.
4. Reap stray timestamped report stubs — in `.claude-code-hermit/sessions/`, delete any `S-*-REPORT-*.md` files that have a timestamped suffix (the variant only, not the canonical `S-NNN-REPORT.md`).

## [1.2.6] - 2026-06-17

### Added

- **reflect: break reflection input-starvation** — three changes that unblock the pipeline on hermits where `observations.jsonl` never fills: (1) `reflect-precheck.ts` now writes storage-drift and schema-drift rows to the observations ledger (deduped by pattern — drift is structural, so a standing drift writes one row until it ages out of the 30-day prune window, not one per session, and never re-triggers a full reflect run every session; the drift slug preserves the full subpath, e.g. `storage-drift:raw/foo`); (2) a freshness RUN gate (`observations_fresh` phase key) flips EMPTY→RUN when new ledger rows exist; (3) new config key `reflection.graduation_min_sessions` (default 1) lowers the graduation threshold from a hardcoded 2, so single-session observations can surface. The judge, triage, and all security guards are unchanged.
- **reflect: `origin` field on ledger rows** — `startup-drift` rows carry `origin:"own-work"`; `reflect-noticed` rows carry `origin` copied from SHELL.md `[origin: external]` markers. Step 3b aggregates origin across grouped rows (external-content wins) and carries it into the candidate's `Evidence Origin`, so judge §2 correctly quarantines external-origin observations to Tier 3.
- **config: `reflection.graduation_min_sessions`** — positive integer, default 1. Dial to 2 to restore pre-v1.2.6 behavior. Applies to both observations-ledger graduation and procedure-capture recurrence. Documented in `docs/config-reference.md` and `hermit-settings reflection`.

### Changed

- **reflect step 3b: graduation threshold is now config-driven** — removed "at least one not the current session" sub-clause; replaced hardcoded ≥2 with `graduation_min_sessions`.
- **reflection-judge §1.4: config-agnostic verification** — verifies ≥1 ledger row per cited session instead of hardcoded ≥2 distinct sessions.
- **proposal-triage + proposal-create: accept ledger graduates** — broadened the artifact exception so any judge-verified `Artifact: state/observations.jsonl` candidate satisfies condition 1 (was limited to efficiency/cost-class candidates).
- **channel-responder: delegation nudge at §2** — adds a one-sentence pointer before the handler list so archive traversals and multi-file research dispatched from channel questions delegate to Explore rather than running inline in the long-lived session.
- **CLAUDE-APPEND: trim reference sections** — removed Agent State table, Subagents catalog, and Quick Reference list (~100 → ~75 lines); content covered by `architecture.md` and `docs/skills.md`, which don't reload every turn. Fixed 23 stale `.py`/`.js` doc references (all scripts migrated to `.ts`). Added missing core agents to `architecture.md` Layer 3. Added "Scheduling ownership boundaries" subsection to `architecture.md`.

### Files affected

| File | Change |
|------|--------|
| `scripts/reflect-precheck.ts` | Write drift rows to observations ledger; dedup by pattern |
| `scripts/lib/drift.ts` | Shared drift-slug helper |
| `scripts/startup-context.ts` | Pass `graduation_min_sessions` to precheck |
| `scripts/validate-config.ts` | Validate `reflection.graduation_min_sessions` |
| `skills/reflect/SKILL.md` | Freshness gate, config-driven graduation, origin aggregation |
| `skills/reflect/reference.md` | Updated schema for origin field |
| `agents/reflection-judge.md` | §1.4 config-agnostic verification |
| `agents/proposal-triage.md` | Accept ledger graduates as condition-1 evidence |
| `skills/proposal-create/SKILL.md` | Same artifact exception broadening |
| `skills/hermit-settings/SKILL.md` | Document `reflection.graduation_min_sessions` |
| `state-templates/config.json.template` | Add `reflection.graduation_min_sessions: 1` |
| `skills/channel-responder/SKILL.md` | Delegation nudge at §2 |
| `state-templates/CLAUDE-APPEND.md` | Trim reference sections (~100 → ~75 lines) |
| `docs/architecture.md` | Add missing agents; scheduling ownership subsection |
| `docs/config-reference.md` | Update `watchdog.enabled` description |
| `tests/reflect-first-sighting.test.ts` | New: covers drift-row dedup and freshness gate |
| `tests/reflect-loop.test.ts` | New: covers graduation threshold |
| `tests/procedure-capture.test.ts` | Updated for config-driven threshold |

### Upgrade Instructions

Run `/claude-code-hermit:hermit-evolve`. The evolve skill handles:

1. Update the plugin — run `claude plugin update claude-code-hermit`.
2. Add `reflection` to `config.json`: open `.claude-code-hermit/config.json` and add `"reflection": { "graduation_min_sessions": 1 }` at the top level (before the closing `}`). Ships enabled by default; set to 2 to restore the two-session recurrence bar.

## [1.2.5] - 2026-06-16

### Changed

- **CLAUDE-APPEND: codify main-as-orchestrator delegation guideline (#406)** — §Context-hygiene now covers execution delegation: a three-condition test for when to dispatch a sub-step, the comms contract (subagent returns verdict + optional `operator_message`; main owns `AskUserQuestion`, channel resolution, `PushNotification`), and the `CLAUDE.md`-inheritance break-even.
- **proposal-act: dispatch the accept-flow tail to a general-purpose subagent (#402)** — implement, quality gate, and verification run in one isolated subagent context; only a compact structured report returns. Skill-authoring (`## Skill Improvement`, `## Skill Draft`) and routine proposals remain in main.

### Files affected

| File | Change |
|------|--------|
| `state-templates/CLAUDE-APPEND.md` | Added delegation guideline to §Context-hygiene + §Operator Notification cross-reference |
| `CLAUDE.md` | Same framing added to plugin dev CLAUDE.md |
| `skills/proposal-act/SKILL.md` | Step (e) dispatches implement+gate+verify to general-purpose subagent |
| `tests/contracts.test.ts` | Added `proposal-act dispatch contract` assertions |

### Upgrade Instructions

Run `/claude-code-hermit:hermit-evolve`. The evolve skill handles:

1. Update the plugin — run `claude plugin update claude-code-hermit`.

No `config.json` changes required.

## [1.2.4] - 2026-06-14

### Fixed

- **hermit-routines: routines silently never registered (#395)** — `load` resolved pluginRoot via `echo $CLAUDE_PLUGIN_ROOT`, which is empty at Bash runtime in all modes, so the guard aborted load and no CronCreate was registered. Now derives pluginRoot from the skill's Base directory (mirrors the #394 hermit-evolve fix).
- **cost-tracker: attribute dispatched-subagent tokens (#390)** — Agent tool_result usage (model-override routines, heartbeat, ad-hoc Task) was silently dropped; now emitted as a per-subagent cost-log line at its resolved model, attributed to the dispatching source. Cost totals will rise to reflect previously-invisible spend; cost-reflect folds subagent cost into the dispatching source row automatically.
### Changed

- **min CC version: floor bumped to 2.1.172 (#389)** — nested-subagent dispatch (used by the shipped `daily-auto-close: haiku` default) requires it; on older versions the nested `session-mgr` call fails silently, preventing auto-close. Prerequisite docs updated.
- **hermit-evolve: upgrades now run in an `evolve-runner` subagent** — keeps the upgrade's transient context (changelog, migrations, diffs) out of the calling session, cutting recurring token cost; only a compact report returns. Undecidable migration choices escalate back to the operator. Interactive evolve no longer prompts mid-flight for new settings or template-conflict choices — safe defaults applied, conflicts parked as `.new`; adjust via `/hermit-settings`.
- **heartbeat: unreachable OK gate replaced by clean-recheck damper** — the per-item OK fast-path in `heartbeat-precheck.ts` was unreachable for any hermit with a checklist (clean items never produce alert entries, which the gate required). A `clean_recheck_cooldown` damper (default `"6h"`) now makes the clean path reachable: after a clean EVALUATE, subsequent ticks return OK directly until the cooldown expires. All change-detecting gates — stale session, micro-proposal, pending-close, suppressed-digest, 20-tick self-eval — bypass the damper. This reduces LLM wakes from every-tick to ~3 per active-day for a healthy hermit. Set `heartbeat.clean_recheck_cooldown: null` to revert to per-tick EVALUATE.

### Changed

- **hermit-brain / hermit-evolution / capability-brainstorm: dispatch heavy reads to `skill-eval-runner`** — the three Tier-2 skills that read session-report bodies, weekly-review files, compiled artifacts, and proposal contents inline now dispatch those reads (and `proposal-metrics-report.ts` / `cost-reflect.ts` script runs) to the shared isolated-context `skill-eval-runner`. Main session keeps channel routing, proposal creation, artifact writes, and channel sends. The dispatching skill passes the resolved `plugin_root` in the dispatch prompt so the runner can run scripts and read template/sibling paths — `${CLAUDE_PLUGIN_ROOT}` is not substituted in `reference.md` content read via the Read tool. Contract tests in `tests/contracts.test.ts` guard against dispatch-ref loss, schema drift, and `${CLAUDE_PLUGIN_ROOT}/` path use in any `reference.md`.
- **weekly-review: topic-page semantic check runs in an isolated-context subagent** — Step 3's full-body topic-page reads are dispatched to `skill-eval-runner` via a new `skills/weekly-review/reference.md`. The runner reads every `compiled/topic-*.md` and returns `{ topic_findings }` (≤3 findings); all channel send and side effects stay in the main session. A `weekly-review delegation contract` in `tests/contracts.test.ts` guards against schema drift.

- **brief: dispatch archived-report/cost/proposal reads to skill-eval-runner** — archived `S-*-REPORT.md` bodies, `cost-summary.md`, `proposals/*.md` frontmatter, `OPERATOR.md`, and `NEXT-TASK.md` are dispatched to the shared `skill-eval-runner` via a new `skills/brief/reference.md`. Live state, TaskList, micro-proposal lifecycle, and delivery stay in the main session. Dispatch is mode-conditional: `--morning`, `--evening`, daily, and default-no-session modes dispatch; `in_progress` default mode summarizes the live SHELL.md in main. A `brief delegation contract` in `tests/contracts.test.ts` guards against schema drift.

- **reflect: file analysis runs in a shared isolated-context subagent** — Resolution Check, routine health, and procedure-capture detection are dispatched to a new `skill-eval-runner` agent (a generic, reference-driven runner any skill can reuse by pointing it at its own `reference.md`). The runner reads only files and returns structured JSON; all writes, frontmatter patches, and proposal routing stay in the main session. Eliminates the 3-verbatim-report read from the main session's inherited context, cutting per-reflect input tokens on always-on hermits. The dispatching skill passes the resolved `plugin_root` in the dispatch prompt so the runner can run `eval-success-signal.ts` — `${CLAUDE_PLUGIN_ROOT}` is not substituted in `reference.md` content read via the Read tool. A `reflect delegation contract` in `tests/contracts.test.ts` asserts the schema block is byte-identical between `reference.md` (producer) and `SKILL.md` (consumer), preventing drift.

- **heartbeat: EVALUATE runs in an isolated-context subagent** — the checklist evaluation is dispatched as a fresh-context Agent subagent instead of running inline in the main session. The eval reads only files and needs none of the inherited main-session context; moving it to isolated context significantly reduces per-wake token cost. The main session handles all writes (alert-state, SHELL.md Monitoring) and notifications after receiving the subagent's structured JSON result, keeping cost attribution and channel access on the main turn.

### Upgrade Instructions

Run `/claude-code-hermit:hermit-evolve`. The evolve skill handles:

1. Add `"clean_recheck_cooldown": "6h"` under `heartbeat` in `.claude-code-hermit/config.json`. If already present, skip. To disable the damper (revert to per-tick EVALUATE), set the value to `null`.

## [1.2.3] - 2026-06-13

### Added

- **Community Discord** — dev-community invite published in both READMEs with channel shape, starter threads, moderation notes, and invite publishing checklist.

### Fixed

- **capability-brainstorm: use fully-qualified skill name for proposal-create** — short-form `/proposal-create` fails when the model autonomously invokes a skill; changed to `/claude-code-hermit:proposal-create` so the Skill tool resolves it correctly.
- **proposal-act/reflect/proposal-create: fully-qualify skill-creator invocations** — short-form `/skill-creator` fails when the model invokes the skill (procedure-capture install, skill-improvement, `NEXT-TASK.md` plan bullets); changed to `/skill-creator:skill-creator` so the Skill tool resolves it.
- **session-start: suppress duplicate startup ping after watchdog context-clear (#385)** — when the watchdog sends `/clear` to refresh context, a scheduled task could re-invoke `session-start` and re-send the "Hermit online" ping. The watchdog now writes `context_cleared: true` to `state/runtime.json` before `/clear`; session-start detects and consumes the marker and suppresses the ping for that invocation only.
- **hooks: cwd-drift bug class resolved (#384)** — `hermitDir()` added to `scripts/lib/cc-compat.ts` resolves `.claude-code-hermit/` via `AGENT_DIR` → `CLAUDE_PROJECT_DIR`+`existsSync` → cwd walk-up → fail-open, surviving any `cd` that drifts shell cwd inside `.claude-code-hermit/`. All 10 affected hook scripts updated; payload-anchored hooks anchor on the absolute `file_path` from the hook payload instead.

### Files affected

| File | Change |
|------|--------|
| `scripts/lib/cc-compat.ts` | Adds `hermitDir()` — resolves `.claude-code-hermit/` surviving cwd drift |
| `scripts/channel-hook.ts` | Uses `hermitDir()` |
| `scripts/cost-tracker.ts` | Uses `hermitDir()` |
| `scripts/session-diff.ts` | Uses `hermitDir()` |
| `scripts/startup-context.ts` | Uses `hermitDir()` |
| `scripts/stop-pipeline.ts` | Uses `hermitDir()` |
| `scripts/record-operator-action.ts` | Uses `hermitDir()` |
| `scripts/channel-reply-reminder.ts` | Uses `hermitDir()` |
| `scripts/cache-edit-guard.ts` | Uses `hermitDir()` |
| `scripts/prompt-context.ts` | Uses `hermitDir()` |
| `skills/capability-brainstorm/SKILL.md` | Fully-qualified `proposal-create` invocation |
| `skills/proposal-act/SKILL.md` | Fully-qualified `skill-creator` invocations |
| `skills/proposal-create/SKILL.md` | Fully-qualified `skill-creator` invocation |
| `skills/reflect/SKILL.md` | Fully-qualified `skill-creator` invocation |
| `agents/session-mgr.md` | Updated for watchdog `context_cleared` marker |
| `README.md` / plugin `README.md` | Community Discord invite added |

### Upgrade Instructions

Run `/claude-code-hermit:hermit-evolve`. The evolve skill handles:

1. **Update the plugin** — run `claude plugin update claude-code-hermit` to get the fixed hooks and skills.

No `config.json` changes required.

## [1.2.2] - 2026-06-13

### Added

- **routine-metrics: `started` marker before skill invocation** — distinguishes "routine fired but errored before completion" (emits `started`, no `fired`) from "correctly never fired" (no entries). `reflect` now surfaces routines where `errored = count(started) − count(fired) >= 2` over 14 days as a diagnostic finding. Closes #378.
- **watchdog: context-size auto-clear** — sends `/clear` when a hermit-owned turn's prompt-side tokens (`input + cache_write + cache_read`) exceed `watchdog.context_clear_tokens` (default 700 000), preventing scheduled routines from re-reading a bloated context at 5–22× normal cost. Fires independently of `watchdog.enabled`; gated on always-on mode, operator silence ≥ 10 min, and 2-tick pane-hash quiescence. Fixes #373.
- **watchdog: liveness signal + doctor detection** — `hermit-watchdog run` now stamps `last_run` into `state/watchdog-state.json` on every invocation, before any gate, so a fresh stamp proves the scheduler/loop (systemd/launchd/cron or the Docker entrypoint loop) is firing the script. `hermit-doctor`'s `watchdog` check reads it: a stale (>20 min) or missing stamp reports `enabled but not firing` with remediation keyed to `runtime_mode` (tmux → `bin/hermit-watchdog install`; docker → recreate the container; unknown → both). Replaces the `systemctl`/`crontab`/`ps` self-diagnosis that false-alarmed on healthy Docker hermits (the loop runs no OS timer by design, and `watchdog.log` only captures stderr, so it stays stale even when firing).

### Fixed

- **hermit-evolve: stop seeding dead `watchdog/` templates into project state (#379)** — v1.2.0 seeded four infra templates into `.claude-code-hermit/watchdog/`; nothing reads them (`hermit-watchdog install` renders from the plugin's `state-templates/watchdog/`), and the storage-drift checker flagged them on every session start. Seeding removed; existing stray dirs cleaned up on next evolve.
- **reflect, hermit-evolution: name the `event` field in routine-metrics fire counts** — prevents silent zero counts when a model confuses `routine-metrics.jsonl`'s `event` field with `proposal-metrics.jsonl`'s `type` field; both skills now explicitly say `event == "fired"` (#375).

### Files affected

| File | Change |
|------|--------|
| `scripts/hermit-watchdog.ts` | Adds `last_run` liveness stamp and context-clear auto-send |
| `scripts/doctor-check.ts` | Reads `last_run` to detect non-firing watchdog |
| `scripts/log-routine-event.sh` | Emits `started` event before skill invocation |
| `scripts/validate-config.ts` | Validates `watchdog.context_clear_tokens` field |
| `skills/reflect/SKILL.md` | Surfaces errored routines (`started` without `fired` ≥ 2) |
| `skills/hermit-doctor/SKILL.md` | Adds liveness check to watchdog section |
| `skills/hermit-evolution/SKILL.md` | Names `event` field in routine-metrics queries |
| `skills/hermit-routines/SKILL.md` | Documents started-marker behavior |
| `state-templates/config.json.template` | Adds `context_clear_tokens: 700000` to watchdog block |

### Upgrade Instructions

Run `/claude-code-hermit:hermit-evolve`. The evolve skill handles:

1. **Remove dead watchdog template dir** — in `.claude-code-hermit/watchdog/`, delete only these four files if present: `hermit-watchdog@.service`, `hermit-watchdog@.timer`, `com.hermit.watchdog.plist`, `crontab.txt`. Then run `rmdir .claude-code-hermit/watchdog/`. `rmdir` refuses a non-empty dir — if the operator added their own files, leave the dir intact and note it. Use per-file `rm` plus `rmdir` only, never `rm -rf`.
2. **Add `context_clear_tokens` to `watchdog` config** — add `"context_clear_tokens": 700000` to the `watchdog` block in `.claude-code-hermit/config.json`. To disable, set to `null` or `0`.
3. **Seed watchdog liveness stamp** — run `.claude-code-hermit/bin/hermit-watchdog run` once to write `last_run` into `state/watchdog-state.json` before the first tick. Stamped before any gate, so it works even with `watchdog.enabled: false`.

## [1.2.1] - 2026-06-12

### Fixed

- **Docker: entrypoint reboot-loop after 1.2.0 upgrade** — `docker-entrypoint.hermit.sh.template` contained `SESSION_NAME="{{TMUX_SESSION_NAME}}"` (a placeholder previously substituted only by `/docker-setup`). The 1.2.0 Upgrade Instructions told Docker operators to `cp` the raw template without a substitution step, leaving the literal string `{{TMUX_SESSION_NAME}}`. The keep-alive watch loop (`tmux has-session -t "{{TMUX_SESSION_NAME}}"`) exited immediately, PID 1 fell through, and `restart: unless-stopped` reboot-looped the container. The entrypoint now resolves the session name from `config.json` at runtime using the same logic as `lib/tmux.getSessionName`; the file is safe to raw-copy with no substitution.
- **Docker: `${PWD}` bind-mount mounts wrong tree when compose runs from wrong directory** — added a comment in `docker-compose.hermit.yml.template` clarifying that `docker compose` must run from the project root (`hermit-docker up` always does this). This was the secondary cause of collateral container failures during manual recovery after the reboot-loop above.
- **`hermit-docker update`: ephemeral plugin update reverted on restart** — it refreshed marketplaces and sent `/reload-plugins`, which serves the newest *staged* version but never moves the version pin in `installed_plugins.json`; the next container restart reverted to the old plugin. Now runs `claude plugin update <id>@<marketplace> --scope <scope>` per installed plugin (the only durable operation — verified against CC 2.1.175), records per-plugin `before`/`after`/`status` in `update-history.jsonl`, and auto-chains `/claude-code-hermit:hermit-evolve unattended` into the tmux session when the core version moved. Reads post-update pins before the reload to dodge `plugin list` view lag.
- **`hermit-docker` prompt-detection was stale for current Claude Code** — `_wait_for_claude_prompt` matched only the old `╭─/╰─` rounded-corner input box, which CC 2.1.175 no longer renders (it uses `────` rules + `❯` + a mode hint), so the wait always timed out and `/reload-plugins` was never sent. Detector now matches the prompt char plus any current box marker; verified live (reload → gated follow-up command executes in the REPL).

### Added

- **`hermit-evolve`: explicit `unattended` argument** — `/claude-code-hermit:hermit-evolve unattended` runs the full upgrade with zero prompts (settings → defaults, permissions added + reported, migration prompts deferred/non-destructive, conflicts parked as `.new`), reporting everything via the channel notification. The no-prompt rule now also covers Step 2b changelog migrations and Step 7 sibling migrations, which previously could block on an `AskUserQuestion`.
- **`bin/hermit-update`: one-command update for local / tmux hermits** — host twin of `hermit-docker update`. Moves the durable pin for project/local plugins (skips user-scope with a manual-command hint), reloads the live tmux session, and auto-chains `hermit-evolve unattended` on a version gap. Delegates to `hermit-docker update` when a Docker stack is running; refuses (rather than touching host pins) when Docker scaffolding exists but the container is stopped.
- **always-on directive upgrade banner** — `check-upgrade.sh` now reads `always_on` and, when true, emits a `REQUIRED:` banner instructing the session to run `hermit-evolve unattended` before other work; `session-start` and `brief` treat it as the hard first action. Interactive hermits keep the advisory wording.
- **`hermit-evolve`: Docker entrypoint is manifest-managed (Step 5c)** — now that the entrypoint is placeholder-free it joins the customization-aware `template-manifest.json` system as a boot-critical file: operator edits are kept (`customized-kept`), conflicts install the new upstream and back up the operator's copy to a gitignore-safe `.claude-code-hermit/state/*.bak`. Closes the "rebuild bakes in the stale on-disk entrypoint" footgun. Compose/Dockerfile remain wizard-rendered and get a report-only upstream-drift signal (`docker_templates`) with a refresh-then-rebuild ordering note. `/docker-setup` records the three upstream template hashes; `doctor-check` warns when docker files are deployed but their baselines are unrecorded.

### Upgrade Instructions

The bin/ wrappers (including the new `hermit-update`) and the Docker entrypoint are refreshed automatically by `hermit-evolve` (Steps 5b/5c) — no manual step needed. Docker operators who deployed before this version will see `doctor-check` warn that docker baselines are unrecorded and `hermit-evolve` report a `Docker: baseline not recorded` note until they run `/claude-code-hermit:docker-setup` once (it re-renders and records the template hashes). Always-on operators: upgrade banners are now directive (`REQUIRED:`) and trigger an unattended evolve at session start; this is opt-out by setting `always_on: false`.

Docker operators still on 1.2.0's broken entrypoint: re-copy the now-placeholder-free entrypoint (no substitution needed after the copy) then rebuild:
```
cp "$(claude plugin path claude-code-hermit)"/state-templates/docker/docker-entrypoint.hermit.sh.template \
  ./docker-entrypoint.hermit.sh
.claude-code-hermit/bin/hermit-docker update
```
For normal start/stop use `.claude-code-hermit/bin/hermit-docker up` (it runs compose from the project root); if invoking `docker compose` directly, do it from the project root so `${PWD}` resolves correctly.

## [1.2.0] - 2026-06-12

### Added

- **hermit-evolve: customization-aware template/bin updates** — `state/template-manifest.json` records the sha256 of every `templates/` and `bin/` file at hatch time; upgrades classify each changed file as `unmodified` (safe to overwrite), `customized-kept` (operator edited, template didn't move — kept silently), or `conflict` (both changed — parked as `.new` for templates, replaced with `.bak` for boot-critical bin/ wrappers). Deleted wrappers are restored. Closes the silent-overwrite surface that previously destroyed operator customizations on every upgrade touching those files. `hatch` now enumerates `state-templates/bin/` dynamically (fixes missing `hermit-watchdog` in prior seeding). `doctor-check` validates manifest shape.
- **hatch: `.worktreeinclude` template** — carries `OPERATOR.md` + `compiled/` into `claude --worktree` worktrees so worktree sessions start with hermit context. A managed marker block (`# >>> claude-code-hermit`) is appended to the project-root `.worktreeinclude`; only read-only context is included (runtime state, config, and channels are deliberately excluded to preserve the single-writer hermit invariant).

- **living topic pages (`type: topic`)** — undated `compiled/topic-<slug>.md` updated in place at session-close (merge findings, bump `updated`, refresh one-line `summary`) instead of accumulating dated copies; exempt from archive rotation; staleness linted on `updated ?? created` across all topic pages; new `topic-missing-updated` lint; declared in the knowledge-schema template alongside a `## Conventions` section for `[[wikilink]]` cross-references (#316).
- **recall write-back** — after a synthesis drawing on 3+ distinct sources, recall offers (operator-confirmed, never automatic) to file it: small durable fact → auto-memory, domain synthesis → topic page.
- **weekly-review: topic-page semantic check** — read-only scan for contradictions, stale claims, and broken `[[wikilinks]]` across topic pages; up to 3 findings join the channel summary.

### Upgrade Instructions

Run `/claude-code-hermit:hermit-evolve`. The evolve skill handles:

1. **Seed `state/template-manifest.json`** — the first evolve after this version ships finds no manifest and runs in bootstrap mode: every managed `templates/` and `bin/` file that differs from upstream is classified as operator-unmodified and silently overwritten. Any file that gets overwritten on this first run will also have a one-time `<name>.bak` written alongside it — if you had customizations before this version shipped, check for `.bak` files in `templates/` and `bin/` to recover them. After this run the manifest is seeded and subsequent upgrades classify correctly.

### Changed

- **startup knowledge injection: catalog-only for non-foundational artifacts** — recent-artifact bodies are replaced by a one-line-per-artifact catalog (stem, type, date, tags + summary line); nothing silently drops out of the injection window anymore. Foundational pages keep full-body/stub injection at the 40% pinned budget, now without the per-type newest-wins collapse (multiple same-type foundational pages all pin); unused pinned budget rolls into the catalog. `procedure-brief` artifacts are excluded from injection, enforcing the schema's existing not-session-injected contract. `search.ts` recency and result dates read `updated` before `created`. `injection_stub` is now only read for foundational artifacts.

### Added

- **post-close context reset via `/clear`** (#340) — after `daily-auto-close` archives a session, the watchdog sends `/clear` on the next tick when the session is idle and unattended, so the next sparse wake reads only the startup-context injection instead of the full stale conversation (drops the 1.25× cold cache-write). Preserves process-scoped `CronCreate` routines and `Monitor` tasks; no re-arm needed. Enabled by default (`post_close_clear: true`); only fires when the watchdog runs on a schedule (Docker: automatic; bare-metal: requires `hermit-watchdog install`).
- **raw/.archive purge policy + raw-size doctor check** (#344) — new `knowledge.archive_retention_days` config key (default `null` = keep forever) deletes `.archive/` entries past retention (`-latest.*` pins never purged); `reflect-precheck` runs `archive-raw` on a 7-day debounce so archival happens regardless of weekly-review; doctor gains a `raw-size` check warning when `raw/` exceeds 50 MB or archival is 14+ days stale with raw files present.
- **heartbeat liveness check in `/hermit-doctor`** (#346) — `heartbeat-monitor.sh` writes `state/heartbeat-liveness.json` (`last_peek_at`) on every poll iteration; `doctor-check.ts` gains a `heartbeat` check (14 JSON checks total) that fails with a seccomp/container diagnosis when an active session's heartbeat has not ticked in 3× the configured interval, or when no tick lands within a short (~2m) startup grace after the monitor registers. A tick older than the monitor's `started_at` is ignored so a prior session's liveness file can't mask a dead restart. Closes the silent-death hole where a Monitor subprocess blocked by kernel restrictions reported fully healthy. `parseDuration` moved to `scripts/lib/time.ts` (shared with precheck). Report grows to fifteen lines (fourteen JSON + sandbox).

- **deny-patterns: block Edit/Write to installed plugin source** — a hermit can no longer modify its own files under `~/.claude/plugins/marketplaces/` (#351).
- **doctor-check: `runtime` check (bun)** — verifies bun presence and version against `required_bun_version` in `hermit-meta.json` (report grows to 13 checks); `hermit-start` preflight hard-errors when bun is missing or below 1.3.0.

- **doctor-check + cost-summary: Opus automated-wake warning** — new 14th doctor check (`opus-wake`) and a `## This Week` line surface automated-source turns (`heartbeat` / `routine:*`) running on Opus over the trailing 7 days; soft warn, no block. Closes the silent $529-Opus-spend failure mode (#342).

- **reflect: observations ledger with mechanical graduation** — sub-threshold observations (cost spikes, quick-mode deferrals, failed three-condition candidates) append to `state/observations.jsonl` instead of project memory; step 3b prunes (30-day TTL, recurrence keeps a pattern's history) and promotes patterns seen in ≥2 distinct sessions to candidates carrying a ledger `Artifact:` citation. New `scripts/prune-observations.js`.
- **reflection-judge: ledger artifact verification + covered-by-memory exemption** — §1.4 verifies `state/observations.jsonl` citations directly (sub-threshold patterns live only in the ledger); ledger-graduated candidates are never suppressed `covered-by-memory`. Closes the lifecycle bug where recording a pattern to memory got it suppressed at graduation.
- **reflect: ephemerality exception for procedure capture** — single-session eligibility when the procedure's artifacts are ephemeral (outside repo/state, e.g. `/tmp`) and the cost is already quantified in session content; Tier 3, kill criteria still apply.
- **weekly-review: reflect vital-signs line** — review gains `reflect_runs/candidates/surfaced/accepted/cost_usd` frontmatter and a `### Reflect` section with a suppression digest (slug:code), computed week-scoped from session-report Progress Log lines and proposal-metrics.jsonl events; evolution block relays it. Makes a healthy-quiet reflect loop distinguishable from a dead one. Also surfaces the observations-ledger size (`obs: N ledger (+M this week)` + `reflect_observations` frontmatter), rendering even when reflect runs are zero — the dashboard input for the #343 reflect-yield kill decision.
- **session-close: close debrief in Lessons** — step 1 asks what was built ad-hoc this session (throwaway scripts, manual procedures, long waits a tool would remove) and what had to be re-derived that a compiled note should have covered; persists one quantified Lesson line per item (substantial re-derived knowledge goes to `compiled/`); arms procedure-capture recurrence upstream.
- **cost-tracker: `api_calls` and `context_usage` per log entry** — each cost-log.jsonl entry now records the number of API calls summed for that turn and the context-window fill fraction from the Stop payload (null when absent); enables per-turn call-count analysis and context/cost correlation (#341).

### Fixed

- **cost-tracker: sums all API calls in a turn** (#341) — the previous code returned usage from the last API call only; multi-step tool-calling turns (each billed separately) were undercounted. The `sumTurnUsage` helper now sums every billed entry back to the turn boundary. **Reported costs will rise — this is not a regression.** A `schema: 2` marker entry is written to `cost-log.jsonl` at upgrade so operators see the boundary clearly.
- **session reports: cost derived from immutable cost-log** (#341) — `cost_usd` and `tokens` in session report frontmatter are now summed from cost-log.jsonl per session-id by the main session before passing to session-mgr (via `session-cost.ts`), eliminating the double-count caused by the skippable per-task `.status.json` reset. Session-mgr falls back to `.status.json` only when the payload value is absent. The redundant prose reset steps are removed from session-mgr.

- **hermit-watchdog: active_hours evaluated in the configured timezone** (#347) — `inActiveHours()` read the host wall clock (`new Date().getHours()`) while its sibling `heartbeat-precheck` already evaluated the same window through `currentHHMM(config.timezone)`; on any host where system TZ differed from `config.timezone` (headless Docker pinned to UTC) the watchdog fired in the wrong window. It now delegates to `currentHHMM`, fails open on an unparseable tz or malformed `HH:MM` bounds, and treats the window end as exclusive to match `heartbeat-precheck`.
- **hermit-watchdog: reads runtime.json through lib/runtime** (code-review cleanup) — the watchdog wrote runtime.json via the shared `writeRuntimeJson` but still read it through a local `readJson`; it now uses `lib/runtime.readRuntimeJson` so the read/write semantics for that file live in one place.
- **lib/lockfile: double-acquire, wedged-lock, and masked-fs-error fixes** (code-review findings) — stale takeover now claims the lock by atomic `rename` instead of unlink-by-path, so two racers over one stale lock can't both end up holding it; a foreign-user pid (EPERM) is treated as not-a-hermit-holder (single-uid invariant) instead of wedging the lock for the staleness window against a possibly-reused pid; and `tryCreate` rethrows real fs errors (ENOSPC/EACCES/EROFS) instead of masking them as "another lifecycle operation in progress".
- **doctor-check: hooks check now verifies exec-form hooks** — `checkHooks` only parsed string-form `command` paths, silently skipping every real hook (all use `command` + `args`); it now resolves `args` entries too, so a missing hook script actually fails the check.
- **heartbeat: stale-wake damper** (#344) — an unchanged stale-operator/stale-session condition no longer fires EVALUATE on every tick; `last_stale_wake_at` gates re-wakes to once per `stale_threshold` (or when the operator advances), while digest/checklist gates still reach through. Stops short-interval heartbeats from waking the LLM 4×+ to re-confirm the same staleness.
- **session lifecycle skills: session-mgr disambiguated as subagent** (#348) — `session`, `session-start`, and `session-close` now carry a tool note that `session-mgr` is invoked via the Agent tool, eliminating the wasted-turn `Unknown skill: claude-code-hermit:session-mgr` error on slow-path start/close.

### Changed

- **startup knowledge injection: catalog-only for non-foundational artifacts** — recent-artifact bodies are replaced by a one-line-per-artifact catalog (stem, type, date, tags + summary line); nothing silently drops out of the injection window anymore. Foundational pages keep full-body/stub injection at the 40% pinned budget, now without the per-type newest-wins collapse (multiple same-type foundational pages all pin); unused pinned budget rolls into the catalog. `procedure-brief` artifacts are excluded from injection, enforcing the schema's existing not-session-injected contract. `search.ts` recency and result dates read `updated` before `created`. `injection_stub` is now only read for foundational artifacts.
- **recall: surfaces auto-memory alongside hermit artifacts** — drops `model: haiku` and adds a "From memory" step over the loaded memory index (#350). Zero-config; existing hermits pick it up on `/plugin update`.
- **daily-auto-close defaults to Haiku** — the silent, stateless midnight close routine ships `model: "haiku"`; near-zero risk on Sonnet fleets, insures against session-model tier-drift cost on Opus fleets (#342).
- **hermit-evolution: merged into a full evolution report** — the skill now produces a unified 6-section digest (cost trend + 30d source split, autonomy, proposal velocity, routines/watches with cadence, top-3 produced (inferred), grown since hatch (approximated)) instead of the prior terse 4-section snapshot; trigger phrases extended to include "evolution report", "monthly report", "how have I grown", "what did I produce last month".

- **bun is now a required runtime (>=1.3)** — first step of the bun migration (#18): declared in `hermit-meta.json`, gated by `hermit-evolve` Step 0b (upgrade refuses to proceed without it), pinned in the Docker template (`BUN_VERSION` arg, native installer; the Claude Code CLI stays on npm).
- **hooks and test harnesses run on bun** — every hooks.json command string, `heartbeat-monitor.sh`, and all test suites invoke `bun` instead of `node`; hook scripts stay stdlib `.js` at this step. `run-with-profile` spawns `process.execPath` so inner hooks inherit the outer runtime.
- **Docker layer is Python-free** — the image drops `python3/venv/pip` from apt; every inline `python3 -c` in the entrypoint template (cred expiry, mtime watch, init JSON, recommended-plugins) and `check-upgrade.sh` converts to `bun -e`/heredoc equivalents with byte-identical outputs; docker-security's host-side verify blocks likewise. The entrypoint PATH line now includes `~/.bun/bin`. Bun quirk hardened: `-e` mode exits 0 on uncaught fs errors, so snippets catch internally and the init block fail-louds explicitly.
- **hermit-start → TypeScript; zero Python remains in the plugin** — the 870-line boot script ported with byte-level side-by-side verification (config merge, channel gating, tmux argv, sandbox-cache fingerprint incl. CPython float repr); the 118-test Python contract harness translated 1:1 to `tests/hermit-start.test.ts` + `tests/contracts.test.ts`. `run-all.sh` retired — the entire suite is `bun test` (848 tests, ~20s); CI and the dev-mode hook run it directly.
- **hermit-stop and hermit-watchdog: Python retired** — both lifecycle scripts are TypeScript, behavior-pinned by black-box contract suites written against the Python first. `fcntl.flock` is replaced by `lib/lockfile.ts`: atomic link-based creation, PID-liveness (flock's release-on-death), an mtime staleness window (PID reuse after reboot), and takeover of the empty `.lifecycle.lock` files the old Python holders left on disk.
- **sandbox-probe and read-cost: Python retired** — `sandbox-probe.py` → `sandbox-probe.ts` (same JSON contract, exit-0-always; hermit-start and the doctor/hatch skills invoke it via bun); `read-cost.py`'s 6 lines inlined into `startup-context.ts`, removing the boot-path `python3` shell-out.
- **all core scripts are TypeScript** — `scripts/` and `scripts/lib/` renamed `.js` → `.ts` (typed, ESM); every spawn-path reference (hooks.json, harnesses, SKILL.md run-instructions, hatch permission allowlist, docs) moved with them. No build step: bun runs `.ts` directly.
- **entire bash test layer → bun test** — all 21 bash harnesses (~5,800 lines: run-hooks.sh, run-scripts.sh, test-*.sh, lib.sh) replaced by `tests/*.test.ts` + shared helpers with 1:1 case parity (708 tests, ~17s; the bash equivalent took minutes of serial spawning). Subprocess spawning survives only at real process boundaries (hook stdin→exit contract, CLI runs); unit probes are in-process imports. `run-all.sh` is now `bun test` + `run-contracts.py` (the last Python harness, which dies with the boot-script ports).
- **doctor-check: real semver range evaluation** — `satisfiesRange` now uses `Bun.semver.satisfies`, so `~`/`^`/compound ranges in `required_core_version`/`required_bun_version` are enforced instead of silently passing. Behavior change: a sibling pin like `~2.0.0` that previously reported `ok` (unrecognized form) now `warn`s when the installed core is outside it. Unparseable ranges still pass (fail-open).
- **bin/ wrappers: runtime-agnostic dispatch, python3-free** — operator-resident shims delegate to the new plugin-shipped `scripts/hermit-exec.sh`, which owns the script-name → runtime mapping (future runtime changes need no wrapper refresh); inline `python3 -c` in `hermit-status`/`hermit-attach`/`hermit-docker` rewritten to bun. Also fixes a stray `"--"` element in `update-history.jsonl` marketplace arrays.
- **lib/tmux: shared `tmuxSessionAlive`/`getSessionName` helpers** (#352) — dedupes the per-script copies in `hermit-start`/`hermit-stop`/`hermit-watchdog`; deferred cleanup from the bun-migration code review.
- **reflect/judge: artifact-cited evidence path** — efficiency/cost candidates may pass the judge with `Sessions: none` plus an `Artifact:` citation to a machine-written state file (`cost-log.jsonl`, `proposal-metrics.jsonl`, `observations.jsonl`); the judge verifies the file contains the cited values instead of suppressing `no-sessions`. The evidence-integrity rule softens accordingly — prose self-certification stays barred.
- **proposal-create: push for measurable success_signal** — cost-measurable proposals must fill `## Success Signal` with a `--validate`-checked predicate; an empty section is the documented exception and `## Verification` must say why.
- **reflect: pattern-absence resolution requires same-area overlap** — absence across 3 sessions only counts when at least one checked session shares a tag with the proposal (tags pooled from the proposal itself and its `related_sessions`); otherwise skip-and-revisit. Stops "stopped doing that kind of work" from auto-resolving as "fixed".

### Upgrade Instructions

1. **Add `.worktreeinclude` managed block.** Check whether the project root has a `.worktreeinclude` file. If it is absent, create it with this content. If it exists but lacks the `# >>> claude-code-hermit` marker, append the block (preceded by a blank line):
   ```
   # >>> claude-code-hermit (managed block — do not edit between markers) >>>
   .claude-code-hermit/OPERATOR.md
   .claude-code-hermit/compiled/
   # <<< claude-code-hermit <<<
   ```
   If the marker is already present, skip silently.
   _(Opt-out: delete the marked block. Note: if a custom `WorktreeCreate` hook replaces the default git behavior, Claude Code does not process `.worktreeinclude`, so this block is harmless and inert.)_

2. **Gitignore `OPERATOR.md`.** Check the project's `.gitignore` for a `.claude-code-hermit/OPERATOR.md` line. If absent, append it. This is required for `.worktreeinclude` to copy the file into worktrees (Claude Code only copies gitignored paths).

3. Run `/claude-code-hermit:heartbeat start` (or wait for the next session start) to restart the monitor so it begins writing `state/heartbeat-liveness.json` (runtime-created — no manual seeding required). An already-running monitor does not pick up the change automatically. Once the first iteration completes, `/hermit-doctor` can evaluate heartbeat liveness. To disable the heartbeat doctor check: set `heartbeat.enabled: false` in `config.json` (check returns `ok: disabled`).

Run `/claude-code-hermit:hermit-evolve`. The evolve skill handles:

1. Verify bun is installed before anything else (Step 0b is the hard gate): `bun --version` must be >= 1.3.0. If missing: `curl -fsSL https://bun.sh/install | bash`.
2. Refresh ALL on-disk boot wrappers (Step 5b's byte-compare will list every `bin/` file as changed — copy each from `state-templates/bin/`). The old wrappers exec `python3` directly and break when the Python scripts are removed from the plugin.
3. Note for Docker operators: `hermit-status`, `hermit-attach`, and `hermit-docker` run on the HOST and now use bun there — install bun on the host even when the hermit itself runs in the container.
4. Docker operators: surgically replace `docker-entrypoint.hermit.sh` at the project root — copy it from the plugin template:
   ```
   cp "$(claude plugin path claude-code-hermit)"/state-templates/docker/docker-entrypoint.hermit.sh.template \
     ./docker-entrypoint.hermit.sh
   ```
   The old entrypoint shells `python3` for credential-expiry checks, mtime watches, and JSON init blocks; the new one uses `bun -e`. Do NOT re-run `/docker-setup` to do this — that wizard regenerates `Dockerfile.hermit` from the new Python-free template and would silently overwrite any operator customizations to it. `Dockerfile.hermit` and `docker-compose.hermit.yml` are not touched by this upgrade; existing hermits keep their full image definition including any custom layers or Python packages.

   **Backpatch (1.2.0 template only):** The 1.2.0 template shipped with an unsubstituted `{{TMUX_SESSION_NAME}}` placeholder in the entrypoint. If you are upgrading from 1.2.0, run this after the `cp` to replace the literal placeholder with the resolved session name:
   ```
   bun -e "
   const fs = require('fs'), path = require('path');
   const cfg = JSON.parse(fs.readFileSync('.claude-code-hermit/config.json','utf8'));
   const name = String(cfg.tmux_session_name ?? 'hermit-{project_name}')
     .replaceAll('{project_name}', path.basename(process.cwd()));
   const f = './docker-entrypoint.hermit.sh';
   fs.writeFileSync(f, fs.readFileSync(f,'utf8').replaceAll('{{TMUX_SESSION_NAME}}', name));
   "
   ```
   On >=1.2.1 templates the placeholder is already gone; the snippet above is a harmless no-op.

   After replacing the entrypoint, run `hermit-docker update` to rebuild the image with it.
5. Append a schema-marker line to `.claude/cost-log.jsonl`: `{"schema": 2, "timestamp": "<ISO now>", "note": "api_calls + context_usage added; pre-marker entries undercount multi-step turns"}`. This stamps the upgrade boundary so operators do not read the post-upgrade cost jump as a regression. Backfill of pre-marker entries is not performed.
6. Add `"post_close_clear": true` to `.claude-code-hermit/config.json` (top-level, not nested under `watchdog`). This enables the post-close context reset that ships enabled by default in new hermits. To disable: set `"post_close_clear": false`.
   Note: the reset only fires when `hermit-watchdog run` is invoked on a schedule. Docker hermits get this automatically (the entrypoint runs it every ~5 min). Bare-metal hermits need `hermit-watchdog install` to set up the systemd/launchd timer — without a timer the marker sits until the next watchdog invocation, which may never come on bare metal.
7. **Set the Haiku default on `daily-auto-close`.** Read `config.routines`, find the entry with `id: "daily-auto-close"`. If it has **no** `model` key, set `"model": "haiku"`. If a `model` is already present, leave it unchanged. (Revert: remove the `model` field from that entry to return it to the session model.)
8. Add `"archive_retention_days": null` under `knowledge` in `config.json` if absent (no behavior change at `null` — keep forever; set a positive integer of days to enable `.archive/` purging).
9. Create `.claude-code-hermit/state/observations.jsonl` as an empty file if it does not exist (append-only ledger; `append-metrics.js` also creates it lazily on first write, so pre-upgrade hermits fail open).
10. No migration of existing sub-threshold memory entries is performed — future observations land in the ledger. Stale pattern-label notes in operator MEMORY.md can be pruned manually at the operator's convenience.
11. Open `.claude-code-hermit/knowledge-schema.md`. If `## Work Products` has no `- topic:` bullet, add: `- topic: living topic page, updated in place — merge new findings; never write a second dated copy. Frontmatter: title, type, created, updated, tags, summary (one-liner), optional session. Exempt from archive rotation. location: compiled/topic-<slug>.md (undated)`. Without this, the first topic page triggers Schema Drift at session start.
12. If the same file has no `## Conventions` section, append: `## Conventions` followed by `- Wikilinks: compiled pages cross-reference each other with [[name]] (the target's filename stem). Pages may also link auto-memory entries the same way. Dangling links are fine — they mark pages worth writing.` and `- summary: a plain one-line string. Don't wrap it in [...] (parses as an array) and avoid \` # \` (parses as an inline comment).`
13. No config changes for the catalog injection — it reuses `knowledge.compiled_budget_chars`. Non-foundational artifacts now appear as catalog lines instead of truncated bodies; tell the operator depth is available via `/recall` or by Reading the listed file.
14. Optional, at the operator's pace: clusters of dated notes on one evolving subject can be consolidated into a single `compiled/topic-<slug>.md` (keep the oldest note's `created`, set today's `updated`); the superseded dated notes then rotate out via the normal weekly archive.

## [1.1.12] - 2026-06-10

### Added

- **hermit-settings: watchdog subcommand** — new interactive menu exposes watchdog enable/disable, `stale_factor`, `escalate_after`, and `operator_grace` fields.
- **docker-setup: enable watchdog at step 9** — after container verification, step 9 now flips `watchdog.enabled: true` in `config.json` for Docker hermits; the entrypoint loop already runs the watchdog so no `bin/hermit-watchdog install` is needed.

### Fixed

- **watchdog: install/uninstall no longer crash on systemd-less Linux** — falls back to printing a crontab line when `systemctl` is absent; uninstall exits cleanly with a "no timer to remove" message instead of throwing.
- **heartbeat-monitor: suppress first-iteration EVALUATE to avoid cold-start double-fire** — first tick after session start skips EVALUATE (alerts empty, checklist unseen); AUTO_CLOSE is never suppressed.
- **hermit-stop: `Started` and `Status` read from wrong source** — `read_active_session()` now reads `session_state` and `created_at` from `runtime.json` (the documented single source of truth). The `**Status:**` field was removed from SHELL.md and always fell back to `unknown`; `**Started:**` could show the raw template placeholder `YYYY-MM-DD HH:MM` if session-mgr missed the substitution. SHELL.md `**Started:**` is still preferred when it contains a real date.
- **hermit-status: `Status` fallback read from runtime.json** — the no-cost-data fallback branch now reads `session_state` from `state/runtime.json` instead of grepping `**Status:**` from SHELL.md (which no longer exists in that file).
- **session-mgr/session-start: `Started` placeholder now explicitly named** — `session-mgr.md` step 5 and `session-start` fast-path step now name the literal placeholder `YYYY-MM-DD HH:MM` so substitution is unambiguous, matching the precision already applied to the `**ID:**` field.

### Files affected

| File | Change |
|------|--------|
| `skills/hermit-settings/SKILL.md` | New watchdog subcommand |
| `skills/docker-setup/SKILL.md` | Step 9 enables `watchdog.enabled` for Docker hermits |
| `scripts/hermit-watchdog.py` | Graceful systemd-absent fallback in install/uninstall |
| `scripts/heartbeat-monitor.sh` | Suppress EVALUATE on first tick; AUTO_CLOSE always fires |
| `scripts/hermit-stop.py` | Read `session_state`/`created_at` from `runtime.json` |
| `state-templates/bin/hermit-status` | Fixed fallback reads `session_state` from `runtime.json` |
| `agents/session-mgr.md` | Explicitly name `YYYY-MM-DD HH:MM` placeholder in step 5 |
| `skills/session-start/SKILL.md` | Explicitly name placeholder in fast-path step |

### Upgrade Instructions

Run `/claude-code-hermit:hermit-evolve`. The evolve skill handles:

1. **Refresh `bin/hermit-status` from the updated template.** The fallback branch that printed `Status: unknown` has been fixed to read from `state/runtime.json`. Overwrite the script if it has not been locally modified:

   ```
   if [ -f .claude-code-hermit/bin/hermit-status ]; then
     cp "$(claude plugin path claude-code-hermit)"/state-templates/bin/hermit-status \
       .claude-code-hermit/bin/hermit-status
   fi
   ```

2. **Auto-enable the watchdog on Docker hermits.** If `docker-entrypoint.hermit.sh` exists in the project root (the artifact `/docker-setup` leaves behind), the watchdog scheduler is already wired into the entrypoint loop, so enable it:

   ```
   if [ -f docker-entrypoint.hermit.sh ]; then
     jq '.watchdog.enabled = true' .claude-code-hermit/config.json > .claude-code-hermit/config.json.tmp \
       && mv .claude-code-hermit/config.json.tmp .claude-code-hermit/config.json
   fi
   ```

   Non-Docker hermits: `watchdog.enabled` stays `false`; opt in via `config.watchdog.enabled: true` + `bin/hermit-watchdog install`. To opt a Docker hermit back out, set `watchdog.enabled: false` via `/hermit-settings`.

## [1.1.11] - 2026-06-10

### Added

- **proposal-metrics-report.js: per-source triage-survival + acceptance rates** — `scripts/proposal-metrics-report.js` aggregates `proposal-metrics.jsonl` per autonomous source (reflect, capability-brainstorm, procedure-capture, scheduled-check), computing triage-survival (CREATE÷total) and acceptance (accepted÷created) with the ≥8-sample gate and 25%/30% kill thresholds. Kill criteria in `capability-brainstorm` and `reflect` (procedure-capture) now call the script instead of hand-grepping; `hermit-evolution` surfaces the full per-source table. Every keep/kill debate now runs on computed data.
- **watchdog: external dead-session and wedge detector** — `scripts/hermit-watchdog.py` single-shot supervisor. Detects dead tmux sessions and restarts them; detects wedged sessions (frozen pane, monitor dead, operator silent) with nudge-then-escalate; re-arms the 4am `heartbeat-restart` when it misses. Shutdown-intent gate prevents resurrecting an intentionally-stopped hermit. Every action logged to `state/watchdog-events.jsonl`; restarts surface to operator channel via `session-start` step 3. Default disabled — opt in via `config.watchdog.enabled: true` + `bin/hermit-watchdog install`.
- **watchdog: OS timer install/uninstall** — `bin/hermit-watchdog install` registers a systemd user timer (Linux/WSL2), LaunchAgent (macOS), or prints a crontab line (fallback). `bin/hermit-watchdog uninstall` tears it down.
- **cost-log: incremental byte-offset index** — new `scripts/lib/cost-log.js` builds `state/cost-index.json` incrementally so `writeCostSummary` and `getCumulativeCost` are O(1) instead of O(n). Index rebuilt automatically on first run or log truncation. Resolves Known Limitation #1.
- **cost-log: corrupt-line counter** — `cost-index.json` carries `skipped_corrupt_lines`; doctor's cost check warns when >0. Resolves Known Limitation #3.
- **doctor: watchdog health check** — new `checkWatchdog()` reports enabled status, OS timer presence, recent restart count, and consecutive-stale count from `state/watchdog-events.jsonl`.
- **procedure capture: reflect drafts a skill from a recurring procedure and installs it operator-gated** — when a multi-step procedure recurs across ≥2 sessions with no skill covering it, reflect writes a `procedure-brief` to `compiled/` and routes a `category: capability` PROP through triage→judge→proposal-create. On accept, `/skill-creator` authors the SKILL.md and the operator confirms the artifact before install to `.claude/skills/`. Two non-skippable gates; metric-driven kill criteria.
- **channel-hook: channel-replies.jsonl** — append-only log of outbound reply-tool calls, written by `channel-hook.js` after every `last_reply_at` update. Provides the engagement history needed for routine-ROI analysis.
- **reflect: routine ROI signal** — extends the routine-health check with a channel-engagement join: reads `channel-replies.jsonl`, computes a delivery-anchored, same-channel engagement ratio per routine, joins per-routine cost from `cost-log.jsonl`, and proposes Tier-1 disable or re-time when a channel-delivering routine has ≥10 fires and ≤20% engagement.
- **recall: full-text search over sessions, compiled artifacts, and proposals** — `scripts/lib/search.js` + `scripts/search.js` CLI + `skills/recall/SKILL.md`. Pure-Node scan (no deps), TF scoring with frontmatter-field boosts, recency decay, and `file:line` snippets. Invoke via `/recall <query>` or channel DM ("what did I decide about X", "when did we last touch Y"). Closes the memory retrieval gap identified in the architecture review.
- **cc-compat: centralized Claude Code format accessors** — new `scripts/lib/cc-compat.js` wraps every surface Anthropic owns and can change (hook-payload field names, transcript JSONL usage shape, cost-log path, best-effort CC version). A CC release now breaks one file loudly instead of five quietly.
- **stop-pipeline: persist structured Stop-payload snapshot** — after each Stop, `state/cc-stop-snapshot.json` records `session_crons` and `background_tasks` as tri-state (`populated / empty / unsupported_or_unreachable`), `captured_at`, and `cc_version`. Sole writer: `stop-pipeline.js`.
- **doctor: scheduler/background-task health check** — new `checkScheduler()` reads the snapshot and reports cron and task state with labeled staleness. Missing snapshot → ok ("not yet captured"); `unsupported_or_unreachable` → warn (never falsely reported as "0 crons").

### Removed

- **SHELL.md: drop the cosmetic `Status` field** — `runtime.json session_state` is the sole lifecycle source; close outcome flows through the session-close → session-mgr payload, never extracted from SHELL.md. Existing SHELL.md files self-heal on next close (field is absent from the new template). Scripts and skills repointed to `runtime.json`.
- **pulse: drop `--full` flag** — infra health is now `/hermit-health`'s sole responsibility. `/pulse` stays session-focused (SHELL, tasks, live cost) with a one-line alert bridge when `alert-state.json` has active entries.

### Changed

- **hermit-health: absorb pulse --full unique sections** — adds micro-pending count, knowledge file counts, enriched reflect counters (runs/empty/output), and `in_progress` proposals to the existing alerts/routines/channel surface.
- **docker-setup/docker-security: classified failure hints + `ports:` auto-edit** — error-recovery messages now suggest targeted fixes (daemon down, build error, port conflict, OAuth expiry) rather than "dump logs and re-run the whole wizard". In docker-security, the hard-gate ports conflict offers to auto-remove the base `ports:` block (with `.bak` backup) so LAN-containment containers can start without a manual hand-edit.
- **cost-tracker, suggest-compact: route hook-payload reads through cc-compat** — `entryText`, `isToolResult`, usage-field extraction, `session_id`, and `transcript_path` now delegate to `cc-compat.js`; `COST_LOG` path resolved via `costLogPath()`. Completes the centralization so every CC-owned read fails in one place. No behavior change; existing tests still pass.
- **proposal-act/reflect: falsifiable success signals** — optional cost-per-session predicate (`success_signal` frontmatter field) on a proposal auto-resolves it when met; reflect evaluates via `scripts/eval-success-signal.js` against session-report `cost_usd` anchored at `accepted_date`. Closes #317-adjacent (§17.1 of architecture review).
- **gate-agent memory: proposal-triage and reflection-judge now persist private heuristics (`memory: project`)** — triage learns suppression patterns, judge learns hollow-evidence shapes; guardrail forbids private memory as the sole suppress basis; over-suppression bounded by reflect's existing Component Health check.
- **reflection-judge: weight evidence by session provenance** — Tier 2/3 candidates backed only by auto-closed sessions lean toward DOWNGRADE; operator-supervised or mixed evidence is unaffected.
- **heartbeat: gate in_progress stale-check on operator activity** — skip the per-tick LLM wake when `last-operator-action.json` shows activity within `stale_threshold`; the faithful Progress-Log check still runs when the operator is quiet beyond the threshold or a stale alert is already active. Falls back to the original unconditional wake on pre-upgrade installs (no `last-operator-action.json`) and on future-dated timestamps (clock skew). Closes #315.
- **knowledge: raise compiled injection budget default 1000 → 2500, ceiling 4000 → 6000** — more domain context at session start for domain hermits; maxed budget is clamped to remaining headroom under the 9000-char hard cap so operator and session sections are never crowded. Pairs with `/recall` (push for orientation, pull for depth).

### Security

- **reflect/judge: quarantine external-origin evidence** — candidates derived from web fetches, `raw/` third-party captures, or non-operator channel messages are forced to Tier 3 (full operator review via `proposal-create`), closing the "learn this habit" injection path into the learning loop. Adds orthogonal `Evidence Origin: own-work | external-content` axis; default `own-work` is backward-safe.

### Upgrade Instructions

Run `/claude-code-hermit:hermit-evolve`. The evolve skill handles:

1. Check whether `config.json` has `knowledge.compiled_budget_chars` set to `1000`. If so, update it to `2500`. If the operator has set a custom value other than `1000`, leave it as-is.
2. The `/recall` skill is auto-discovered — no file changes needed for existing hermits.
3. Seed `bin/hermit-watchdog` from `state-templates/bin/hermit-watchdog` if it does not already exist in `.claude-code-hermit/bin/`.
4. Add `"watchdog": {"enabled": false, "stale_factor": 2, "escalate_after": 3, "operator_grace": "15m"}` to `config.json` if the `watchdog` key is absent.
5. Re-run `/docker-setup` (or surgically update `docker-entrypoint.hermit.sh` — add the `_wd_cycle` counter and `hermit-watchdog run` call inside the `while tmux has-session` loop) before running `hermit-docker update` if running a Docker hermit.

The watchdog is **disabled by default**. To opt in: set `config.watchdog.enabled: true` via `/hermit-settings`, then run `bin/hermit-watchdog install` to register the OS timer.

## [1.1.10] - 2026-06-05

### Fixed

- **brief: anchor proposal-count status read to frontmatter** — resolved proposals quoting `status: proposed` in their body no longer inflate the morning-brief pending count. Closes #287.

### Added

- **session-start: `--task` handler** — non-interactive start seeds the task and bypasses all operator prompts; scheduled `--task` routines now work by design, not LLM inference.
- **hatch: git init on fresh dirs** — when hatching in an empty, non-git directory, offers a local `git init` so hermit build artifacts are versioned from day one. Closes #282.
- **cost-reflect: structural cost audit skill** — breaks 7-day spend into token-type drivers (cache_read / cache_write / output / input), flags cold-start overhead, and attributes cost per session. Opt-in as a weekly routine via `/hermit-settings`. Closes #295.
- **cost-tracker/cost-reflect: trigger-source attribution** — every `cost-log.jsonl` entry records its trigger source (`heartbeat`, `routine:<id>`, or `other`); cost-reflect adds a **Cost by source** breakdown. Closes #294.
- **session-discipline: context-hygiene rule** — delegate broad scans/research to `Explore` subagent; keeps main context lean.

### Changed

- **cost-tracker: pricing moved to `lib/pricing.js`** — shared with cost-reflect; no behavior change.
- **hermit-routines: optional per-routine `model` override** — run lightweight routines on Haiku via subagent dispatch to cut idle cost; ignored on `heartbeat-restart`. Closes #289.

### Removed

- **budget-enforcement layer** — `idle_budget`, `ask_budget`, SHELL.md `Budget:` field, cost-tracker budget warnings, and `hermit-status` budget display removed; doctor's cost check is now visibility-only.
- **idle-tasks checklist** — `IDLE-TASKS.md` template, heartbeat pickup, and session-mgr idle-task reconciliation removed; autonomous work flows through reflection → proposal → NEXT-TASK.

### Files affected

| File | Change |
|------|--------|
| `skills/hatch/SKILL.md` | git-init eligibility probe and new Step 7.5 |
| `skills/cost-reflect/SKILL.md` | new skill |
| `scripts/lib/pricing.js` | new — PRICING table, costByType(), calculateCost() |
| `scripts/cost-reflect.js` | new — token-type breakdown, cold-start, per-session analyzer |
| `scripts/cost-tracker.js` | consume lib/pricing.js; remove budget warnings |
| `state-templates/CLAUDE-APPEND.md` | new context-hygiene rule under §Rules |
| `state-templates/config.json.template` | remove `idle_budget` and `ask_budget` keys |
| `docs/skills.md` | cost-reflect row in Channel-Friendly Summaries |
| `tests/run-scripts.sh` | pricing regression + cost-reflect fixture tests |

### Upgrade Instructions

Run `/claude-code-hermit:hermit-evolve`. The evolve skill handles:

1. **Update the plugin.** Run `claude plugin update claude-code-hermit --scope local` (or the scope you used at install).
2. **Offer** the operator via AskUserQuestion to delete `.claude-code-hermit/IDLE-TASKS.md` if it exists; delete if confirmed, skip if declined.
3. **Remove** `idle_budget` and `ask_budget` keys from `.claude-code-hermit/config.json` if present.
4. **Remove** any `**Budget:**` line from `.claude-code-hermit/SHELL.md` if present.

No `config.json` changes required for new keys.

**Note:** Existing `.status.json` files may show a stale `budget_usd` field until the next cost-tracker write — harmless.

## [1.1.9] - 2026-06-04

### Added

- **session-close: `shutdown_skill` config hook** — fires before archival on both operator and `--auto` close paths, as the counterpart to `boot_skill`, for stopping always-on services. Best-effort: a wedged stop cannot lose the session report. Closes #259.
- **channel-responder: capture interactive channel patterns as SHELL.md findings** — after responding via channel, appends durable preference or recurrence signals to `## Findings` so reflect can treat them as current-session evidence. Closes #253.
- **reflect: batch reflection-judge calls** — spawns all pending judge calls in one parallel pass instead of serially, cutting reflect wall-clock on large proposal queues. Closes #236.
- **brief: surface plugin upgrade in always-on morning brief** — the morning brief now mentions an available plugin update when one is detected. Closes #254.
- **brief: suppress evening "session still open" note when `always_on` + `daily-auto-close` enabled** — avoids a spurious reminder in configurations that intentionally keep sessions running 24/7.
- **session-close: memory-review fallback when reflect short-circuits** — captures single-session discoveries on operator closes where reflect's cadence precheck returns EMPTY. Skipped on `--auto` by construction. Closes #230.
- **docs: clarify OPERATOR.md vs CLAUDE.md** — FAQ entry and how-to-use pointer; behavioral rules belong in CLAUDE.md, not OPERATOR.md. Closes #262.

### Fixed

- **hermit-routines: validate `pluginRoot` before the load reset** — `load` aborts if `$CLAUDE_PLUGIN_ROOT` is empty or its `scripts/` are missing, before the Step 3 CronDelete sweep, preventing a bad plugin root from tearing down working routine CronCreates. Closes #251.
- **session bootstrap: drop `disable-model-invocation` from session skill** — always-on multi-step boot invokes via the Skill tool, which the flag rejected; bare hermits were unaffected, making the failure look intermittent. Closes #229.
- **hatch: always default `push_notifications: true` on fresh hatch** — removed the channel-choice derivation that wrote `false` whenever a channel was selected; the runtime guard in CLAUDE-APPEND already enforces channel-first delivery with push as fallback.
- **brief: drop doubled `hermit-evolve` call in brief upgrade notice** — deduplicate the evolve instruction that appeared twice in the upgrade nudge.
- **hatch: render actual `push_notifications` value in Step 10 report** — the step now shows the resolved value rather than always printing `true`.

### Files affected

| File | Change |
|------|--------|
| `scripts/hermit-start.py` | Add `shutdown_skill: null` default |
| `skills/session-close/SKILL.md` | Fire `shutdown_skill` before archival; memory-review fallback |
| `skills/channel-responder/SKILL.md` | Add §4 interactive pattern capture to SHELL.md findings |
| `skills/reflect/SKILL.md` | Batch reflection-judge calls in parallel |
| `skills/brief/SKILL.md` | Upgrade notice; suppress evening note; fix doubled evolve call |
| `skills/hatch/SKILL.md` | Fix push_notifications report value; mention shutdown_skill |
| `state-templates/config.json.template` | Add `shutdown_skill: null` key |
| `docs/config-reference.md` | Document `shutdown_skill` |

### Upgrade Instructions

Run `/claude-code-hermit:hermit-evolve`. The evolve skill handles:

1. Read `.claude-code-hermit/config.json`.
2. If `push_notifications` is `false`, ask: "Push notifications are currently disabled — with this update they act as a channel fallback when your primary channel is unreachable. Enable? (y/n)".
3. If yes: set `push_notifications: true` and write the file.
4. If no: leave config.json unchanged.

**Note:** `shutdown_skill` is a new config key (counterpart to `boot_skill`). Evolve presents it automatically; leave `null` unless a service teardown skill exists.

## [1.1.8] - 2026-06-01

### Added

- **startup-context: schema-drift warning at session start** — surfaces a "Schema Drift" block when any `compiled/` artifact has a `type` not declared in `knowledge-schema.md ## Work Products`, closing the up-to-7-day lag before the weekly Knowledge Health check fires. Silent when schema is absent/empty (weekly review handles that) or when all types are declared. Reuses the existing `parseSchema` logic from `knowledge-lint.js`. Closes #208.
- **archive-compiled.js** — weekly-review now rotates compiled artifacts, keeping the newest 2 per type; `foundational`-tagged artifacts exempt. Companion to `archive-raw.js`. (#201)

### Changed

- **hermit-evolve: deterministic pre-pass (`scripts/evolve-plan.js`)** — a read-only analyzer precomputes the version gap, bounded CHANGELOG slice, new config keys, changed templates/bin, and the CLAUDE-APPEND block diff in one JSON pass; the skill acts on it instead of reading and diffing whole files in-context. Cuts a typical evolve run to ~15–25K tokens and fixes the CHANGELOG 2000-line read truncation that could silently skip the oldest `### Upgrade Instructions`. Closes #211.

### Fixed

- **archive-raw: cover dated `.json` snapshots and pin `-latest.*` aliases** — retention now globs `(md|json)`, so domain-hermit JSON snapshots obey `raw_retention_days` instead of accumulating forever; `-latest.*` pointer files are pinned (never archived); `.json` artifacts with no frontmatter fall back to a `YYYY-MM-DD` filename date for age resolution. Closes #209.

### Files affected

| File | Change |
|------|--------|
| `scripts/startup-context.js` | Schema-drift warning block at session start |
| `scripts/archive-compiled.js` | New — rotates compiled artifacts by type, keeps newest 2 |
| `scripts/archive-raw.js` | Cover dated `.json` snapshots; pin `-latest.*` aliases |
| `scripts/evolve-plan.js` | New — deterministic pre-pass for hermit-evolve |
| `scripts/knowledge-lint.js` | parseSchema fix for bold-markdown type entries |
| `skills/hermit-evolve/SKILL.md` | Wire evolve-plan.js pre-pass into evolve flow |
| `skills/weekly-review/SKILL.md` | Invoke archive-compiled.js during weekly rotation |
| `skills/proposal-create/SKILL.md` | Propagate origin into metrics for kill-criteria grep |
| `skills/capability-brainstorm/SKILL.md` | Minor refinements |
| `skills/hatch/SKILL.md` | Minor refinements |
| `state-templates/PROPOSAL.md.template` | Minor refinements |
| `state-templates/bin/hermit-run` | Minor refinements |
| `state-templates/knowledge-schema.md.template` | Minor refinements |

### Upgrade Instructions

Run `/claude-code-hermit:hermit-evolve`. No `config.json` changes required. The skill's Step 8 adds the new `Bash(node */scripts/evolve-plan.js*)` permission automatically; you may see a single approval prompt for the helper on the first run.

## [1.1.7] - 2026-05-31

### Fixed

- **cost-tracker: reset per-session cost/tokens on session change** — `getCumulativeCost` now resets the running total when `.status.json` belongs to a different hermit session, so session reports record per-session spend instead of all-time cumulative carryover. Closes #190.
- **brief/proposal-list/heartbeat/reflect: fresh-read annotations on state-reading steps** — adds an inline nudge to each skill's load-bearing current-state reads instructing the agent to re-read the file now rather than reuse a value from a pre-compaction context summary; prevents stale proposal statuses and session state from appearing in operator-facing outputs after compaction. Closes #192.
- **scripts/log-routine-event.sh: resolve hermit root by walking up from CWD** — CronCreate prompts fire with the session's primary working directory as `$PWD`, which may be a subdirectory of the hermit root; the script now walks up to the nearest ancestor containing `.claude-code-hermit/` so the metrics append lands in the right place instead of failing with "No such file or directory". Closes #180.

### Changed

- **brief: push-notification fallback** — the always-on brief now delivers via the standard Operator Notification pattern (channel DM or push fallback) instead of requiring a configured channel, so push-only operators get a condensed one-liner rather than a silent no-op when no channel is reachable. Closes #174.
- **session/heartbeat: bind completion notification to idle transition** — completion notification is now the final step of the Work-done flow (§6), not a standalone action; the autonomous heartbeat-pickup branch explicitly routes to §6 instead of a bare notify. Prevents sessions staying `in_progress` after autonomous task completion, which caused stale-session heartbeat alerts and delayed report archival. Closes #173.
- **heartbeat: digest renders proposal titles** — suppressed `proposal-pending:<PROP-NNN>` entries in the daily digest now render as `PROP-NNN "title"` (read from proposal frontmatter) instead of the bare dedup key, so operators can identify pending proposals without opening the repo; falls back to the bare key on zero or multiple file matches. Closes #191.

### Files affected

| File | Change |
|------|--------|
| `scripts/cost-tracker.js` | Reset running total on session change |
| `skills/brief/SKILL.md` | Fresh-read annotation; push-notification fallback |
| `skills/proposal-list/SKILL.md` | Fresh-read annotation |
| `skills/heartbeat/SKILL.md` | Fresh-read annotation; digest renders proposal titles |
| `skills/reflect/SKILL.md` | Fresh-read annotation |
| `skills/session/SKILL.md` | Bind completion notification to idle transition |
| `scripts/log-routine-event.sh` | Walk up to hermit root from CWD |
| `plugins/claude-code-hermit/CLAUDE.md` | Add `daily-auto-close` to skills list |
| `state-templates/CLAUDE-APPEND.md` | Add `daily-auto-close` to quick reference |

### Upgrade Instructions

Run `/claude-code-hermit:hermit-evolve`. The evolve skill handles:

1. **Refresh skills.** Updated skill files are delivered automatically on the next `/plugin update`.

No `config.json` changes required.

## [1.1.6] - 2026-05-28

### Added

- **hermit-doctor: archive + reflect checks** — two new diagnostic checks for archival stall (runtime.json stuck `in_progress`/`waiting` >2d, or `idle` with non-null `session_id` >2d) and reflect-loop empty-rate (>80% empty over ≥10 runs with 0 proposals created). Closes #148.
- **routines: `reflect_after: true` optional flag** — appends `/claude-code-hermit:reflect --quick` to the routine's CronCreate prompt, closing the same-day feedback gap for late-day routines whose Tier-1 `current-session` observations would otherwise wait until the next morning's scheduled reflect. The append is skipped when the routine's own skill is `reflect`. Closes #142.
- **reflect: `--quick` mode** — bypasses the cadence precheck, binds `$PHASE = adult`, skips cost_spike / proposal scan / Resolution Check / Component Health, and scans only live SHELL.md `## Findings` / `## Blockers` for Tier-1 `current-session` candidates. Does not call `update-reflection-state.js` so the next scheduled reflect fires normally.
- **reflection-judge: per-code suppress counters** — `reflection-state.json → counters.judge_suppress_by_code` now accumulates suppression counts by canonical code (`no-evidence`, `no-sessions`, `covered-by-memory`). The reflect skill passes the per-code map in its State Update payload; `update-reflection-state.js` merges it cumulatively. `/hermit-health` surfaces the non-zero mix (e.g. `suppress mix — no-evidence:12, covered-by-memory:3`) on the reflect routine bullet.

### Fixed

- **proposal-triage: status-aware dedup (#159)** — open proposals (`proposed`/`deferred`/`dismissed`) still hard-block as `DUPLICATE`; `accepted`/`resolved` surface via `closest_prop` metadata and let evaluation continue, instead of silently killing follow-up proposals on shared infrastructure.
- **heartbeat: start subcommand reads state file before writing** — fixes "File has not been read yet" failure on always-on restart when `state/heartbeat-monitor.runtime.json` exists from a prior session.
- **heartbeat start: deterministic dedup via persisted task_id** — step 4 now reads `state/heartbeat-monitor.runtime.json` and TaskStops the recorded `task_id` before falling back to a TaskList description scan. Prevents duplicate monitors when the daily `heartbeat-restart` routine fires while a prior monitor is still alive.

### Changed

- **hermit-evolve step 10** — after printing the upgrade summary, fires the standard Operator Notification (channel DM or push fallback) with a condensed one-line message. Always-on operators no longer miss upgrades that completed while they weren't watching the terminal. Closes #141.
- **skills/simplify: sync to upstream reference** — deleted (`-`) lines are the behavior baseline; reverting an added `== True` back to plain truthiness is no longer mis-flagged as a behavior change. Phase 3a repairs malformed findings from intent instead of dropping them.

### Files affected

| File | Change |
|------|--------|
| `scripts/doctor-check.js` | Archive-stall and reflect-loop-empty-rate diagnostic checks |
| `skills/hermit-doctor/SKILL.md` | Invokes the two new doctor checks |
| `skills/hermit-routines/SKILL.md` | `reflect_after` flag support in CronCreate prompt assembly |
| `skills/reflect/SKILL.md` | `--quick` mode; passes `judge_suppress_by_code` in State Update |
| `agents/proposal-triage.md` | Status-aware dedup; `accepted`/`resolved` no longer hard-block |
| `agents/hermit-config-validator.md` | Minor sync with triage status semantics |
| `scripts/update-reflection-state.js` | Merges `judge_suppress_by_code` map cumulatively |
| `scripts/heartbeat-precheck.js` | State-file read-before-write; persisted task_id dedup |
| `skills/heartbeat/SKILL.md` | Updated start subcommand to persist task_id |
| `skills/hermit-evolve/SKILL.md` | Step 10 operator notification |
| `skills/hermit-health/SKILL.md` | Surfaces suppress-mix from `judge_suppress_by_code` |
| `skills/simplify/SKILL.md` | Upstream behavior-baseline and Phase 3a repair sync |
| `skills/daily-auto-close/SKILL.md` | Minor wording; no behavior change |
| `tests/` | New and updated tests for all of the above |

### Upgrade Instructions

Run `/claude-code-hermit:hermit-evolve`. The evolve skill handles:

1. **Refresh skills and agents.** The updated files are delivered automatically on the next `/plugin update`.
2. **Optionally enable `reflect_after` on routines.** To get same-session reflect after a routine, add `"reflect_after": true` to any routine entry in `config.json` (except the reflect routine itself). Re-run `/claude-code-hermit:hermit-routines load` after saving.

No `config.json` changes required.

## [1.1.5] - 2026-05-25

### Added

- **daily-auto-close routine** — fires at midnight (local) and closes the session via `/session-close --auto` once the operator has been idle ≥10 min. If the operator is active at midnight, writes `state/pending-close.json`; the next heartbeat tick drains the flag on the first lull, bypassing active-hours and other skip gates. Fixes silent-no-archives on long-running daemons.
- **skills/daily-auto-close/SKILL.md** — new routine driver (queue / drain-direct / stale-flag-cleanup branches).

### Changed

- **reflect/weekly-review: removed `closed_via: auto` skip** — all archives count as evidence regardless of close trigger. The `operator_turns == 0` check in `isEmptyAutoArchive` still excludes genuinely-empty 12h-inactivity closes from the self-directed denominator; chatty daemon midnight closes (with real operator content) now reach reflect and weekly-review.
- **lib/frontmatter.js: `isEmptyAutoArchive` shared helper** — extracts the `closed_via: auto && operator_turns: 0` predicate from both `reflect-precheck.js` and `weekly-review.js` to a single site.
- **Auto-close wording** — heartbeat, session-close, channel-responder, always-on docs updated to reflect both AUTO_CLOSE triggers (12h-inactivity and midnight lull).

### Fixed

- **heartbeat-precheck: pending-close drain before SKIP gates** — a missing or empty `HEARTBEAT.md` was short-circuiting with `SKIP` before the drain could fire, leaving the midnight close stuck on at-most-daily cadence.
- **heartbeat-precheck: stale-flag guard on fail-open drain** — absent/malformed `last-operator-action.json` still fail-opens to `AUTO_CLOSE`, but only when `pending-close.json` was queued within 24h. Prevents a stale flag from a crashed prior session auto-closing a fresh one.
- **weekly-review: UTC date in ISO week calculation** — `getISOWeek` was using local-time `getDate/getMonth/getFullYear` instead of their UTC equivalents, causing sessions to fall outside the computed week window in timezones ahead of UTC near week boundaries.

### Files affected

| File | Change |
|------|--------|
| `skills/daily-auto-close/SKILL.md` | New skill — midnight auto-close routine driver |
| `scripts/heartbeat-precheck.js` | Pending-close drain block; stale-flag guard; drain before SKIP gates |
| `scripts/lib/frontmatter.js` | `isEmptyAutoArchive` helper extracted |
| `scripts/reflect-precheck.js` | Uses shared `isEmptyAutoArchive`; removed `closed_via:auto` skip |
| `scripts/weekly-review.js` | Uses shared `isEmptyAutoArchive`; UTC fix in `getISOWeek`; removed autonomy-exclusion filter |
| `scripts/hermit-start.py` | Registers `daily-auto-close` routine on boot |
| `state-templates/config.json.template` | `daily-auto-close` entry in default routines |
| `skills/reflect/SKILL.md` | Removed `closed_via:auto` skip from Resolution Check and routine-effect scan |
| `skills/heartbeat/SKILL.md` | Updated AUTO_CLOSE wording for both triggers |
| `skills/session-close/SKILL.md` | Clears `pending-close.json` on operator-invoked close |
| `skills/channel-responder/SKILL.md` | Updated auto-close wording |
| `skills/hatch/SKILL.md` | Documents `daily-auto-close` routine in config scaffold |
| `docs/always-on.md`, `docs/always-on-ops.md` | Updated AUTO_CLOSE trigger descriptions |

### Upgrade Instructions

Run `/claude-code-hermit:hermit-evolve`. The evolve skill handles:

1. **Add `daily-auto-close` routine to `config.json`.** Read `config.routines`. If any entry has `id: "daily-auto-close"`, skip. Otherwise append: `{"id": "daily-auto-close", "schedule": "0 0 * * *", "skill": "claude-code-hermit:daily-auto-close", "run_during_waiting": true, "enabled": true}`.
2. **Re-arm routines.** Invoke `/claude-code-hermit:hermit-routines load` so the new entry registers via CronCreate this session.
3. **Report.** "Added `daily-auto-close` routine — long-running daemon sessions now archive at midnight when idle ≥10 min, restoring reflect / weekly-review / brain evidence on chatty hermits. **Note:** weekly self-directed rate may shift for 1–2 reviews as midnight archives age into the window."

## [1.1.4] - 2026-05-23

### Changed

- **heartbeat: migrated to CC Monitor** — OK/SKIP ticks no longer wake the LLM; bypasses the `/loop` cloud-schedule prompt (CC 2.1.150). EVALUATE interrupts mid-task instead of deferring to idle. `heartbeat.show_ok` removed; use `/heartbeat status` for liveness.
- **env defaults: `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` 50 → 65** — auto-compact was firing well before the quality-degradation zone (~73%).
- **env defaults: `COMPACT_THRESHOLD` 50 → 75** — tool-call-based nudge was firing mid-session for any non-trivial work.
- **hatch: `push_notifications` now defaults to `true`** — derived from channel choice (no channel → on, channel → off). Toggle via `/hermit-settings push-notifications`.

### Fixed

- **docs: `COMPACT_THRESHOLD` description corrected to tool-call-count fallback** — config-reference previously called it a "context % threshold," contradicting `suggest-compact.js`.

### Files affected

| File | Change |
|------|--------|
| `skills/heartbeat/SKILL.md` | Migrated to CC Monitor; removed show_ok; updated start/stop/status flow |
| `scripts/heartbeat-monitor.sh` | New shell script for the Monitor subprocess |
| `scripts/hermit-start.py` | Register heartbeat Monitor on boot |
| `skills/session-close/SKILL.md` | Stop heartbeat Monitor on session close |
| `state-templates/config.json.template` | Bumped env defaults; push_notifications defaults to true |
| `skills/hatch/SKILL.md` | push_notifications derived from channel choice |
| `docs/config-reference.md` | COMPACT_THRESHOLD description corrected |

### Upgrade Instructions

Run `/claude-code-hermit:hermit-evolve`. The evolve skill handles:

1. **Run `/claude-code-hermit:heartbeat start`** — sweeps any pre-existing CronCreate entry and registers the new Monitor in one shot.
2. **Update `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` in `config.json`** — if `env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE == "50"`, set it to `"65"`; otherwise leave it alone.
3. **Update `COMPACT_THRESHOLD` in `config.json`** — if `env.COMPACT_THRESHOLD == "50"`, set it to `"75"`; otherwise leave it alone.
4. **Update `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` in the settings file** — read `.claude/settings.local.json` (or `.claude/settings.json` per `hatch_target`); if the value is `"50"`, update to `"65"`; otherwise leave it alone.
5. **Update `COMPACT_THRESHOLD` in the settings file** — if the value is `"50"`, update to `"75"`; otherwise leave it alone.
6. **Set `push_notifications` default** — if absent from `config.json`, set to `true` and notify: "`push_notifications` now defaults to `true` — you'll get a desktop/Remote Control push when no channel is enabled or a configured channel is unreachable. Run `/hermit-settings push-notifications off` to disable." If already present, leave it untouched.
7. **Report env changes** — for each key: "Bumped `X` 50 → Y — `<reason>`." or "Left `X` at `<value>` (custom override preserved)."

## [1.1.3] - 2026-05-23

### Fixed

- **docker-setup: Screen 2 acknowledgement now covers `auto` mode** — guided-path attach instructions and the manual deployment guide both walk operators through the "Enable auto mode?" first-launch gate (press `1` + Enter to persist in the named volume). Previously only `bypassPermissions` had Screen 2 guidance; `auto`-mode Docker hermits saw a frozen-looking REPL with no instructions.

### Changed

- **v1.1.2 auto-migration upgrade step retracted** — the prompt that asked operators to switch `permission_mode` from `acceptEdits`/`bypassPermissions` to `auto` is gone. Reason: CC's interactive "Enable auto mode?" first-launch gate blocks headless boot, breaking Docker hermits mid-upgrade with no operator attached. The retraction was already applied to v1.1.2's CHANGELOG; called out here for visibility. `auto` remains a selectable mode via `/hermit-settings permissions` — operators opt in when they can attend the first-run acknowledgement.

### Files affected

| File | Change |
|------|--------|
| `skills/docker-setup/SKILL.md` | Screen 2 paragraph + manual deployment guide cover both `bypassPermissions` and `auto` |
| `CHANGELOG.md` | new 1.1.3 entry |
| `.claude-plugin/plugin.json` | version 1.1.2 → 1.1.3 |

### Upgrade Instructions

Run `/claude-code-hermit:hermit-evolve`. The evolve skill handles:

1. **Refresh docker-setup skill text.** No operator action — the updated skill ships with the plugin update.

**Note:** if your Docker hermit was migrated to `permission_mode: auto` by the v1.1.2 evolve step and now hangs on container boot, edit `.claude-code-hermit/config.json` to set `permission_mode: "bypassPermissions"` (or your pre-1.1.2 value), then run `.claude-code-hermit/bin/hermit-docker down && .claude-code-hermit/bin/hermit-docker up`.

No config.json changes required.

## [1.1.2] - 2026-05-23

### Added

- **`/simplify` skill: plugin-owned port of the bundled skill** — CC v2.1.146 renamed it to `/code-review` (read-only). Three parallel reviewers (reuse, quality, efficiency) propose edits; main agent applies them with conflict resolution. Reports `applied N · deduped M · principle-rejected K · stale-anchor skips L · parse failures P`.
- **push_notifications: new opt-in config flag (GH #106)** — when `true`, fires `PushNotification` as fallback when no channel is enabled, the channel is unreachable, or a post-resolve reply fails. Default false; toggle via `/hermit-settings push-notifications`.
- **sandbox: auto-configured by `/hatch` when supported** — writes the standard profile (filesystem denies for `~/.aws`, `~/.ssh`, `~/.gnupg`; network unrestricted) silently on probe pass; prints an install hint and skips on probe fail. Existing `sandbox.*` keys are preserved. Set `sandbox.enabled: false` to opt out.
- **`scripts/sandbox-probe.py`: shared capability probe** — returns `pass/warn/fail` with install hint on failure; result cached per boot. Used by `/hatch`, `hermit-start`, and `/hermit-doctor`.
- **Docker image: ships `bubblewrap` + `socat`** — required for sandbox inside unprivileged containers. `hermit-start` auto-sets `sandbox.enableWeakerNestedSandbox: true` on container boots and removes it otherwise.
- **`/hermit-doctor` sandbox check** (ninth check). Runs the capability probe and cross-references `sandbox.enabled` in settings files. Reports `pass/warn/fail` with remediation.
- **FAQ entry** for bash sandboxing — explains the macOS/Linux split, custom-CA tooling edge cases, and the WSL2 prerequisite.
- **`sandbox-profiles.json`** in `state-templates/` defines the `off` and `standard` profiles. `deny-patterns.json` gains a `sandbox.filesystem.denyRead` section as the canonical source for credential-path denies.
- **sandbox: contract tests + doc clarification** — 5 new tests for probe cache/warn/fail paths (suite now 81). Clarified that the ninth `/hermit-doctor` check runs in the skill orchestrator, not `doctor-check.js`, so `doctor-report.json` omits the sandbox line.

### Changed

- **`/proposal-act` step (e.5): swapped `/code-review` for `/simplify`** — gates shift from correctness (JSON bug-finding) to cleanup (refactor proposals the skill applies itself). Failures log a warning and fall back to skip; `code-review:code-review` remains available for deeper bug checks.
- **`permission_mode: auto` available as an opt-in (CC 2.1.150+)** — classifier-reviewed autonomy; selectable via `/hermit-settings permissions` or chosen at `/hatch` time. NOT the default for Docker or tmux always-on deployments: CC shows an interactive "Enable auto mode?" acknowledgement on first launch, which blocks headless boot until acknowledged. Quick Docker / tmux always-on hatches keep `bypassPermissions`; interactive hatches default to `acceptEdits`. Existing installs are NOT auto-migrated to `auto` — operators opt in explicitly when they can attend the first-run acknowledgement. Requires CC 2.1.150+; not available on Pro, Haiku, or non-Anthropic providers. `min_claude_code_version` bumped to `>=2.1.150` in `hermit-meta.json`.

### Fixed

- **sandbox probe: corrected Ubuntu 24.04+ remediation message** — the warn branch previously suggested a non-existent sysctl. Now points at the AppArmor profile for 24.04+ while keeping `kernel.unprivileged_userns_clone=1` for older kernels. `install_hint` field now populated so all callers surface it consistently.

### Upgrade Instructions

1. **Apply the standard sandbox profile when supported** (or confirm existing config).

   Read the target settings file — resolve via `hatch_target` (`local` → `.claude/settings.local.json`; `committed` → `.claude/settings.json`; fallback chain: `.claude-code-hermit/state/hatch-options.json` → marker scan → scope detection).

   - If the file already contains any *operator-intent* sandbox key (`enabled`, `filesystem`, `network`, `failIfUnavailable`, `autoAllowBashIfSandboxed`, or `allowUnsandboxedCommands`): tell the operator "Your existing sandbox config was preserved." **Skip the rest of this step.** Note: `enableWeakerNestedSandbox` is hermit-managed (auto-written by `hermit-start` in Docker) and does NOT count as operator config — ignore it when deciding whether to skip.
   - **If running inside a container** (`/.dockerenv` or `/run/.containerenv` exists): skip the probe (it would fail unconditionally on `unshare --user --pid true` in unprivileged containers). Apply the standard profile directly (see below). Tell the operator: "Sandbox enabled (standard profile, container — enableWeakerNestedSandbox auto-managed by hermit-start)."
   - Otherwise (not a container, no operator config): run `python3 ${CLAUDE_PLUGIN_ROOT}/scripts/sandbox-probe.py`.
     - If status is `"pass"`: apply the standard profile (see below). Tell the operator: "Sandbox enabled (standard profile, written to {file})."
     - If status is `"warn"`: surface the probe `message` to the operator first, then apply the standard profile. Tell the operator: "Sandbox configured (may degrade silently per warning above; written to {file})."
     - If status is `"fail"`: do NOT write any sandbox block. Print one line: "Sandbox unavailable: {message} — run `{install_hint}` to enable later, then re-run this migration."

   **Apply the standard profile** means: read `${CLAUDE_PLUGIN_ROOT}/state-templates/sandbox-profiles.json` (select the `standard` entry — includes `enabled`, `failIfUnavailable`, `autoAllowBashIfSandboxed`, `allowUnsandboxedCommands`); read `${CLAUDE_PLUGIN_ROOT}/state-templates/deny-patterns.json` and extract `sandbox.filesystem.denyRead`; merge `profile.filesystem = { "denyRead": <that array> }`; merge into the target settings file under the `sandbox` key.

2. **Rebuild the Docker image** (Docker operators only).

   The base image now includes `bubblewrap` and `socat`. Without a rebuild the sandbox silently degrades inside the container. Run `hermit-docker update` or `docker compose build` to pick up the new packages. Note: the entrypoint itself did not change, so no template refresh is needed.

3. **Note on custom-CA tooling** (informational, no action required unless affected).

   Tools that use a MITM proxy with a custom certificate authority (e.g. `gcloud` with a corporate proxy, `terraform` with a company CA) may require `"enableWeakerNetworkIsolation": true` in the `sandbox` block. See [Claude Code sandbox docs](https://code.claude.com/docs/en/settings#sandbox-settings) and the FAQ entry in `docs/faq.md`.

4. **Refresh the CLAUDE-APPEND block to point `quality-gate-judge` at `/claude-code-hermit:simplify`.** The injected `## Subagents` table in operator `CLAUDE.md` (or `CLAUDE.local.md`) contains a `quality-gate-judge` row that previously read `decides whether /code-review should run`. After this release, `hermit-evolve` Step 7's sibling-sync re-syncs the canonical block to the resolved `hatch_target` — operators with the marker present see the wording flip to `/claude-code-hermit:simplify` automatically. No operator-prompt required; the marked block is template-authoritative.

## [1.1.1] - 2026-05-21

### Added

- **hatch: scope-aware output routing (GH #111)** — detects install scope and routes outputs: `local` → `CLAUDE.local.md` + `settings.local.json`; `project` → `CLAUDE.md` + `settings.json`; `user` → `.local`. Target persisted to `hatch-options.json`; `hermit-evolve` and `docker-setup` are now target-aware.

### Changed

- **adapted to CC 2.1.146 `/simplify` → `/code-review` rename** — all runtime invocations and templates updated. `min_claude_code_version` bumped to `>=2.1.146`. Requires CC 2.1.146+; run `/hermit-evolve` to refresh existing CLAUDE-APPEND.
- **hatch routing: review-pass refinements (GH #111)** — `docker-setup` uses the same fallback chain as `hermit-evolve` to avoid leaking personal hardening into the repo; `hatch` preserves original `stamped_by`/`stamped_at` when re-stamping; new contract test guards rename drift across all five consumers.

### Fixed

- **AUTO_CLOSE defeated by routine SHELL.md writes (#109)** — heartbeat-precheck read SHELL.md mtime, which routines bump sub-12h. Fix: new `scripts/record-operator-action.js` hook writes `state/last-operator-action.json` on real operator activity only, filtering cron prompts, slash-commands, and channel messages. Heartbeat-precheck now gates `AUTO_CLOSE` on this file, falling back to SHELL.md mtime for pre-upgrade installs.

### Upgrade Instructions

0. **Append local-file entries to `.gitignore`** (always, regardless of target).
   - Read `.gitignore` at the project root.
   - If it does not contain the line `CLAUDE.local.md`, append it.
   - If it does not contain the line `.claude/settings.local.json`, append it.

1. **Migration preflight — detect deny patterns that block this migration.**
   - Read `permissions.deny` from both `.claude/settings.json` and `.claude/settings.local.json` (if they exist).
   - If any of the following appear: `Edit(.claude/settings.json)`, `Write(.claude/settings.json)`, `Edit(.claude/settings.local.json)`, `Write(.claude/settings.local.json)`, `Bash(*> .claude/settings.json*)`, `Bash(*> .claude/settings.local.json*)` — surface them to the operator with this message: "These deny patterns (from the hardened always_on set) will block the migration writes. Temporarily removing them is required to proceed."
   - Ask operator: **Temporarily remove for this migration** (stash, migrate, restore at end) / **Skip migration** (keep current layout, no file moves) / **Abort** (stop hermit-evolve entirely).
   - If "Skip migration": record `hatch_target = "committed"` and stamp `.claude-code-hermit/state/hatch-options.json`, then skip steps 3–5. Continue to step 6 (hermit-evolve will correctly write to committed files going forward).
   - If "Temporarily remove": remove the listed deny entries from the settings file(s) now. Note them for restoration in step 7.

2. **Decide hermit visibility for this project.**
   - Read `claude plugin list --json`. Apply precedence `local > project > user` for entries where plugin name is `claude-code-hermit` and `projectPath` matches the current project root. Map: project → committed; local/user/null → local.
   - Ask operator a single Visibility prompt with three options (scope-derived target at position 0 as recommended): **`.local` files** (gitignored — operator-personal) / **Committed files** (shared with teammates) / **Stay on committed (skip migration)** (no file moves; hermit-evolve writes to committed files going forward).
   - If "Stay on committed (skip migration)": record `hatch_target = "committed"`, stamp `.claude-code-hermit/state/hatch-options.json`, skip steps 3–5 entirely (do not prompt per-step). Continue to step 6.
   - Otherwise record the choice into `.claude-code-hermit/state/hatch-options.json`.

3. **Migrate hermit CLAUDE-APPEND block if target = .local.**
   - If `CLAUDE.md` contains the marker `<!-- claude-code-hermit: Session Discipline -->`: show diff (CLAUDE.md → CLAUDE.local.md). Ask operator: **Move** (diff-and-confirm) / **Keep in CLAUDE.md** / **Skip**.
   - If moving: check whether the block content differs from the canonical template at this plugin version. If hand-edits exist inside the marker, surface them — ask whether to carry them across or drop them.

4. **Migrate hermit-scoped hook allow entries if target = .local.**
   - Identify hermit-scoped entries in `.claude/settings.json` `permissions.allow` by matching: `Bash(git diff:*)`, `Bash(git status:*)`, `Bash(git log:*)`, `Bash(node */scripts/cost-tracker.js*)`, `Bash(node */scripts/suggest-compact.js*)`, `Bash(node */scripts/heartbeat-precheck.js*)`, `Bash(node */scripts/reflect-precheck.js*)`, `Bash(node */scripts/archive-shell.js*)`, `Bash(node */scripts/run-with-profile.js*)`, `Bash(node */scripts/evaluate-session.js*)`, `Bash(node */scripts/append-metrics.js*)`, `Bash(node */scripts/generate-summary.js*)`, `Bash(node */scripts/update-reflection-state.js*)`, `Bash(node */scripts/cron-tz-shift.js*)`, `Bash(bash -c 'AGENT_DIR=\".claude-code-hermit\"*)`, `Edit(.claude-code-hermit/**)`, `Write(.claude-code-hermit/**)`.
   - Show diff (`.claude/settings.json` → `.claude/settings.local.json`). Ask operator: **Move** / **Keep in settings.json** / **Skip**.

5. **Migrate hermit deny patterns if target = .local.**
   - Identify by matching entries against `state-templates/deny-patterns.json` (both `default` and `always_on` sets).
   - Show diff (`.claude/settings.json` → `.claude/settings.local.json`). Ask operator: **Move** / **Keep in settings.json** / **Skip**.

6. **If target = committed:** no marker or permission migration needed. hermit-evolve continues writing to committed files (current behavior) — steps 3–5 are skipped.

7. **Restore preflight denies** (only if step 1 stashed entries). Re-add the stashed deny entries to the operator's chosen target settings file.

## [1.1.0] - 2026-05-18

### Added

- **`channels.primary`: operator-configurable primary outbound channel (PROP-041)** — adds `scripts/resolve-outbound-channel.js`; checks `channels.primary` first, then falls back to the first eligible entry in config order. No hardcoded slug list; any channel plugin with `dm_channel_id` set is eligible. `/hermit-settings channels` gains `primary <name>` and `primary clear` verbs.

- **new skills: `/hermit-brain`, `/hermit-evolution`, `/hermit-health`** — on-demand analytics replacing the retired Cortex surface. `/brain`: fragile zones and learnings; `/evolution`: cost/autonomy trends; `/health`: alert state and channel availability. All emit ≤1500-char channel-optimised markdown.
- **automatic session close (PROP-040)** — heartbeat archives sessions idle for 12h+ via a new `AUTO_CLOSE` verdict from `heartbeat-precheck.js`. Auto-closed reports carry `closed_via: auto`; reflect skips them; weekly-review excludes them from the autonomy denominator.
- **channel-reply reminder (PROP-037)** — new `scripts/channel-reply-reminder.js` UserPromptSubmit hook injects a reminder with the exact reply tool and `chat_id` on every inbound channel message. No-op when no channel envelope is present. Addresses silent-stranding when MCP-level guidance alone was insufficient.

### Fixed

- **auto-close: SHELL.md Monitoring append now runs before `/session-close --auto`** — the append previously landed in the new session's template instead of the archived report, losing the auto-close evidence trace.

### Changed

- **Cortex: cron-driven regeneration replaced by on-demand skill dispatch** — `/hermit-brain`, `/hermit-evolution`, `/hermit-health` read state directly per invocation; no pre-built file artifact.
- **`weekly-review`: appends a "This week's evolution" block** (cost, autonomy, proposal counts with week-over-week Δ) and sends via channel. Computed from `compiled/review-weekly-*.md` frontmatter.
- **`weekly-review` routine default changed to `enabled: true`** for new installs. Existing operators retain their current setting; to receive the new channel-friendly weekly evolution summary, enable the `weekly-review` routine via `/claude-code-hermit:hermit-settings`.
- **frontmatter contract: relaxed from strict enforcement to convention** — `validate-frontmatter.js` removed; include `title`, `created`, `tags`, `source`, `session` by convention. See `docs/frontmatter-contract.md`.
- **`/reflect`: Tier 1 + `current-session` accepted at any hermit phase (PROP-036)** — previously only `newborn` allowed it; long-running daemons without archived sessions were left silent. Tier 1 + `archived-session` still requires 2+ archives; Tier 2/3 unchanged.

### Fixed

- **`hermit-evolve`: migration check uses correct `obsidian/` path (PR #102)** — wrong path meant upgrade-time Findings note never fired. Also: `weekly-review` channel selection uses explicit priority order; `/brain` trigger list no longer collides with `/knowledge`; `TestAnalyticsSkillsContract` guards analytics skill drift.

### Removed

- **Skills:** `/claude-code-hermit:obsidian-setup`, `:cortex-refresh`, `:cortex-sync`
- **Scripts:** `build-cortex.js`, `cortex-refresh-stage.js`, `validate-frontmatter.js`
- **Templates:** `state-templates/obsidian/` (six Cortex page templates)
- **Templates:** `state-templates/cortex-manifest.json.template`
- **Docs:** `docs/obsidian-setup.md`
- **Stop-hook stage:** cortex-refresh stage removed from `scripts/stop-pipeline.js`
- **Weekly-review:** `Latest Review.md` pointer write removed from `scripts/weekly-review.js`

### Files affected

| File | Change |
|------|--------|
| `scripts/resolve-outbound-channel.js` | New: primary channel resolver CLI |
| `scripts/channel-reply-reminder.js` | New: UserPromptSubmit hook for channel reply reminder |
| `scripts/weekly-review.js` | Evolution block; use resolver for channel send |
| `scripts/heartbeat-precheck.js` | New `AUTO_CLOSE` verdict; SHELL.md mtime check |
| `scripts/validate-config.js` | Special-case `channels.primary` optional string |
| `skills/hermit-brain/SKILL.md` | New analytics skill |
| `skills/hermit-evolution/SKILL.md` | New analytics skill |
| `skills/hermit-health/SKILL.md` | New analytics skill |
| `skills/heartbeat/SKILL.md` | AUTO_CLOSE branch; step ordering fix |
| `skills/session-close/SKILL.md` | `--auto` flag to bypass operator-summary prompt |
| `skills/hermit-settings/SKILL.md` | `primary` verbs; channels list shows primary |
| `skills/hermit-evolve/SKILL.md` | Fix `obsidian/` path; add `min_claude_code_version` gate |
| `skills/reflect/SKILL.md` | Tier 1 + `current-session` accepted at any hermit phase |
| `skills/weekly-review/SKILL.md` | Evolution block; channel send |
| `skills/channel-responder/SKILL.md` | §0 reply-via-channel contract |
| `state-templates/CLAUDE-APPEND.md` | Updated Operator Notification protocol; Quick Reference |
| `state-templates/config.json.template` | Add `channels.primary` optional string |
| `hooks/hooks.json` | Add `channel-reply-reminder` UserPromptSubmit entry |
| `skills/obsidian-setup/`, `cortex-refresh/`, `cortex-sync/` | Removed |
| `scripts/build-cortex.js`, `cortex-refresh-stage.js`, `validate-frontmatter.js` | Removed |
| `state-templates/obsidian/`, `cortex-manifest.json.template` | Removed |

### Upgrade Instructions

Run `/claude-code-hermit:hermit-evolve` after `/plugin update`. The evolve skill handles:

1. **Detect** existing project-root `obsidian/` directory — leave it untouched. Log a Findings note: `"obsidian/ no longer maintained by hermit; safe to delete or keep as personal vault."` Leave `.claude-code-hermit/cortex-manifest.json` in place.
2. **Inform** the operator: `weekly-review` template default is now `enabled: true` for new installs; your current setting is not auto-flipped. To receive the new channel-friendly weekly evolution summary, run `/claude-code-hermit:hermit-settings` and enable the `weekly-review` routine.
3. **Note** that `/obsidian-setup`, `/cortex-refresh`, and `/cortex-sync` have been removed — no migration required.

No config.json changes required.

## [1.0.40] - 2026-05-16

### Added

- **cost reporting: show token counts alongside USD on all surfaces (GH #77)** — USD is noisy with caching; tokens give a stable, pricing-independent signal. Affects `pulse`, `brief`, `hermit-doctor`, `weekly-review`, and session frontmatter. `cost-tracker.js` accumulates `total_tokens`; pulse reads live cost from `.status.json`.

- **Docker: `gh` CLI installed in baseline image (PROP-028, GH #82)** — anonymous by default (60 req/hr); set `HERMIT_GH_TOKEN` in `.env` for authenticated calls. Compose maps it to `GH_TOKEN` inside the container.

- **CLAUDE-APPEND: calibration rule added** — new `Rules` bullet: verify or label specific claims (version-pinned behavior, API signatures, menu paths, prices/dates). General domain knowledge answerable directly. Resolves PROP-025.

### Changed

- **CLAUDE-APPEND: `Proposals mandatory` rule tightened** — added explicit "Never hand-write `proposals/PROP-*.md` files"; manual IDs reuse NNNs and violate the canonical `PROP-NNN-<slug>-HHMMSS` schema.

### Removed

- **`hermit-takeover` and `hermit-hand-back` skills removed** — duplicated `bin/hermit-docker down/up` but skipped the SIGTERM-triggered `/session-close --shutdown`. Doc references repointed at `bin/hermit-docker`/`bin/hermit-start`.

### Upgrade Instructions

**`gh` baseline install (Dockerfile + Compose).** Existing hermits have on-disk `Dockerfile.hermit` and `docker-compose.hermit.yml` at the project root that plugin updates won't touch. Two surgical patches are needed before rebuilding:

**Step 1 — Dockerfile.** Open `Dockerfile.hermit` at the project root. If the file does not exist, Docker has not been set up — skip to Step 3. Check whether it already contains `apt-get install -y --no-install-recommends gh`. If it does, skip to Step 2. If not, locate the line:

```
    apt-get install -y --no-install-recommends nodejs && \
```

Replace the continuation (the `rm -rf` line that follows it) with:

```
    apt-get install -y --no-install-recommends nodejs && \
    mkdir -p -m 755 /etc/apt/keyrings && \
    curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
      -o /etc/apt/keyrings/githubcli-archive-keyring.gpg && \
    chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg && \
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
      > /etc/apt/sources.list.d/github-cli.list && \
    apt-get update && apt-get install -y --no-install-recommends gh && \
    rm -rf /var/lib/apt/lists/*
```

**Step 2 — docker-compose.hermit.yml.** Open `docker-compose.hermit.yml` at the project root. If the file does not exist, skip to Step 3. Check whether it already contains `GH_TOKEN=`. If it does, skip to Step 3. If not, find the line starting with `      - AGENT_HOOK_PROFILE=` and add immediately after it:

```
      - GH_TOKEN=${HERMIT_GH_TOKEN:-}
```

**Step 3 — Rebuild.** Run `hermit-docker update` to rebuild the image with the patched Dockerfile. On next start, `gh --version` should succeed inside the container.

**Netguard note:** No dnsmasq allowlist change is required. The existing `server=/github.com/` rule already covers `api.github.com` and `cli.github.com` as subdomains — do not add redundant entries.

**Authenticated calls (optional):** To use `gh` with a GitHub PAT, add `HERMIT_GH_TOKEN=<your-pat>` to `.claude-code-hermit/.env`, then `hermit-docker down && hermit-docker up`. The Compose template maps it to `GH_TOKEN` inside the container. Without a token, `gh` runs anonymously (60 req/hr rate limit).

**`hermit-takeover` / `hermit-hand-back` removal.** No operator action needed. The canonical Quick Reference line now lives in `state-templates/CLAUDE-APPEND.md`, and `hermit-evolve` step 6 (atomic block sync) refreshes the operator's project `CLAUDE.md` on the next evolve run.

## [1.0.39] - 2026-05-14

### Fixed

- **`skills/proposal-act/SKILL.md` frontmatter parse error** — unquoted internal colon in description (`how to proceed: start implementing`) caused `YAML frontmatter failed to parse`; description was silently dropped at runtime. Wrapped in single quotes.

### Changed

- **`/proposal-act` accept: "Start implementing now" added as default third option** — executes the Proposed Solution in the current turn, then auto-resolves and notifies the operator.
- **"Create a session task" branch preserves an existing `NEXT-TASK.md` rather than overwriting it.** If one is already pending, the branch skips the write, marks the proposal `accepted`, and tells the operator to consume the existing task first via `/session-start`.
- **Resolve Flow drops the hardcoded "Pattern confirmed absent" suffix.** `Resolved on <date>.` is now the default append. Reflect's auto-resolve path may still add the pattern-absence note in SHELL.md Findings (unchanged); the proposal file itself stays generic.
- **`HEARTBEAT.md.template`: scope proposal review to `status: proposed`.** Accepted proposals were re-surfaced as actionable by the LLM-evaluated checklist item. New wording explicitly skips accepted, resolved, deferred, and dismissed.
- **`/proposal-act` accept-flow wording tightened (review pass)** — step ordering, waiting-branch copy, and NEXT-TASK collision recovery path all clarified.
- **`quality_gate.tier` config key + `quality-gate-judge` subagent (GH #66, PROP-019)** — three tiers: `budget` (default, `/simplify` never runs), `balanced` (judge decides per implementation), `quality` (`/simplify` always runs). Toggle via `/hermit-settings quality-gate`.
- **NEXT-TASK numbered-bullet append simplified** — replaced brittle conditional numbering with sequential `4.` onwards with `(if ...)` prefixes.

### Files affected

| File | Change |
|------|--------|
| `skills/proposal-act/SKILL.md` | Three-option accept step 4; resolve wording; description string (single-quoted to escape internal colon); tier-branched step (e.5); NEXT-TASK numbered-bullet ordering |
| `agents/quality-gate-judge.md` | **New** haiku subagent: reads proposal body + touched files, returns RUN/SKIP verdict for step (e.5) balanced tier |
| `agents/hermit-config-validator.md` | Mirror enum check for `quality_gate.tier` in the validator's prose checklist |
| `scripts/validate-config.js` | Add `quality_gate` to `REQUIRED_KEYS`; add enum validator for `quality_gate.tier` (matches existing `escalation` pattern) |
| `state-templates/HEARTBEAT.md.template` | Scope proposal review to `status: proposed` |
| `state-templates/config.json.template` | New `quality_gate.tier` key (default `"budget"`) |
| `state-templates/CLAUDE-APPEND.md` | Subagents section: add `quality-gate-judge` entry |
| `skills/hermit-settings/SKILL.md` | `quality-gate` subcommand: 3-option tier picker (Budget/Balanced/Quality), display row |
| `skills/hatch/SKILL.md` | `quality_gate` added to Template-only fields list |
| `docs/config-reference.md` | Top-Level Keys row + Complete Example for `quality_gate.tier`; dev-quality overlap note |
| `docs/skills.md` | `quality-gate` appended to hermit-settings subcommand list |
| `tests/test-proposal-act-accept-flow.sh` | New regression test + tier-branched asserts; subagent-file existence/frontmatter asserts |
| `tests/run-contracts.py` | `TestConfigContract`: assert `quality_gate.tier` enum in template |
| `tests/run-all.sh` | Register new test |

### Upgrade Instructions

**HEARTBEAT.md**: existing hermits have an on-disk `HEARTBEAT.md` that template updates won't touch. Check line 5 of `.claude-code-hermit/HEARTBEAT.md`. If it still reads exactly:

```
- Review proposals/ for any needing attention
```

replace it with:

```
- Review `proposals/` for any with `status: proposed` needing operator review. Skip `accepted` (operator-owned, implementation underway), `resolved`, `deferred`, and `dismissed`.
```

If you have customised this line, skip and update manually.

**config.json (`quality_gate.tier`)**: if `quality_gate.tier` is already present in `.claude-code-hermit/config.json`, skip. Otherwise ask the operator via `AskUserQuestion`:

> *"Pick the quality-gate tier for autonomous proposal implementations. The hermit runs `/simplify` at step (e.5) of `/proposal-act` based on this setting."*

Options:
- **Budget** (default; recommended): write `"quality_gate": { "tier": "budget" }`. `/simplify` never runs at step (e.5). Cheapest. No post-implementation review.
- **Balanced**: write `"quality_gate": { "tier": "balanced" }`. The new `quality-gate-judge` haiku subagent decides per implementation (reads proposal body + touched files, returns `RUN` or `SKIP`). Costs ~$0.005 per judge call plus an occasional ~$0.25 `/simplify` run on RUN verdicts.
- **Quality**: write `"quality_gate": { "tier": "quality" }`. `/simplify` runs on every implementation. ~$0.25-$0.35 per implementation in Sonnet pricing.

If the operator has `claude-code-dev-hermit:dev-quality` installed and uses it to gate commits, recommend **Budget**: `/dev-quality` already runs `/simplify` pre-commit, and any non-Budget tier here would double-fire `/simplify` (~$0.40-$0.70 of duplicated spend per committed implementation).

Operators can flip later via `/claude-code-hermit:hermit-settings quality-gate`.

**CLAUDE.md — Subagents section**: open `.claude-code-hermit/CLAUDE.md` (created during `/hatch` from the CLAUDE-APPEND template). Locate the `## Subagents` section. If `quality-gate-judge` is already listed, skip. Otherwise, after the line that starts with `` - `hermit-config-validator` (Haiku) — ``, insert exactly:

```
- `quality-gate-judge` (Haiku) — decides whether `/simplify` should run at step (e.5) of `/proposal-act` accept flow; reads proposal body + touched files, returns RUN/SKIP verdict. Only invoked when `quality_gate.tier: "balanced"`.
```

If the Subagents section has been customised or reordered such that the anchor line isn't found, surface a manual note: "Add `quality-gate-judge` to your Subagents section in CLAUDE.md."

### Known Limitations

- **"Create a session task" does not queue multiple proposals.** `session-start` always deletes `NEXT-TASK.md` after presenting it, so appending would lose unselected items. The preserve-and-notify guard is the safe minimum. Making `session-start` understand a queue of suggested tasks is a separate follow-up.

## [1.0.38] - 2026-05-12

### Added

- **`safeForLLM()` sanitizer for LLM-bound rejection text (PROP-008)** — wraps known Claude context-marker tags (e.g. `<system-reminder>` → `[system-reminder]`) so they can't be interpreted as injected system context.

### Changed

- **`validate-config.js`: rejection text routed through `safeForLLM` (PROP-008)** — user-controlled fields (channel name, schedule, etc.) sanitized before reaching Claude's context to prevent `<system-reminder>` injection via `config.json`.
- **`validate-config.js` hook: `continueOnBlock: true` (PROP-008)** — config validation failure previously halted the turn; now surfaces the error as feedback so Claude can fix the config without operator recovery.
- **`hermit-evolve`: `min_claude_code_version` gate at Step 0** — reads `hermit-meta.json` and aborts with an upgrade message if the CLI is below the declared minimum. First core-side `hermit-meta.json` added with `min_claude_code_version: ">=2.1.139"`.
- **hooks: converted to exec form (`args: []`)** — fixes path-with-spaces fragility where `${CLAUDE_PLUGIN_ROOT}` expanded unquoted in shell form. All 8 convertible hook entries updated; dev-mode contract runner stays in shell form.
- Added `tests/test-hook-registration-form.sh` contract test — guards against future regressions to naked shell-form interpolation across the plugin fleet. Also fails loudly when the path-resolution glob returns zero hook entries, so a future refactor that breaks `MONOREPO_ROOT` resolution cannot silently pass the test vacuously.

### Fixed

- **`hermit-docker update`: cache-bust fix for CC binary** — `docker compose build` reused cached `npm install` layers, causing silent version rollbacks. Fixed by adding `CLAUDE_CODE_VERSION` build arg to `Dockerfile.hermit.template`; BuildKit invalidates the layer when the version changes.

- **`hermit-docker update`: false downgrade report fixed** — `CC_AFTER` now sourced from the resolved build-arg version instead of querying the container (which returned the baked image version before self-update).

- **`/reload-plugins`: gated on CC prompt readiness** — previously `tmux has-session` succeeded before `claude` was ready, causing sent keys to land in the bash shell. Now polls for the `╭─`/`╰─` input-box characters before sending (up to 60s).

### Files affected

| File | Change |
|------|--------|
| `state-templates/docker/Dockerfile.hermit.template` | `ARG CLAUDE_CODE_VERSION=latest`; npm install pinned to `@${CLAUDE_CODE_VERSION}` |
| `state-templates/docker/docker-compose.hermit.yml.template` | `CLAUDE_CODE_VERSION: ${CLAUDE_CODE_VERSION:-latest}` under `build.args` |
| `state-templates/bin/hermit-docker` | `update` arm: `--build-arg` pass-through; `CC_AFTER` from pinned value; `_wait_for_claude_prompt` readiness gate; log field renamed |

### Upgrade Instructions

- **Requires Claude Code 2.1.139 or newer.** The `args: []` exec form was introduced in CC 2.1.139. Update Claude Code before pulling this release, or hooks will fail to register.

Docker users only. Non-Docker (tmux/local) hermits are unaffected.

The `hermit-docker update` wrapper (`bin/hermit-docker`) is refreshed wholesale by `hermit-evolve` step 5b — no manual wrapper edit needed.

The on-disk `Dockerfile.hermit` and `docker-compose.hermit.yml` in the project root need two surgical patches to pass the build arg through. Apply them idempotently:

1. **Idempotency check for `Dockerfile.hermit`.** If the file does not exist in the project root, skip (Docker not set up). If the file already contains `ARG CLAUDE_CODE_VERSION`, skip this file — already patched.

2. **Patch `Dockerfile.hermit`.** Anchor on the exact line `ARG HOST_UID=1000`. If this line is not found (operator-customized Dockerfile), tell the operator: "Auto-patch skipped for Dockerfile.hermit — anchor `ARG HOST_UID=1000` not found. Add these two lines manually after the HOST_UID ARG: `ARG CLAUDE_CODE_VERSION=latest` and change the npm install line to `RUN npm install -g bun @anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}`." Then skip to step 4.

   Use the Edit tool with:

   `old_string`:
   ```
   ARG HOST_UID=1000
   ```

   `new_string`:
   ```
   ARG HOST_UID=1000
   ARG CLAUDE_CODE_VERSION=latest
   ```

3. **Pin the npm install in `Dockerfile.hermit`.** Anchor on `@anthropic-ai/claude-code` NOT already followed by `@` (i.e. the line doesn't yet have `@${CLAUDE_CODE_VERSION}`). If the npm install line has already been version-pinned, skip.

   Use the Edit tool with:

   `old_string`:
   ```
   RUN npm install -g bun @anthropic-ai/claude-code
   ```

   `new_string`:
   ```
   RUN npm install -g bun @anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}
   ```

   If the old_string is not found (operator added extra packages to the line), tell the operator: "Auto-patch skipped for the npm install line — it has been customized. Update it manually to include `@${CLAUDE_CODE_VERSION}` after `@anthropic-ai/claude-code`."

4. **Idempotency check for `docker-compose.hermit.yml`.** If the file does not exist, skip. If it already contains `CLAUDE_CODE_VERSION:`, skip — already patched.

5. **Patch `docker-compose.hermit.yml`.** Anchor on `HOST_UID: ${UID:-1000}`. If not found, tell the operator: "Auto-patch skipped for docker-compose.hermit.yml — anchor `HOST_UID: ${UID:-1000}` not found. Add `CLAUDE_CODE_VERSION: ${CLAUDE_CODE_VERSION:-latest}` manually under the `build.args:` block."

   Use the Edit tool with:

   `old_string`:
   ```
         HOST_UID: ${UID:-1000}
   ```

   `new_string`:
   ```
         HOST_UID: ${UID:-1000}
         CLAUDE_CODE_VERSION: ${CLAUDE_CODE_VERSION:-latest}
   ```

6. **Rebuild.** Tell the operator: "Run `.claude-code-hermit/bin/hermit-docker update` once to bake the version-pinned image. The first rebuild after this patch will reinstall claude-code (cache is invalidated by the new `RUN` command string); subsequent same-version runs reuse the cache as expected."

## [1.0.37] - 2026-05-11

### Added

- **`capability-brainstorm` skill (PROP-007)** — on-demand brainstorm synthesizing memory, capabilities, and codebase shape into at most 2 ideas; each routed through `proposal-triage` before becoming a PROP. Writes `compiled/capability-brainstorm-*.md` on non-empty runs.

### Changed

- **proposal IDs: collision-safe composite form (PROP-008)** — IDs now use `PROP-NNN-<slug>-HHMMSS` (ID = filename stem). Slug is up to 5 content words; `HHMMSS` prevents same-second collisions with an `a`/`b`/… suffix. Merge-safe: different machines produce different filenames.
- **`/proposal-act`: anchored prefix-glob resolution** — `accept PROP-009` resolves both legacy `PROP-009.md` and `PROP-009-*.md` without false positives. Disambiguation prompt shown on multi-match. Short-form `accept PROP-NNN` unchanged.
- **Legacy `PROP-NNN.md` files continue to work** — no migration, no rename. All resolution, listing, and cortex scripts accept both the old and new filename forms.

### Fixed

- **`knowledge-schema.md.template`: declare `review` type (PROP-011)** — `weekly-review` writes `type: review` artifacts but the template only declared `note`, causing a permanent Knowledge Health false positive on every freshly-hatched hermit.

### Files affected

| File | Change |
|------|--------|
| `skills/proposal-create/SKILL.md` | New ID generation (ID = filename stem `PROP-NNN-slug-HHMMSS`), slug algorithm with `proposal` fallback for empty slugs, collision `a`/`b`/… fallback |
| `skills/proposal-act/SKILL.md` | Anchored prefix-glob resolution algorithm with disambiguation prompt (two-pattern no-suffix glob; bracketed-suffix glob) |
| `docs/frontmatter-contract.md` | `id`/`proposal` field docs and proposal file pattern note both legacy and new forms |
| `docs/artifact-naming.md` | Proposals naming entry notes both legacy and new forms |
| `state-templates/CLAUDE-APPEND.md` | Quick-reference table updated to show the new proposal filename form |
| `plugins/claude-code-hermit/CLAUDE.md` | Repo-internal quick-reference bullet updated to show the new form |
| `skills/proposal-list/SKILL.md` | Example table updated to show new-format IDs alongside legacy |
| `state-templates/PROPOSAL.md.template` | `id:` placeholder updated to `PROP-NNN-slug-HHMMSS` |
| `agents/session-mgr.md` | `proposals_created` scan regex updated to capture full `PROP-NNN-slug-HHMMSS[a]` form |
| `scripts/reflect-precheck.js` | Widened proposal filename regex to accept new-format files |
| `scripts/build-cortex.js` | Widened proposal filename regex |
| `scripts/cortex-refresh-stage.js` | Widened proposal filename regex |
| `scripts/weekly-review.js` | Widened proposal filename regex |
| `scripts/validate-frontmatter.js` | Widened proposal filename regex |
| `scripts/doctor-check.js` | Widened proposal filename regex |
| `state-templates/knowledge-schema.md.template` | Added `- review:` bullet under `## Work Products` |
| `tests/run-scripts.sh` | Extended schema-empty fixture sed to also strip `- review:` starter bullet |

### Upgrade Instructions

The on-disk `knowledge-schema.md` is operator-editable, so apply this as a surgical, idempotent patch.

1. **File check.** If `.claude-code-hermit/knowledge-schema.md` does not exist, skip — `/hatch` has not been run for this project yet, and the new template already contains the entry for first-time setups.

2. **Idempotency check.** Read `.claude-code-hermit/knowledge-schema.md`. If the `## Work Products` section already contains a bullet starting with `- review:`, skip — patch already applied (or the operator already declared it themselves).

3. **Anchor check.** Confirm the file contains the unmodified `- note:` anchor line:

   ```
   - note: general-purpose compiled note. location: compiled/note-<slug>-<date>.md
   ```

   If this line is missing or customized, tell the operator: "Auto-patch failed — anchor not found. The `- note:` bullet in `knowledge-schema.md` has been customized. Add the following bullet manually under `## Work Products`: `- review: weekly review report from the weekly-review routine. location: compiled/review-weekly-<YYYY>-W<NN>.md`"

4. **Propose the patch.** Tell the operator what will be inserted and ask for confirmation:

   > "Patching `.claude-code-hermit/knowledge-schema.md` to declare the `review` type under `## Work Products` (fixes PROP-011 — Knowledge Health false positive after every weekly-review). Apply? [Yes / Skip]"

5. **On Yes — apply.** Use the Edit tool on `.claude-code-hermit/knowledge-schema.md` with:

   `old_string`:
   ```
   - note: general-purpose compiled note. location: compiled/note-<slug>-<date>.md
   ```

   `new_string`:
   ```
   - note: general-purpose compiled note. location: compiled/note-<slug>-<date>.md
   - review: weekly review report from the weekly-review routine. location: compiled/review-weekly-<YYYY>-W<NN>.md
   ```

## [1.0.36] - 2026-05-10

### Added

- **`hermit-start`: third-party channel plugins via `channels.<name>.marketplace` (#47)** — previously any non-official channel name appended a bare token that killed the launch process. Now falls back to `channels.<name>.marketplace` from `config.json`.
- **`cache-edit-guard.js`: warn on Edit/Write to marketplace cache (#48)** — edits to `.claude/plugins/cache/...` are no-ops at runtime. New PreToolUse hook warns with the canonical source path. Set `HERMIT_CACHE_GUARD=block` to hard-block instead.
- **`hermit-start`: marketplace pre-flight for `--channels` (PROP-005)** — validates each channel's marketplace token at boot; drops unregistered channels with a `[hermit] WARNING` rather than silently booting with no active channels. Fail-soft if `claude` is missing.
- **`hermit-start`: refuse channel names starting with `-` as bare args** — defense-in-depth; keeps validation local to `hermit-start` rather than relying on downstream `claude` flag parsing.

### Fixed

- **hook stderr: control-character sanitization (PROP-006)** — `tool_input`-derived values in `cache-edit-guard.js` and `channel-hook.js` could inject forged ANSI lines into terminal output. Added `scripts/lib/sanitize.js` (`safe()` replaces C0/DEL/C1 with `?`); routed all stderr interpolations through it.

### Files affected

| File | Change |
|------|--------|
| `scripts/hermit-start.py` | Marketplace pre-flight (PROP-005); third-party channel marketplace fallback (#47); reject bare args starting with `-` |
| `scripts/cache-edit-guard.js` | New PreToolUse hook (#48); routed `safe()` over `tool_input`-derived stderr (PROP-006) |
| `scripts/channel-hook.js` | Routed `safe()` over `chat_id` stderr interpolation (PROP-006) |
| `scripts/lib/sanitize.js` | New helper — replaces C0/DEL/C1 control chars with `?` for stderr-bound strings (PROP-006) |
| `hooks/hooks.json` | Registers `cache-edit-guard.js` for Edit\|Write (#48) |
| `skills/channel-setup/SKILL.md` | Install/enable/manual commands now resolve marketplace from config rather than hardcoding `claude-plugins-official` (#47) |
| `docs/config-reference.md` | Documents the new `channels.<name>.marketplace` field (#47) |
| `tests/run-contracts.py` | New `TestCacheEditGuard` (7 cases), `TestStderrSanitization` (4 cases), and 3 third-party-channel cases |
| `CLAUDE.md` | Dev note: `hermit-docker update` rebuilds with on-disk entrypoint, not the template |

### Upgrade Instructions

Run `/claude-code-hermit:hermit-evolve`. The evolve skill handles:

1. **No state-file changes required.** All four items in this release ship inside the plugin (`scripts/`, `hooks/`, `skills/`, `docs/`) — they take effect on the next boot without modifying anything under `.claude-code-hermit/`.

2. **No `config.json` changes required.** The new `channels.<name>.marketplace` field is purely additive and only consulted when an operator configures a non-built-in channel; existing discord/telegram/imessage configs need no edits.

3. **Optional: enable cache-edit hard block.** Operators who want Edit/Write attempts on `.claude/plugins/cache/...` to fail rather than warn can export `HERMIT_CACHE_GUARD=block` in their shell environment. Default behaviour (warn-only) is the safer choice for most operators.

**Note:** The PROP-005 marketplace pre-flight and PROP-006 stderr sanitization are silent on benign input — operators should see no behavioural difference unless they have a misconfigured channel marketplace or an adversarial tool_input value.

## [1.0.35] - 2026-05-09

### Fixed

- **Docker entrypoint: post-recovery sanity check + npm reinstall (#44)** — orphan-recovery renamed the binary but never verified it. When `claude --version` reports `0.0.0`, entrypoint now reinstalls from npm to self-heal without requiring `docker compose down && up`.

### Files affected

| File | Change |
|------|--------|
| `state-templates/docker/docker-entrypoint.hermit.sh.template` | Added post-recovery sanity-check block; reinstalls `claude` from npm when `claude --version` reports `0.0.0`; exits 1 with actionable message if npm itself fails |

### Upgrade Instructions

Docker users only — this patch updates the rendered `docker-entrypoint.hermit.sh`, which is baked into the container image at build time. Non-Docker (tmux/local) hermits are unaffected.

1. **File check.** If `docker-entrypoint.hermit.sh` does not exist at the project root, skip all steps — `/docker-setup` has not been run for this project yet, and the new template already contains the fix for first-time setups.

2. **Idempotency check.** Read `docker-entrypoint.hermit.sh` at the project root. If it already contains the string `claude binary is non-functional`, skip all steps — the patch is already applied.

3. **Propose the patch.** Tell the operator what will be inserted and ask for confirmation:

   > "Patching `docker-entrypoint.hermit.sh` to add a self-heal block after the orphan-recovery code (fixes #44 — corrupted `claude` binary after mid-install self-update). The block is inserted immediately after the orphan-recovery `fi`, before `--- 0. Wait for auth credentials ---`. Apply? [Yes / Skip]"

4. **On Yes — apply.** Use the Edit tool on `docker-entrypoint.hermit.sh` with:

   `old_string` (closing lines of the orphan-recovery block + blank line + next section header — unique since v1.0.20):
   ```
     fi
   fi

   # --- 0. Wait for auth credentials ---
   ```

   `new_string`:
   ```
     fi
   fi

   # Sanity-check: if the recovered (or pre-existing) binary reports 0.0.0, the
   # orphan was non-functional. Reinstall from npm to self-heal so a `restart`
   # unwedges the container without needing `docker compose down && up -d`.
   # Two-step form (capture then default) avoids the empty-vs-"0.0.0" pitfall
   # under set -euo pipefail when head -1 exits 0 on empty input.
   _CLAUDE_VER="$(claude --version 2>/dev/null | grep -oP '[0-9.]+' | head -1 || true)"
   _CLAUDE_VER="${_CLAUDE_VER:-0.0.0}"
   if [ "$_CLAUDE_VER" = "0.0.0" ]; then
     echo "[docker-entrypoint] claude binary is non-functional (version: 0.0.0) — reinstalling from npm..."
     if npm install -g @anthropic-ai/claude-code; then
       _CLAUDE_VER="$(claude --version 2>/dev/null | grep -oP '[0-9.]+' | head -1 || true)"
       _CLAUDE_VER="${_CLAUDE_VER:-0.0.0}"
       if [ "$_CLAUDE_VER" = "0.0.0" ]; then
         echo "[docker-entrypoint] ERROR: claude still reports 0.0.0 after reinstall."
         echo "[docker-entrypoint] Recreate the container: .claude-code-hermit/bin/hermit-docker down && .claude-code-hermit/bin/hermit-docker up"
         exit 1
       fi
       echo "[docker-entrypoint] Reinstall succeeded (v${_CLAUDE_VER})."
     else
       echo "[docker-entrypoint] ERROR: npm install failed — cannot recover the claude binary."
       echo "[docker-entrypoint] Recreate the container: .claude-code-hermit/bin/hermit-docker down && .claude-code-hermit/bin/hermit-docker up"
       exit 1
     fi
   fi
   unset _CLAUDE_VER

   # --- 0. Wait for auth credentials ---
   ```

   If the anchor does not match (operator has customized this file), tell them: "Auto-patch failed — anchor not found. Re-run `/claude-code-hermit:docker-setup` and choose 'Yes — back up' when prompted, or apply the block manually between the orphan-recovery `fi` and the `--- 0. Wait for auth credentials ---` comment."

5. **Rebuild the container.** Run `.claude-code-hermit/bin/hermit-docker update`. The patched entrypoint is baked into the image on rebuild.

## [1.0.34] - 2026-05-08

### Fixed

- **plugin detection: scoped to project/local only across five skills** — bare `scope == "local"` predicate leaked plugins from sibling repos. All five sites now apply `enabled == true AND (scope == "project" OR scope == "local") AND projectPath == cwd`. Disk glob replaced with `claude plugin list --json`.

- **`docker.recommended_plugins.marketplace`: normalized to `org/repo`** — entrypoint now resolves canonical marketplace name at boot via `claude plugin marketplace list --json`. Pre-v1.0.34 literal-name entries get one warning and are skipped; re-run `/docker-setup` to rebuild cleanly.

### Files affected

| File | Change |
|------|--------|
| `skills/hatch/SKILL.md` | Step 1.5 uses `claude plugin list --json` + filter; stash carries `installPath`; downstream steps read from `installPath` |
| `skills/docker-setup/SKILL.md` | Step 7b.1 filter tightened; dedupe rule added; Step 7b.3/5/10 updated to write `marketplace` as `org/repo` only |
| `skills/docker-security/SKILL.md` | Step 3a filter tightened; `path` field → `installPath` |
| `skills/hermit-evolve/SKILL.md` | Step 7 replaces disk glob with `claude plugin list --json` + filter; reads from `installPath` |
| `skills/channel-setup/SKILL.md` | Step 3 replaces unstructured grep with JSON + filter; adds `marketplace_name` gate; adds explicit `plugin enable` |
| `skills/hermit-settings/SKILL.md` | Display renders `org/repo`; `add` action writes `marketplace` as `org/repo` with dedupe-by-(plugin, marketplace) |
| `state-templates/docker/docker-entrypoint.hermit.sh.template` | Install loop resolves marketplace name from `claude plugin marketplace list --json` once at start; single warn-and-skip path for pre-v1.0.34 legacy entries; `❯` prefix match for already-installed guard |
| `docs/config-reference.md` | `recommended_plugins` schema documents `marketplace` as `org/repo` (canonical name resolved at boot); example entry updated |
| `docs/recommended-plugins.md` | Config format table documents `marketplace` as `org/repo` |

### Upgrade Instructions

Run `/claude-code-hermit:hermit-evolve`. The evolve skill handles:

1. **Refresh skill spec** — the updated skill text loads on the next invocation of each affected skill. No state files or templates change.

If you use Docker:

2. **Rebuild your container** — run `.claude-code-hermit/bin/hermit-docker update`. The new entrypoint resolves marketplace names at boot from the CLI's source of truth (`claude plugin marketplace list --json`) instead of guessing from the repo basename.

3. **Re-run `/claude-code-hermit:docker-setup` once** — only required if your existing `docker.recommended_plugins` has any entry where `marketplace` is not an `org/repo` (the most common case is pre-v1.0.34 official entries that store the literal `"claude-plugins-official"`). The new entrypoint warns once at boot and skips such entries; re-running `/docker-setup` rebuilds the entries cleanly from the current host plugin list. Skip this step if every `marketplace` value in your config already contains a `/`.

## [1.0.33] - 2026-05-07

### Changed

- **Right-sized thinking budgets across `reflect`, `reflection-judge`, and `proposal-create`** — `reflection-judge.md` drops `ultrathink` (uses `effort: medium`); `reflect/SKILL.md` downgrades to `think hard` (~10K vs ~32K); `proposal-create/SKILL.md` drops keyword from body-writing, downgrades to `think hard` for capability-plan branch. Reduces cost without compromising quality.

### Files affected

| File | Change |
|------|--------|
| `agents/reflection-judge.md` | Replaces `ultrathink` line with plain "reason carefully" instruction |
| `skills/reflect/SKILL.md` | Downgrades `ultrathink` to `think hard` |
| `skills/proposal-create/SKILL.md` | Drops `ultrathink` from body-writing step; downgrades to `think hard` for capability-plan branch |

### Upgrade Instructions

No upgrade actions required. Skill and agent text changes propagate via plugin update — no `config.json`, `runtime.json`, `state-templates/`, or operator-editable file changes.

## [1.0.32] - 2026-05-07

### Added

- **memory-first for suggestions** — suggestion-generating skills and triage/judge subagents now consult auto-memory before declaring a finding novel; suppress with `covered-by-memory` if already covered. Acting skills (`session-close`, `proposal-act`, etc.) exempt.

### Changed

- **`proposal-triage`**: adds Step 1.5 memory cross-reference; new `covered-by-memory` suppress code + `memory_ref` metadata field.
- **`reflection-judge`**: adds §1.5 memory cross-check for all Evidence Source types; `[memory: <filename>]` breadcrumb in suppress reason.

### Files affected

| File | Change |
|------|--------|
| `agents/proposal-triage.md` | Adds Step 1.5 memory cross-reference, `covered-by-memory` code, `memory_ref` metadata |
| `agents/reflection-judge.md` | Adds §1.5 memory cross-check, `covered-by-memory` code, `[memory:]` breadcrumb |
| `state-templates/CLAUDE-APPEND.md` | Adds Memory-first paragraph in Knowledge Discipline section |

### Upgrade Instructions

Run `/claude-code-hermit:hermit-evolve`. The evolve skill executes:

1. **Refresh the CLAUDE-APPEND anchored block.** Step 6 reads `state-templates/CLAUDE-APPEND.md` and replaces the marker→EOF block in the project's `CLAUDE.md`. The new Memory-first paragraph propagates idempotently.

No `config.json` changes required.

## [1.0.31] - 2026-05-07

### Fixed

- **Remove quick-task gate from session-triggered scheduled checks** — the "no tasks created, under 5 minutes" skip caused `revise-claude-md` (when installed) to miss short declarative operator corrections (e.g. "from now on never X"), which are exactly the sessions with the highest-signal CLAUDE.md updates.

### Changed

- **`reflect`: operator-value self-check now covers micro-proposals** — dismiss-ratio tally counts `micro-resolved` events, distinguishing `rejected` (noise) from `expired` (timing).
- **`runtime.json` schema gains `last_shell_snapshot_at`** (ISO or null). Owned by `archive-shell.js`. Used for the 24h dedup gate on routine SHELL.md snapshots.

### Added

- **guild/group channel setup in `docker-setup` and `channel-setup`** — after DM pairing, optionally register Discord server channels or Telegram group chats via `/<plugin>:access group add`, each with its own `requireMention` choice.
- **Reflect lessons-to-memory pass.** Reflect's existing Memory update outcome now explicitly covers durable lessons (operator-stated rules, preferences that recurred, decision rationales) alongside sub-threshold patterns. Uses Claude's trained auto-memory flow ("remember it"). No new infrastructure — extension of existing reflect outcomes.
- **mechanical SHELL snapshot** — when SHELL.md exceeds 400 lines and ≥24h has elapsed, `reflect-precheck.js` snapshots it to `sessions/snapshots/` and compacts the Progress Log to a pointer. Pure JS, no LLM; bounds always-on growth without operator action.
- **`scripts/archive-shell.js`**: new helper — snapshots SHELL.md, compacts the Progress Log, updates `runtime.json.last_shell_snapshot_at`. Atomic `link()` doubles as the concurrency lock.
- **`reflect-precheck`: `phases.archive_due` gated on `archiveTaken`** — omitted from phases JSON on archive failure so the LLM doesn't reason about a snapshot that didn't land.

### Upgrade Instructions

Run `/claude-code-hermit:hermit-evolve`. The evolve skill executes:

1. **Add `last_shell_snapshot_at` to `runtime.json`.** Read `.claude-code-hermit/state/runtime.json`. If the file exists and does not contain the key `last_shell_snapshot_at`, add `"last_shell_snapshot_at": null` and write back atomically (temp file + rename). Idempotent.
2. **Add `archive-shell.js` permission to project settings.** Read `.claude/settings.json` (or `.claude/settings.local.json`, whichever holds the plugin allowlist). If `permissions.allow` does not contain `Bash(node */scripts/archive-shell.js*)`, append it. Idempotent.

No routine changes. No `config.json` changes. `/session-close` behavior unchanged.

## [1.0.30] - 2026-05-05

### Removed

- **`/docker-security` Prompt 2 (read-only root filesystem)** — removed; `read_only: true` caused 401 `Invalid authentication credentials` after token expiry (~8h) because credential-refresh writes failed silently. Remaining three toggles (LAN containment, resource bounds, audit log) unaffected.

### Fixed

- **`hermit-start`: bootstrap now passed as `claude` argv** — eliminates a race where `tmux send-keys` bootstraps were silently swallowed on slow boots before the TUI was ready.

- **`hermit-docker restart`: fails under security overlay** — `compose restart` ignored `depends_on`, causing the hermit to rejoin the netguard netns while it was down. Fixed: `restart` now does `down && up -d`.

- **`/docker-setup` Step 8: `ackReaction` race fixed** — `set ackReaction` was sent before the container LLM could write `access.json`. Replaced with a direct host-side edit of the bind-mounted `access.json`.

- **PR-review polish** — `hermit-docker restart` rejects service args; bootstrap only fires in always-on/tmux mode; Step 8 ackReaction uses `Read`+`Edit` instead of overwriting; `/docker-security` step numbering fixed.

### Upgrade Instructions

Run `/claude-code-hermit:hermit-evolve`. The evolve skill handles:

1. **Delete `docker.security.read_only` from `.claude-code-hermit/config.json`** — the key is now inert and surfaces as a stale `/hermit-doctor` warning.

**Note:** If that key had `enabled: true`, the container is still running with `read_only: true`. Re-run `/claude-code-hermit:docker-security`, answer through the remaining prompts, then `hermit-docker down && hermit-docker up`. Existing `claude-config` volume and credentials are preserved.

No other `config.json` changes required.

## [1.0.29] - 2026-05-04

### Added

- **`/hatch` Quick mode** — 5-turn fast path (identity, sign-off/deployment/channel, OPERATOR.md, confirm) that auto-chains to `/docker-setup quick`, `/channel-setup`, or `/session`. Advanced wizard unchanged; re-init forces Advanced.
- **`/docker-setup quick` positional arg** — skips the setup-mode gate; applies safe defaults (OAuth, bridge, auto-mirror SAFE plugins, auto-accept apt). Third-party plugins still confirmed per-entry; security non-negotiables preserved.
- **`tests/test-template-skill-sync.sh`** — contract test asserting every top-level key in `config.json.template` is referenced in `hatch/SKILL.md`; prevents silent field drops when the template gains a new key.

### Changed

- **`/channel-setup` Step 5: collapsed to single 3-option question** — `Already paired` / `Ready to pair` / `Skip`, saving one round trip and removing a silent-skip bug.
- **`/hatch` Step 5: overlay-on-template refactor** — reads `config.json.template` as base instead of duplicating an inline default object that had drifted (missing 9 fields).
- **`/hatch` resequenced** — setup-mode gate moved before file writes; hermit detection split into silent pre-flight and an activation prompt (Advanced only; Quick handles it in Turn 1).
- **`/docker-setup` Step 4: template rendering deferred to new Step 7b.6** — renders Dockerfile, compose, and entrypoint after plugin + apt-package resolution so `{{PACKAGES_BLOCK}}` substitution uses the finalized package set.

### Fixed

- **`/docker-security`: DNS containment hardening** — four bugs: missing `no-resolv` caused NXDOMAIN blocks to time out; `claude.ai`/`claude.com` absent from allowlist; verifier misclassified timeouts; RO-write canary wrote to read-only root path. Verifier now uses `mktemp + trap EXIT`.
- **`/docker-security` step 7c: force `--no-cache` netguard build** — `hermit-docker up` reused cached layers, silently preserving stale images; wizard now runs explicit `--no-cache` build.
- **`/docker-security` tune instruction: `hermit-docker down && hermit-docker up`** — `restart hermit-netguard` left hermit with stale resolver state; updated across SKILL.md, docs, and template.
- **`tests/test-docker-security-templates.sh`: 12 new assertions** — covers `no-resolv`, OAuth domains, DNS-block timeout, canary path, `--no-cache` rebuild, tune instruction.
- **`tests/test-template-skill-sync.sh`: explicit `exit 1` + cached skill read** — added `exit 1` after `print_results`; cached `SKILL_CONTENT` to avoid per-key `grep` subprocess.
- **`hatch/SKILL.md` Phase 6 trailing comma.** The `AskUserQuestion` block had a trailing comma after the last question object before `]` — an invalid JSON payload that any strict executor would reject.
- **`hatch/SKILL.md` Quick defaults table: corrected cross-references.** Source column used "Step 4 Phase X" labels that don't exist in the Quick branch (Quick never runs Step 4). Changed to "Advanced Phase X equivalent".
- **`docker-setup/SKILL.md`: removed sub-step number collision.** "3. Project dependencies:" inside Step 2's body shadowed the top-level `### 3.` heading — renamed to `**Project dependencies scan:**`.
- **`channel-setup/SKILL.md` Step 5: removed redundant parenthetical** from the question text (restart instructions already appear in the prose immediately above).
- **`channel-setup/SKILL.md` Step 6 → 6b: added routing.** Step 6 had no "continue to step 6b" exit line — a model executing the skill could skip 6b entirely.
- **`hatch/SKILL.md` Quick Turn 5: removed stale CHANGELOG cross-reference.** The "full mock in CHANGELOG `[Unreleased]`" pointer was inaccurate (the section contains a description, not a full mock) and would go stale after release. The inline template block is self-contained.

### Verification

End-to-end manual verification (run before release):

- Fresh project, Quick + Docker + Discord (most common path): `/hatch` → pick Quick → answer 5 batched turns → confirm → auto-chains to `/docker-setup quick`. Verify `.claude-code-hermit/` is NOT created before the gate is answered (ls before answering). Total: ≤14 round trips end-to-end.
- Fresh project, Advanced unchanged: `/hatch` → pick Advanced → expect every current question still asked, every file still written.
- Re-init guard: in a project with existing `.claude-code-hermit/`, `/hatch` → pick re-initialize → verify the setup-mode gate is NOT shown; Advanced wizard runs directly. OPERATOR.md preserved unless operator chose regenerate.
- Customize escape hatch: in Quick at the confirm screen, pick Customize → expect Advanced wizard runs from scratch with no prefill.
- Channel-setup Step 5: `/channel-setup` after Quick hatch → expect single 3-option question (Already paired / Ready to pair / Skip).
- Docker template render ordering: in Advanced mode, choose project apt packages that differ from defaults → verify rendered `Dockerfile.hermit` `{{PACKAGES_BLOCK}}` substitution matches the FINAL `docker.packages` array.
- Security regression checks (Docker Quick mode): per-plugin yes/no still asked for any third-party marketplace plugin (not bulk-accepted); validator regex still rejects malformed `org/repo`; public-repo pre-flight curl still gates private GitHub repos.
- Existing tests: `cd plugins/claude-code-hermit && bash tests/run-all.sh` → all suites pass including the new `test-template-skill-sync.sh` (28 assertions).

### Files affected

| File | Change |
|------|--------|
| `skills/hatch/SKILL.md` | Resequence (gate before writes), split silent detection from activation prompt, replace inline default JSON with template-overlay algorithm, fix scheduled_checks accounting, add Quick Branch section (5 turns + confirm + auto-chain), add Quick-mode adjustment to Step 10 report |
| `skills/docker-setup/SKILL.md` | Add Step 1.5 setup-mode gate (positional `quick` arg supported), apply Quick defaults silently throughout (auth, network, SAFE plugin mirror, apt auto-accept, build-now), add Step 7b.6 deferred template rendering (fixes latent `{{PACKAGES_BLOCK}}` sequencing concern; applies to both modes) |
| `skills/channel-setup/SKILL.md` | Step 5 batched question collapsed to single 3-option `AskUserQuestion` |
| `skills/docker-security/SKILL.md` | DNS-block verifier: timeout + exit-code 124 classification + mktemp/trap; RO-write canary path; --no-cache rebuild step; tune instruction updated |
| `docs/docker-security.md` | Tune instruction: `hermit-docker down && hermit-docker up`; mDNS wording simplified |
| `state-templates/docker/security/dnsmasq.allowlist.template` | Add `no-resolv`; add `claude.ai` and `claude.com`; update catchall comment |
| `tests/test-template-skill-sync.sh` | New: monorepo-internal contract test for template ↔ hatch sync |
| `tests/run-all.sh` | Wire new test into the suite |
| `tests/test-docker-security-templates.sh` | 12 new assertions: no-resolv, OAuth domains, DNS-block timeout, canary path, --no-cache rebuild, tune instruction |

### Upgrade Instructions

Run `/claude-code-hermit:hermit-evolve`. The evolve skill handles:

1. **Skip if no docker-security overlay** — if `docker-compose.security.yml` does not exist at the project root, steps 2–4 are no-ops.
2. **Re-render the security overlay** — run `/claude-code-hermit:docker-security` and accept the same toggles already enabled. The wizard re-renders `dnsmasq.allowlist` with `no-resolv` and the new `claude.ai`/`claude.com` entries, and forces a `--no-cache` netguard rebuild.
3. **Restart hermit** — run `hermit-docker down && hermit-docker up` after the wizard completes (the wizard prompts for this).
4. **Verify** — `/claude-code-hermit:docker-security` verification block should show `DNS-block: OK` (NXDOMAIN, not timeout) and `DNS-allow: OK`.

No `config.json` changes required.

## [1.0.28] - 2026-05-04

### Fixed

- **docker-security netguard: four rootless Docker startup bugs fixed** — dropped unwritable `state:/var/log/netguard` bind mount (logs to stdout now); replaced `$!` PID capture with `pgrep dnsmasq`; added `NET_BIND_SERVICE`/`SETUID`/`SETGID` caps; added `start_period: 5s` + `interval: 10s` to healthcheck.
- **docker-security netguard entrypoint: `--log-facility=-`** — routes dnsmasq query logs to stdout instead of silently dropping to syslog (no syslogd in Alpine).

### Files affected

| File | Change |
|------|--------|
| `state-templates/docker/security/netguard-entrypoint.sh.template` | Drop tee + file logging + `$!` PID capture; add `--log-facility=-`; replace `kill -0` with `pgrep dnsmasq` |
| `skills/docker-security/SKILL.md` | cap_add list (4 caps), drop `state:/var/log/netguard` volume, healthcheck `start_period: 5s` + `interval: 10s` |
| `docs/docker-security.md` | DNS tuning section: stdout instead of `state/dns.log`; correct "blocked-by-policy" wording |
| `tests/test-docker-security-templates.sh` | New: contract test for entrypoint + SKILL.md regression patterns |

### Upgrade Instructions

1. **Skip if no docker-security overlay.** If `docker-compose.security.yml` does not exist at the project root, this entry is a no-op.
2. **Re-render the overlay.** Run `/claude-code-hermit:docker-security` and accept the same toggles already enabled — the wizard re-renders the overlay with the corrected `cap_add` list, no `state:/var/log/netguard` bind, and the new healthcheck.
3. **Rebuild the netguard image.** Run `bin/hermit-docker down && bin/hermit-docker up`. Compose rebuilds `hermit-netguard` because the entrypoint template content changed.
4. **Verify.** `docker compose -f docker-compose.hermit.yml -f docker-compose.security.yml ps` should show `hermit-netguard` as `healthy` within ~10s.

No `config.json` changes required.

## [1.0.27] - 2026-05-04

### Fixed
- **docker-security: port-conflict guard** — detect operator-added `ports:` on `hermit` and offer to move them to `hermit-netguard` (the netns owner) when LAN containment is enabled. Wizard hard-gates `hermit-docker up` until the operator removes the base `ports:` block, preventing the `conflicting options: port publishing and the container type network mode` error.
- **docker-security: auto-pick free subnet** — scan all host Docker networks and walk `172.28-31` then `10.244-247` before prompting, instead of hardcoding `172.28.0.0/24`. Eliminates `Pool overlaps with other one on this address space` on hosts with multiple hermit projects or colliding networks.
- **docker-security: `publish_ports` survives reruns** — operators who removed the base `ports:` block on a previous run no longer lose the netguard publish mapping on the next wizard pass.
- **docker-security: early daemon guard** — `docker info` preflight now exits with a clear message instead of cryptic subprocess errors when the Docker daemon is unreachable.

### Added
- **hermit-doctor: expanded docker-security check** — now flags subnet collisions (`warn`) and hermit-side `ports:` blocks that conflict with LAN containment (`fail`). Daemon-unreachable degrades to `warn` rather than `fail`. Existing 8-check structure unchanged.
- **Container guard for host-only skills** — `docker-setup`, `docker-security`, `hermit-takeover`, and `hermit-hand-back` each detect `/.dockerenv` / `/run/.containerenv` at step 0 and refuse to run inside the container, printing a redirect to the correct vantage point. Prevents partial-success file writes that corrupt host scaffolding when invoked from inside the hermit container.

### Changed
- **docker-security: design rationale relocated** — limitations, DNS allowlist tuning, and reversal prose moved from the skill body into `docs/docker-security.md`. SKILL.md trimmed from 572 → 552 lines; a pointer to the docs URL is the only reference kept in the skill.

### Files affected

| File | Change |
|------|--------|
| `skills/docker-security/SKILL.md` | Container guard, port-conflict + subnet fix, rationale relocated |
| `skills/docker-setup/SKILL.md` | Container guard at step 0 |
| `skills/hermit-takeover/SKILL.md` | Container guard at step 0 |
| `skills/hermit-hand-back/SKILL.md` | Container guard at step 0 |
| `scripts/doctor-check.js` | docker-security check: subnet collision + ports-conflict branches |
| `docs/docker-security.md` | New: design rationale, limitations, DNS tuning, reversal guide |
| `tests/run-hooks.sh` | New docker-security check test cases |

### Upgrade Instructions

1. Run `/claude-code-hermit:hermit-doctor`.
2. If the `docker-security` check surfaces a WARN or FAIL, run `/claude-code-hermit:docker-security` and accept the defaults.
3. Run `hermit-docker down && hermit-docker up`.

**Note:** Operators without a docker-security overlay need no action.

No `config.json` changes required.

## [1.0.26] - 2026-05-03

### Fixed

- **hermit-routines: shift routine schedules from `config.timezone` to machine timezone** before CronCreate — uses new `scripts/cron-tz-shift.js` helper (IANA zones, fractional offsets, DOW wrap, fail-open).
- **`hermit-doctor` `docker-security` check: overlay path anchored to `hermitDir`** — was resolving relative to `process.cwd()`, causing false "not configured" when doctor ran from a different CWD.

### Added

- **Container hardening** — docker-compose template adds `no-new-privileges:true`, `cap_drop: ALL`, and `pids_limit: 2048` for `bypassPermissions` containers.
- **`/claude-code-hermit:docker-security` advanced wizard** — opt-in overlay (`docker-compose.security.yml`) with four toggles: LAN containment + DNS sidecar (`hermit-netguard`), read-only root filesystem, resource bounds, boot-time audit log. Fleet-aware: reads `## Docker network requirements` from sibling plugin manifests.
- **`hermit-doctor` eighth check: `docker-security`** — flags drift between `docker.security.*` posture in `config.json` and presence of `docker-compose.security.yml`.
- **`hermit-docker` wrapper: pins `SERVICE="hermit"`** — avoids ambiguity once security overlay adds `hermit-netguard`; auto-chains the overlay when present.
- **Per-fleet-plugin contract: `## Docker network requirements`** — plugins declare needed domains/LAN endpoints; `/docker-security` wizard offers per-entry confirmation.

### Files affected

| File | Change |
|------|--------|
| `scripts/cron-tz-shift.js` | New: shifts 5-field cron between IANA timezones |
| `scripts/lib/time.js` | Extended `currentHHMM` to accept optional `ref` date |
| `skills/hermit-routines/SKILL.md` | `load` now invokes `cron-tz-shift.js` per routine |
| `skills/hatch/SKILL.md` | Added `cron-tz-shift.js` to Bash allowlist |
| `skills/hermit-evolve/SKILL.md` | Added `cron-tz-shift.js` to required node entries list |
| `skills/smoke-test/SKILL.md` | Added step 4b: helper availability check |
| `skills/docker-security/SKILL.md` | New: opt-in hardening wizard (LAN, ro-fs, resource bounds, audit log) |
| `scripts/doctor-check.js` | Eighth check: `docker-security` posture vs overlay drift |
| `state-templates/bin/hermit-docker` | Pins `SERVICE=hermit`, chains security overlay when present |
| `docs/config-reference.md` | Updated `routines.schedule` TZ description |
| `tests/cron-tz-shift.test.sh` | New: 20 deterministic cron-shift tests |
| `tests/run-hooks.sh` | Updated doctor-check test: 7 → 8 checks |

### Upgrade Instructions

Run `/claude-code-hermit:hermit-evolve`. The evolve skill handles:

1. **Add `cron-tz-shift.js` to the Bash allowlist.** Add `Bash(node */scripts/cron-tz-shift.js*)` to `.claude/settings.json` `permissions.allow` alongside the other `node */scripts/...` entries.

2. **Re-register routines.** Run `/claude-code-hermit:hermit-routines load` to apply the timezone shift to existing CronCreate registrations.

3. **Skip if no Docker scaffolding.** If `docker-compose.hermit.yml` does not exist at the project root, this entry is a no-op.

4. **Ask the operator for consent.** Use `AskUserQuestion` (header: `"Container hardening"`):
   - **Yes — apply hardening** (Recommended): proceed to step 5.
   - **Skip**: do nothing for this entry; continue with the rest of evolve.

   Hardening is opt-in because operators may have customized their compose for special workloads (privileged ports, larger PID needs).

5. **Idempotency check.** Read the rendered `docker-compose.hermit.yml`. If it contains the literal string `no-new-privileges`, skip — already migrated. Tell the operator: "Container hardening already in place, skipping." (If it contains `cap_drop` or `pids_limit` but not `no-new-privileges`, a partial previous attempt may have stalled — show the operator the current file and ask them to patch it manually or re-run `/docker-setup` with backup.)

6. **Locate the insertion point.** Find the `hermit:` service block. Within it, locate the `restart:` line at 4-space indent. If either is missing or the structure is ambiguous (e.g. service renamed, restart removed, indentation drift), do NOT attempt the patch — fall through to step 8.

7. **Patch.** Insert the following three stanzas immediately before the `restart:` line, indented to match adjacent service keys (4 spaces in the standard template). Show the diff to the operator and ask for final confirmation before writing:

   ```yaml
   cap_drop:
     - ALL
   security_opt:
     - no-new-privileges:true
   pids_limit: 2048
   ```

   *(Shown unindented for clarity — in the file each line gets 4 leading spaces, same level as `restart:` and `stop_grace_period:`.)*

   On confirm: write the file. Then jump to step 9.

8. **Fallback for unrecognized structure.** Tell the operator:

   > "Your `docker-compose.hermit.yml` has been customized — I can't patch it safely. Re-run `/claude-code-hermit:docker-setup` and choose **'Yes — back up'** when prompted to regenerate it cleanly with the new hardening defaults. Your customizations will be preserved in `docker-backup/` so you can re-apply them on top."

   No further action.

9. **Container recreation reminder (CRITICAL).** Tell the operator:

   > "**`hermit-docker restart` is NOT enough** — Docker only applies `cap_drop`, `security_opt`, and `pids_limit` at container creation, not on restart. To activate the new settings, run:
   >
   > ```
   > .claude-code-hermit/bin/hermit-docker down
   > .claude-code-hermit/bin/hermit-docker up
   > ```
   >
   > The named config volume preserves credentials, plugins, and onboarding state."

No `config.json` changes required.

10. **Inform the operator about the new advanced wizard (no automatic action).** After steps 1–9 complete (or are skipped), tell them:

   > "v1.0.26 also ships an opt-in advanced wizard, `/claude-code-hermit:docker-security`, for stronger isolation than the baseline. The headline gain is blocking your container from reaching your local network — meaningful if you run hermit on a home or office machine alongside HA, NAS, printer, etc. Run `/claude-code-hermit:docker-security` when you're ready; nothing changes until you do. See [`docs/docker-security.md`](docs/docker-security.md) for the full toggle reference and documented limitations."

   This step is informational only — the wizard is opt-in by design, never invoked automatically by `/hermit-evolve`.

## [1.0.25] - 2026-05-01

### Changed

- **`reflect`, `cortex-sync`: delegate recon-heavy scans to `Explore` subagent** — proposal scan, resolution-check session fetch, and tag-vocabulary scan return compact summaries instead of raw file contents; orchestrator falls back to inline `Read` for truncated files.
- **`proposal-triage`: extended evidence scope, richer verdict output** — adds session cross-reference, OPERATOR.md alignment check, and compiled-artifact overlap scan before the three-condition gate; `SUPPRESS` verdicts include quoted excerpts; `maxTurns` 8 → 14.
- **`reflect`, `reflect-scheduled-checks`, `proposal-create`: triage verdict counters** — all three callers append `triage-verdict` events to `proposal-metrics.jsonl`; `reflect` Component Health flags if `SUPPRESS` dominates `CREATE` at 2×.
- **`channel-setup` and `docker-setup`: default `ackReaction` to 👀 on first pair** — freshly paired hermits had no inbound emoji feedback; sets 👀 unless already customized.
- **Recommended plugins: added `feature-dev` (Anthropic-official)** — surfaces in `/hatch` Phase 4 for opt-in install.

### Fixed

- **`proposal-triage` agent: YAML frontmatter parse error** — the `description` field contained a bare colon-space sequence (`<code>: <reason>`) which YAML interprets as a key-value separator, causing all frontmatter fields (model, effort, maxTurns, tools, disallowedTools) to be silently dropped at load time. Quoted the description string to fix the parse error.

### Files affected

| File | Change |
|------|--------|
| `agents/proposal-triage.md` | Extended evidence scope, richer verdict output, YAML fix |
| `skills/reflect/SKILL.md` | Explore delegation; triage verdict counters |
| `skills/cortex-sync/SKILL.md` | Explore delegation; manifest flag fix |
| `skills/reflect-scheduled-checks/SKILL.md` | Triage verdict counters |
| `skills/proposal-create/SKILL.md` | Triage verdict counters |
| `skills/channel-setup/SKILL.md` | Default ackReaction to 👀 on first pair |
| `skills/docker-setup/SKILL.md` | Default ackReaction to 👀; feature-dev recommended plugin |
| `skills/hatch/SKILL.md` | feature-dev opt-in in Phase 4 |
| `docs/recommended-plugins.md` | Added feature-dev entry |

### Upgrade Instructions

For each entry in `.claude-code-hermit/config.json` `channels` where `enabled !== false` and the channel name is `discord` or `telegram`:

1. Resolve the `access.json` path:
   - Try `channels.<channel>.state_dir/access.json` (relative paths anchored at project root).
   - Fall back to `~/.claude/channels/<channel>/access.json`.
2. If the file does not exist: skip this channel — defaults will be applied next time `/claude-code-hermit:channel-setup` or `/claude-code-hermit:docker-setup` runs.
3. Parse the JSON. If `ackReaction` is missing or set to `""`:
   - Set `ackReaction` to `"👀"` and write the file back, preserving every other key exactly and matching existing formatting (typically 2-space indent, trailing newline).
   - Log: "Set default `ackReaction` (👀) for `<channel>`."
4. If `ackReaction` is already a non-empty string: skip — preserve operator customization.

Use direct JSON edit, not the slash command. The setup skills route through `/<channel>:access set ackReaction` with a state-dir hint because they run during interactive pairing; for the migration, a direct edit is simpler for batch backfill across multiple channels and doesn't depend on channel plugins being loaded at upgrade time.

**Offer `feature-dev` install for existing hermits.** Read `config.json`. If `docker.recommended_plugins` exists and contains `"feature-dev"`, skip silently — already adopted. If `docker.recommended_plugins` is absent (tmux/local hermit without docker setup), run `claude plugin list` — if `feature-dev` appears, skip silently.

Otherwise, ask the operator with `AskUserQuestion` (header: "feature-dev"):

- Question: "claude-code-hermit's recommended-plugin set now includes `feature-dev` (Anthropic-official) — orchestrated 7-phase implementation workflow (`/feature-dev:feature-dev`) for designing, exploring, and reviewing code changes. Install it?"
- Options: **Yes — install** (default) / **No — skip**

On **Yes**: run `claude plugin install feature-dev@claude-plugins-official --scope project` (idempotent if already installed). If `config.json` has a `docker.recommended_plugins` array, append `"feature-dev"` to it and write the file back, preserving existing formatting (2-space indent, trailing newline). If the key is absent (tmux/local hermits without docker setup), skip the config.json edit. Log: "Installed `feature-dev`@`claude-plugins-official`."

On **No**: skip — operator can install later via `/claude-code-hermit:hermit-settings` or by re-running `/claude-code-hermit:hatch`.

## [1.0.24] - 2026-04-29

### Added

- **Heartbeat and reflect precheck scripts** — `scripts/heartbeat-precheck.js` emits `SKIP`/`OK`/`EVALUATE` before each tick; `scripts/reflect-precheck.js` determines due phases and owns the `EMPTY` audit trail; both zero-dependency, fail-open. `heartbeat/SKILL.md` thinned 209 → 94 lines; detail extracted to `skills/heartbeat/reference.md` loaded on demand.

- **`GITIGNORE-APPEND.txt`: complete local-scope coverage** — added `templates/`, `bin/`, `HEARTBEAT.md`, `IDLE-TASKS.md`, `knowledge-schema.md`, and `.claude.local/` (channel state dir). Previously hatch's gitignore append left bin/ and operator-editable files unignored, so `.claude-code-hermit/` kept showing as untracked in projects with local scope.

- **`hatch`: operator consent before `.gitignore` writes** — step 7 now shows the entries to be appended and waits for `AskUserQuestion` confirmation before modifying or creating the project `.gitignore`.

### Removed

- **`scope` config field and `project` scope removed** — hermit state is now always gitignored; `project` scope risked committing LLM-generated artifacts (potentially containing credentials) to git history. `GITIGNORE-APPEND-PROJECT.txt` deleted.

### Fixed

- **`channel-setup`: inject `<CHANNEL>_STATE_DIR` into `settings.local.json`** — without `DISCORD_STATE_DIR`/`TELEGRAM_STATE_DIR` in the session env, channel servers ignored `state_dir` and defaulted to `~/.claude/channels/<channel>/`, causing "Failed to reconnect" errors and misplaced `access.json` files.

- **`hatch`: add `heartbeat-precheck.js` and `reflect-precheck.js` to required permissions** — both scripts are called on every heartbeat tick and reflect run but were missing from the `permissions.allow` block, causing operators to be prompted on every invocation.

### Files affected

| File | Change |
|------|--------|
| `scripts/heartbeat-precheck.js` | New — heartbeat precheck script |
| `scripts/reflect-precheck.js` | New — reflect precheck script |
| `scripts/lib/time.js` | New — shared timezone helpers |
| `skills/heartbeat/SKILL.md` | Thinned to 94 lines; precheck integration |
| `skills/heartbeat/reference.md` | New — alert dedup and self-eval detail, loaded on demand |
| `skills/reflect/SKILL.md` | Precheck integration in step 1 |
| `skills/hatch/SKILL.md` | Gitignore consent gate; precheck permissions added |
| `skills/channel-setup/SKILL.md` | STATE_DIR injection in step 6 |
| `skills/hermit-evolve/SKILL.md` | Upgrade instruction execution |
| `skills/migrate/SKILL.md` | Scope removal references updated |
| `state-templates/GITIGNORE-APPEND.txt` | Extended local-scope entries |
| `state-templates/GITIGNORE-APPEND-PROJECT.txt` | Deleted |
| `state-templates/config.json.template` | `scope` field removed |
| `scripts/hermit-start.py` | `scope` handling and worktree setup removed |
| `docs/config-reference.md` | `scope` field entry removed |
| `tests/run-scripts.sh` | Precheck test cases added (34 → 52 script tests) |

### Upgrade Instructions

Run `/claude-code-hermit:hermit-evolve`. The evolve skill handles:

1. If `config.json` contains `"scope": "project"`:
   - **Warn the operator** (channel in always-on mode; inline in interactive mode):
     > "claude-code-hermit v1.0.24 removed the `project` scope. Your hermit state is currently tracked in git. To clean it up: (a) run `/claude-code-hermit:migrate` for a credential audit and manifest, (b) manually run `git rm --cached -r .claude-code-hermit/sessions/ .claude-code-hermit/proposals/ .claude-code-hermit/state/ .claude-code-hermit/raw/ .claude-code-hermit/compiled/ .claude-code-hermit/config.json`, then (c) replace the `.claude-code-hermit` block in `.gitignore` with the local-scope template. Skipping this leaves session reports and raw artifacts in your git history. Reply (1) to continue anyway (drop `scope` field only, no git changes), or (2) to abort so you can clean up first."
   - On **(2)**: abort hermit-evolve entirely with a message directing the operator to run `/claude-code-hermit:migrate` first. The `scope` key remains in `config.json`, so the next `/hermit-evolve` run will re-enter this instruction automatically.
   - On **(1)**: drop the `scope` field from `config.json` and proceed. Write a `compiled/` artifact `compiled/decision-scope-removal-<YYYY-MM-DD>.md` recording the operator's acknowledged decision to skip migration for now (frontmatter: `title`, `type: decision`, `created`, `tags: [scope, security]`).
2. If `config.json` contains `"scope": "local"` or no `scope` key: silently remove the `scope` key from `config.json` and continue.
3. Add missing precheck script permissions to `.claude/settings.json`. Check if `permissions.allow` contains `"Bash(node */scripts/heartbeat-precheck.js*)"` and `"Bash(node */scripts/reflect-precheck.js*)"`. If either is missing, show the operator the entries to add and ask with `AskUserQuestion` (header: "Precheck permissions") — options: **Yes — add** (default) / **No — skip**. If confirmed, merge the missing entries into `permissions.allow`.
4. Apply extended `.gitignore` coverage to existing projects. Read the project `.gitignore`. Check if it contains `.claude-code-hermit/bin/`. If not, show the operator the lines that will be appended (from `${CLAUDE_PLUGIN_ROOT}/state-templates/GITIGNORE-APPEND.txt`, filtered to entries not already present) and ask with `AskUserQuestion` (header: "Update .gitignore") — options: **Yes — append** (default) / **No — skip**. Append only if confirmed.

## [1.0.23] - 2026-04-28

### Removed

- **hermit-start: agent worktree setup removed** — `setup_agent_worktree()` and `HERMIT_AGENT_WORKTREE` export deleted; dev-hermit v0.3.0 dropped the worktree topology, leaving the 45s boot overhead with no consumers.

### Changed

- **`docs/architecture.md`: agent layer description** — the line claiming dev-hermit "adds repo-mapper, implementer, reviewer" was always wrong (dev-hermit historically shipped only an `implementer`; v0.3.0 ships zero agents). Replaced with a generic statement pointing operators at each plugin's CLAUDE.md for its actual agent set.

### Files affected

| File | Change |
|------|--------|
| `plugins/claude-code-hermit/scripts/hermit-start.py` | Removed `setup_agent_worktree()` (~60 lines), call site, and `HERMIT_AGENT_WORKTREE` env export |
| `plugins/claude-code-hermit/docs/architecture.md` | Generalized agent-layer line (no concrete plugin example) |

### Upgrade Instructions

Run `/claude-code-hermit:hermit-evolve`. The evolve skill handles:

1. **Remove the stale agent worktree** if it exists. Run `git -C "$PROJECT_ROOT" worktree list --porcelain` to detect a registered worktree at `.claude/worktrees/agent/`. If present, run `git -C "$PROJECT_ROOT" worktree remove --force .claude/worktrees/agent`. If absent from `git worktree list` but the directory still exists on disk, `rm -r .claude/worktrees/agent` (no `-f` per repo rules) and `git worktree prune` to clear any stale ref. Best-effort: do not block the upgrade if the operation fails — print a one-line warning telling the operator to clean up manually.
2. **Note the env-var removal.** Tell the operator: "v1.0.23 removes the `HERMIT_AGENT_WORKTREE` env var from the per-session tmux env file. Any custom skill or script you wrote that reads this var (none ship in the official hermit fleet) will see it as unset — adjust to either drop the dependency or read project root from `Path.cwd()` instead."

The `.claude/worktrees/` line in `state-templates/GITIGNORE-APPEND.txt` and `GITIGNORE-APPEND-PROJECT.txt` is intentionally preserved — it covers Claude Code's native `isolation: worktree` agent feature (used by other plugins), not just the deleted hermit-managed subpath.

No `config.json` changes required.

## [1.0.22] - 2026-04-28

### Added

- **hermit-start: persistent agent worktree setup** — `setup_agent_worktree()` creates `.claude/worktrees/agent/` and sets `HERMIT_AGENT_WORKTREE`; idempotent across first boot, stale-ref re-register, and existing worktree.
- **gitignore templates: `.claude/worktrees/`** — added to `GITIGNORE-APPEND.txt` and `GITIGNORE-APPEND-PROJECT.txt`.

### Changed

- **hermit-start: `auto` permission mode** — `hermit-start.py` now passes `--permission-mode auto` to Claude Code instead of treating it as unknown. Max plan → Opus 4.7 only; Team/Enterprise/API → Sonnet 4.6 or Opus 4.6/4.7. Not available on Pro, Haiku, or non-Anthropic providers.
- **hatch + hermit-settings: `auto` surfaced in permission mode options** — replaces the outdated "Teams/Enterprise only" note with accurate plan/model requirements.
- **channel-setup: Docker-mode guard** — step 1 reads `state/runtime.json` and redirects to `/docker-setup` if `runtime_mode == "docker"`, with a fallback check for `docker/Dockerfile.hermit` for scaffolded-but-unbooted projects.
- **hatch: deployment-mode next-steps** — Step 10 next-steps restructured into "Pick a mode / After picking / Anytime" groups so `/channel-setup` is visible for tmux and interactive users; channel-save note now names all three modes (Docker/tmux/interactive) with their activation paths.
- **hatch: config.json leak prevention** — Phase 2 draft rule prohibits restating config fields in OPERATOR.md; Phase 4 scrub removes any matching sentence before writing; `config.json` excluded from Phase 1 scan; `proposal-create` extended to redirect config-mirroring proposals to `/hermit-settings`.
- **OPERATOR.md template: four-question scaffold** — comment rewritten with Focus/Constraints/Approval/Comms model; warns against restating config fields.
- **CLAUDE.md: CLAUDE-APPEND contract** — `CLAUDE-APPEND.md` must not restate `config.json` values (schedules, flags, channel IDs); describes behaviors only.

### Files affected

| File | Change |
|------|--------|
| `plugins/claude-code-hermit/scripts/hermit-start.py` | Agent worktree setup; `auto` permission mode support |
| `plugins/claude-code-hermit/state-templates/GITIGNORE-APPEND.txt` | `.claude/worktrees/` added |
| `plugins/claude-code-hermit/state-templates/GITIGNORE-APPEND-PROJECT.txt` | `.claude/worktrees/` added |
| `plugins/claude-code-hermit/skills/channel-setup/SKILL.md` | Docker-mode guard at step 1 |
| `plugins/claude-code-hermit/skills/hatch/SKILL.md` | Deployment-mode next-steps; `auto` permission mode option; config.json leak prevention (Phase 2 rule, Phase 4 scrub, scan exclusion comment) |
| `plugins/claude-code-hermit/skills/proposal-create/SKILL.md` | "Do NOT include" extended: config-mirroring proposals redirected to `/hermit-settings` |
| `plugins/claude-code-hermit/state-templates/OPERATOR.md` | Comment rewritten with four-question scaffold; config field warning added |
| `plugins/claude-code-hermit/CLAUDE.md` | CLAUDE-APPEND contract: must not restate config.json values |
| `plugins/claude-code-hermit/skills/hermit-settings/SKILL.md` | `auto` added to permission mode options |
| `plugins/claude-code-hermit/docs/config-reference.md` | `permission_mode` entry updated for `auto` with plan requirements |

### Upgrade Instructions

Run `/claude-code-hermit:hermit-evolve`. The evolve skill handles:

1. **Refresh** `scripts/hermit-start.py` from the updated plugin.
2. **Refresh** `skills/channel-setup/SKILL.md`, `skills/hatch/SKILL.md`, and `skills/hermit-settings/SKILL.md` from the updated plugin.
3. **Append** `.claude/worktrees/` to the project `.gitignore` if dev-hermit agent worktrees are in use.

No `config.json` changes required.

## [1.0.21] - 2026-04-27

### Changed

- **doctor-check: read `required_core_version` from `hermit-meta.json` only** — drops `plugin.json` fallback; sidecar keeps hermit-internal fields validator-invisible.
- **docs: bump Claude Code prerequisite to v2.1.110+** — `claude plugin tag` and the dependency resolver both require v2.1.110+.
- **docs: `boot_skill` declaration guidance → `hermit-meta.json`** — `config-reference.md` and `creating-your-own-hermit.md` updated to match the sidecar migration.

### Files affected

| File | Change |
|------|--------|
| `plugins/claude-code-hermit/scripts/doctor-check.js` | Reads `required_core_version` from hermit-meta.json; drops plugin.json fallback |
| `plugins/claude-code-hermit/docs/how-to-use.md` | Claude Code prerequisite: v2.1.98+ → v2.1.110+ |
| `plugins/claude-code-hermit/docs/always-on.md` | Claude Code prerequisite: v2.1.98+ → v2.1.110+ |
| `plugins/claude-code-hermit/docs/always-on-ops.md` | Claude Code prerequisite: v2.1.98+ → v2.1.110+ |
| `plugins/claude-code-hermit/skills/channel-responder/SKILL.md` | Channels preview version note: v2.1.98+ → v2.1.110+ |
| `plugins/claude-code-hermit/docs/config-reference.md` | `boot_skill` declaration: plugin.json → hermit-meta.json |
| `plugins/claude-code-hermit/docs/creating-your-own-hermit.md` | `boot_skill` guide: plugin.json → hermit-meta.json |

### Upgrade Instructions

Run `/claude-code-hermit:hermit-evolve`. The evolve skill handles:

1. **Refresh** `scripts/doctor-check.js` from the updated plugin.

No `config.json` changes required.

## [1.0.20] - 2026-04-26

### Changed

- **CHANGELOG: clarify v1.0.19 upgrade for always-on operators** — `bin/hermit-stop` shares the broken `bin/hermit-run`; upgrade instructions now lead with a stop step before the replace.
- **`release-auditor` agent: slug-aware refactor for monorepo** — takes a plugin slug, reads version from repo-root `marketplace.json`; fixes two false-positive FAILs from the pre-monorepo path layout.

### Files affected

| File | Change |
|------|--------|
| `plugins/claude-code-hermit/CHANGELOG.md` | v1.0.19 Upgrade Instructions: new step 1 for always-on operators (existing 1→2, 2→3) |
| `.claude/agents/release-auditor.md` | Slug-aware refactor: input contract, all path references rewritten under `plugins/<slug>/`, repo-root marketplace lookup, core-only DEFAULT_CONFIG check gate |

### Upgrade Instructions

Run `/claude-code-hermit:hermit-evolve`. No operator action required — this is a documentation-only patch on top of v1.0.19.

No `config.json` changes required.

## [1.0.19] - 2026-04-26

### Fixed

- **`smoke-test`: scheduled-check skill resolution uses harness loaded-skills list** — path-walking `${CLAUDE_PLUGIN_ROOT}/../<plugin>/skills/` only found same-marketplace siblings, causing false-negative WARNs for cross-marketplace plugins.
- **`hermit-evolve` step 7: gate sibling upgrades on `_hermit_versions` key** — monorepo cache exposes all sibling plugins regardless of install; `default "0.0.0"` treated them as fresh installs and re-executed their upgrade steps indefinitely.
- **`hermit-doctor` and `dev-doctor`: stale "six-check" references fixed** — copy in both skill files now aligns with the seven-check report that includes `dependencies`.
- **`plugins/claude-code-hermit`: missing `LICENSE` and stale install snippet** — restored MIT LICENSE under the plugin path; updated `Creating Your Own Hermit` snippet from pre-monorepo `gtapps/claude-code-dev-hermit` to canonical `gtapps/claude-code-hermit`.
- **`Test Hooks` CI workflow: re-pointed to monorepo path** — `paths:` filters and `run:` steps updated to `plugins/claude-code-hermit/**`; `CONTRIBUTING.md` updated to match.

### Changed

- **Monorepo layout** — plugin source moved from repo root to `plugins/claude-code-hermit/`; `${CLAUDE_PLUGIN_ROOT}` and sibling-scan patterns resolve correctly; marketplace cache now contains `plugins/<name>/` subdirs.
- **`bin/hermit-run`: monorepo layout scan** — glob updated from `marketplaces/*/` to `marketplaces/*/plugins/*/`; existing hatched projects must replace this file.
- **`docker/docker-entrypoint.hermit.sh.template`: monorepo-aware `HERMIT_PLUGIN_ROOT`** — replaced shallow `find -maxdepth 2` with a direct path check at `${MARKETPLACE_DIR}/claude-code-hermit/plugins/claude-code-hermit/`.
- **`hermit-doctor` seventh check: `dependencies`** — reads `required_core_version` from sibling plugin manifests; warns if core version doesn't satisfy the semver range.
- **Docker entrypoint: survive interrupted Claude CLI self-update** — boot-time shim detects orphan `.claude-<rand>` symlink and recovers; Python plugin-install block wrapped in `try/except FileNotFoundError`.

### Files affected

| File | Change |
|------|--------|
| `state-templates/bin/hermit-run` | Marketplace cache scan glob: `marketplaces/*/` → `marketplaces/*/plugins/*/` |
| `state-templates/docker/docker-entrypoint.hermit.sh.template` | (a) Replaced shallow `find -maxdepth 2` plugin.json discovery with a direct path check at `marketplaces/claude-code-hermit/plugins/claude-code-hermit/`. (b) Added boot-time orphan-symlink recovery for `~/.npm-global/bin/claude`. (c) Hardened the Python recommended-plugins block with `try/except FileNotFoundError` per `subprocess.run` plus a trailing `|| echo` after the heredoc so the entrypoint cannot be killed by a transient missing `claude` mid-self-update. |
| `scripts/doctor-check.js` | New `checkDependencies()` function and `satisfiesRange()` helper; added to `runAllChecks()` between `checkProposals` and `checkPermissions` |
| `skills/hermit-doctor/SKILL.md` | Description, body, and check table updated from "six checks" to "seven checks"; new `dependencies` row added |
| `tests/run-hooks.sh` | doctor-check minimal-install assertion bumped from 6 to 7 expected checks; expected ID list includes `dependencies` |

### Upgrade Instructions

Run `/claude-code-hermit:hermit-evolve`. The evolve skill handles:

1. **Always-on operators only: stop the running hermit cleanly before continuing.** If a hermit is currently running for this project (`bin/hermit-status` reports it active), tear it down manually first — `bin/hermit-stop` is broken in this version because it shares the broken `bin/hermit-run` dispatcher with `bin/hermit-start`. For tmux operators: `tmux kill-session -t <session-name>` (find it via `tmux ls`). For Docker operators: `.claude-code-hermit/bin/hermit-docker down`. Then continue with step 2 below; restart with `bin/hermit-start` (or `bin/hermit-docker up`) after `hermit-evolve` finishes. If no hermit is currently running for this project, this step is a no-op.

2. **Replace `.claude-code-hermit/bin/hermit-run` with the new template.** Read `${CLAUDE_PLUGIN_ROOT}/state-templates/bin/hermit-run` and overwrite the target project's `.claude-code-hermit/bin/hermit-run`. Preserve executable bit (`chmod +x`). Without this step, `bin/hermit-start` will continue to fail with `[hermit] Plugin root not found or invalid:` because the old scan glob doesn't match the monorepo cache layout.

3. **For Docker-deployed hermits: rebuild the container.** The `docker-entrypoint.hermit.sh.template` baked into the image carries a stale `find` invocation that won't locate the plugin under the monorepo cache. Run `.claude-code-hermit/bin/hermit-docker update --cc-only` (or a full `update`) so the next boot picks up the new entrypoint. Non-Docker (tmux/local) operators can skip this step.

No `config.json` changes required. The `dependencies` doctor check requires no operator action — it's read-only and reports ok by default.

## [1.0.18] - 2026-04-24

### Changed

- **hermit-doctor: rename from doctor** — avoids collision with Claude Code's built-in `/doctor` command; follows the `hermit-*` naming convention.
- **hermit-start: align DEFAULT_CONFIG model with template** — `model` fallback was `None`; now `'sonnet'` to match `config.json.template`.

### Files affected

| File | Change |
|------|--------|
| `skills/hermit-doctor/SKILL.md` | Renamed from `skills/doctor/`; heading, name, and activation keyword updated |
| `state-templates/CLAUDE-APPEND.md` | `/doctor` → `/hermit-doctor` in quick-reference |
| `CLAUDE.md` | `doctor` → `hermit-doctor` in skills list |
| `docs/artifact-naming.md` | `/doctor` → `/hermit-doctor` |
| `scripts/hermit-start.py` | `DEFAULT_CONFIG model: None` → `'sonnet'` |

### Upgrade Instructions

Run `/claude-code-hermit:hermit-evolve`. The evolve skill handles:

1. **Patch `/doctor` → `/hermit-doctor` in target-project `CLAUDE.md`:** find the Quick Reference line containing the backtick-quoted token `` `/doctor` ``. If `` `/hermit-doctor` `` is already present, or if neither token appears, skip without error. Otherwise replace `` `/doctor` `` with `` `/hermit-doctor` `` on that line only and write the file back.

No `config.json` changes required.

## [1.0.17] - 2026-04-24

### Added

- **`scripts/prompt-context.js` — UserPromptSubmit hook injects `[Now: <Day>, <date> <HH:MM> <TZ>]`** — CC's `# currentDate` is TZ-naive; this provides a fresh, weekday-aware timestamp on every prompt. Fails open.

- **`bin/hermit-attach` helper** — single command to reconnect to the running hermit (tmux or Docker); reads `state/runtime.json` and dispatches accordingly.
- **`/create-pr` skill** — project-local skill for opening PRs: Conventional Commits title, Summary/Test-plan body, `#N` auto-links, AskUserQuestion gate before `gh pr create`.
- **`hermit-docker update` subcommand** — full rebuild, `--cc-only`, or `--plugins-only` (zero-downtime marketplace refresh); logs to `state/update-history.jsonl`.

### Changed

- **`state-templates/GITIGNORE-APPEND.txt`: ignore `.claude-code-hermit/cost-log.jsonl`** — cost log was only ignored under `.claude/`; the hermit-prefixed path was missing. Entries reordered so all `.claude/` lines precede `.claude-code-hermit/` lines.

- **heartbeat: stale-session alert includes recovery hint** — updated alert text to name context-compaction desync as a cause and give the operator two direct recovery commands (`resume` via `/claude-code-hermit:session-start`, or `idle` to drop the session). Avoids adding state-machine scaffolding to a subsystem scheduled for retirement post-KAIROS GA.

- **channel-responder: recognize slash commands** — added `Slash command` branch at top of step 2 classification; messages starting with `/` routed to the matching skill/subagent instead of drawing an improvised "don't recognize this command" reply.

- **`/doctor` skill — six-check health report** — `scripts/doctor-check.js` runs config, hooks, state, budget, proposals, and permissions checks; writes `state/doctor-report.json`; exits 0 always.
- **`/doctor` → `/hermit-doctor` rename** — avoids collision with CC's built-in `/doctor`; `doctor-check.js` and `state/doctor-report.json` paths unchanged.
- **`docs/artifact-naming.md`** — new reference doc for the four-bucket layout (`raw/`, `compiled/`, `state/`, `proposals/`), naming conventions, and frontmatter requirements.
- **Weekly reviews migrated to `compiled/`** — `weekly-review.js` now writes `compiled/review-weekly-YYYY-Www.md`; `reviews/` directory removed from gitignore and startup scanner; session-start surfaces latest review via `newestByType`.
- **Session reports: `## Artifacts` section** — added between `## Changed` and `## Blockers` to cite durable `compiled/` outputs from the session.
- **`ultrathink` at planning-heavy steps** — added to `reflection-judge.md`, `reflect/SKILL.md`, and `proposal-create/SKILL.md` at the three decisive judgment points.
- **`config.model` defaults to `"sonnet"` for new hatches** — was `null`; explicit default makes the launch model visible and reproducible.
- **Model and effort tuning documented in `docs/how-to-use.md`** — covers `config.model` and `CLAUDE_CODE_EFFORT_LEVEL` env var.

### Files affected

| File | Change |
|------|--------|
| `state-templates/bin/hermit-attach` | New helper — reconnect to tmux or docker session |
| `state-templates/bin/hermit-docker` | `update` subcommand added |
| `state-templates/bin/hermit-status` | Attach hint added for tmux runtime |
| `scripts/hermit-start.py` | Attach hint now shows `bin/hermit-attach` |
| `skills/docker-setup/SKILL.md` | `update` added to step 9 command reference |
| `skills/hatch/SKILL.md` | `update-history.jsonl` added to state init list |
| `skills/channel-responder/SKILL.md` | Slash command branch added to classifier |
| `skills/hermit-doctor/SKILL.md` | Renamed from `skills/doctor/`; name and activation keyword updated |

### Upgrade Instructions

Run `/claude-code-hermit:hermit-evolve`. The evolve skill handles:

1. **bin/hermit-docker update support:** rewrite `.claude-code-hermit/bin/hermit-docker` from the updated template (step 5b already does this wholesale). No operator action needed.
2. **update-history.jsonl:** create empty `.claude-code-hermit/state/update-history.jsonl` if it does not exist.
3. **bin/hermit-attach:** copy `state-templates/bin/hermit-attach` to `.claude-code-hermit/bin/hermit-attach` and `chmod +x`. Overwrite if present.
4. **bin/hermit-status:** rewrite `.claude-code-hermit/bin/hermit-status` from the updated template (step 5b already does this).
5. **Migrate weekly reviews to compiled/:** if `.claude-code-hermit/reviews/` exists, for each `weekly-<weekKey>.md`:
   - Compute target path `.claude-code-hermit/compiled/review-weekly-<weekKey>.md`. If the target already exists and its frontmatter contains `type: review`, skip this file (idempotence guard — safe to re-run).
   - Read the source file's frontmatter. Synthesize the new frontmatter by prepending these fields in order: `type: review`, `title: "Weekly Review: <weekKey>"`, `created: <source file mtime as ISO 8601>`, `tags: [weekly, review]`. Preserve `generated: true` and all existing metric fields (`week`, `sessions_count`, `proposals_created`, `proposals_accepted`, `proposals_resolved`, `total_cost_usd`, `avg_session_cost_usd`, `self_directed_rate`). Preserve the body verbatim.
   - Write to the target path. Delete the source file.
   - After processing all files, remove the `.claude-code-hermit/reviews/` directory if now empty.
6. **Update project `.gitignore`:** if `.claude-code-hermit/reviews/` appears as a line in the project's `.gitignore`, remove it. The migration eliminates the directory.
7. **SESSION-REPORT.md.template drift:** the template now includes a `## Artifacts` section between `## Changed` and `## Blockers`. If `.claude-code-hermit/templates/SESSION-REPORT.md.template` exists in the project state dir and lacks this section, add it. The evolve template-diff machinery already handles this — just confirm the diff includes the `## Artifacts` insertion.
8. **Obsidian `Latest Review.md`:** if `obsidian/Latest Review.md` exists and still embeds `reviews/weekly-<weekKey>`, rewrite the embed to `compiled/review-weekly-<weekKey>`. Otherwise the next weekly-review run regenerates it.

Declaring a `review` type in `knowledge-schema.md` is left to the operator — the schema is project-owned, so hermit-evolve does not append.

9. **Patch `/doctor` → `/hermit-doctor` in target-project `CLAUDE.md`:** read the project's `CLAUDE.md` (not the plugin's). Find the line in the Quick Reference section that lists backtick-quoted hermit skill commands — it will contain `` `/doctor` `` (the form used by `state-templates/CLAUDE-APPEND.md`). If `` `/hermit-doctor` `` is already present, or if neither token appears in the file, skip without error (fail-open). Otherwise replace the token `` `/doctor` `` with `` `/hermit-doctor` `` on that line and write the file back. Do not alter any other line.

10. **Interactive model migration:** if `config.model` is `null` or missing, ask the operator:
   > "Hermit now defaults to `"sonnet"` for new installs (matches the effective default on most tiers). Your hermit currently inherits the Claude Code default at launch. Pin it to `"sonnet"` (recommended), keep `null` (continue inheriting), or set another alias (`opus`, `haiku`, `best`)?"
   Apply the operator's choice. If they choose "keep null", write `null` explicitly. If they skip or close without answering, leave the key as-is.

## [1.0.16] - 2026-04-22

### Changed

- **reflect-scheduled-checks: decoupled from reflect** — now a self-contained routine skill; `reflect` no longer runs or adjusts scheduled checks. New `scheduled-checks` routine fires at `5 9 * * *`.
- **reflect-scheduled-checks: split unavailable/error gating** — `unavailable` backs off 4 hours only; `error` backs off `interval_days`. Adds `last_error_at` field to state.
- **micro-proposals: drop single-slot constraint** — schema changes from `{active: null}` to `{pending: []}`, allowing multiple concurrent proposals; channel-responder matches by ID.
- **hermit-start.py: export `CLAUDE_PLUGIN_ROOT` to always-on tmux session** — Bash tool calls inside cron-triggered skills now have the variable available.

### Fixed

- **reflect-scheduled-checks: false-negative unavailable classification** — uses loaded-skills list instead of filesystem grep for presence checks.
- **proposal-triage: prevent turn exhaustion on multi-file dedup runs** — `maxTurns` raised from 5 to 8; verdict directive added to prevent early exit.

### Files affected

| File | Change |
|------|--------|
| `skills/reflect-scheduled-checks/SKILL.md` | Standalone routine; unavailable/error gating split; loaded-skills presence check |
| `skills/reflect/SKILL.md` | Removed scheduled-checks section and interval-adjustment logic |
| `agents/proposal-triage.md` | maxTurns 5→8; terminal verdict directive added |
| `skills/channel-responder/SKILL.md` | Multi-slot micro-proposals: ID-based answer matching |
| `skills/heartbeat/SKILL.md` | Multi-slot micro-proposals: pending array |
| `skills/brief/SKILL.md` | Multi-slot micro-proposals: pending array |
| `skills/smoke-test/SKILL.md` | Multi-slot micro-proposals: pending array |
| `scripts/generate-summary.js` | Multi-slot micro-proposals: pending array |
| `scripts/hermit-start.py` | CLAUDE_PLUGIN_ROOT export; scheduled-checks routine in DEFAULT_CONFIG |
| `state-templates/config.json.template` | scheduled-checks routine added |
| `state-templates/micro-proposals.json.template` | Schema: `{active: null}` → `{pending: []}` |
| `CLAUDE.md` | `reflect-scheduled-checks` added to skills list |
| `state-templates/CLAUDE-APPEND.md` | `reflect-scheduled-checks`, `channel-responder` added to quick reference |

### Upgrade Instructions

Run `/claude-code-hermit:hermit-evolve`. The evolve skill handles:

1. **Migrate `micro-proposals.json`:** Read `micro-proposals.json`. If it has a top-level `active` key: if value is null, rewrite as `{"pending": []}`. If value is an object, rewrite as `{"pending": [<that object with tier: 1 if missing>]}`. Remove `active` in both cases.

2. **Add `scheduled-checks` routine:** If `config.json` routines contains no entry with `id: "scheduled-checks"`, append `{"id": "scheduled-checks", "schedule": "5 9 * * *", "skill": "claude-code-hermit:reflect-scheduled-checks", "run_during_waiting": true, "enabled": true}`. Skip if already present.

3. **Add `last_error_at` field:** For each entry under `state/reflection-state.json → scheduled_checks`, if `last_error_at` is absent, add `"last_error_at": null`.

4. **Restart always-on session:** Run `hermit-stop` then `hermit-start` so the new `CLAUDE_PLUGIN_ROOT` export takes effect in the tmux environment.

No `config.json` schema changes required beyond the routine addition in step 2.

## [1.0.15] - 2026-04-22

### Added

- **iMessage channel support in channel-hook** — `channel-hook.js` now recognizes `imessage` tool names; `dm_channel_id` persistence works for iMessage MCP bots; `hooks.json` matcher extended to `(discord|telegram|imessage).*reply`.
- **plugin-validator: native `claude plugin validate` as Check 0** — the agent now runs the official Claude Code validator first and treats its findings as authoritative for schema compliance; hermit-specific checks (1–7) layer cross-references on top.
- **release-auditor: marketplace.json version cross-check** — audits `plugins[0].version` in marketplace.json against `plugin.json.version`. The plugin manifest wins silently when they differ, so a mismatch is a FAIL.

### Changed

- **marketplace.json: full metadata** — adds top-level `metadata.description`, and per-plugin `author`, `license`, `homepage`, `repository`, and `keywords` so marketplace listings render correctly.
- **release skill: native validator + marketplace version sync** — step 1 runs `/plugin validate .` before tests; step 4 cross-checks plugin.json and marketplace.json versions via `jq`; step 6 derives tag from `jq` to prevent drift.
- **docs/security.md: Docker plugin trust model** — reflects the current policy: the entrypoint installs every enabled entry in `docker.recommended_plugins` regardless of marketplace; the trust gate is at configuration time (explicit operator confirmation during `/docker-setup` or `/hermit-settings docker`), with preselection restricted to `claude-plugins-official` and `gtapps/*`.
- **brief skill: no longer auto-closes sessions** — notes "run /session-close to archive" when `in_progress` instead of delegating to `/session-close --idle`. Output cap relaxed to 6 lines.
- **smoke-test skill: cron schedule validation** — routine validator now requires the `schedule` key (5-field cron) and FAILs on legacy `time`/`days` fields, matching the routines schema in config.

### Fixed

- **hermit-stop in interactive mode no longer corrupts runtime state** — exits early with a "terminate Claude manually" message instead of writing `idle` to `runtime.json` while Claude was still running.
- **docs/skills.md: smoke-test vs test-run descriptions swapped** — the table had the two descriptions transposed; smoke-test is post-hatch validation, test-run is the full test suite.
- **docs/testing.md: frontmatter validator path** — script moved from `tests/` to `scripts/`; doc updated to match.
- **README.md: `/claude-code-hermit:evolve` → `/claude-code-hermit:hermit-evolve`** — upgrade instructions referenced the old skill name.
- **SHELL.md.template: `/monitor` → `/watch`** — monitoring section pointed to the old skill name.

### Added

- **knowledge-lint: `schema-empty` and `schema-missing` findings** — all-commented `knowledge-schema.md` silently disabled type enforcement; both findings now surface at normal verbosity (suppressed on empty hermit).
- **knowledge-schema.md template: starter bullets** — ships with one `note` and one `input` entry uncommented so type enforcement is active on fresh hatches.
- **startup-context: `---Storage Drift---` section** — warns when artifacts land in paths invisible to session injection (unknown top-level dirs, subdirs under `raw/`/`compiled/`); silent when clean.

### Changed

- **knowledge-lint: `parseSchema` sentinel split** — returns `false` for missing file, `null` for present-but-empty schema; removes `fs.accessSync` TOCTOU pre-check and redundant info line.
- **update-reflection-state: simplified `last_sparse_nudge` fallback** — the fallback `state.last_sparse_nudge ?? null` was unreachable when `mergedNudge` is empty (empty merge implies existing state was also empty); simplified to `null`.
- **`plugin_checks` renamed to `scheduled_checks`** — config key, state key, `/hermit-settings` subcommand, sub-skill (`reflect-plugin-checks` → `reflect-scheduled-checks`), and Evidence Source tag (`plugin-check/<id>` → `scheduled-check/<id>`); pipeline unchanged.

### Added

- **reflection-judge: `ACCEPT (operator-request)` verdict tag** — adds `operator-request` as a valid source tag alongside `current-session` and `scheduled-check`; test suite validates all three.
- **tests: DOWNGRADE grammar and verdict-tag coverage checks** — `recurrence-gate-matrix.sh` gains sections verifying `DOWNGRADE` example and all three source-tag verdict lines.
- **docs: `source` field semantics clarified in frontmatter-contract** — `source:` is origin-only; gate bypass is governed by `Evidence Source:` field.
- **CLAUDE.md: "Avoid overengineering" constraint** — added to development constraints.
- **.gitignore: `.codex` entry** — excludes Codex CLI working directory from version control.

- **reflect/proposal pipeline: Evidence Source provenance tags** — all four pipeline stages accept `Evidence Source:` (`archived-session` | `current-session` | `scheduled-check/<id>` | `operator-request`); scheduled-check and operator-request bypass Rule #1; structured suppress codes replace free-text reasons.
- **reflect: evidence integrity rule** — `current-session` candidates must not be injected into SHELL.md before `reflection-judge` reads them; inferred patterns are ineligible.
- **reflect: suppression detail in Progress Log** — `suppressed: [<slug>: <code>, ...]` suffix appended on suppressions (capped at 3).
- **tests: recurrence-gate-matrix test suite** — `tests/recurrence-gate-matrix.sh` validates Evidence Source bypass behaviour across all gates.

### Upgrade Instructions

Run `/claude-code-hermit:hermit-evolve`. The evolve skill executes these steps:

1. **Rename config key in `.claude-code-hermit/config.json`:** if a top-level `plugin_checks` array exists, rename it to `scheduled_checks`. If both `plugin_checks` and `scheduled_checks` exist, merge entries by `id` (scheduled_checks wins on conflict); log the merge to stderr and continue. Preserve all other top-level keys unchanged. If neither exists, no-op.
2. **Rename state key in `.claude-code-hermit/state/reflection-state.json`:** if a top-level `plugin_checks` object exists, rename it to `scheduled_checks` (pure key move, values unchanged). If `reflection-state.json` is missing, no-op. Preserve all other top-level keys unchanged.
3. **Evidence Source tag in proposals:** no automated migration. If `.claude-code-hermit/proposals/PROP-*.md` contains the string `plugin-check/`, it refers to historical provenance and can be left as-is — the tag is human-readable and does not affect gate behavior for accepted/resolved proposals. Operators may manually search-replace to `scheduled-check/` if desired.
4. **Operators invoking `/hermit-settings plugin-checks` will get "unknown subcommand"** after upgrade. Use `/hermit-settings scheduled-checks` instead.
5. **Seed starter bullets if `knowledge-schema.md` parses empty:** if `.claude-code-hermit/knowledge-schema.md` exists and has no uncommented bullet lines under `## Work Products` or `## Raw Captures` (all bullets inside HTML comments), append `- note: general-purpose compiled note. location: compiled/note-<slug>-<date>.md` under `## Work Products` and `- input: general-purpose raw capture. location: raw/input-<slug>-<date>.md` under `## Raw Captures`. Preserve all existing content and comments. If the section headers are missing, append them with the bullets. If the file is missing, no-op (hatch creates it on first run).

## [1.0.14] - 2026-04-20

### Added

- **docker-setup: plugin-declared apt dependencies (step 7b.packages)** — domain plugins declare `## Docker apt dependencies` in their `hatch` SKILL.md or `DOCKER.md`; `docker-setup` unions these with project-level deps before a single confirmation prompt.
- **`boot_skill`: domain hermits can override the bootstrap skill** — `hermit-start.py` reads `config.boot_skill`; domain hermits declare it in `hermit-meta.json`; `hatch` writes it to project config. Managed via `/hermit-settings boot-skill`.

### Changed

- **docker-setup: package confirmation deferred to after plugin selection** — the project-signal apt scan (step 2.3) now collects candidates without immediately writing `docker.packages`; final confirmation happens in new step 7b.packages after the plugin list is finalized, so plugin-declared deps can be included in a single unified prompt.

### Fixed

- **hermit-docker: revert login to REPL `/login`** — `claude auth login` can't complete OAuth in Docker/tmux (no browser callback path); reverted to `docker compose exec` REPL with post-exit credential verification.
- **docker-setup: setup-mode bootstrap suppression** — first boot now lands on an idle REPL prompt; `hermit-start.py` reads-and-deletes `.setup-mode` marker, skipping bootstrap send (one-shot).
- **docker-setup: channel pairing confirmation gates** — skill blocks with `AskUserQuestion` before pair command and before `access.json` verification; eliminates race past unfinished pairing.
- **docker-setup: login gate** — skill asks "Done / Failed" after `hermit-docker login`; on failure surfaces logs and stops.
- **docker-setup: drop `/reload-plugins` pre-pair** — was a workaround for bootstrap-turn collision; no longer needed.
- **docker-setup step 9: clarify no-session on fresh setup** — explicit note prevents LLM adding sleep loops waiting for a session.
- **docker-setup: pre-create channel state dirs before compose up** — Docker creates missing bind-mount dirs as root, making them unwritable by the `claude` user; skill now `mkdir -p` before `compose up`.
- **tmux send-keys: split text and Enter into two calls** — CC's TUI treats one-shot `send-keys '<text>' Enter` as bracketed paste; now sends text and Enter as separate calls with 0.5s pause.
- **docker-setup: verify channel token before pairing** — step 8 checks `.claude.local/channels/<plugin>/.env` for `*_BOT_TOKEN` before prompting for a pairing code.
- **config template: add boot_skill field** — `boot_skill` was used by `hermit-start.py` but absent from `config.json.template` and `DEFAULT_CONFIG`; new projects now have the field populated as `null`.

### Files affected

| File | Change |
|------|--------|
| `state-templates/bin/hermit-docker` | Login reverts to REPL via `compose exec`; post-exit credential verification; use `CLAUDE_CONFIG_DIR` env var |
| `state-templates/docker/docker-entrypoint.hermit.sh.template` | Banner updated to match REPL-based login flow |
| `scripts/hermit-start.py` | Setup-mode marker check: read-and-delete `.setup-mode`, skip bootstrap if present; `boot_skill` config field overrides the default `/claude-code-hermit:session` bootstrap |
| `skills/hatch/SKILL.md` | Step 3 reads `hermit.boot_skill` from activated hermit's `plugin.json`; step 5 writes it to `config.boot_skill` |
| `skills/hermit-settings/SKILL.md` | New `boot-skill` argument to view/clear/change `config.boot_skill` |
| `skills/docker-setup/SKILL.md` | Login gate; setup-mode touch before build; blank-prompt note; drop reload-plugins; pairing gates; step 9 no-session note; step 2.3 defers confirmation; new step 7b.packages unions project + plugin-declared apt deps |
| `docs/creating-your-own-hermit.md` | New Docker dependencies section documenting the `## Docker apt dependencies` convention (hermit-owned vs project-owned scope split); simplified hatch naming to just `hatch` (plugin namespace disambiguates) |
| `state-templates/config.json.template` | Added `boot_skill: null` top-level key |
| `scripts/hermit-start.py` | Added `boot_skill: None` to `DEFAULT_CONFIG` |

### Upgrade Instructions

Run `/claude-code-hermit:hermit-evolve`. The evolve skill handles:

1. **Replace** `state-templates/bin/hermit-docker` with the updated version from the plugin.
2. **Replace** `state-templates/docker/docker-entrypoint.hermit.sh.template` with the updated version from the plugin.
3. **Sync `boot_skill` from any activated domain hermit.** For each hermit recorded in `_hermit_versions` (excluding `claude-code-hermit`):
   - Locate the hermit's `plugin.json` via the same sibling-plugin scan used at init (`${CLAUDE_PLUGIN_ROOT}/../*/.claude-plugin/plugin.json`).
   - If its manifest declares `hermit.boot_skill` (e.g. `"/claude-code-homeassistant-hermit:ha-boot"`):
     - If the project's `config.boot_skill` is `null` or missing: set it to the declared value.
     - If `config.boot_skill` is already set and matches the declared value: no-op.
     - If `config.boot_skill` is set to a skill in a *different* plugin's namespace: leave it alone and warn the operator about the conflict.
   - If the hermit's manifest omits `hermit.boot_skill` but `config.boot_skill` currently points at a skill in that hermit's namespace: clear `config.boot_skill` to `null` so the default `/claude-code-hermit:session` takes over.
   - If no domain hermit is activated: leave `config.boot_skill` as-is (likely `null`).

**If you have root-owned `.claude.local/channels/` dirs from a previous setup:** fix them on the host with `sudo chown -R $USER .claude.local/` from the project root, then restart the container.

`config.json` gains an optional top-level `boot_skill` field (string or `null`). Step 3 above handles population for existing projects with a domain hermit; core-only projects need no manual change.

---

## [1.0.13] - 2026-04-20

### Added

- **reflect: adaptive phase gates** — `newborn` (<3d) / `juvenile` (3–13d) / `adult` (14+d) gate recurrence and sub-threshold surfacing; closes the cold-start silence on fresh installs. Tier 2/3 still require real cross-session evidence in every phase.
- **reflect: operator-value self-check** — reflection questions now include dismiss-ratio and deferred-proposal-buildup checks from `proposal-metrics.jsonl`.
- **reflect: cost-spike detection** — today's cost vs 7-day median; `>2×` records a sub-threshold observation eligible for recurrence graduation.
- **reflect: Component Health agent check** — flags `reflection-judge` when `judge_suppress > 2× judge_accept` with ≥5 verdicts.
- **reflect: mandatory Progress Log entry** — every run (including empty) appends `[HH:MM] reflect (<phase>) — ...` to SHELL.md.

### Changed

- **reflect: silent by default** — unconditional top-of-skill operator notification removed; notify only on outcomes.
- **reflect: Three-Condition Rule hoisted** — defined once before first reference.
- **reflect: sub-threshold → project memory** — recorded with pattern label + session_id so recurrence can graduate them.
- **reflect: Resolution Check 14-day guard** — requires both pattern absence from 3 sessions AND ≥14 days since `accepted_date`.
- **reflect: Skill Health → Component Health** — broadened to agents and hooks (hooks out-of-scope pending telemetry).
- **reflection-judge: `(current-session)` verdict variants** — explicit trigger for SHELL.md fallback when no archived report exists; callers can tell evidence isn't archived yet.
- **CLAUDE-APPEND.md quick reference** — added `/session-start`, `/reflect`, `/channel-setup`, `/hatch`, `/smoke-test`.

### Fixed

- **heartbeat: reflect no longer inline** — long reflect runs (30–40 min) occupied the REPL and delayed CronCreate routines 90+ min. Reflect is now routine-only (default `0 9 * * *`, seeded in `config.json.template` and `DEFAULT_CONFIG`). Heartbeat reverts to a pure health tick.

### Files affected

| File | Change |
|------|--------|
| `skills/reflect/SKILL.md` | Adaptive phase gates, cost-spike detection, operator-value self-check, mandatory Progress Log entry, Component Health broadened, Resolution Check 14-day guard |
| `agents/reflection-judge.md` | Current-session fallback path and `(current-session)` verdict variants |
| `scripts/update-reflection-state.js` | `preserve()` helper extracted; `last_digest_at` passthrough added |
| `skills/heartbeat/SKILL.md` | Reflection section removed from Idle Agency |
| `state-templates/config.json.template` | `reflect` routine added (`0 9 * * *`, enabled by default) |
| `scripts/hermit-start.py` | `reflect` routine added to `DEFAULT_CONFIG` |
| `state-templates/CLAUDE-APPEND.md` | Quick reference updated with 5 previously missing skills |

### Upgrade Instructions

Run `/claude-code-hermit:hermit-evolve`. The evolve skill handles:

1. **Add reflect routine** — append `{"id": "reflect", "schedule": "0 9 * * *", "skill": "claude-code-hermit:reflect", "enabled": true}` to the `routines` array in `config.json` if no entry with `"id": "reflect"` exists.
2. **Register the new routine** — invoke `/claude-code-hermit:hermit-routines load` after updating `config.json`.
3. **Refresh CLAUDE-APPEND** — copy the updated `state-templates/CLAUDE-APPEND.md` into the project's `.claude/` injection point.

No other config changes required.

**Note:** Hermits <14 days old will start surfacing sub-threshold observations in SHELL.md Findings — `Noticed: <pattern>` in `newborn` phase, `Noticed (digest): ...` weekly in `juvenile`. Hermits ≥14 days old land in `adult` (identical to prior behavior). To opt out: set `"enabled": false` on the reflect routine.

---

## [1.0.12] - 2026-04-20

### Changed

- **`routines` skill renamed to `hermit-routines`** — avoids collision with Claude Code's native schedule/routines concepts. The slash command is now `/claude-code-hermit:hermit-routines` (and bare `/hermit-routines`). The `config.json` `routines` array key, `hermit-settings routines` subcommand, `routine-metrics.jsonl`, and `[hermit-routine:<id>]` CronCreate tags are unchanged.
- **Stale routine-watcher prose removed** — several docs and skills still referenced the old bash watcher (removed in 0.0.9). Cleaned up `docs/always-on-ops.md`, `docs/architecture.md`, `docs/testing.md`, `skills/proposal-act/SKILL.md`, `hooks/hooks.json`.
- **Cortex Portal.md is now a live Dataview template** — replaced the generated `obsidian/Cortex Portal.md` (rewritten by `build-cortex.js` on every refresh) with a static Dataview/dataviewjs template. Recent sessions, active proposals, reflect health, and recent artifacts now update live in Obsidian without any rebuild trigger.
- **Connections.md refreshes automatically** — a new mtime-gated stage in the Stop hook (`scripts/cortex-refresh-stage.js`) rebuilds `Connections.md` at the end of any turn that modified sessions, proposals, or artifact manifest. Cost on no-change turns is a handful of `stat()` calls. The nightly `cortex-refresh` routine remains as a safety net.

### Files affected

| File | Change |
|------|--------|
| `skills/hermit-routines/SKILL.md` | Renamed from `skills/routines/SKILL.md`; updated all internal invocation references |
| `state-templates/obsidian/Cortex Portal.md.template` | Rewritten as Dataview/dataviewjs template |
| `scripts/build-cortex.js` | Removed Portal generation; now writes `Connections.md` only |
| `scripts/cortex-refresh-stage.js` | New: mtime-gated Stop hook stage |
| `scripts/stop-pipeline.js` | Added cortex-refresh as stage 5 (standard+ only) |
| `skills/cortex-refresh/SKILL.md` | Updated description to reflect Portal is now live Dataview |
| `skills/cortex-sync/SKILL.md` | Updated step 4 to note Portal is live Dataview |
| `skills/obsidian-setup/SKILL.md` | Updated step 5 to clarify script scope |
| `state-templates/obsidian/Brain.md.template` | Added **Recent Inputs** Dataview section — live view of `raw/` sorted by recency, excluding `.archive/` |
| `state-templates/cortex-manifest.json.template` | Seeded `artifact_paths` with `"compiled"` so new hermits index durable outputs out of the box |

### Upgrade Instructions

Run `/claude-code-hermit:hermit-evolve`. The evolve skill handles:

1. **Update `/routines` invocations** — replace any manual invocations of `/claude-code-hermit:routines` with `/claude-code-hermit:hermit-routines`. If you have custom scripts or notes that reference `/routines load` or `/routines status`, update those references. No config or state changes required — the `routines` array in `config.json` is unchanged.

2. **Replace `obsidian/Cortex Portal.md`** with the new Dataview template — copy `${PLUGIN_ROOT}/state-templates/obsidian/Cortex Portal.md.template` to `obsidian/Cortex Portal.md` (overwrite). The file was previously machine-generated; it is now a static template that Obsidian's Dataview plugin renders live.

3. **Seed `cortex-manifest.json` with `compiled/`** — read `.claude-code-hermit/cortex-manifest.json`. If `artifact_paths` does not already contain `"compiled"`, append it. Write the file back. Skip if the file does not exist.

4. **Replace `obsidian/Brain.md`** with the new template — copy `${PLUGIN_ROOT}/state-templates/obsidian/Brain.md.template` to `obsidian/Brain.md` (overwrite). Adds the **Recent Inputs** Dataview section so operators can see what the hermit has been reading without `raw/` polluting the relationship map.

No `config.json` changes required.

---

## [1.0.11] - 2026-04-19

### Fixed

- **Always-on bootstrap prompt never submitted** — CC's TUI treated `send-keys '<text>' Enter` as bracketed paste, leaving the bootstrap in the input box unsubmitted; split into two calls with 0.5s gap.

### Files affected

| File | Change |
|------|--------|
| `scripts/hermit-start.py` | Bootstrap send split into two `tmux send-keys` calls (text, 0.5s sleep, Enter) so Claude Code's paste detection doesn't swallow the submit keystroke |

### Upgrade Instructions

`hermit-evolve` executes these steps in order:

1. **No `bin/hermit-start` regeneration needed** — `bin/hermit-start` is a thin wrapper that invokes the plugin's `scripts/hermit-start.py`. The fix lands automatically when the plugin updates; run `.claude-code-hermit/bin/hermit-stop && .claude-code-hermit/bin/hermit-start` to pick it up. Verify by attaching (`tmux attach -t <session>`) and confirming the composite bootstrap prompt is auto-submitted rather than sitting unprocessed in the composer.

No `config.json` changes required.

---

## [1.0.10] - 2026-04-19

### Fixed

- **Always-on bootstrap silently dropped `/heartbeat start` and `/routines load`** — three back-to-back `tmux send-keys` calls raced against the slow `/session` skill; replaced with one composite prompt that orders heartbeat-start → routines-load → session in a single Claude turn.
- **`/routines` missing from `CLAUDE-APPEND.md` Quick Reference** — skill landed in v1.0.9 but wasn't listed; operators couldn't discover it.

### Files affected

| File | Change |
|------|--------|
| `scripts/hermit-start.py` | Bootstrap rewritten — three racing `tmux send-keys` replaced with one composite prompt that orders heartbeat-start → routines-load → session in a single Claude turn; respects existing `auto_session` / `heartbeat.enabled` / `routines` config gates |
| `state-templates/CLAUDE-APPEND.md` | `/routines` added to Quick Reference line |

### Upgrade Instructions

`hermit-evolve` executes these steps in order:

1. **Refresh `CLAUDE-APPEND.md`** — re-append the updated appendix to the project's `.claude/CLAUDE.md` so operators see `/routines` in the Quick Reference. The skill itself has been usable since v1.0.9; this only fixes discoverability.
2. **No `bin/hermit-start` regeneration needed** — `bin/hermit-start` is a thin wrapper that invokes the plugin's `scripts/hermit-start.py`. The fix lands automatically when the plugin updates; just run `.claude-code-hermit/bin/hermit-stop && .claude-code-hermit/bin/hermit-start` to pick up the new bootstrap behavior. Verify by checking the operator-visible log shows `Bootstrap: ... queued` lines AND that `/claude-code-hermit:routines status` reports active CronCreate registrations after launch.

No `config.json` changes required.

---

## [1.0.9] - 2026-04-19

### Fixed

- **Routine delivery silently dropped in `--remote-control` + channels mode** — `routine-watcher.sh` `send-keys` calls were silently swallowed between turns; replaced with per-session `CronCreate` registrations via new `/hermit-routines` skill. `hermit-start.py` auto-loads routines on always-on launch.

### Added

- **`/claude-code-hermit:routines` skill** — manages per-session CronCreate registrations. Subcommands: `load` (register all enabled config.routines), `list` (show configured routines), `status` (show active CronCreate entries via CronList), `stop [id]` / `stop --all` (CronDelete). Changes take effect immediately — `hermit-settings routines` auto-runs `/routines load` after writing config.

- **`scripts/log-routine-event.sh`** — helper invoked by routine cron prompts to append timestamped fire events to `state/routine-metrics.jsonl` without asking the LLM to construct JSON.

### Removed

- `scripts/routine-watcher.sh`, `scripts/cron-match.py`, `scripts/routine-queue-flush.js`, `state-templates/routine-queue.json.template`, the `routines` tmux window in `hermit-start.py`, `routine-queue-flush` Stage 5 in `stop-pipeline.js`, the `routine-stale:<id>` heartbeat alert, and corresponding tests.

### Files affected

| File | Change |
|------|--------|
| `skills/routines/SKILL.md` | New skill — load/list/status/stop subcommands |
| `scripts/log-routine-event.sh` | New helper — append `fired` events to `routine-metrics.jsonl` |
| `scripts/hermit-start.py` | Removed routine-watcher tmux window; auto-sends `/routines load` after `/heartbeat start` when `config.routines` is set |
| `scripts/stop-pipeline.js` | Removed Stage 5 `routine-queue-flush` call |
| `skills/heartbeat/SKILL.md` | Removed stale-queue check and `routine-stale:<id>` alert; footer updated |
| `skills/hermit-settings/SKILL.md` | Routines section auto-invokes `/routines load` after config write — changes apply live, no restart needed |
| `skills/hatch/SKILL.md` | No longer copies `routine-queue.json.template`; metrics log description updated |
| `skills/smoke-test/SKILL.md` | Removed `routine-queue.json` shape repair |
| `skills/session-start/SKILL.md` | Removed `routine-watcher` from advisory-lock holders list |
| `agents/session-mgr.md` | Removed routine-watcher from `session_state` writers note |
| `tests/run-hooks.sh`, `tests/run-contracts.py` | Removed routine-queue-flush and cron-match tests |
| Docs | `always-on-ops.md`, `troubleshooting.md`, `architecture.md`, `skills.md`, `how-to-use.md`, `state-templates/CLAUDE-APPEND.md` updated |

### Upgrade Instructions

`hermit-evolve` executes these steps in order:

1. **Delete the obsolete queue file.** `rm -f .claude-code-hermit/state/routine-queue.json` — the bash watcher no longer exists, the file is orphaned.
2. **Register routines via CronCreate.** Invoke `/claude-code-hermit:routines load`. This replaces the old bash-watcher behavior live with no session restart. Confirm the result line shows `Routines registered: <ids> (<N> ok, 0 failed)`.
3. **Verify.** Invoke `/claude-code-hermit:routines status` and confirm one `[hermit-routine:<id>]` entry per enabled routine in `config.json`.
4. **Tell the operator about residual tmux noise.** If the hermit is running in always-on / tmux mode, the old `routines` tmux window keeps a defunct `routine-watcher.sh` process alive (POSIX keeps the process running even though the script file was deleted). It will print `python3: can't open file '.../cron-match.py'` errors on its loop until next `.claude-code-hermit/bin/hermit-stop`. **Harmless — ignore.** Operators who want a clean tmux state can do a one-time `.claude-code-hermit/bin/hermit-stop && .claude-code-hermit/bin/hermit-start` at their convenience.

No `config.json` changes required. Interactive `/session` users who want routines active in interactive mode must run `/claude-code-hermit:routines load` themselves — `hermit-start.py` only auto-loads in always-on mode.

---

## [1.0.8] - 2026-04-18

### Fixed

- **docker: hermit plugin installed but not enabled** — entrypoint now runs idempotent `claude plugin enable` every boot so containers self-heal on restart.
- **docker-setup: stale REPL swallowed channel pairing** — sends `/reload-plugins` once before first pair command.
- **docker-compose: `stop_grace_period` raised to 60s** — 10s SIGKILL'd mid graceful session-close.
- **docker-setup: avoids `hermit-docker up` echo hints** — uses `docker compose up -d` directly during setup so the outer LLM doesn't follow the trailing "attach" suggestion.
- **docker-setup: recommended plugins mirror host install** — step 7b reads host project/local plugins instead of a canned list; entrypoint adds marketplace before install; safelist preselects `claude-plugins-official` + `gtapps/*` only, third-party requires explicit opt-in; `org/repo` regex validator rejects malformed values.
- **entrypoint: recommended-plugin re-install loop** — `install_target in installed` set-membership check never matched raw line output; switched to substring match.
- **hermit-docker login: double-OAuth race** — REPL's auth check + `/login` opened two URLs racing on `.credentials.json`. Now uses one-shot `claude auth login` gated by `claude auth status --json`.

### Added

- **docker-setup step 8b: clean restart** — `hermit-docker down` + `up -d` so first real session has plugins loaded and no setup chatter in transcript.
- **routine fire metrics** — `routine-watcher.sh` appends `queued`/`fired`/`dequeued` to `state/routine-metrics.jsonl`; reflect uses it to propose retiming idle routines.

### Files affected

| File | Change |
|------|--------|
| `state-templates/bin/hermit-docker` | `login` subcommand replaced `claude /login` with auth-status-gated `claude auth login` |
| `state-templates/docker/docker-entrypoint.hermit.sh.template` | Banner warns against manual `claude` invocation; timeout error message updated; third-party marketplace auto-add on boot; unconditional idempotent `claude plugin enable claude-code-hermit` on every boot |
| `skills/docker-setup/SKILL.md` | Step 7b now mirrors host-installed plugins; login guidance updated; `/reload-plugins` sent once before channel pairing; mid-setup uses raw `docker compose up -d` to avoid LLM-misleading echo hints; new step 8b clean-restart at end |
| `state-templates/docker/docker-compose.hermit.yml.template` | `stop_grace_period: 60s` added so SIGTERM graceful session-close has time to complete |
| `skills/hermit-settings/SKILL.md` | Removed third-party plugin warning; unified restart instruction |
| `skills/reflect/SKILL.md` | Routine health check reads `routine-metrics.jsonl`; idle routine proposal path added |
| `skills/hatch/SKILL.md` | Initializes `state/routine-metrics.jsonl` |
| `scripts/routine-watcher.sh` | Emits `queued`/`fired`/`dequeued` events to `routine-metrics.jsonl` |
| `docs/config-reference.md` | Updated `enabled` field description; security model note rewritten |
| `docs/recommended-plugins.md` | Third-party section rewritten to reflect auto-install |

### Upgrade Instructions

Run `/claude-code-hermit:hermit-evolve`. The evolve skill handles:

1. **Create `state/routine-metrics.jsonl`** — If `.claude-code-hermit/state/routine-metrics.jsonl` does not exist, create it as an empty file. No content required — `routine-watcher.sh` appends to it on the next routine fire.

2. **Add domain hermit or third-party plugins to container** — Re-run `/claude-code-hermit:docker-setup` (or `/hermit-settings docker`) to mirror host-installed plugins into `config.json docker.recommended_plugins`, then rebuild the container. Only `project` and `local`-scope plugins are mirrored; user-scope plugins are ignored (install them at `project` scope on the host first if you want them in the container). If a domain hermit is already installed on the host but missing from `docker.recommended_plugins`, add it manually: `add <plugin> <org/repo-marketplace>`.

3. **Update `bin/hermit-docker` login subcommand** — Replace the `login)` case body in `.claude-code-hermit/bin/hermit-docker` with the new auth-status-gated form. Find the block starting with `login)` and ending with `;;`, and replace the body so `hermit-docker login` runs `claude auth status --json` first, then `claude auth login` only if not already authenticated.

4. **Regenerate Docker scaffolding** — the entrypoint self-heal fix is COPY'd into the image at build time, and the `stop_grace_period: 60s` fix is in `docker-compose.hermit.yml`. Both apply only after regeneration. Re-run `/claude-code-hermit:docker-setup` (which regenerates `docker-entrypoint.hermit.sh` and `docker-compose.hermit.yml` and triggers rebuild on next up), OR for the hermit-enable fix alone, remediate now without rebuild: `docker compose -f docker-compose.hermit.yml exec hermit claude plugin enable claude-code-hermit@claude-code-hermit --scope project`.

No `config.json` changes required.

---

## [1.0.7] - 2026-04-17

### Added

- **Baseline audit offer (first session)** — on the first session of a new hermit in an existing codebase, operator is offered a one-time audit using the plugins accepted at hatch (`claude-md-improver`, `claude-automation-recommender`). One proposal per plugin invocation. One-shot, marker-gated (`.baseline-pending`).

- **Reflect diagnostic counters** — `state/reflection-state.json` now tracks per-hermit reflect metrics under a `counters` key. No behavioral change to reflect itself.

  Tracked: `total_runs`, `empty_runs`, `runs_with_candidates`, `judge_accept`, `judge_downgrade`, `judge_suppress`, `proposals_created`, `micro_proposals_queued`, `last_run_at`, `last_output_at`, `since`.

  `pulse --full` surfaces a Reflect Health summary. `cortex-refresh` injects it into Cortex Portal.md.

### Changed

- **`GITIGNORE-APPEND.txt` (local scope): ignore `tasks-snapshot.md`** — `tasks-snapshot.md` is regenerated every turn by the `cost-tracker` hook from the native Tasks store, same category as `cost-summary.md` (already ignored). Adding it eliminates per-turn churn in `git status` for local-scope hermits. Project-scope gitignore unchanged — its "everything else is versioned" contract still applies.

- **`CLAUDE-APPEND.md`: `hermit-config-validator` added to Subagents section** — the agent was present in `agents/` and listed in `CLAUDE.md` but missing from the template injected into target projects. Deployed hermits had no LLM-visible documentation for this agent.

### Files affected

| File | Change |
|------|--------|
| `skills/reflect/SKILL.md` | `## State Update` extended with counter increment rules (single write per run) |
| `skills/hatch/SKILL.md` | Inline `reflection-state.json` init extended with `counters` object; Phase 4b baseline audit marker added |
| `skills/pulse/SKILL.md` | `--full` flag extended with Reflect Health section |
| `skills/session-start/SKILL.md` | Step 5b added: baseline audit offer on first session |
| `scripts/build-cortex.js` | Reads `counters` from `reflection-state.json`; injects Reflect Health block into Cortex Portal.md |
| `scripts/update-reflection-state.js` | New script — handles reflect state-update (counter increments, timestamps, missing-counters fallback) |
| `skills/reflect/SKILL.md` | `## State Update` replaced with single `update-reflection-state.js` call |
| `skills/hatch/SKILL.md` | `update-reflection-state.js` permission added to required allow list |
| `state-templates/GITIGNORE-APPEND-PROJECT.txt` | Ignore `.claude-code-hermit/.baseline-pending` |
| `state-templates/GITIGNORE-APPEND.txt` | Ignore `tasks-snapshot.md` for local-scope hermits |
| `state-templates/CLAUDE-APPEND.md` | `hermit-config-validator` added to Subagents section |
| `docs/always-on-ops.md` | Step 4 updated to mention baseline audit offer in always-on mode |

### Upgrade Instructions

Run `/claude-code-hermit:hermit-evolve`. The evolve skill handles:

1. **`tasks-snapshot.md` gitignore** — For local-scope hermits, append the new line to `.gitignore` and run `git rm --cached .claude-code-hermit/tasks-snapshot.md` if the file was previously tracked. Project-scope hermits are unaffected.

2. **Backfill `counters` on existing `reflection-state.json`** — Read `.claude-code-hermit/state/reflection-state.json`. If `counters` is absent, add it with all integer fields = `0`, both timestamp fields (`last_run_at`, `last_output_at`) = `null`, and `since` = current ISO timestamp (with offset). Preserve all other keys (`last_reflection`, `last_resolution_check`, `plugin_checks`, etc.). If the file is missing entirely, initialize with the full schema from `skills/hatch/SKILL.md`. If `counters` already exists, leave it untouched — no reset on upgrade.

3. **Add `update-reflection-state.js` permission** — In `.claude/settings.json`, add `"Bash(node */scripts/update-reflection-state.js*)"` to `permissions.allow`. Without this, reflect's state-update call will prompt for approval on every run.

4. **Refresh CLAUDE-APPEND** — Re-run `hatch` step that appends `CLAUDE-APPEND.md` to the project's `.claude/CLAUDE.md`, or manually append the `hermit-config-validator` entry to the `## Subagents` section.

No `config.json` changes required.

## [1.0.6] - 2026-04-17

### Changed

- **Storage convention tightened** — `type` frontmatter is the explicit discriminator; subdirs inside `raw/`/`compiled/` and new top-level dirs in `.claude-code-hermit/` are prohibited (artifacts there were invisible to injection and archival). New `docs/plugin-hermit-storage.md` is the canonical reference.
- **`CLAUDE-APPEND.md`: stale `reviews/` row removed from Agent State table** — `reviews/` was listed as a first-class directory but is prohibited by the storage rules in the same file. Removed to eliminate the contradiction.
- **`CLAUDE-APPEND.md`: `memory/` added to prohibited top-level directory list** — Matches the prohibition list in `docs/creating-your-own-hermit.md`.
- **`knowledge-schema.md.template`: `location:` field casing normalized** — Per-example `Location:` entries (capitalized) normalized to lowercase `location:` to match the field declaration style in the section headers.

### Files affected

| File | Change |
|------|--------|
| `state-templates/CLAUDE-APPEND.md` | Storage rules updated; `reviews/` row removed; `memory/` added to prohibited list |
| `state-templates/knowledge-schema.md.template` | `location:` fields added to Work Products and Raw Captures sections; casing normalized |
| `docs/creating-your-own-hermit.md` | Knowledge outputs section rewritten with explicit path format and prohibitions |
| `docs/plugin-hermit-storage.md` | New canonical reference for plugin hermit storage convention |

### Upgrade Instructions

Run `/claude-code-hermit:hermit-evolve`. The evolve skill handles:

1. **CLAUDE-APPEND.md refresh** — Replace the existing `CLAUDE-APPEND.md` appendix in the target project's `.claude/` directory with the updated template. This picks up the corrected Agent State table (no `reviews/` row) and the expanded prohibited-directory list (now includes `memory/`).

No `config.json` changes required. The `knowledge-schema.md.template` change only affects new hermits hatched from this version onward — existing `knowledge-schema.md` files in target projects are operator-editable and are not overwritten by `hermit-evolve`.

## [1.0.5] - 2026-04-16

### Fixed

- **docker-entrypoint: channel schema + silent marketplace failure** — channels read as list instead of object so `enabled: false` was ignored; `marketplace add` failures swallowed by `|| true`. Now filters disabled channels and surfaces marketplace errors explicitly.
- **docker-entrypoint: plugins installed but left disabled** — `claude plugin install` leaves plugins dormant; now calls `claude plugin enable` after each channel/recommended install.
- **`claude login` → `claude /login`** — correct CLI invocation; updated across `hermit-docker`, entrypoint, skills, and docs.
- **hermit-docker: `_require_running` preflight** — `attach`/`bash`/`login`/`restart` now check `$SERVICE` is up before `docker compose exec` and print a clear start-it-first message.
- **docker-setup step 8: readiness gates** — manual branch skips exec'd steps; "build now" polls `docker compose ps` 10s; workspace trust + channel pairing gate on `tmux has-session` to avoid "no server running" races.
- **docker-setup step 8: `access.json` verification** — channel pairing polls `.claude.local/channels/<plugin>/access.json` (~3s, retry ~8s) and shows `tmux capture-pane` on miss instead of declaring success.
- **docker-setup: broken doc link** — `recommended-plugins.md` path fixed to `../../docs/...`.

### Changed

- **hatch completion message** — "Go always-on" leads with `docker-setup`; `smoke-test` moved to troubleshooting note; `bypassPermissions` promoted to first permissions option.
- **migrate: scope confirmation gate (step 0)** — reads `config.json.scope` as authoritative, surfaces divergence with `.gitignore`, prompts to switch. Switching reconciles `config.json`, `.gitignore`, and `git rm --cached` for newly-ignored tracked paths behind one confirmation.

### Files affected

| File | Change |
|------|--------|
| `skills/migrate/SKILL.md` | Step 0 scope confirmation + reconciliation sub-flow; Step 1 scope detection updated |
| `state-templates/bin/hermit-docker` | `_require_running` helper; `claude login` → `claude /login` |
| `state-templates/docker/docker-entrypoint.hermit.sh.template` | `claude login` → `claude /login` in echo messages and comment |
| `skills/docker-setup/SKILL.md` | Step 8 readiness gates; doc link fix; `claude login` → `claude /login` |
| `skills/hatch/SKILL.md` | Completion message reorder; permissions option order; formatting |
| `docs/faq.md` | `claude login` → `claude /login` |
| `docs/troubleshooting.md` | `claude login` → `claude /login` |
| `docs/always-on.md` | `claude login` → `claude /login` |
| `docs/config-reference.md` | `claude login` → `claude /login` |
| `docs/architecture.md` | `claude login` → `claude /login` |
| `scripts/hermit-start.py` | `claude login` → `claude /login` in comment |
| `README.md` | Restructured introduction and quick start |

### Upgrade Instructions

Run `/claude-code-hermit:hermit-evolve`. The evolve skill handles:

1. **`hermit-docker` script** — Copy updated `state-templates/bin/hermit-docker` to `.claude-code-hermit/bin/hermit-docker`. This picks up the `_require_running` helper and the `claude /login` fix.
2. **`docker-entrypoint.hermit.sh`** — If Docker is in use, patch the rendered entrypoint at the project root: replace `claude login` with `claude /login` (two echo lines in the timeout paths). This is a cosmetic fix; the container still works — it only affects the error message shown when the 10-minute credential wait times out.

No `config.json` changes required.

## [1.0.4] - 2026-04-16

### Fixed

- **runtime.json: `waiting_reason` field** — records why session entered `waiting` (`unclean_shutdown`/`dead_process`/`conservative_pickup`/`operator_input`) so `channel-responder` routes `(1)`/`(2)` replies to archive-or-resume instead of treating them as task instructions.
- **session-mgr: `session_id` patched into SHELL.md on open** — header now correct from first tick instead of holding the placeholder until close.
- **session-mgr: `cost_usd` reads `.status.json` first** — hook-written cost was silently discarded when SHELL.md parse won; now status file takes precedence.
- **session-start fast-path: patches SHELL.md ID placeholder** — updates in-context without spawning session-mgr when runtime has the ID.
- **routine-watcher: drains stale queue entries on startup** — prunes entries >2h old to prevent phantom stale-routine alerts across restarts.
- **heartbeat: micro-proposal pending alert** — step 6 flags tier-1 entries in `micro-proposals.json` via `micro-proposal-pending:<id>` so they don't silently expire; stale queue message now includes elapsed time.

### Changed

- **proposal-act: accept no longer stamps `resolved_date`** — only sets `accepted_date`. `reflect` stamps `resolved_date` later once the pattern is absent from 3 sessions. Fixes `weekly-review.js` resolution count always being zero.
- **reflect: concrete Resolution Check procedure** — bounded round-robin (≤5/cycle) reads each accepted proposal's evidence, scans last 3 reports, marks resolved if absent. Position tracked in `reflection-state.json.last_resolution_check`.
- **reflection-judge: explicit `Sessions: none` gate** — step 0 short-circuits to `SUPPRESS` without evidence verification; reflect notes the suppression in SHELL.md Findings for revisit.
- **proposal-create: `source` + `category` in `created` events** — metrics now distinguish manual / auto-detected / operator-request and improvement / routine / capability / constraint / bug.
- **generate-summary.js: per-source acceptance + resolved count** — new `proposals_resolved` and `auto_detect_accept_rate` frontmatter fields answer "are autonomous proposals good?".
- **reflect + session-start: notification routing de-duplicated** — "Always-On Notification Rule" block replaced with one-liner deferring to CLAUDE-APPEND's Operator Notification section.
- **reflect: preserves micro-proposal `question` text in JSONL + active slot** — enables post-hoc analysis of what was asked vs operator response.
- **heartbeat: `noise_ticks` self-eval field** — counters increment when a dismissed-proposal-linked alert fires; at 20+ across 3+ sessions, proposes retuning or removing the check (mirrors `clean_ticks`).
- **docs/frontmatter-contract.md** — `resolved_date` writer updated to `reflect (pattern absence)`.

### Files affected

| File | Change |
|------|--------|
| `agents/session-mgr.md` | `waiting_reason` field docs; `session_id` → SHELL.md on open; `cost_usd` reads `.status.json` first |
| `scripts/routine-watcher.sh` | Drain stale queue entries older than 2h on startup |
| `skills/channel-responder/SKILL.md` | Route `waiting_reason` for unclean shutdown / dead process replies |
| `skills/heartbeat/SKILL.md` | `micro-proposal-pending` alert key; step 6 micro-proposal check; `noise_ticks` self-eval field; stale queue message includes elapsed time; `waiting_reason` on NEXT-TASK.md conservative pickup |
| `skills/session-start/SKILL.md` | Set `waiting_reason` on unclean shutdown / dead process; fast-path patches SHELL.md ID; de-duplicate notification routing |
| `skills/proposal-act/SKILL.md` | Remove `resolved_date` stamp from accept flow |
| `skills/reflect/SKILL.md` | Add resolution check procedure; de-duplicate notification routing; preserve micro-proposal `question` in JSONL |
| `agents/reflection-judge.md` | Add explicit `Sessions: none` suppression gate |
| `skills/proposal-create/SKILL.md` | Add `source` and `category` to `created` metrics events |
| `scripts/generate-summary.js` | Per-source acceptance rates and resolved count |
| `docs/frontmatter-contract.md` | Update `resolved_date` lifecycle table |

### Upgrade Instructions

Run `/claude-code-hermit:hermit-evolve`. The evolve skill handles:

1. **No config.json changes required** — all changes are in skill/agent files.
2. **`state/reflection-state.json`** — if it exists and lacks a `last_resolution_check` key, no action needed; the resolution check procedure initializes it on first run.
3. **`state/alert-state.json` self_eval entries** — existing entries lack `noise_ticks`. The heartbeat self-eval step initializes missing fields as 0 on first read; no manual migration needed.
4. **Existing `proposal-metrics.jsonl` events** — old `created` events without `source`/`category` fields are handled by `generate-summary.js` bucketing them as `unknown`. No backfill required.
5. **Accepted proposals with `resolved_date` already set** — these were stamped at accept time under the old behavior. They may show a `resolved_date` even though `status` is `accepted`, not `resolved`. On first reflect run, the resolution check will re-evaluate them. If the pattern is gone, they'll be promoted to `resolved` (updating `resolved_date` to the current time). If not, `resolved_date` stays set but `status` remains `accepted` — a cosmetically odd but non-breaking state that will self-heal.

## [1.0.3] - 2026-04-16

### Added

- **`proposal-triage` agent (Haiku)** — pre-creation gate: deduplicates against existing PROP-NNN files and applies the three-condition rule; returns `CREATE | SUPPRESS:<reason> | DUPLICATE:<id>`.
- **`reflection-judge` agent (Sonnet)** — post-reflect validator: verifies cited sessions actually describe the claimed pattern before proposals are queued; returns `ACCEPT | DOWNGRADE:<tier> | SUPPRESS`.
- **`knowledge` skill** — read-only lint of `raw/` and `compiled/`; flags stale, unreferenced, missing-type, and oversized artifacts; delegates to `scripts/knowledge-lint.js`.
- **`scripts/knowledge-lint.js`** — shared lint module extracted from `weekly-review.js`; eliminates duplicated inline logic.
- **Test infrastructure: `tests/run-all.sh`, `tests/lib.sh`, `tests/run-scripts.sh`** — unified entry point for hook, contract, and script suites; shared assertions via `lib.sh`.

### Changed

- **`reflect`: evidence validation pipeline** — delegates each candidate to `reflection-judge` before acting; Tier 1/2 pass through `proposal-triage` before micro-approval; Tier 3 passes through triage before `proposal-create`.
- **`proposal-create`: pre-creation gate** — calls `proposal-triage` before writing; stops on DUPLICATE or SUPPRESS.
- **`pulse --full`** — new flag that appends infrastructure health sections after the session block: proposal counts by status, pending micro-proposals, routines on/off, last reflect/heartbeat timestamps, and knowledge file counts (`raw/`, `compiled/`, `raw/.archive/`).
- **`heartbeat`: IDLE-TASKS management** — when the operator asks about idle tasks (add, remove, manage), heartbeat now reads/writes `.claude-code-hermit/IDLE-TASKS.md` instead of HEARTBEAT.md. Creates the file from template if absent. Warns if `idle_behavior` is not `"discover"`.
- **`weekly-review.js`: simplified via shared lint** — knowledge health section now calls `knowledgeLint()` from `knowledge-lint.js` instead of duplicating the logic inline. Output format updated to per-finding lines with file, age, and reason.
- **`HEARTBEAT.md.template`: removed two redundant built-in checks** — "Check for NEXT-TASK.md" and "Check if current task has blocked items that may have resolved" are handled natively by the heartbeat skill. Removed to reduce LLM reasoning load per tick.
- **Test runner unified** — `tests/run-hooks.sh` refactored to use shared lib. All suites now accessible via `bash tests/run-all.sh`. Smoke-test-runner agent updated to use the unified entry point.
- **`CLAUDE.md` and `CLAUDE-APPEND.md`** — `proposal-triage` and `reflection-judge` added to agent listings. `/knowledge` added to CLAUDE-APPEND.md Quick Reference. Subagent section in CLAUDE-APPEND.md expanded with descriptions for all four agents.

### Files affected

| File | Change |
|------|--------|
| `agents/proposal-triage.md` | New agent |
| `agents/reflection-judge.md` | New agent |
| `skills/knowledge/SKILL.md` | New skill |
| `scripts/knowledge-lint.js` | New shared lint module |
| `tests/run-all.sh` | New unified test entry point |
| `tests/lib.sh` | New shared test assertions library |
| `tests/run-scripts.sh` | New script/static test suite |
| `tests/run-hooks.sh` | Refactored to use lib.sh |
| `skills/reflect/SKILL.md` | Evidence validation + triage gate |
| `skills/proposal-create/SKILL.md` | Pre-creation triage gate |
| `skills/pulse/SKILL.md` | `--full` infrastructure health flag |
| `skills/heartbeat/SKILL.md` | IDLE-TASKS management subcommand |
| `scripts/weekly-review.js` | Delegates knowledge lint to shared module |
| `state-templates/HEARTBEAT.md.template` | Removed redundant built-in check items |
| `state-templates/CLAUDE-APPEND.md` | Added `/knowledge`, agent descriptions |
| `CLAUDE.md` | Added proposal-triage and reflection-judge to agent list |
| `docs/skills.md` | knowledge skill entry; pulse --full documented |
| `docs/architecture.md` | Minor updates |
| `README.md` | Updated |
| `.claude/agents/smoke-test-runner.md` | Updated to use run-all.sh |
| `.claude/skills/test-run/SKILL.md` | Updated for unified test runner |
| `.claude/skills/release/SKILL.md` | Release process improvements |

### Upgrade Instructions

Run `/claude-code-hermit:hermit-evolve`. The evolve skill handles:

1. **CLAUDE-APPEND refresh** — refresh CLAUDE-APPEND.md to pick up `/knowledge` in Quick Reference and the updated Subagents section (replaces the old single-line `## Subagent: session-mgr` entry).
2. **No config.json changes required** — all new behavior is in skill/agent files.
3. **New agents are available immediately** — `proposal-triage` and `reflection-judge` ship with the plugin; no per-project action needed. Skills that call them (`reflect`, `proposal-create`) will use them automatically.

**Clean up HEARTBEAT.md (if applicable):**

1. Read `.claude-code-hermit/HEARTBEAT.md`. If the file does not exist, skip these steps.
2. Remove the line `- Check for NEXT-TASK.md` if present. Remove the line `- Check if current task has blocked items that may have resolved` if present.
3. After both removals, for each of `## Idle Checks` and `## Task Checks`: if the header now has no remaining checklist items beneath it, remove that header too.
4. If any changes were made, write the file back and report what was cleaned up. If nothing changed, skip silently.

## [1.0.2] - 2026-04-15

### Fixed

- **Fully qualified agent/skill names enforced throughout skill instructions** — Bare names (e.g., `:session-mgr`) were silently misrouted by the harness. All skill instruction files now use the canonical `claude-code-hermit:<name>` form. Affects every skill that spawns a subagent or invokes another skill.
- **session-mgr: null `session_id` fallback on runtime.json write** — If `session_id` was null or missing when setting `session_state` to `in_progress`, the session would archive under `S-null`. Step 7 now pre-computes the ID in the same write if it wasn't set in step 6.
- **session-mgr: invocation payload takes precedence over stale SHELL.md** — On both close and idle-transition, if the caller passes structured task data (status, blockers, lessons, changed files), those values are used directly instead of re-reading potentially stale SHELL.md fields.

### Changed

- **session-start: fast-path gate skips session-mgr on normal startup** — when `runtime.json` is healthy and SHELL.md exists, no agent spawn; eliminates a full agent turn on every normal session start.
- **session / session-close: compile final data in-context before handing off to session-mgr** — callers pass a compact structured payload, preventing stale SHELL.md re-reads from overwriting in-context data.
- **session-mgr: maxTurns reduced from 15 to 12** — Consistent with actual observed turn counts; the previous ceiling was never reached.
- **hermit-settings: improved guidance** — Clearer instructions for configuring hermit behavior.

### Files affected

| File | Change |
|------|--------|
| `agents/session-mgr.md` | maxTurns 15→12; null session_id fallback; payload-precedence rule on close/idle |
| `skills/session-start/SKILL.md` | Fast-path gate: skip session-mgr when runtime state is clean |
| `skills/session/SKILL.md` | Compile final data in-context; structured compact payload to session-mgr |
| `skills/session-close/SKILL.md` | Compile final data in-context; structured compact payload to session-mgr |
| `skills/hermit-settings/SKILL.md` | Improved configuration guidance |
| All skill/agent instruction files | Bare agent/skill names replaced with fully qualified `claude-code-hermit:` form |

### Upgrade Instructions

Run `/claude-code-hermit:hermit-evolve`. The evolve skill handles:

1. **CLAUDE-APPEND refresh** — No changes to CLAUDE-APPEND.md in this release; refresh is not required.
2. **No template changes** — State templates and `config.json` are unchanged.
3. **Behavioral changes are in skill/agent instruction files only** — These take effect immediately via the plugin; no per-project migration needed.

No `config.json` changes required.

## [1.0.1] - 2026-04-15

### Fixed

- **State JSON files now copied from templates during hatch** — `alert-state.json`, `routine-queue.json`, and `micro-proposals.json` were previously written inline by the LLM, producing malformed content that silently broke routine queuing.
- **Smoke-test validates and repairs state file schema** — new step 6 checks all three schema-sensitive files; repairs without discarding existing data; emits WARN per repaired file.

### Added

- `state-templates/routine-queue.json.template` — canonical initial content `{"queued": []}`
- `state-templates/alert-state.json.template` — canonical initial content with `alerts`, `self_eval`, `total_ticks`, `last_digest_date`
- `state-templates/micro-proposals.json.template` — canonical initial content `{"active": null}`

### Files affected

| File | Change |
|------|--------|
| `state-templates/routine-queue.json.template` | New template |
| `state-templates/alert-state.json.template` | New template |
| `state-templates/micro-proposals.json.template` | New template |
| `skills/hatch/SKILL.md` | Copy 3 state files from templates instead of inline LLM JSON |
| `skills/smoke-test/SKILL.md` | Add step 6: state file validation and repair |

### Upgrade Instructions

Run `/claude-code-hermit:hermit-evolve`. The evolve skill handles:

1. **CLAUDE-APPEND refresh** — No changes to CLAUDE-APPEND.md in this release; refresh is not required.
2. **Template copy** — The three new `.template` files are only used during `hatch`. Existing hermit state files are not touched automatically; if you suspect a malformed state file, run `/claude-code-hermit:smoke-test` to detect and repair it.

No `config.json` changes required.

## [1.0.0] - 2026-04-14

Initial public release.
