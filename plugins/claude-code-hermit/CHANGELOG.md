# Changelog

## [Unreleased]

### Added
- Localized script-owned channel messages: budget, auto-mode denial, mint/reauth, watchdog lifecycle, and `channel-status-responder` replies now compose in the operator's `language` (en / pt-PT; any Portuguese signifier resolves to `pt-PT`) instead of hardcoded English. Default config (`language` null) stays byte-identical.
- Tiered operator notifications via per-channel `maintainer_channel_id` and top-level `operator_profile`. Technical, operational, and spend content routes to an outbound-only maintainer chat (or `SHELL.md` Findings under `non-technical` with no maintainer chat), while the primary chat sees plain-language client copy. `resolve-outbound-channel.ts` emits a sanitized `language` in its success JSON, and `channel-send.ts` gains `--tier client|maintainer`.

### Changed
- Auto-mode denial message rewritten to plain channel voice ("One action could not run because it needed approval. Work that doesn't depend on it can continue. You don't need to fix this.") for every install. The tool name, sanitized input, and reason now route to the maintainer chat or `SHELL.md` Findings, not a second message in the client chat.
- Watchdog lifecycle messages (restart, wedge, forced-pause, stalled-question) localized and sent maintainer-tier. Stock installs with no maintainer chat stay byte-identical.
- Mint/reauth pins the resolved primary chat as its reply route and marks its sends sensitive, keeping the OAuth sign-in URL out of the searchable channel log.

### Fixed
- Model-override routines (weekly `doctor`, `daily-auto-close`) composed operator-facing notifications in English regardless of configured `language`, because the dispatched subagent never saw the SessionStart language injection. The dispatch prompt now carries a language clause and `resolve-outbound-channel.ts` returns the language.
- A budget alert that degrades to `SHELL.md` Findings because a configured maintainer channel is unreachable no longer counts as delivered, so heartbeat re-announces it once the channel recovers instead of silently marking it notified.
- `hermit-start` and the Docker entrypoint now refuse to boot a second instance over a live one for the same project (host↔Docker split-brain guard); override with `HERMIT_FORCE_BOOT=1`.
- The boot singleton guard no longer false-blocks over a *cleanly-stopped* instance: a `session_state: idle` or `shutdown_completed_at` marker is treated as definitive death, so a host↔Docker switch within ~10 min of a clean stop boots instead of stalling on the still-fresh liveness file.
- `hermit-docker up` no longer reports a phantom `BOOT CONFLICT` from a stale `.boot-conflict` marker left by a prior inert boot, and a clean stop no longer waits the full process-kill grace period when nothing survived.
- `hermit-stop` and watchdog restarts now verify the claude process tree exited, terminate survivors with `SIGTERM`, and refuse to report success otherwise (`last_error: orphaned_process`, non-zero exit, shutdown left pending).
- Channel messages arriving while a shutdown is pending now get a deterministic "shutting down" reply and no longer reach the model.

### Upgrade Instructions
1. Add `"operator_profile": "technical"` to `config.json` if absent (top-level, beside `language`). This is the safe default: keep it `technical` for a self-run box, and set it to `"non-technical"` only on a client-facing install where the person on the channel is not the maintainer.
2. Refresh the § Operator Notification block in the operator's `CLAUDE.md` / `CLAUDE.local.md` from the current `state-templates/CLAUDE-APPEND.md` (it adds the **Language & audience** paragraph and the resolver `language` note). If your evolve already re-syncs the marker-delimited hermit block, this is covered automatically.
3. Re-register CronCreate-fallback routines (`/claude-code-hermit:hermit-routines load`) so their stored dispatch prompts pick up the new language clause. Monitor-delivery installs (the default) re-read the skill on each fire and need nothing.
4. Maintainer-channel question, unattended-safe: apply the safe default (leave `maintainer_channel_id` unset, so technical detail lands in `SHELL.md` Findings), then send the question itself as a maintainer-tier channel message: "denial detail now goes to Findings, reply if you'd like it in a chat instead, and optionally set a maintainer channel id." If no channel exists, record it as a Findings pending note instead. An attended evolve may ask this inline.
5. The `bin/hermit-docker` and Docker entrypoint changes ride the standard bin-wrapper refresh — let evolve re-sync the `bin/` wrappers as usual; do not blind-copy them.
6. **Docker hermits — refresh the on-disk entrypoint BEFORE rebuilding.** Refresh the on-disk `docker-entrypoint.hermit.sh` from `state-templates/docker/docker-entrypoint.hermit.sh.template` first (re-run `/claude-code-hermit:docker-setup` or patch it surgically), THEN run `hermit-docker update`. The rebuild uses the on-disk entrypoint, not the template (see CLAUDE.md § Debugging gotchas), so a plain `update` rebuilds with the stale boot guard.
7. The compose template added a `HERMIT_FORCE_BOOT` env line. Existing installs can re-run `/claude-code-hermit:docker-setup` to regenerate the compose file, or add the line manually; it stays unset by default (the singleton guard is only overridden when `HERMIT_FORCE_BOOT=1`).

## [1.2.32] - 2026-07-23

### Fixed
- In artifact republish, `force: true` on redeploys — Claude Code 2.1.x rejects a same-URL `Artifact` redeploy from a session that never viewed the current version ("hasn't viewed the latest version"), which fired on every dashboard/proposals/weekly-review refresh after a restart. These pages are single-writer and deterministically re-rendered, so there's nothing to merge; redeploys now pass `force: true`.
- In channel hooks, resolve plugin-qualified envelope sources to the configured channel key — inbound messages carry `source="plugin:discord:discord"` on the wire, but `config.json` keys channels by the bare server name; the mismatch silently dead-ended `pause`/`stop`/`resume`/`snooze` and the deterministic `status` reply fleet-wide. `allowed_users` now also enforces correctly on the reply-reminder/log path for plugin-qualified sources (previously fell through to accept-all). The auth gate and the reply/send path now normalize through the same helper, so a config keyed by the qualified source can no longer pass auth while failing to route or attribute cost.
- Setup-token stored `/login` credentials no longer shadow the login token — token install and the Docker boot gate now park a stale `.credentials.json` (rename to `.credentials.json.pre-token.bak`). Interactive Claude Code sessions authenticate with a stored `/login` credential ahead of `CLAUDE_CODE_OAUTH_TOKEN` (the reverse of the documented precedence, confirmed live on CC 2.1.218), so a converted hermit that kept its old login file 401'd ~8h later when that stored access token lapsed, while its valid year-long token sat unused.
- In doctor, `credential-expiry` warns when a live `/login` credential shadows the token — in token mode, a `.credentials.json` still carrying an access token is flagged with the exact absolute `mv` park command (previously a bare relative path, which only worked when the operator's cwd was the config dir). A parked file or a `/logout` stub is inert and stays `ok`. Check count unchanged.

### Upgrade Instructions
1. **Docker hermits — refresh the on-disk entrypoint BEFORE rebuilding.** `hermit-docker update` rebuilds with the operator's on-disk `docker-entrypoint.hermit.sh`, not the plugin template. Re-run `/claude-code-hermit:docker-setup` (or patch the on-disk copy from `state-templates/docker/docker-entrypoint.hermit.sh.template`) first, then `hermit-docker update`. This carries the §0c credential-parking guard.
2. **Already-converted token-mode hermits — park the stale credential now.** If the hermit uses `setup-token` auth and still has a `.credentials.json`, park it: `docker exec <stack>-hermit-1 mv /home/claude/.claude/.credentials.json /home/claude/.claude/.credentials.json.pre-token.bak`, then restart the container. The refreshed entrypoint (step 1) also does this automatically at the next boot; this step recovers a hermit that is already dark now.
3. **Returning to `/login` auth (rare).** The parking guard only fires while a setup-token is present, so to switch a hermit back to `/login`, delete `.hermit-setup-token` first, then run `hermit-docker login`.

## [1.2.31] - 2026-07-22

### Fixed
- Hermit-docker warns when the container runs a stale baked entrypoint — `up`, `restart`, and `update --plugins-only` content-hash the on-disk `docker-entrypoint.hermit.sh` against the image's baked copy and warn to rebuild on mismatch; `update`'s evolve chain flags when a second rebuild is needed.
- In hermit-docker / hermit-exec, version-aware error for a stale plugin clone — a subcommand the container's clone predates (e.g. `setup-token` on a pre-1.2.30 clone) reports the version skew and points at `update` instead of the misleading "plugin may be corrupted, reinstall".
- In watchdog, re-arm fallback damped and pause-gated — the step-5 heartbeat-restart re-arm re-injected both bootstrap prompts every ~5-min tick while the fired-age stayed >26h; now one attempt per 6h window, and never while paused.

## [1.2.30] - 2026-07-21

### Added
- Docker long-lived login token auth (`claude setup-token`) — subscription logins expire on an unknowable date and recovery needed SSH access to the box; the hermit now mints its own 1-year token, so expiry is deterministic. Stored `0600` on the config volume (never `.env` — `env_file` applies at container creation, which would force a host-side recreate per renewal) and exported by the launcher at process start. New default for `/docker-setup`; `/login` and API-key remain documented alternatives.
- In doctor, core self-declares its login token to `credential-expiry` — the check now walks core's own `hermit-meta.json` alongside siblings', and honours a per-credential `warn_days` (core uses 14; default stays 7). Check count unchanged.
- `/claude-code-hermit:relogin` — renews the login token over the operator's channel: relays a one-time sign-in link, takes the code back, installs, restarts. The token itself never crosses the channel.
- In watchdog, reactive re-auth recovery — a lapsed token is detected and recovered deterministically with no model in the loop (the hermit can't reason without a login). Ack-first: it asks the operator to reply `reauth` before minting anything, so a one-time link is never burned while nobody is watching.
- `hermit-docker setup-token` — terminal front door for the same flow, for conversion and fresh installs. `hermit-watchdog restart <reason>` exposes the existing locked restart path that all three front doors share.
- Proposal lifecycle fully Bash-scripted state writes — new `scripts/proposal.ts` CLI (`create`, `patch`, `shell-append`, `next-task`, `routine`) replaces the Write/Edit tool calls on `.claude-code-hermit/`, which the harness blocks in background/worktree sessions. `create` claims the ID atomically with the file write, closing the burned-ID half-created-state hazard.

### Changed
- In proposal-create/proposal-act, no Write/Edit tool calls on `.claude-code-hermit/` remain — both skills invoke `proposal.ts` verbs; the next-prop-id/append-metrics/generate-summary steps in proposal-create fold into `proposal.ts create`; Resolve's compact-requested.json write moves to `--request-compact`.
- Transactional markdown helpers promoted from `apply-reflection-actions.ts` into `scripts/lib/md-write.ts`; proposal-ID logic extracted into `scripts/lib/prop-id.ts` (`next-prop-id.ts` is now a thin CLI wrapper over it, contract unchanged); `generate-summary.ts` gains an `import.meta.main` guard and exports `run` so other scripts can call it directly instead of spawning a subprocess.

### Removed
- Dropped the pre-frontmatter bullet-metadata reader in proposals. `**Status:**`-style metadata is no longer parsed. Frontmatter has been the canonical proposal format since 1.0.0 and no write path has been able to patch a bullet-metadata file for some time, so a legacy file listed as actionable but could not be accepted, deferred, dismissed, or resolved. Such a file now surfaces in `proposal-list` as status `unknown` rather than showing recovered metadata it can't act on; it is still listed, never silently dropped. The `proposals-index.json` row flag is renamed `legacy` → `unparseable` to match what it now means; nothing reads the value, and the index is fully regenerated on the next proposal write.

### Upgrade Instructions
1. Re-run `bun ${CLAUDE_PLUGIN_ROOT}/scripts/apply-settings.ts <hatch-target settings file> allow` to seed the permission for `scripts/proposal.ts`. Without this, proposal lifecycle actions (create/accept/defer/dismiss/resolve) prompt for permission — functionally denied in headless/channel/background sessions.
2. Re-running the same `apply-settings.ts ... allow` command above also seeds the permission for `scripts/setup-token-mint.ts`. Without it, `/relogin` prompts — which is a denial in the channel session it is designed to run in.
3. **Docker hermits only — refresh the on-disk entrypoint BEFORE rebuilding.** `hermit-docker update` rebuilds with the operator's on-disk `docker-entrypoint.hermit.sh`, not the plugin template, so bumping the plugin and running `update` alone rebuilds with the old entrypoint. Re-run `/claude-code-hermit:docker-setup` (or patch the on-disk copy from `state-templates/docker/docker-entrypoint.hermit.sh.template`) first, then `hermit-docker update`. This carries the boot-gate fix for token auth.
4. **Optional — convert an existing Docker hermit to token auth:** run `.claude-code-hermit/bin/hermit-docker setup-token`, complete the browser step, done. Nothing will nag you to convert. Until you do, the hermit keeps using its `/login` credentials and still goes dark when they expire; after converting, renewal is a once-a-year prompt on your channel with no server access.
5. **Never run `/logout` inside the container.** It deletes the stored credentials *and* resets first-launch state, after which the interactive wizard demands a login and refuses the token. No renewal path needs it.

### Fixed
- Docker entrypoint no longer false-blocks a token-auth hermit at boot — the §0/§0b credential gates only understood API-key and `/login` auth, so a hermit using a long-lived token sat waiting on the stale `expiresAt` of a `.credentials.json` it wasn't using. Both gates now recognise token mode, keyed on the token file (the env var is exported later, after the entrypoint runs). §0b is skipped even when the token has expired: booting a 401-alive session keeps channel ingestion up, which is what the reactive recovery relies on to reach the operator.
- In `hermit-docker login`, short-circuits on token-mode hermits — it mirrored the same stale `expiresAt` check and would have reported "expired" forever on every converted hermit, pushing operators into a login they don't need.
- Session-start configured operator language no longer drops mid-session — SessionStart context (full start and the post-compaction capsule) now carries `operator_language` from config.json, so replies and notifications keep the operator's language after crash recovery, resume, and compaction. Underscore locale codes (`pt_BR`) are accepted, and the capsule emits the fact first so a state-heavy hermit doesn't lose it to the compaction-capsule size cap.
- In startup-context, `config.json` `language` runs the injection threat scan — the value is settable via `hermit-settings` on a channel turn, so it is remote-influenceable; the structural whitelist alone would have passed a letters-and-spaces injection phrase into every session's context. It now blocks and records a `config.json:language` hit like every other injected surface.

## [1.2.29] - 2026-07-20

### Added
- Transcript-digest ground-truth behavioral telemetry for reflect — new `scripts/transcript-digest.ts` mines recent session transcripts into verdict-sized JSON counters (tool failures, rejections by kind, wakes vs productive wakes, compactions, subagent dispatches). Reflect's new weekly `behavior` phase cites them as machine-measured evidence via a defer-loop auto-row and anomaly checklist. Self-activates on the next scheduled reflect; no migration.
- Session-close deterministic midnight decision — new `session-archive.ts auto-close-decision` verb replaces the `--scheduled` prose branch table (noop / queued / close-now); the 10-min lull constant moves to `scripts/lib/auto-close.ts`, shared with the heartbeat-precheck drain and the watchdog post-close-clear backoff.
- Reflect transactional apply of runner resolution actions — new `scripts/apply-reflection-actions.ts` validates the whole `resolution_actions` batch before any write (frontmatter patch, proposal-metrics append, Findings line); invalid batches write nothing.
- In reflect/session, `--scheduled-check-run <id>` cursor flag — `update-reflection-state.ts` writes `scheduled_checks.<id>.last_run` directly; session step 4b no longer hand-edits reflection-state.json.

### Changed
- Session-archive owns post-archive markers — idle archive writes `state/compact-requested.json`; close/auto delete `state/pending-close.json`; auto also writes `state/clear-requested.json`. Outcomes reported in a `markers` output field and never flip `ok`; recover re-archives suppress the marker writes (still delete pending-close). Skills stop doing this bookkeeping in prose.

### Fixed
- In session-archive, derive session cost from the cost-log window, not `.status.json` — `.status.json` is a cumulative running total, so auto-closed sessions were stamped with the hermit's lifetime spend, inflating report `cost_usd`/`tokens` and `weekly-review`'s weekly total.
- In session-archive, open the cost arc at session open — a session archived before its first tracked turn measured the previous session's window and inherited its cost.
- In apply-settings, seed permissions for the new reflect scripts — `apply-reflection-actions.ts` and `transcript-digest.ts` were missing from the sealed allow-list, so a headless reflect was functionally denied on both and silently degraded to introspection-only.
- In session-archive, `auto-close-decision` no longer deletes a queued close on an unreadable runtime — a corrupt or transiently unreadable `runtime.json` mapped to the stale-flag reap, discarding a live `pending-close.json` and stranding the session until the next midnight. The reap now requires a successfully read, non-closeable `session_state`.
- In session-archive, `recover` reaps `pending-close.json` on the no-SHELL.md path — that branch returned a completed close without the marker bookkeeping, so a flag queued before the crash survived and could auto-close the next session on its first heartbeat tick.
- In routine-monitor, gate on an open operator turn, not `session_state` — an `in_progress` session that never closed starved every monitor-delivered routine (including its own `daily-auto-close`) indefinitely, since `session_state` means "nobody closed the session," not "a conversation is happening." The defer now keys on a Stop-cleared `state/operator-turn-open.json` marker (60-min TTL backstop against an orphaned marker), fail-open to emit on absent/malformed/stale/future-dated markers.

### Upgrade Instructions

1. Re-run `bun ${CLAUDE_PLUGIN_ROOT}/scripts/apply-settings.ts <hatch_target settings file> allow` to add the two new script permissions. Without it, scheduled reflect is asked for permission (functionally denied in headless/channel sessions) and never applies its resolution actions or reads its behavior digest.
2. Run `/claude-code-hermit:hermit-routines load` to re-arm the routine monitor with the fixed gate **before** any session-restart step. Two bounded mixed-version windows exist until this runs: an old monitor with the new hooks still starves on `in_progress` until re-arm (this ordering closes that gap); a new monitor with old in-session hooks (marker never written) falls back to pure emit — CronCreate parity, no starvation, only a mild loss of politeness — until the session next restarts.

## [1.2.28] - 2026-07-17

### Fixed
- Watchdog liveness-keyed re-arm of dead heartbeat/routine monitors — a Monitor subprocess that dies mid-session (e.g. at a restart) is now detected from its stale liveness file and re-armed within one watchdog cycle, damped to one attempt per monitor per 6h. Previously recovery waited on the `heartbeat-restart` anchor (up to 3 days on slow cadences) or the 26h fired-age fallback, which stays inert when the model-issued `fired` metric is missing.
- In hatch/apply-settings, stop seeding no-op `Write(path)` permission rules — Claude Code only matches file-permission checks against `Edit(path)` rules (Edit covers all file-editing tools, including Write), and (v2.1.211+) warns at boot on `Write(path)` rules. The seeded allow rule `Write(.claude-code-hermit/**)` is dropped, and `apply-settings deny` now strips redundant `Write(<glob>)` rules whose `Edit(<glob>)` twin is present (e.g. `Write(*/.claude/plugins/marketplaces/*)`) before writing settings, so a freshly-hatched hermit no longer trips the boot warning. `deny-patterns.json` keeps both spellings — the tool-specific `enforce-deny-patterns` runtime hook still needs the `Write` variant.
- Hermit-routines model-override dispatch anchors the subagent to the absolute project dir — stops relative-path misresolution (doubled `.claude-code-hermit` path) that caused false doctor alerts under cheap-model routines.

### Upgrade Instructions

Run `/claude-code-hermit:hermit-evolve`.

1. In your hatch-target settings file (`.claude/settings.local.json` or `.claude/settings.json`, whichever `hatch` wrote to), remove any `Write(<glob>)` line from both `permissions.allow` and `permissions.deny` whose `Edit(<glob>)` twin is already present — at minimum the stale `Write(.claude-code-hermit/**)` allow line and the `Write(*/.claude/plugins/marketplaces/*)` deny line.

**Note:** The watchdog re-arm and hermit-routines dispatch-path fixes are additive/backward-compatible and need no migration step — `watchdog-state.json`'s new `last_monitor_rearm` field is created on demand, gated on the existing `watchdog.enabled`.

No other config.json changes required.

## [1.2.27] - 2026-07-15

### Removed
- Stop probing/auto-configuring the bash sandbox in hatch. hermit no longer writes `sandbox.*`; Claude Code's native sandbox (`/sandbox`) owns setup. Fixes a false-positive probe that bricked Bash mid-hatch on nested-userns hosts (#601).

### Fixed
- Docker-security log-only DNS mode now honors static `address=` allowlist records — previously log-only skipped `dnsmasq.allowlist` entirely, so operator-pinned internal hostnames (e.g. Tailscale MagicDNS) silently failed to resolve unless enforce mode was on. The log-only entrypoint now extracts and applies static `address=/host/ip` records (excluding the `address=/#/` catchall) while still forwarding everything else — block-nothing behavior is unchanged.

### Upgrade Instructions

For hermits with the Docker security overlay installed (`.claude-code-hermit/docker/netguard-entrypoint.sh` exists — skip entirely if not):
1. Copy `state-templates/docker/security/netguard-entrypoint.sh.template` over `.claude-code-hermit/docker/netguard-entrypoint.sh` (keep it executable).
2. Run `.claude-code-hermit/bin/hermit-docker update` to rebuild the `hermit-netguard` image with the new entrypoint and bounce the stack.
3. Do **not** re-run the full `/docker-security` wizard for this upgrade — it regenerates `dnsmasq.allowlist` from your fleet/domain selections and would erase any hand-added `address=` records. No `dnsmasq.allowlist` change is needed; the fix only changes how the entrypoint parses the file that's already there.

No settings mutation for the sandbox-probing removal. Existing installs keep whatever `sandbox.*` they already have — a previously hatch-enabled sandbox that works stays enabled and working; hermit simply stops managing the key. If your Bash is failing with a nested-userns/seccomp error, set `sandbox.enabled: false` yourself. The doctor `sandbox` report line is gone.

## [1.2.26] - 2026-07-15

### Fixed
- Heartbeat/routines monitor wake notifications no longer count as operator activity — `HEARTBEAT_EVALUATE`/`HEARTBEAT_ERROR`/`ROUTINE_DUE`/`ROUTINE_MONITOR_ERROR` prompts were stamping `last-operator-action.json`, spuriously resetting the AUTO_CLOSE lull and suppressing daily-close drains. The UserPromptSubmit filter now drops the monitor emission grammar.
- Watchdog context resets invalidate the session-id cost cache — post-close and emergency `/clear` now delete `sessions/.status.json` (and the emergency clear cross-stamps the compact tracker), so the compact tier can no longer fire a spurious `/compact` on the destroyed context's stale cost entry.

### Upgrade Instructions

Run `/claude-code-hermit:hermit-evolve`. Both fixes are additive and backward-compatible — no state migration or manual step needed.

No config.json changes required.

## [1.2.25] - 2026-07-14

### Fixed
- Heartbeat eval-runner subagent can no longer fabricate alert-state schema — the haiku eval-runner previously authored `alerts{}` bookkeeping directly (counts, suppression, resolution, `last_clean_eval_at`) and intermittently invented fields, garbled keys, or marked a pending `micro-proposal-pending:*` key suppressed, silencing a genuine Tier-1 operator decision. The subagent now returns only a firing set of `{key, text}` judgment items; `update-alert-state.ts` derives `micro-proposal-pending:*`/`proposal-pending:*` from their source-of-truth files and owns the entire dedup/suppression/resolution/digest ladder deterministically, so this class of fabrication is no longer possible regardless of model. No state-schema migration needed — additive/backward-compatible, existing `alert-state.json` entries read unchanged.
- Heartbeat proposal/micro-proposal ids never reach the operator channel — the daily digest and suppression notifications now carry an id-free channel label (proposal title / micro-proposal question only), scrubbing any internal id even when embedded in a title, per the channel-voice rule. Monitoring lines (file-only) are unchanged. Additive `channelText` field — existing `alert-state.json` entries read unchanged.
- Heartbeat an unreadable structured state file no longer reports a clean tick — when `micro-proposals.json` or a `proposals/*.md` frontmatter can't be read, the tick reports `ALERT` and re-checks next tick (rather than a false `OK` that armed the clean-recheck damper), and the daily digest is held back rather than advancing its clock on a partial view. Existing pending alerts under the affected prefix are frozen, never silently aged toward resolution.
- Cost scripts cwd-anchored cost-log resolution — `today-cost.ts`, `session-cost.ts`, `weekly-review.ts`, `cost-reflect.ts`, and `reflect-precheck.ts` resolved cost-log paths against `process.cwd()`, silently reporting `$0.00`/zeros (or suppressing the reflect cost-spike phase) after a cwd drift. All now anchor to `hermitDir()`; `today-cost.ts` reports `cost data unavailable` instead of a misleading `$0.00` when the log can't be read.
- Heartbeat stale-session no longer false-alarms on sessions spanning midnight — staleness is now derived deterministically by `update-alert-state.ts` (bottom-most Progress Log entry, timezone-correct mod-24 resolution) instead of asking the eval model to do time arithmetic over date-less `[HH:MM]` stamps; the model can no longer emit the key at all.
- Evaluate-session progress nudge no longer backdates entries to the session start date — same date-less-timestamp fix, now timezone-correct: the nudge resolves the last `[HH:MM]` Progress Log stamp in `config.timezone` (matching how stamps are written and the stale-session alert) instead of the server-local zone, so a hermit whose container TZ differs from `config.timezone` no longer mis-nudges; the 48h "session may be complete" nudge keys off SHELL.md mtime.

### Upgrade Instructions

Run `/claude-code-hermit:hermit-evolve`. All fixes are additive and backward-compatible — no state migration or manual step needed.

No config.json changes required.

## [1.2.24] - 2026-07-13

### Added
- Routine-monitor routines run from one persistent Monitor subprocess — where the Monitor tool is available, every enabled routine except `heartbeat-restart` is now scheduled by `scripts/routine-due.ts` (polled every 60s by `scripts/routine-monitor.sh`), which evaluates cron schedules directly in `config.timezone`, applies the pause/waiting/idle gates itself, and wakes the session only for routines that should actually run — a skipped fire now costs zero model tokens instead of a full-context turn, and routines due in the same poll batch into one wake. `heartbeat-restart` stays a CronCreate re-arm anchor that keeps the monitor alive across restarts and >24h pauses. Platforms without Monitor (Amazon Bedrock, Google Cloud Agent Platform, Microsoft Foundry, or `DISABLE_TELEMETRY`/`CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`) fall back to the previous per-routine CronCreate flow unchanged. New `hermit-doctor` check `routine-monitor` reports liveness and the active mode.

### Changed
- Startup-context sessionStart injection is now source-gated — post-compaction (`source=compact`) injects only a ≤1,200-char delta capsule (lifecycle state, task + last progress line, file pointers; never cost/upgrade/catalog/drift/report bodies), and resumed sessions skip the Last Report section when SHELL.md is active — the resumed transcript already contains it. Fresh starts unchanged.
- Routine scheduling idle-gating is coarser in monitor mode — the subprocess gates on `session_state`, not the harness's turn-level idle gate, so a routine wake can now interject into an active conversation (the same trade `/heartbeat` already accepts). CronCreate fallback/anchor mode is unaffected.
- Default doctor routine schedule clusters with reflect/scheduled-checks — `10 9 * * 1` (was `0 10 * * 1`), joining the 09:00/09:05 window so co-due wakes share a warm prompt cache; distinct default wake windows drop from 5 to 4. Existing always-on hermits are ratcheted forward automatically by `hermit-start.ts` (see Upgrade Instructions).
- Routine-metrics.jsonl rows gain a `delivery` field (`cron-create` or `monitor`) — `log-routine-event.sh` and `routine-precheck.ts` both take an optional trailing delivery argument, default `cron-create` (unchanged for existing callers). The `routine-cost` doctor check now excludes monitor-delivered skips from its `$/run` denominator, since they cost zero tokens and would otherwise dilute the metric below a genuinely expensive routine's real cost.
- `heartbeat/SKILL.md` timeout comment corrected — a live probe confirmed a `persistent: true` Monitor does not expire at `timeout_ms`; the field is schema-required boilerplate, and the daily `heartbeat-restart` re-arm exists to recover from monitor death and session restarts, not a timeout.
- Session-archive structured report frontmatter — archived reports now carry `blockers`, `lessons`, `artifacts`, and `next_start` as frontmatter fields alongside their existing prose sections; the report's own frontmatter doubles as its index row, no separate index file needed.
- Reflect/brief/weekly-review/startup-context frontmatter-first report reads — these read a report's structured frontmatter row first and open the full body only for a legacy report (no `next_start` key) or when a check needs prose the row can't witness; a no-change reflect run now reads zero full report bodies.

### Fixed
- Startup-context a post-compaction start no longer clears a prior context-scan warning — the `source=compact` path only scans the delta capsule (task/progress), so it now merges the scan record instead of overwriting it; a compaction can no longer flip the doctor `context-scan` check to "clean" while an injection marker still sits in OPERATOR.md/compiled/report. The next full start re-scans comprehensively and overwrites, self-healing any stale merged hit.
- Routine-monitor scan-loop efficiency, skip-metric ordering, and error throttling — `routine-due.ts` now builds one timezone formatter per poll and pre-compiles each cron once (instead of reconstructing both per candidate minute), and advances the no-match cursor to the current minute so a not-yet-due routine stops re-walking a growing window every poll; skip metrics are stamped only after the schedule cursor persists, so a failed write no longer leaves a phantom `skipped-*` row; and `routine-monitor.sh` throttles `ROUTINE_MONITOR_ERROR` (emitted on the 1st and every 60th consecutive failure) so a persistent spawn failure can't storm the session.
- Cost attribution co-firing routines no longer mis-charge the first routine — when ≥2 routines fire in one shared wake turn (a monitor co-fire, named on the `ROUTINE_DUE` line), `cost-tracker` attributes the turn to a synthetic `routine:multi` bucket instead of the first id, so the doctor's per-routine `$/run` check no longer inflates one routine and masks the others. Detection is anchored to the `ROUTINE_DUE` line so `heartbeat-restart`'s re-arm output can't false-trigger it.
- In hermit-doctor, `credential-expiry` no longer warns on the Claude Code session's own OAuth token — the access token auto-refreshes via its refresh token roughly every 8h with no operator action (confirmed live: unattended hermits rewrite `.credentials.json` hours after boot with no `/login` run), so warning on its `expiresAt` was a false "re-login" alarm every cycle. The check now reports only sibling-plugin `expiry_probe` results.

### Removed
- Suggest-compact Stop-hook stage deleted. the tool-call compact nudge counted Stop events, not tool calls or context usage, and duplicated the three real compaction tiers (native autocompact, watchdog backstop, emergency clear). Stop-pipeline no longer emits anything on stdout; `COMPACT_THRESHOLD` env key removed.

### Upgrade Instructions

1. Run `/claude-code-hermit:hermit-routines load` — this registers the routine monitor (sweeping any pre-existing per-routine CronCreates in the process), re-registers the `heartbeat-restart` anchor, and is idempotent to re-run.
2. Verify `state/routine-monitor-liveness.json` exists and is fresh (within the last ~2 minutes). If it's absent, the install fell back to CronCreate mode automatically — confirm via `/claude-code-hermit:hermit-routines status`; no action needed, routines keep working as before.
3. If upgrading an already-running always-on hermit (no restart), run `/claude-code-hermit:hermit-routines status` afterward and confirm only `[hermit-routine:heartbeat-restart]` remains in the CronList — if other `[hermit-routine:*]` entries are still present, re-run `load` to complete the sweep.
4. Migrate the doctor routine's schedule in `.claude-code-hermit/config.json` by **exact string match only**: `"0 10 * * 1"` → `"10 9 * * 1"`; `"0 10 * * *"` → `"10 9 * * *"`. Any other value on that routine is operator-customized — leave it untouched. (A boot-time ratchet in `hermit-start.ts` also recognizes both old defaults as a backstop for hermits that skip this step or switch from interactive to always-on later, but it only fires on the next always-on launch — this step applies immediately.)
5. **Remove `COMPACT_THRESHOLD` from `.claude-code-hermit/config.json`** — delete the key from the `env` block if present.
6. **Remove `COMPACT_THRESHOLD` from the operator's settings env block** — check the hatch target settings file (`.claude/settings.local.json` or `.claude/settings.json` per `state/hatch-options.json`) and delete the `"COMPACT_THRESHOLD"` entry from `env` if present.
7. Stale permission cleanup (`Bash(bun */scripts/suggest-compact.ts*)`) is handled by the standard permissions step — no separate action.
8. **Optional:** delete leftover counter files at `<os tmpdir>/claude-agent-compact-<uid>/` (`rm -r`, not `rm -rf`). Safe to skip — the OS tmpdir is ephemeral and container-local in Docker deployments.

No other config.json changes required.

## [1.2.23] - 2026-07-12

### Fixed
- Dashboard/proposals-page proposals-index self-heals on every read — `loadProposals()` (shared by both artifact renderers) previously trusted a parseable-but-stale `proposals-index.json` unless the file was missing; an out-of-band proposal-file rename/move (e.g. Bash `mv`, which produces no Write/Edit event) left the cache stale indefinitely, and both pages rendered the open proposal with its old id and an empty body until the index was rebuilt by hand. `loadProposals()` now rebuilds the index from disk on every read — `rebuildIndex()` is a cheap frontmatter-only scan, no LLM/token cost, and the renderer already reads every open proposal's full body anyway. A row whose backing file still can't be read after the rebuild (a TOCTOU race) now renders `_(file missing: <file>)_` instead of a silently empty body. `channel-responder`'s YES/#N and micro-approval escape-hatch resolution paths — the surface the operator acts through — also validate the index against disk before matching.

### Upgrade Instructions

Run `/claude-code-hermit:hermit-evolve`. No further action needed — the fixes live in `dashboard.ts` and `channel-responder/SKILL.md`, picked up from the plugin install path on the next session.

No config.json changes required.
### Added
- Credential registry — sibling plugins can declare expiring credentials in `hermit-meta.json` `credentials[]` (`name`, `state_path`, `expiry_probe`, `reauth_skill`); the doctor `credential-expiry` check now executes each `expiry_probe` (bash, 5s timeout, one-line `OK`/`EXPIRES:<iso>`/`EXPIRED` protocol) alongside the built-in Claude OAuth check, warning on expired or <7d credentials and naming the plugin's reauth skill. Malformed output or a timeout degrades to a "probe failed" warn, never a crash. A new HEARTBEAT.md standing check surfaces non-ok credentials to the operator. See `docs/creating-your-own-hermit.md` § Credential registry.

### Upgrade Instructions

Append this line to the operator's existing `HEARTBEAT.md`, under `## Standing Checks`, if not already present:

```
- Read `state/doctor-report.json` → the `credential-expiry` check; if its status is warn or fail, tell the operator which credential needs re-auth and name the plugin's reauth skill from the report detail.
```

No `config.json` changes required — the credential registry is populated entirely by sibling plugins' `hermit-meta.json`, which `hermit-evolve` does not need to touch.
### Changed
- Proposals artifact page open proposals are now collapsible — collapsed-by-default one-line summaries with an open count, matching the dashboard; deep-link anchor moved onto the `<details>`.

## [1.2.22] - 2026-07-12

### Fixed
- In enforce-deny-patterns, fold unquoted backslash escapes — `r\m -rf` / `rm -r\f` no longer slip past rm and other command/flag-anchored deny globs. The fold is restricted to ordinary chars: escaped quotes/separators (`\"`, `\;`, …) are kept verbatim so they can't desync the segment split — an unquoted `\"` no longer opens a spurious run that hides a following `rm -rf`, and `\;` no longer fabricates a separator.

### Upgrade Instructions

Run `/claude-code-hermit:hermit-evolve`. No further action needed — the fix lives in `enforce-deny-patterns.ts`, picked up from the plugin install path on the next session.

No config.json changes required.

## [1.2.21] - 2026-07-10

### Added
- In proposal mechanics, named CLI wrappers — `resolve-prop.ts`, `next-prop-id.ts`, `record-gate.ts`, `queue-micro-proposal.ts` replace inline prose in `proposal-act`, `proposal-create`, and `reflect` (PROP-id fuzzy resolution, ID/slug generation, gate-verdict parsing + fail-closed routing, micro-approval queuing) with deterministic scripts on the existing verdict-line contract. `append-metrics.ts`'s validate-then-append logic is extracted to `scripts/lib/append-jsonl.ts`, reused by all three new appenders.
- Artifact chrome localization. the dashboard and proposals-page renderers now read their ~35 hardcoded UI strings (section headers, stat labels, empty states, age labels, the footer, the synthesized budget-alert line) from a new `scripts/lib/artifact-strings.ts` table instead of inline English literals. `.claude-code-hermit/state/artifact-strings.json`, when present, overlays a translated table **per key** over the English defaults — a missing key or an absent file falls back to English, so an untranslated hermit renders byte-identically to today. `hatch` (Step 5b) and `hermit-settings language` now generate/regenerate that table (model-translated once, at language-set time) whenever the operator's `language` is non-`en`, and delete it when switching back to `en`. Closes the gap where model-authored content (briefs, proposal bodies, weekly reviews) already followed `config.language` but the surrounding page chrome stayed English. See `docs/artifacts.md` § Localization.
- In enforce-deny-patterns, closed the documented `rm -rf` bypass — matches `rm -fr`/`rm -r -f`/`rm -f -r` and `/bin/rm`/`./rm`-prefixed spellings now, bare and behind `&&`/`;`/`|`; matching also normalizes doubled whitespace, unquoted `$IFS`, and backslash-continuation obfuscation (quote-aware — never folds quoted data). Same patterns merge into the native `settings.json` deny array via `apply-settings.ts deny`.
- In heartbeat, injection gate on HEARTBEAT.md — precheck scans the checklist pre-wake for injection markers (instruction-override phrases, context-marker tags, decode-pipes); a hit alerts the operator and suspends evaluation until the file is edited, one alert per file version. Deterministic operator-safety notifications are exempt from the suspension: a pending budget alert pierces the announced-damper and a due 12h stale auto-close still fires (neither reads HEARTBEAT.md). This also fixes a pre-existing bug where the heartbeat budget-alert fallback read `alert-state.json` instead of `budget-alerts.json` (a no-op since the per-writer split) — step 3b now reads the merged view and marks notified via a new single-writer-safe `cost-tracker.ts --mark-budget-notified` entrypoint.
- In startup-context, injection-time threat scan — everything the SessionStart hook injects (compiled bodies/stubs, catalog summaries, OPERATOR.md/SHELL.md excerpts, last report) is routed through the context-marker defuser plus a tight marker scan (injection phrases, credential-shaped strings); a hit replaces only that entry with `[BLOCKED: <reason>]` while the file on disk stays untouched. Hits persist to `state/context-scan.json`; new `context-scan` doctor check surfaces them. Defense-in-depth for context integrity, not a permission boundary.
- Usage-metrics ledger. a new PostToolUse hook (`usage-track.ts`, matcher `Skill|Read`) and a `record-operator-action.ts` extension append skill invocations and `compiled/` reads to `state/usage-metrics.jsonl`. `weekly-review` now suggests archiving knowledge with no tracked use in 60+ days (suggest-only, never auto-archives; tracked sources only — startup injection and subagent reads aren't seen).

### Changed
- In hooks, shared stdin/profile helper (`lib/hook-input.ts`) — unifies stdin draining and `AGENT_HOOK_PROFILE` parsing across the four PreToolUse gates (`pause-gate`, `ask-gate`, `enforce-deny-patterns`, `cache-edit-guard`).
- In hooks, preToolUse stdin cap raised 64KB → 1MB — fewer legitimate large payloads hit the cap. The default-allow gates (`enforce-deny-patterns`, `cache-edit-guard`) still fail open above the cap, so this narrows rather than closes the oversize gap for them.
- Pause-gate fails closed on oversize stdin while paused — a payload too large to parse (>1MB) can no longer slip an action past an active pause; unpaused, oversize still fails open like any ignored stdin.
- `AGENT_HOOK_PROFILE` matching is now case/whitespace-insensitive in hooks in `enforce-deny-patterns`, aligning it with the dev plugin's `git-push-guard`.
- In proposal-act/proposal-create/reflect, mechanics prose collapsed to script calls — operator-facing behavior is unchanged; each dispatch is now one script invocation instead of an inline algorithm, cutting ~2-4K tokens per proposal/reflect turn.

### Fixed
- In record-operator-action, operator-typed slash commands now refresh `last-operator-action.json` — the blanket bare-`/` drop keyed on a `<command-message>` wrapper that never reaches the hook's stdin, so slash-driven sessions looked idle to AUTO_CLOSE and watchdog hygiene; only hermit's own tmux-injected commands are filtered now (#574).
- In cost-tracker, fall back to `other` source when a turn's boundary falls outside the 512KB scan window — prevents a large turn (e.g. a plugin upgrade run) from inheriting a stale or self-echoed routine marker and tripping a false `hermit-doctor` routine-cost warn.
- In doctor routine-cost, window $/run to the routine's fire-tracking start — the cumulative `cost-index.json` numerator was divided by a fire-count denominator that only covers the window since `routine-metrics.jsonl` tracking was added (#378), so hermits with lifetime cost predating that feature saw an inflated $/run and false warns on infrequent routines. Cost is now windowed to each routine's earliest tracked fire, falling back to the lifetime total when windowing isn't available.

### Upgrade Instructions

Run `/claude-code-hermit:hermit-evolve`.

1. **Add the four new proposal-mechanics permission entries.** Run `bun ${CLAUDE_PLUGIN_ROOT}/scripts/apply-settings.ts <hatch_target file> allow` to add `Bash(bun */scripts/*.ts*)` entries required for the new CLI wrappers to run unattended.
2. **Localize the artifact chrome for a non-`en` hermit.** Read `language` from `.claude-code-hermit/config.json`. If it is set and is **not** `en`, generate the translated UI-chrome table so the dashboard/proposals pages stop rendering half-English:
   - Emit the English scaffold: `bun ${CLAUDE_PLUGIN_ROOT}/scripts/artifact-strings-scaffold.ts <language> <current-ISO-timestamp>`.
   - Translate every value inside the `strings` object into that language, leaving the keys and any `{placeholder}` tokens verbatim (word order may move around a token; the token text must not change).
   - Write the result to `.claude-code-hermit/state/artifact-strings.json`.
   The next dashboard/proposals refresh republishes once (the string file is ordinary render input, so it trips the hash gate a single time) with fully-localized chrome; steady state stays no-op-gated. If `language` is `en` or unset, do nothing — English is the default and today's output is unchanged. To opt out of localization on a non-`en` hermit, delete `.claude-code-hermit/state/artifact-strings.json`.
3. **Harden `rm` deny patterns.** Resolve `hatch_target` (`.claude-code-hermit/state/hatch-options.json` → `target`, per the same resolution hermit-evolve already does in its own Step 1) to the settings file (`.claude/settings.local.json` for `local`, `.claude/settings.json` for `committed`/`project`). Read that file's `permissions.deny`. If it does **not** already contain `"Bash(rm -rf *)"`, the operator chose Skip (or has no deny rules) at hatch time — do nothing, preserve that choice. Otherwise run `bun ${CLAUDE_PLUGIN_ROOT}/scripts/apply-settings.ts <resolved-settings-file> deny minimal` to merge the eight new `rm` flag-order/path-prefixed patterns — additive and idempotent (`mergeDeny` dedups), safe to re-run. The runtime hook itself needs no migration; it reads `state-templates/deny-patterns.json` from the plugin install directly on the next session.

## [1.2.20] - 2026-07-10

### Added
- In cost attribution, inbound-channel turns get their own `by_source` bucket — `classifySource` now recognizes the `<channel source="...">` transcript envelope and tags the turn `channel:<name>` (e.g. `channel:discord`) instead of collapsing into the catch-all `other` bucket. Redaction collapses `channel:*` the same way it already does `routine:*`.
- In hermit-doctor, `routine-cost` check — joins per-routine cost from `state/cost-index.json` with fire-turn run counts from `state/routine-metrics.jsonl` (every `started`/`skipped-*` fire, since skipped fires still accrue cost to the routine bucket) and warns naming a routine whose \$/run exceeds both 3× the peer median (the other routines' median, self excluded) and the new `doctor.routine_cost_floor_usd` (default \$2). Surfaces expensive-outlier routines without manually cross-referencing state files. See `docs/routine-authoring.md`.
- In cost-reflect, plain-language spend statement for channel cost questions — a channel-tagged turn now runs a new `--plain` mode instead of the raw token-category breakdown: today's spend vs. a trailing-7-day typical day, drivers named by work (not token type), spend-cap status, and a one-line notional-dollars caveat — no `cache_read`/`cache_write`, session IDs, or internal IDs. `channel-responder` gains a "Spend request" intent routing cost/spend questions to `/cost-reflect` instead of a free-form model turn.
- Context-reset breadcrumb a new `PreCompact` hook plus a watchdog pre-`/clear` flush — `precompact-stamp.ts` stamps SHELL.md's Progress Log before every `/compact` (manual or native auto-compaction); the watchdog's emergency 700k `/clear` (which never fires `PreCompact`) flushes the same breadcrumb directly before sending the keystroke. A trace only — it does not recover in-context observations, just marks that a mid-arc reset happened.
- Channel voice contract. `CLAUDE-APPEND.md` and `channel-responder` now carry one canonical rule: channel-bound messages drop internal IDs (PROP-NNN, S-NNN, MP-…), token counts, slash commands, file paths, and cron strings in favor of plain language with an actionable next step. Generalizes the rule `hermit-doctor` already enforced on its own alerts, and brings the `session-start` baseline-audit summary into compliance — it now drops the PROP-ids and slash command from channel-sent text. A contract test guards the rule text and the one deterministic (non-model) channel sender that composes prose, `composeBudgetMessage`; it does not guarantee every channel-emitting skill's model-authored replies comply.
- In weekly-review, `### Delivered` section + `delivered`/`open_loops_count` frontmatter — enumerates this week's session-report `## Artifacts` bullets so the channel summary can name what was produced, without re-reading the body.
- In docs, owner's Guide and plain trust page — new `docs/owners-guide.md` (talk, approve, pause, spend, who to call) and `docs/what-your-assistant-can-do.md`, both written for the non-developer owner. `channel-setup` now sends a short plain-language welcome pointing at the guide the first time a channel is newly paired.
- In hermit-doctor, `context-age` check — warns when the active session's context size (`max_prompt_tokens`) is over the `context_hygiene.compact.min_context_tokens` threshold and no compact/clear event fired in the last 24h. A cause-independent tripwire for stuck or disabled context hygiene.
- In hermit-doctor, `version-currency` check — warns when the local marketplace cache lists a newer core version than the one installed, escalating the wording if the gap's CHANGELOG carries a `### Fixed` heading. Silent no-op in a monorepo/dev checkout.
- In hermit-routines, wake-clustering lint — `load` now warns (one advisory line) when enabled routines' fire-times spread across more than `routine_wake_lint.max_windows` (default 6) distinct 30-min windows, naming the loneliest fires. A wake-count nudge: fewer distinct wake windows means fewer cache-cold wakes. Advisory only, never blocks registration.
- In Suggestion cards, plain-language proposal approvals on channel turns — on a channel-tagged turn `proposal-list` renders open proposals as "Suggestion #N … Reply YES/LATER/NO" cards (not the PROP-id/tier/age table), `channel-responder` maps YES/LATER/NO to accept/defer/dismiss, and `proposal-act` confirms in the same plain voice. Terminal output is unchanged.
- In docs, routine-authoring playbook — new `docs/routine-authoring.md` covers converting a costly broad-skill routine into a scoped one (haiku pin, verdict-line return, precheck gating); `hermit-routines` and `hatch` now point to it.

### Fixed
- In hermit-start, `DEFAULT_CONFIG` back in sync with `config.json.template` — added the missing `routine_wake_lint.max_windows` and `doctor.routine_cost_floor_usd` keys so a project relying solely on `hermit-start`'s own defaulting logic (not the hatch template) still gets both.
- In session-cost, per-session `cost_usd` no longer reads `0.00` for real work — cost-log rows carry the shared transcript UUID, never the logical `S-NNN`, so the old exact-id match never hit; `session-cost.ts` now sums the arc window `[opened_at, closed_at]` (new `--opened-at`/`--closed-at` overrides). `cost-tracker.ts` re-stamps `opened_at` per arc keyed on the transcript id (so a crash/restart's stale window can't over-count the next session) and stamps `closed_at` on the idle transition (so a close running after idle still recovers the window instead of falling back to the always-zero exact-id match).

### Changed
- In session-start, `--task` collision guard — a routine-seeded `session-start --task` arriving while a session is live no longer overwrites the running task: it defers the incoming task to `NEXT-TASK.md` (or drops it if one is already pending) and aborts; a crash-recovery collision auto-archives the crashed session as partial and starts fresh. The `## Task` is stored verbatim so the same-task re-entrant comparison stays valid.
- In session, work-done NEXT-TASK auto-drain — at a task boundary under `balanced`/`autonomous` escalation, a queued `NEXT-TASK.md` is now adopted and started automatically instead of stopping at "Ready for what's next"; `conservative` still leaves the queue for heartbeat. NEXT-TASK.md is deleted only once adopted.
- In session, task-completion notification speaks owner language — drops the internal `S-NNN` id and leads with what was delivered ("Done — <task>. Prepared: <deliverable>.") instead of "Archived as S-NNN…"; generalizes `hermit-doctor`'s plain-language channel rule.
- In weekly-review, channel summary rewritten to Delivered / Decisions / Waiting on you / Spend — replaces the dev "evolution block" (Autonomy %, Operator Dependence, PROP ids, reflect vitals) in the channel-sent message only; the written `compiled/review-weekly-*.md` file keeps all dev-facing sections unchanged.
- In hermit-routines, consolidate the pre-fire gate into `routine-precheck.ts` — one script call now owns the waiting-check, pause-check, and `started` stamp per routine fire, replacing three model-issued tool calls. Metrics schema and readers unchanged.
- In hermit-routines, diff-based cron registration — `load` no longer tears down and recreates every routine CronCreate on each call; a new `scripts/cron-registry.ts` planner diffs against a `state/cron-registry.json` mirror and only re-registers routines that changed or are aging toward CC's 7-day auto-expiry cliff. Eliminates the daily `heartbeat-restart` reload's bulk `CronList`/`CronDelete`/`CronCreate` churn on an unchanged config. `load --reset` keeps the old unconditional sweep as an explicit escape hatch for suspected mirror/reality drift.
- Session-mgr replaced by `scripts/session-archive.ts` — every session-lifecycle write (idle transition, operator/auto close, session open, interrupted-transition recovery) now runs as a deterministic, tested script instead of a 16.3KB sonnet subagent dispatch, saving a ~15-25k-token re-seed on every task boundary. `agents/session-mgr.md` is deleted. Recovery is a tested branch table keyed on a new `transition_mode` runtime.json field; a transition marker left by the old subagent mid-upgrade (no `transition_mode`) is treated as a full close and annotated in the report's Blockers.
- In reflect, batch `proposal-triage` gate calls — `proposal-triage` now accepts N candidates in one call and returns N title-tagged verdict blocks, matching `reflection-judge`'s existing batch grammar. Reflect gates all pending candidates in a single dispatch instead of one per candidate; `proposal-create` and `scheduled-checks` keep calling it as a batch of one.
- In reflect, preference ladder for procedure capture — an adjacent-but-not-fully-covering skill now routes as a Tier 2 `## Skill Improvement` (extend it) instead of a Tier 3 `## Skill Draft` (new skill); drafting a new skill is the last resort. Skill names may no longer be derived from an incident, PR/issue number, error string, or "fix-X" phrasing. `channel-responder` now routes a channel correction that clearly names a skill straight to a `skill-correction:<name>` observations-ledger row instead of a `## Findings` line, feeding the same graduation path session-close already uses; unresolved corrections still fall back to Findings.
- In doctrine, codify measured token economics — dev and operator `CLAUDE.md` now frame the atom of cost as the API call (cache traffic dominates spend, not per-prompt injection), note that each delegation bookends main with ≥2 full-context turns, and extend the script-mediation rule to native tool outputs (e.g. `CronList`).
- In reflect, sKILL.md slimmed 52KB → ~15.7KB (stub + `branches.md` split) — candidate-processing gates, scheduled-checks steps, procedure capture, and `skill-correction:*` routing moved to `skills/reflect/branches.md`, read only when that branch fires. `reference.md` and the `--quick`/`--scheduled-checks`/`--precheck-verdict` interfaces are unchanged.
- In heartbeat, dispatch prompt points to a canonical return schema instead of inlining it — the typed JSON return object now lives in `reference.md` § Return Schema (which the subagent already reads); the per-tick dispatch prompt is a pointer. De-dupes the contract without changing behavior.

### Upgrade Instructions

Run `/claude-code-hermit:hermit-evolve`.

1. **Merge new config keys** — `doctor.routine_cost_floor_usd` (default 2) and `routine_wake_lint.max_windows` (default 6) are added to `.claude-code-hermit/config.json` via the standard `new_config_keys` merge (missing-only, never overwrites an operator-set value). The `routine-cost` doctor check and the wake-clustering lint are then live immediately.

2. **Restart the hermit after the first `load`.** The first `load` after upgrading finds no `state/cron-registry.json` mirror and treats every enabled routine as needing (re-)registration, then self-seeds the mirror. In an always-on hermit that upgrades in-process (no restart), the pre-upgrade `CronCreate`s are still live while the new planner emits an all-`CREATE` plan with no deletes, so routines fire twice until the process restarts or the old crons hit CC's 7-day expiry. Restart the hermit (or run `/claude-code-hermit:hermit-routines load --reset`) once after upgrading to clear the duplicates. A fresh boot needs no action.

3. **Session-lifecycle & routine permission migration.** Re-run `bun ${CLAUDE_PLUGIN_ROOT}/scripts/apply-settings.ts <hatch_target file> allow` (the same settings file `hatch` originally wrote to — `.claude/settings.json` or `.claude/settings.local.json`, per this hermit's `hatch_target`) to add the new `Bash(bun */scripts/session-archive.ts*)`, `Bash(bun */scripts/routine-precheck.ts*)`, and `Bash(bun */scripts/cron-registry.ts*)` entries to the sealed allow-list. This is additive and idempotent (`mergeAllow` dedups by exact string) — safe to run even if the entries are already present. Without them, the hermit is asked for permission (functionally denied in headless/channel sessions) on its first post-upgrade idle transition and on every routine fire / `load`.

## [1.2.19] - 2026-07-06

### Added
- In watchdog, `last_hygiene_eval` telemetry — each `maybeContextClear`/`maybeContextCompact` tick records why it fired or skipped in `watchdog-state.json`, keyed per mechanism so the clear and compact tiers keep separate records, surfaced in `hermit-doctor`. Previously every gate was a silent `return`.

### Changed
- In hermit-routines, quiet success-path load log — a clean `load` run now logs registration counts only; the full per-ID CronCreate list is reserved for runs with at least one failure. Cuts a recurring ~21-ID dump from SHELL.md on every session start and daily `heartbeat-restart` re-arm. (#533)
- In reflect, `--quick` mode gains a precheck gate — `reflect_after` routines now run a bash-only content-hash check against SHELL.md's `## Findings`/`## Blockers` before invoking `/reflect --quick`; an unchanged scan since the last processed quick run short-circuits to a one-line Progress Log note instead of loading the 49KB skill body. Manual `/reflect --quick` invocations are unaffected. (#531)
- In hermit-evolve, split into a thin stub + `reference.md` — steps 0-9 (the upgrade procedure) now live in a new `reference.md`, read only by the `evolve-runner` subagent; `SKILL.md` keeps only routing and step 10, matching the pattern already used by `reflect`/`brief`/`weekly-review`. No behavior change — same steps, same delegation. (#531)

### Fixed
- In watchdog, context-hygiene thresholds measure real context size, not the per-turn billing sum — a multi-call turn summed every API call, so a ~300k context could log ~1.5M tokens and misfire the 700k `/clear`. `cost-tracker.ts` records `max_prompt_tokens` (the largest single call) per turn; the destructive `/clear` requires that real metric and never fires on the per-call-average fallback used for legacy entries.
- Watchdog a subagent's own cost-log line no longer masks its dispatching turn — `getLastCostLogEntry` skips subagent-appended lines, which could otherwise read as under the compaction floor while the real turn was bloated.
- In watchdog, idle-phase accumulation is visible to both hygiene tiers — when `runtime.session_id` is null (heartbeat/routine/channel wakes between work arcs) both fall back to the harness session id in `sessions/.status.json`; `hermit-start` drops that cache on boot so a post-restart tick can't act on a defunct session's entry.
- Hermit-start a fresh boot clears stale `shutdown_requested_at`/`shutdown_completed_at` — a deliberate start supersedes prior shutdown intent, which `passesLifecycleGuards` otherwise reads as "stopping" forever, bricking watchdog restart recovery and both hygiene tiers.
- In session-mgr, `shutdown_completed_at` is stamped only when a shutdown was actually requested — set it only when `shutdown_requested_at` is already non-null (`hermit-stop.ts`'s signal), so a nightly auto-close reusing the "Full Shutdown" framing no longer falsely marks the always-on process as stopping.
- In hermit-doctor, `watchdog` check covers the hygiene tier independent of `watchdog.enabled` — steps 0a-0c depend on the scheduler tick even when the restart tier is off. Adds a pathology warning for a shutdown stamp stuck on a still-alive session, checked after the liveness signal (which wins when both hold) and gated on stamp age so an in-flight `hermit-stop` doesn't false-positive.

### Upgrade Instructions

Run `/claude-code-hermit:hermit-evolve`. No new config keys this release; the evolve skill handles one state repair:

1. **Clear a stuck shutdown stamp.** Read `.claude-code-hermit/state/runtime.json`. If `session_state` is `in_progress` or `waiting`, or a tmux/docker session for this hermit is currently alive, AND either `shutdown_requested_at` or `shutdown_completed_at` is non-null: set both fields to `null` and write the file back. This is the exact fleet pathology this release fixes — a nightly auto-close (or any close routed through `/session-close`'s "Full Shutdown" framing without a matching `hermit-stop.ts`-initiated `shutdown_requested_at`) leaves a stamp that silently disables watchdog restart recovery and both context-hygiene tiers (`maybeContextClear`/`maybeContextCompact`) until the hermit's next restart. Skip this step if the session is genuinely idle/stopped — a stamp on a stopped hermit is correct and must not be cleared.

## [1.2.18] - 2026-07-05

### Added
- In `apply-settings`, sealed `automode-seed` op — writes the hermit's auto-mode classifier exception (`autoMode.allow`) and environment context (`autoMode.environment`) into `.claude/settings.local.json` (`$defaults`-preserving, additive-only). `hatch` seeds it attended, alongside the existing permissions merge.
- `artifacts.publish_authorized` tri-state config flag + boot-time grant — a channel reply may only flip this flag (new `/hermit-settings artifact-authorization`, channel-bridged via the existing `on_resolve` micro-proposal mechanism); `hermit-start` applies `artifact-allow` + `automode-seed` idempotently at every boot when it's `true`, outside any session and outside the auto-mode classifier. Self-healing if the settings file is later wiped or migrated.
- `PermissionDenied` channel notifier (`permission-denied-notify.ts`) — deterministic, deduped channel alert when the auto-mode classifier (or the permissions system) denies a tool call on the managed unattended session, so a block stops being silent.

### Fixed
- Hermit-evolve the 1.2.17 artifact-allow migration could self-apply unattended — live auto-mode hermits were blocking the migration's settings write with `[Self-Modification]`, and the deferred-migration relay's "On accept (default)" wording then let the session apply it anyway, violating Step 10's defer-only contract. Reworded to defer-only with an explicit channel resolution stanza; the resolved decision only sets `artifacts.publish_authorized`, and the boot wrapper applies the actual grant. Root cause (live tmux probes, `--model sonnet --permission-mode auto`): auto mode suspends wildcarded `Bash(bun */scripts/*.ts*)` allow rules, so a hermit's sealed settings ops always re-enter the classifier in-session — a live user-message intent or a seeded `autoMode.allow` exception are the only things that clear it.
- Operator doc pointers no longer dangle — CLAUDE-APPEND, the SessionStart storage-drift line, and the docker-compose template stopped naming plugin-root docs by a bare `docs/…` path (unresolvable from the operator's project cwd, where the plugin's `docs/` doesn't exist); the artifact-refresh skill refs now use `${CLAUDE_PLUGIN_ROOT}/docs/`. New `operator-doc-refs` test fails the build on any bare `docs/…` ref in a state-template or SessionStart injection.

### Upgrade Instructions
- The `artifacts.publish_authorized` key is added by the generic `new_config_keys` template sync (Step 3/9) — no bespoke migration step.
- **Auto-mode self-maintenance seed.** Attended: run `bun ${CLAUDE_PLUGIN_ROOT}/scripts/apply-settings.ts .claude/settings.local.json automode-seed` and tell the operator in one line what was recorded (mirrors hatch Step 8). **Unattended: skip this step entirely — do not run it and do not defer it.** `hermit-start`'s boot-time grant seeds it once `artifacts.publish_authorized` is `true`; running the sealed op unattended is exactly the self-modification the classifier blocks.
- The `PermissionDenied` hook ships in `hooks/hooks.json`, loaded straight from the installed plugin package — a normal `/plugin update` picks it up with no per-project migration step and no new config key.

## [1.2.17] - 2026-07-05

### Added
- Deterministic channel voice — new `lib/channel-send.ts` (+ `channel-send.ts` CLI) posts operator-language messages straight to Telegram/Discord with no model turn: watchdog restart/wedge/pause events, `cost-tracker` budget-cap alerts, and a new `channel-status-responder.ts` hook that answers an idle `"status"` message at zero model cost. The status reply targets the chat it was asked on; a failed send falls back to the model-mediated path.
- Binding pause/stop/resume — `state/operator-pause.json`/`state/auto-pause.json` (new `lib/pause.ts`) are the source of truth for a hard stop, enforced by a `PreToolUse` gate (`pause-gate.ts`) that denies every tool call while paused except a channel reply and `PushNotification`. A `UserPromptSubmit` hook (`pause-keyword.ts`) sets/clears it from an exact `pause`/`stop`/`resume`/`snooze <dur>` channel message (gated by the same `allowed_users` allowlist as replies); heartbeat, routines, and the watchdog (which also sends `tmux Escape` to interrupt an in-flight call) consult it. New `bin/hermit-pause on|off|snooze <dur>|status` operator CLI. Inert until the flag is set.
- Budget enforcement. new `config.budget` block (`daily_usd`/`weekly_usd`/`monthly_usd`, all optional and `null` by default, plus `action: "alert"|"pause"`) checked at every Stop against a new tz-aware `by_week`/`by_month` aggregate in `state/cost-index.json` (`lib/cost-log.ts`, index version 2 → 3). At 80% of any cap, a one-time warning alert; at 100%, a breach alert, and under `action: "pause"` a hard pause (`reason: "budget"`) that auto-resumes at the breached window's next boundary (daily → midnight, weekly → next Monday, monthly → 1st) — no operator action needed to un-stick it. `heartbeat-precheck.ts` lets exactly one `EVALUATE` through an active budget pause so the breach can still be announced (reply tools are pause-exempt); every subsequent tick falls back to `SKIP|paused`. Drive-by: an unrecognized model string is still priced at sonnet rates but now flagged `model_unpriced: true` on its cost-log line, surfaced as a `cost-summary.md` warning.
- In Telemetry export** — new `config.telemetry_export` block POSTs a versioned, allowlist-built health/cost bundle (`schema_version, 1`) to an operator-configured webhook, sent from the watchdog tick so it still fires while the session is wedged or dead. Failures spool to `state/telemetry/spool/` (newest 7 kept) and retry automatically; 3 consecutive failures raise a deduped alert. Ships **disabled — this is core's second direct outward egress (after `hermit-doctor`'s channel-liveness probe), so it defaults opt-in rather than the usual opt-out.
- Binding `AskUserQuestion` guard on unattended sessions. new `config.ask_gate` (default `true`) plus a `PreToolUse` hook (`scripts/ask-gate.ts`) deny `AskUserQuestion` on the managed unattended session and redirect the model to the channel reply tool and a durable micro-proposal entry, so a spontaneous ask from a built-in flow, another plugin's skill, or the model itself can't silently stall an unwatched pane. The deny is scoped per-session via a `HERMIT_MANAGED` marker (set in the managed session's tmux env-file), so a hand-launched maintenance `claude` — or a `docker exec` shell — in the same `always_on` project still asks normally; per-session bypass with `HERMIT_ASK_GATE=off`. The watchdog gains a companion check for prompts that can't be redirected this way (native permission dialogs) — a single deduped operator notification per stalled episode, and it suppresses its own wedge nudges and re-arm keystrokes on that pane so it never auto-answers the prompt. See [Unattended Asks](docs/security.md#unattended-asks).
- In Hermit Dashboard artifact, plus proposals and weekly-review pages — hub-and-spoke artifact delivery, default on.** The Hermit Dashboard (`config.artifacts.dashboard`, status, proposal queue, weekly evolution) gains a **latest-brief** section and a **compiled-docs index**. Two new pages join it: `config.artifacts.proposals` — full text of every open proposal, each in its own anchored `<section id="prop-nnn">` for deep-linking (rendered by new `scripts/lib/proposals-page.ts` + `render-proposals-page.ts` CLI, reusing the dashboard's proposal loader/markdown converter/CSS); and `config.artifacts.weekly_review` — the latest compiled weekly review published as markdown directly, frontmatter stripped (new `render-weekly-artifact.ts`, no HTML render needed since the Artifact tool renders `.md` natively). All three republish to the same URL on every refresh (`brief`, `weekly-review`, `proposal-create`, `proposal-act`), gated by a content hash so an unchanged page never mints a new artifact version; publish failures (no entitlement, tool absent) fall back silently to the existing markdown-only channel delivery. Any compiled doc or proposal can also be published as a one-off page on operator request ("open X as a page") — no config gate, since that's operator-initiated by definition. All three flags ship **enabled — publish rides Claude Code's own governed Artifacts path (org admin toggle, RBAC, retention, audit log), so this doesn't carry the same opt-in bar as `telemetry_export`'s hermit-authored webhook egress; disable per-page via `/hermit-settings artifact-dashboard|artifact-proposals|artifact-weekly-review`. See `docs/artifacts.md` for the refresh protocol and `docs/config-reference.md#artifacts` for privacy/entitlement notes.
- Unattended Artifact publish authorization — `hatch` and `hermit-evolve` now offer to add `Artifact` to `permissions.allow` (new sealed `artifact-allow` op in `apply-settings.ts`, kept separate from the hook-permission allow-list so declining it never touches hook consent) so unattended sessions never stall on the first-publish permission ask. Declining instead banks the first publish of each enabled artifact page inline during the attended setup session, so every later refresh is a prompt-free same-URL republish.
- Channel-safe approvals everywhere — micro-proposal entries gain optional `options`/`on_resolve` fields (plain yes/no entries unchanged); `channel-responder` resolves numbered/label replies and re-enters the asking skill via `on_resolve`. `proposal-act`'s accept-flow 3-way ask and `hermit-settings`' quality-gate ask are de-stranded on channel-tagged turns (conversational reply-tool question + a durable MP entry, whichever surface answers first wins). New `channel-ask-contract` static test fails the build the moment a skill adds an `AskUserQuestion`/`Ask:` prompt without the Step-0 channel marker.
- Proactive doctor. a weekly `doctor` routine now runs `hermit-doctor` on its own (`0 10 * * 1`; always-on hermits ratchet to daily `0 10 * * *` on boot) instead of waiting for the operator to ask. Three new checks (16 → 19): `credential-expiry` (local read of OAuth token expiry — the ~8h re-login trap, now caught before it strands the box), `model-pricing-known` (config/routine/heartbeat models checked against the pricing table), and `channel-liveness` (a token-authed liveness call per enabled channel — Telegram `getMe`, Discord `/users/@me` — core's first direct outward egress, 5s timeout, fail-soft). New escalation step: newly-appearing `warn`/`fail` findings message the channel once in plain language, deduped via `alert-state.json` (`doctor:<check-id>` keys) until resolved; all-ok stays silent. Doc-count drift fixed throughout `hermit-doctor/SKILL.md` (was "fifteen", JSON already emitted 16 — now twenty everywhere, nineteen scripted checks + the skill-computed sandbox check).

### Fixed
- In reflection-judge + heartbeat, bounded cost-log/proposal-metrics reads — the §0.5 citation check now Greps for the cited value (the judge gains the `Grep` tool; Bash stays disallowed) and heartbeat's discover-mode priority check reads `state/cost-index.json` aggregates; both previously `Read` forever-growing JSONL files whole (~150K tokens per read once cost-log passes the 2,000-line Read cap).
- In cron-tz-shift, emit range+step (`8-23/6`) not bare `8/6` — a shifted hour/minute/DOW field that formed an arithmetic sequence ending at the field max but starting above the field min collapsed to a bare `N/step` token, which `CronCreate` rejects as invalid syntax. Affected routines silently failed to register every load cycle. (#515)
- In alert-state, split into per-writer files so a budget-breach alert can't be clobbered — budget alerts now live in `state/budget-alerts.json` and the telemetry export-failed alert in `state/telemetry-alert.json`, each with a single writer process. Previously all three writers (Stop-hook budget, watchdog-tick telemetry, heartbeat) whole-file-overwrote one `alert-state.json`, so a cross-process race could drop a breach alert unannounced. Generic readers union the files via `readMergedAlerts`.
- In pause, split into operator/auto files so a budget pause can't downgrade an operator stop — operator/watchdog pauses write `state/operator-pause.json`, budget pauses `state/auto-pause.json`; a budget-breach tick can no longer overwrite an operator's indefinite "stop" into an auto-resuming pause. `isPaused` resolves precedence (operator > watchdog > budget).
- In remote pause/status, trust the operator DM, not accept-all, when no `allowed_users` is set — with no allowlist configured, `pause`/`resume`/`snooze` and full `status` are accepted only from the operator's DM (`chat_id === dm_channel_id`); an untrusted sender gets a redacted coarse status (no spend, task text, or approval IDs). A stranger in a group can no longer freeze the hermit or read its state.
- In status, relay a composed reply on delivery failure instead of a blind model turn — when the deterministic status send can't deliver (an unsupported platform like iMessage/webhook, or a transient error), the responder injects the already-composed, redaction-correct status as context for the model to relay verbatim via the channel reply tool, instead of falling through to a model turn that — while paused — can't `Read` state and would answer from nothing.
- In telemetry, single-instance lock + recovery-first wall-cap — a per-run lock stops overlapping cron/Docker-loop ticks from double-delivering a bundle or losing the consecutive-failure count; the watchdog wall-caps the export so a slow/hung endpoint can't delay dead-session restart.
- In telemetry, refuse a bearer token over cleartext http — `postBundle` won't attach `Authorization` to a non-https, non-loopback URL; it fails loud (spool + alert) rather than leak the token on the wire.
- In ask-gate, don't strand a question on a dead channel — a channel whose recent sends are failing (e.g. a revoked token) is no longer treated as a valid redirect target, so the `AskUserQuestion` renders in the pane for the watchdog stall backstop instead of being denied into a channel that can't deliver (advisory `state/channel-health.json`, written by `lib/channel-send`).
- In watchdog, stall detection scans only the pane tail — a rendered menu or quoted output that echoes the modal tokens higher up no longer trips a false stall that would silently disable wedge/restart recovery.
- Pause/budget messages carry a dated resume time — `YYYY-MM-DD HH:MM` instead of bare `HH:MM`, so a weekly/monthly auto-resume isn't misread as minutes away (`friendlyBoundary`, shared via `lib/time`).
- Cost-index rebuilds on a timezone change; status computes spend read-only when the index is stale — a `config.timezone` edit no longer under-enforces a cap through mixed-tz buckets, and a stale/version-mismatched index no longer shows a false `$0` on the channel status reply.

### Upgrade Instructions
- The new `channel-status-responder.ts` hook ships in `hooks/hooks.json`, and `lib/channel-send.ts`/`channel-send.ts` ship in `scripts/` — all loaded straight from the installed plugin package, so a normal `/plugin update` picks them up with no per-project migration step and no new config key. Reuses each channel's existing `dm_channel_id`/`allowed_users`/`state_dir` — nothing to reconfigure for an already-set-up channel.
- The new hooks (`pause-gate.ts`, `pause-keyword.ts`) ship in `hooks/hooks.json`, which Claude Code loads straight from the installed plugin package — a normal `/plugin update` picks them up with no per-project migration step. The new `bin/hermit-pause` CLI is copied into `.claude-code-hermit/bin/` by `hatch`/`hermit-evolve`'s existing bin-wrapper refresh (detected as a missing boot wrapper) — a normal `/claude-code-hermit:hermit-evolve` restores it for already-installed operators.
- No config toggle for pause: the mechanism is inert by construction until an operator or an authorized sender invokes it. `state/operator-pause.json`/`state/auto-pause.json`, the alert-state split files (`budget-alerts.json`/`telemetry-alert.json`), and `channel-health.json` are all created lazily by the shipped scripts on first write — no migration. A pause already in force under the legacy single `state/pause.json` at upgrade time is still honored until the operator resumes.
- **Shared-group channel installs should set `allowed_users`.** Remote control (pause/resume/snooze) and full status now trust only the operator's DM when no `allowed_users` is configured. If a channel's primary chat is a group/server channel — so `dm_channel_id` is that shared chat — set `channels.<source>.allowed_users` to the operators who may control and see the hermit; otherwise every member of that chat is treated as the operator. DM-only installs need no change.
- Existing hermits are missing the `budget` config block entirely (pre-1.2.17 template). No bespoke migration needed: `hermit-evolve`'s existing generic template-key sync (`evolve-plan.ts`'s `new_config_keys`, Step 9) already detects any top-level template key absent from the operator's `config.json` and adds it verbatim from `config.json.template` — a normal `/claude-code-hermit:hermit-evolve` adds `"budget": {"daily_usd": null, "weekly_usd": null, "monthly_usd": null, "action": "alert"}`, inert until the operator sets a cap via `/hermit-settings`. The `state/cost-index.json` schema version bump (2 → 3) is self-healing: the next Stop hook rebuilds it automatically from `cost-log.jsonl`, no manual step needed.
- Existing hermits are missing `ask_gate` entirely (pre-1.2.17 template). The same generic `new_config_keys` template sync adds `"ask_gate": true` verbatim on a normal `/claude-code-hermit:hermit-evolve` — the gate and watchdog check are then live immediately (no restart needed for the watchdog check; the hook loads from the installed plugin package on next `/plugin update`). Set `ask_gate: false` to opt out.
- Existing hermits are missing the `artifacts` config block entirely, or have only `dashboard` set (pre-1.2.17 template). No bespoke migration needed for the config itself: the generic `new_config_keys` template sync (`evolve-plan.ts`, which recurses into nested leaves for a present-but-partial parent, not just fully-absent blocks) adds whichever of `dashboard`/`proposals`/`weekly_review` are missing, verbatim from the template — all default `true`. A pre-existing operator-set `dashboard: false` is left untouched (operator values are never overwritten). The `## Artifact Pages` pointer in `CLAUDE-APPEND.md` ships as part of the existing Step 6 whole-block sync; no separate step needed. Disable a page via `/claude-code-hermit:hermit-settings artifact-dashboard|artifact-proposals|artifact-weekly-review`.
- **Artifact publish authorization.** If any `artifacts.*` flag ends up `true` after the sync above, this is an operator decision with **no default in unattended mode — never run `apply-settings.ts` for this step unattended, even after relaying the deferral.**
  **Attended:** ask the operator: "This hermit publishes status/proposal/weekly-review pages via Claude Code's Artifact tool. Unattended sessions can't answer a permission prompt. Authorize publishes now, or bank the first publish of each page yourself instead?" On authorize: run `bun ${CLAUDE_PLUGIN_ROOT}/scripts/apply-settings.ts <hatch_target settings file> artifact-allow`, then `bun ${CLAUDE_PLUGIN_ROOT}/scripts/apply-settings.ts .claude/settings.local.json automode-seed`, then set `artifacts.publish_authorized` to `true` via `settings-edit`. On bank: publish the first version of each enabled page inline per `docs/artifacts.md`'s refresh procedure, record each URL in `state/artifacts.json`, and set `artifacts.publish_authorized` to `false`.
  **Unattended:** defer per SKILL.md Step 10 — record the deferred-migration block with this channel resolution stanza: `options: ["Authorize", "Bank first publishes"]`, `on_resolve: "/claude-code-hermit:hermit-settings artifact-authorization --answer {answer}"`. The reply flips `config.artifacts.publish_authorized` only; `hermit-start` applies the grant (`artifact-allow` + `automode-seed`) idempotently at next boot, outside the classifier.
- `cron-tz-shift.ts` is invoked fresh from the installed plugin script on every `hermit-routines load` — no per-project state to migrate, the fix applies on next `/plugin update`.
- The channel-safe approvals change needs no state migration — `options`/`on_resolve` are optional fields and `state-templates/micro-proposals.json.template` is unchanged. The HA plugin's `ha-morning-brief` (step 9a) shares the MP-lifecycle sync comment with core `brief/SKILL.md` and should pick up the same `options` reply-hint wording in a follow-up change. `session`/`session-start` still have unbridged interactive asks (session-start already has its own `--task` non-interactive bypass) — out of scope here, allowlisted in the new contract test, tracked as a follow-up.
- **Add the `doctor` routine to `config.json`.** Read `config.routines`. If any entry has `id: "doctor"`, skip. Otherwise tell the operator: "Adding a weekly self-diagnostic — /hermit-doctor runs Mondays 10:00 on haiku and messages you only when something is newly broken. Decline to keep it off." On accept (default), append `{"id": "doctor", "schedule": "0 10 * * *", "skill": "claude-code-hermit:hermit-doctor", "model": "haiku", "run_during_waiting": true, "enabled": true}` if `config.always_on` is `true`, else the same entry with `"schedule": "0 10 * * 1"`. On decline, append the same entry with `"enabled": false` — the id check makes the decline stick across future evolves. Then invoke `/claude-code-hermit:hermit-routines load` so the entry registers via CronCreate this session, and report: "Doctor now runs itself weekly (nineteen checks, up from sixteen — credential expiry, model pricing, channel liveness) and escalates new warn/fail findings to your channel once, in plain language. All-green weeks stay silent."
- Existing hermits are missing the `telemetry_export` config block entirely (pre-1.2.17 template). No bespoke migration needed: the same generic `new_config_keys` template sync adds `"telemetry_export": {"enabled": false, "destination": {"type": "webhook", "url": null, "bearer_env": "HERMIT_TELEMETRY_TOKEN"}, "interval_hours": 24, "redact_operator_text": true}` verbatim — inert, opt-in, nothing to migrate. If the operator later enables it under docker-security, add the webhook's host to the DNS allowlist or exports will fail and spool indefinitely.

## [1.2.16] - 2026-07-03

### Fixed
- In brief, `cost_context.yesterday` mislabeled token magnitude (K vs M) — a ~532M-token day rendered as `532.4K`. `reference.md` now copies the trend row's cells verbatim instead of re-deriving them. (#511)
- In lib/format.ts, `kStr`/`formatTokens` auto-select K/M/B by magnitude — was K-only, rendering large totals as `532431K tokens`. Fixes `cost-summary.md`, `today-cost.ts`, `weekly-review.ts`, `doctor-check.ts`, and `startup-context.ts`. Tier thresholds also account for rounding, so values just under a boundary (e.g. `999999`) promote to the next suffix instead of overflowing (`1.0M`, not `1000K`).
- In `hermit-docker update` / `hermit-update`, domain (sibling) hermits now update, not just core — the per-plugin loop moved pins straight from the local marketplace cache, which is never refreshed after first boot (auto-update is off by default for third-party/local marketplaces), so siblings silently resolved as "already up to date." Both wrappers now run `claude plugin marketplace update <name>` before the loop and process core first so `^core`-dependent siblings re-resolve cleanly. A plugin left `unchanged` with a live CLI error (e.g. `dependency-version-unsatisfied`) is now reported as `blocked` with the reason, instead of silently looking up to date, in both the terminal summary and `update-history.jsonl`.

### Upgrade Instructions
- Existing hermits run a stale on-disk copy of `bin/hermit-docker` and `bin/hermit-update` — `hermit-evolve`'s Step 5b bin-wrapper refresh replaces both from the current template, so a normal `/claude-code-hermit:hermit-evolve` picks up this fix. Until that runs, `hermit-docker update` / `hermit-update` on an un-evolved hermit keeps the old core-only behavior.

## [1.2.15] - 2026-07-03

### Removed
- `pulse`, `hermit-brain`, `daily-auto-close`, `reflect-scheduled-checks`, `knowledge`, `test-run` in skills. folded into surviving skills or dropped (see Changed); the core skill surface goes 34 → 28.
- `hermit-config-validator`, `quality-gate-judge` in agents. config validation is already covered by the `validate-config.ts` PostToolUse hook and `hermit-doctor`; the balanced quality-gate RUN/SKIP decision is now inline in `proposal-act`. 7 → 5 agents.
- Scripts/run-with-profile.ts. vestigial hook wrapper; no hook invoked it, and profile-gated hooks already self-gate on `AGENT_HOOK_PROFILE`.
- Docs/skills.md. hand-maintained skill listing that had drifted out of date; the plugin `CLAUDE.md` is the canonical skill list.

### Added
- In scripts, `render-docker-templates.ts`, `render-security-overlay.ts`, `lib/render-template.ts` — the deterministic Docker template rendering (placeholder substitution, subnet collision-detection) extracted from the docker skills into fail-loud, tested scripts. `lib/render-template.ts` is the shared `{{PLACEHOLDER}}` engine; it writes nothing if any placeholder survives.
- State-templates/docker/security/verify-security.sh — the `/docker-security` Step 8 live-posture verification heredoc, extracted verbatim into a static file the skill streams via `exec -T hermit sh -s < verify-security.sh`.
- In contract tests, version-triad and marketplace sync — the sibling manifest walk in `hooks.contract.test.ts` now also asserts each domain plugin's `plugin.json` `dependencies[claude-code-hermit]` base version matches its `hermit-meta.json` `required_core_version`, and a new test enforces `marketplace.json` ↔ `plugin.json` name/version parity in both directions. Runs under `test-hooks.yml`.
- `state/proposals-index.json` — derived proposal frontmatter cache (token efficiency). `proposals-index.ts` mirrors every proposal's frontmatter (id/status/source/category/title/created/session/responded), rebuilt on every proposal write by the `generate-summary` PostToolUse hook. `proposal-list` now renders from the index instead of reading every `PROP-*.md` body (~22K tokens → ~1K for a dozen proposals) and rebuilds it unconditionally so out-of-band writes/deletions can't leave a stale count. Legacy pre-frontmatter proposals are parsed with a `legacy: true` flag; the cache is safe to delete and rebuilds on demand.

### Changed
- Docker-setup / docker-security skills delegate rendering. Steps that hand-substituted `{{...}}` (docker-setup Step 4/7b.6; docker-security subnet detection + overlay/nftables/dnsmasq render) now call the render scripts; the conversational prompts, gates, and operational steps stay in the skills. Rendered output is functionally equivalent to the prior prose substitution — no operator-visible change (the rendered `Dockerfile.hermit` / compose files are not manifest-hashed, so no `hermit-evolve` drift fires).
- Nftables.conf.template comment — removed brace-wrapping from the `LAN_ALLOWLIST_RULES` / `DNSMASQ_UID` references in the header comment so the render engine doesn't substitute documentation prose (comment-only; no rendered-output change).
- Brief absorbs pulse — the no-flag path now serves live session status (per-session cost from `sessions/.status.json`, active-alert pointer) and gains pulse's `status`/`progress`/`what are you working on` triggers. Preserves pulse's blocked-session `/debug` hint and idle cumulative-cost source (`cost-summary.md`).
- Hermit-health absorbs hermit-brain and the knowledge lint. health now reports fragile zones, stale accepted proposals, and recent learnings alongside infra (runner-free), and runs `knowledge-lint.ts` on demand under the `check knowledge`/`lint knowledge` triggers. Runs on `model: haiku` (restoring the tier the absorbed `knowledge` skill used) — the report is mechanical aggregation, so the cheaper model holds for the `check knowledge` path.
- Session-close gains `--scheduled` — the midnight close-now/queue/noop decision formerly in `daily-auto-close`; the `daily-auto-close` routine now invokes `/claude-code-hermit:session-close --scheduled` (routine `id` unchanged).
- Reflect gains `--scheduled-checks` — the interval-check runner formerly in `reflect-scheduled-checks`, reusing reflect's evidence/triage/micro-approval gates; the `scheduled-checks` routine now invokes `/claude-code-hermit:reflect --scheduled-checks`.
- Proposal-act balanced quality gate is inline — the RUN/SKIP decision (formerly the `quality-gate-judge` agent) is now made in-skill at step e.5 and in the dispatched subagent.
- Hermit-exec.sh drops the `.py` fallback — no Python scripts ship.

- CLAUDE-APPEND slimmed 10.6KB → ~6.8KB (token efficiency) — the operator-notification branch matrix moved to `channel-responder` § Outbound notification protocol, watch-authoring rules to the `watch` skill, and knowledge-storage detail to `docs/plugin-hermit-storage.md`. The block is re-paid on every session load and every subagent dispatch, so this cuts recurring context cost across the fleet. Load-bearing anchors and the `resolve-outbound-channel.ts` invocation are retained (guarded by `tests/claude-append-budget.test.ts`).
- Five verbose skill descriptions trimmed (token efficiency) — hermit-doctor, cost-reflect, docker-security, capability-brainstorm, hermit-evolution dropped inline check/trigger enumerations. Trigger phrases were preserved, except hermit-evolution, which also shed five redundant `Activates on` variants; its remaining seven cover the skill's intent.
- Reflect no-op gating (token efficiency) — reflect accepts a `--precheck-verdict` handoff so the reflect routine's CronCreate prompt runs `reflect-precheck.ts` in bash and only loads reflect's 42KB body on a `RUN` verdict; EMPTY days never load it. Manual `/reflect` keeps its in-body precheck.

### Changed (repo, not shipped)
- **README + CLAUDE.md** — list `laravel-forge-hermit` in the pre-built hermits; drop the removed `/hermit-brain` and `/pulse` from the on-demand skills list (their scope now reads under `/hermit-health` and `/brief`).
- **CI** — new `test-scribe.yml` runs hermit-scribe's suite; `test-hooks.yml` gains a guard that the repo-internal `/simplify` mirror stays byte-identical to the shipped skill.

### Fixed
- In heartbeat, default proposal-scan item now matches the real status vocabulary (token efficiency) — the eval spec scanned `status: pending`, but proposals are written `status: proposed`, so the default checklist item could never fire and the 6h clean-recheck damper was the only thing capping wasted heartbeat dispatches. `heartbeat-precheck.ts` now resolves the default item filesystem-side, so a clean proposal queue reaches `OK` without an LLM wake.
- In heartbeat, unreadable `proposals/` dir no longer produces a false `OK` — the scan resolver distinguishes a missing dir (nothing to review) from an existing-but-unreadable one (EACCES/EIO/EMFILE) and fails open to `EVALUATE` on the latter, honoring its stated "never a false OK" invariant. A coherence test pins the shipped `HEARTBEAT.md.template` against the scan-item classifier so a template reword can't silently disable the fast path.
- In proposals-index, `mkdir`s `state/` before writing and keeps unreadable proposals as placeholder rows — a partial layout no longer yields an `OK`-with-no-write, and an fs-unreadable proposal stays visible in `proposal-list` instead of silently vanishing (heartbeat still wakes on it).
- In enforce-deny-patterns, match compound commands — each `&&`/`;`/`|` segment is now tested against the deny globs, so a pattern anchored to a leading command (e.g. `Bash(rm -rf *)`) fires inside `cd /tmp && rm -rf x` instead of being bypassed. Splitting is quote-aware, so a separator inside a quoted string (e.g. `echo "step 1; rm -rf build"`) does not fragment the command into a spurious match.
- In hermit-doctor, cost-log path honors the hermit-dir argument — resolved via `cc-compat.costLogPath()` rather than a CWD-relative path, so the cost and Opus-wake checks no longer report a false `ok` when doctor runs from a different directory.
- In hermit-doctor, dependency check handles the versioned plugin-cache layout — when the plugin root sits under `cache/<mp>/<plugin>/<version>/` (the same layout `cache-edit-guard` assumes), the sibling scan now walks up to the marketplace root and picks each sibling's newest version, rather than seeing only other core versions one level up and reporting a false "no siblings" all-clear. The monorepo/flat-cache one-level scan is unchanged.
- In docs, correct prerequisites and stale samples — `how-to-use.md` now states Bun (not Node.js 22+) as the hooks/scripts runtime and drops the `python3`/`node` permission samples the wizard never writes; README and `architecture.md` drop hand-written check/skill counts that had drifted.
- In settings-edit / proposals-index, atomic writes — both write via tmp+rename. A torn `config.json` no longer makes the strict reader `exit(1)` on every later run (operator locked out of config edits), and a torn `proposals-index.json` no longer makes `proposal-list` throw under concurrent proposal writes.
- In enforce-deny-patterns, also split on newlines and skip escaped quotes — a newline-separated command and an escaped quote (`\'`) before a separator no longer hide a dangerous segment (e.g. `rm -rf`) from the leading-anchored deny globs.
- In hermit-doctor, guard the versioned-cache sibling scan against non-semver dir names — `Bun.semver.order` throws on a non-semver dir (e.g. a `backup/` copy), which degraded the whole dependency check to a generic warn; non-semver names are filtered before the sort.
- In brief / hermit-health, preserve folded skills' triggers and pointers — restore the `hermit brain` activation phrase on `hermit-health`, and pulse's `/claude-code-hermit:session-start` (idle) and `/claude-code-hermit:session` (blocked) recovery pointers on `brief`, all dropped during the fold.
- In channels, enforce string sender IDs — `validate-config` now rejects a non-string `allowed_users` entry, and `channel-hook` coerces `dm_channel_id` to a string when persisting a live `chat_id`. A numeric channel ID silently fails the string-based sender allow-list gate (`channel-reply-reminder.ts`), locking out an authorized operator; the type is now enforced at both entry points.

### Upgrade Instructions

Run `/claude-code-hermit:hermit-evolve`. The evolve skill handles:

1. **Migrate merged/renamed routine skills.** In `.claude-code-hermit/config.json`, for every entry in `routines` (and any `scheduled_checks` entry that names a skill), rewrite the `skill` field if it references a removed skill — keep the entry's `id`, `schedule`, `model`, and flags unchanged:
   - `claude-code-hermit:daily-auto-close` → `claude-code-hermit:session-close --scheduled`
   - `claude-code-hermit:reflect-scheduled-checks` → `claude-code-hermit:reflect --scheduled-checks`
   - `claude-code-hermit:pulse` → `claude-code-hermit:brief`
   - `claude-code-hermit:hermit-brain` → `claude-code-hermit:hermit-health`
   - `claude-code-hermit:knowledge` → `claude-code-hermit:hermit-health`
   - `claude-code-hermit:test-run` → removed with no replacement; delete any `routines`/`scheduled_checks` entry that references it (it was a manual, on-demand skill, so a reference here is unusual but would otherwise dangle to a skill-not-found no-op).
2. **Scrub the stale permission.** Remove `Bash(bun */scripts/run-with-profile.ts*)` from the target settings file's `permissions.allow` if present (Step 8 already lists this removal). No new permissions are required.
3. **No config-key additions** this release.
4. **CLAUDE-APPEND block (token efficiency).** The hermit-managed block in `CLAUDE.md`/`CLAUDE.local.md` is replaced automatically by Step 6; if you customized text inside it, re-apply it afterward (the replaced block is shown in the evolve report). `HEARTBEAT.md` is not touched, and no new config keys are added.
5. **Build the proposals index (token efficiency).** Run `bun ${CLAUDE_PLUGIN_ROOT}/scripts/proposals-index.ts .claude-code-hermit` once to create `state/proposals-index.json` (derived state — safe to delete and rebuild anytime; the `generate-summary` hook refreshes it on every subsequent proposal write). Step 8 already adds the `Bash(bun */scripts/proposals-index.ts*)` permission.

Operators who don't want the merged behavior can keep using the old natural-language triggers — `status`/`progress` reach `brief`; `what's stuck`/`recent learnings` reach `hermit-health`; `check knowledge` reaches `hermit-health`.

## [1.2.14] - 2026-07-02

### Added
- In channel-log, episodic DM capture — hook-level capture of Discord/Telegram DM text into `state/channel-log.sqlite` (FTS5), gated by the existing operator allowlist and `knowledge.channel_log_enabled`. Feature-detected: inert until a channel delivers a message.
- In recall, channel log as a fourth source — `/recall` and `search.ts` now search past DM text alongside sessions/compiled/proposals, labelled `[channel]` and flagged as untrusted external input.
- In weekly-review, channel-log consolidation step — distills durable decisions from the week's DM log into memory/compiled via a read-only skill-eval-runner dispatch; prunes only already-consolidated rows past `knowledge.channel_log_retention_days`.
- In startup-context, post-compaction state pointers — a new capped section injects `runtime.json` session_state/waiting_reason, pending micro-approvals, and outbound channel routing on every `SessionStart` with `source: "compact"`, so both native and driver-sent compaction stop silently dropping hermit state.
- In watchdog, routine-hygiene context compaction — `context_hygiene.compact` (on by default, 150k/4h) sends `/compact` at a much lower threshold than the existing 700k emergency `/clear`, so cold-cache wakes stop re-paying the full accumulated context. A boundary marker (`state/compact-requested.json`, written by `session` and `proposal-act` at arc-end moments) waives the interval cooldown but never the 60k token floor.

### Changed
- In hatch, config.json assembly is now deterministic (`hatch-config.ts`) — Step 5's ~40-line hand-merge of the template with wizard answers is now a single script call; the model builds an answers payload instead of hand-transcribing cron strings, `scheduled_checks` entries, and channel objects. Re-init merges by id (routines, `scheduled_checks`) and per-field (channels), never advances `_hermit_versions`, and preserves any key the payload doesn't mention. Fixes a pre-existing bug where Step 3/Quick Turn 1 read `hermit.boot_skill` from a sibling's `plugin.json` instead of `hermit-meta.json` (always resolved to `null`). `validate-config.ts` gained `remote` (boolean) and `idle_behavior` (`wait`/`discover`) checks it was missing. Hardened payload handling: a malformed `activated_hermit` (missing slug/version) is refused rather than stamping a phantom `_hermit_versions` entry; null `channels`/`scheduled_checks_plugins` payloads fail cleanly instead of crashing; a duplicate plugin in `scheduled_checks_plugins` no longer produces duplicate ids; and `morning_brief_time: null` disables an existing channel brief on re-init.

### Fixed
- In suggest-compact, removed dead `context_usage` branch — the Stop hook never receives a `context_usage` field, so the 60%-based suggestion has never fired. The tool-call counter is now the sole suggestion path; docs no longer describe it as a fallback.

### Upgrade Instructions

Run `/claude-code-hermit:hermit-evolve`. The evolve skill handles:

1. **Merge new config keys** — `knowledge.channel_log_enabled`, `knowledge.channel_log_retention_days`, and the `context_hygiene` block are added to `.claude-code-hermit/config.json` via the standard `new_config_keys` merge (missing-only, never overwrites an operator-set value).

No other file refresh required — skills and scripts load live from the installed plugin.

**Note:** both new features (channel-log capture, routine-hygiene compaction) ship enabled by default per the research-preview convention. Disable via `/hermit-settings` (`knowledge.channel_log_enabled: false`, `context_hygiene.compact.enabled: false`) if not wanted.

## [1.2.13] - 2026-06-29

### Added
- In proposal template, optional `## References` section — backward-looking sources for agent-authored proposals. Placed after `## Verification`; required — cite real sources, or write `n/a — <reason>` for operator-requested or qualitative proposals. `proposal-create` is updated to fill it.

### Changed
- In proposal-triage, reflection-judge, skill-eval-runner, removed `maxTurns` cap — fixed caps caused turn-exhaustion failures on mature deployments where proposals, sessions, and memory accumulate over time; any static number eventually becomes too small. Empirically confirmed: omitting the cap gives generous harness-default headroom rather than a trap.

### Fixed
- Proposal-triage, reflection-judge gates now fail closed on missing verdict — a no-verdict result (cap hit, error, or malformed output) previously failed open, letting candidates bypass dedup/suppression. All callers (`proposal-create`, `reflect`, `reflect-scheduled-checks`) now fail closed and append a `gate-failed` row to `state/proposal-metrics.jsonl` plus a Progress Log note. The candidate re-surfaces on the next reflect cycle.
- In hermit-evolve, domain (sibling) hermits now upgrade reliably — `evolve-plan.ts` computes sibling plans deterministically (registry-driven from `_hermit_versions`), `plan.work_pending` replaces the core-only short-circuit so sibling-only gaps still run, and the `hermit-update`/`hermit-docker update` wrappers chain evolve on any registered hermit gap.

### Upgrade Instructions

Run `/claude-code-hermit:hermit-evolve`. The evolve skill handles:

1. **Refresh PROPOSAL.md template** — copy `${CLAUDE_PLUGIN_ROOT}/state-templates/PROPOSAL.md.template` to `.claude-code-hermit/templates/PROPOSAL.md.template` so the new `## References` section reaches the next generated proposal. Past PROP-NNN files are not retroactively rewritten.
2. **Refresh bin wrappers** — `bin/hermit-update` and `bin/hermit-docker` in `.claude-code-hermit/bin/` ship new sibling-gap detection logic. The evolve skill replaces them automatically via the standard bin-wrapper refresh (Step 5b).

## [1.2.12] - 2026-06-26

### Added
- In config, `storage_drift.ignore` — allowlist of top-level `.claude-code-hermit/` dirs exempt from storage-drift alerts. Domain plugins register hermit-owned runtime trees (Composer vendor installs, SDK caches) so the drift check never false-flags them as stray archive content. See `docs/plugin-hermit-storage.md`.
- In session-close, completed-vs-Artifacts closeout check — a quality-check item flags when `## Completed` claims a deliverable a skill persists to `compiled/` but it's absent from `## Artifacts`, catching silently-dropped outputs at close instead of in a later session. Report template now labels `## Completed` as narrative. (#465)

### Changed
- In judge subagents, state terse-output rationale explicitly — `proposal-triage`, `reflection-judge`, and `quality-gate-judge` now say their final message lands verbatim in the caller's long-lived context and re-read from cache each turn, so reasoning belongs in thinking, not the response (#468).

### Fixed
- In drift, storage-drift no longer false-flags allowlisted runtime dirs — `findStorageDrift` reads `config.storage_drift.ignore` and skips declared dirs in both the session-start Storage Drift block and the reflect observations ledger. Fail-open: absent or invalid config defaults to no exemptions.
- In heartbeat/alert-state, atomic writes + corrupt-file quarantine — `heartbeat-precheck.ts` and `update-alert-state.ts` write `alert-state.json` via temp+rename and quarantine an unparseable existing file to `alert-state.json.corrupt-<ts>` instead of reinitializing skill-owned `alerts`/`self_eval` to empty. Reads split the file read from the JSON parse (shared `scripts/lib/alert-state.ts`), so a transient read error (EACCES/EMFILE/EIO) on a healthy file is never mistaken for corruption and never quarantined or reset. Stops silent loss of accumulated alert/self-eval telemetry on an interrupted or partial write (#463).
- In hermit-settings, reconcile the heartbeat monitor on change — after writing a `heartbeat` change, auto-runs `/heartbeat start` (if enabled) or `/heartbeat stop` (if disabled) so the live Monitor's cadence and `config.json` can't silently desync. (#452)
- In routines, suppress duplicate `fired` metric — heartbeat-restart's self-re-arm (`hermit-routines load` at its own prompt tail) could log a second `fired` with no intervening `started` (#464); `log-routine-event.sh` now skips a `fired` that immediately follows another `fired` for the same routine.

### Upgrade Instructions

Run `/claude-code-hermit:hermit-evolve`. The evolve skill handles:

1. **Refresh SESSION-REPORT.md template** — copy `${CLAUDE_PLUGIN_ROOT}/state-templates/SESSION-REPORT.md.template` to `.claude-code-hermit/templates/SESSION-REPORT.md.template`.

No `config.json` changes required. (`storage_drift.ignore` is additive and fail-open; domain plugins register their own dirs via their hatch steps.)

## [1.2.11] - 2026-06-24

### Added
- In hatch, idle_behavior choice in Quick — Quick Turn 3 now asks proactive (`discover`) vs reactive (`wait`) instead of silently defaulting to `discover`, so operators pick deliberately.
- In cost-reflect, per-model cost breakdown — adds a "Cost by model" section so mixed-model (Sonnet main + Haiku subagent) operators can attribute spend per model without reading raw logs. Section is omitted for single-model windows.
- Scripts/docker-preflight.ts — single-call probe for docker-setup Step 1 (docker presence, config/WSL/existing-file checks, host gitconfig, auto-memory seed) returned as one JSON blob, replacing fanned-out Bash round-trips.
- Scripts/hatch-scaffold.ts — deterministic state-tree scaffolder for hatch Step 2 (dirs, templates, `bin/` chmod, state files with a live `reflection-state.since`). Mode-aware: `--reinit=true` refreshes hermit-owned pristine files only and never clobbers operator/state artifacts.

### Changed
- In docker-setup, copy the static entrypoint with `cp` — `docker-entrypoint.hermit.sh` (26 KB, no placeholders) is copied verbatim from the template instead of regenerated line-by-line through the model — cuts the slowest step of every docker-setup with zero transcription risk. Manifest baseline unchanged (cp is byte-identical).
- In docker-setup, step 1 prerequisites via docker-preflight.ts — one probe call; Steps 4/5 reuse its `gitconfig`/`memory` fields instead of re-probing.
- In hatch, step 2 state tree via hatch-scaffold.ts — replaces the enumerated mkdir/cp/chmod/init prose with one scaffold call; reasoned artifacts (config.json, OPERATOR.md content, CLAUDE block) keep their own steps.
- In hatch, append the session-discipline block with `cat` — the placeholder-free CLAUDE-APPEND template is appended/created via `cat` instead of LLM regeneration (the replace path still removes the prior block first).
- In hatch, phase 3/5 question specs as tables — the verbose `questions: [...]` JSON examples collapse to compact, content-identical tables, trimming the resident SKILL.md. Verified a live Haiku run still builds the batched AskUserQuestion correctly from the table form.

### Fixed
- In docker, bash sandbox set off in containers — `/hatch` and `/docker-setup` set `sandbox.enabled:false` for container deployments. The container is the isolation boundary Anthropic recommends for unattended runs; the nested bwrap sandbox is optional and, on Ubuntu 24.04+ hosts, can't start in-container and silently kills the heartbeat and `/watch` Monitors. `hermit-start` no longer manages the key at runtime; `/hermit-evolve` migrates existing installs. (https://code.claude.com/docs/en/sandbox-environments)
- In hatch, domain auto-resume — domain hatch writes a state marker before delegating to core; core terminus reads, deletes, and invokes the pending domain hatch via the Skill tool. Removes the dead printed-command return hop and the competing-signal freeze. Adds the domain hatch continuation protocol doc.
- In hermit-docker login, re-authenticate on expired token — gate the "already authenticated" short-circuit on credential freshness (`claudeAiOauth.expiresAt < Date.now()`), not just presence; an expired OAuth token now opens the login REPL instead of falsely reporting success.
- In hatch, init gate keys on `config.json` — Step 1 now treats `config.json` (not bare directory content) as the "already initialized" signal, so a pre-core resume marker, an empty `state/` tree, or a half-written aborted run no longer trips the reinit prompt on a genuine first hatch.
- In hatch, quick auto-chain vs resume — the Quick auto-chain is suppressed when a resume marker is present, so it and the resume terminus can't both fire and drop each other. Resume marker no longer carries an unused `requested_at` field.

### Upgrade Instructions

~~Step 1 — Docker sandbox posture (Docker hermits only).~~ — **superseded, no-op.** Hermit no longer probes for or configures the Claude Code bash sandbox; that's the operator's call via Claude Code's own `/sandbox` command. Do not write any `sandbox.*` key. Existing installs keep whatever `sandbox.*` they already have.

## [1.2.10] - 2026-06-23

### Added

- Scripts/manifest-seed.ts — deterministic sha256-baseline writer for `template-manifest.json`; used by `hatch`, `docker-setup`, and `hermit-evolve`. Replaces model-computed hashes (LLM sha256 is unreliable), fixing silent drift misclassification. Fail-loud; refuses to overwrite a present-but-corrupt manifest; preserves foreign keys.
- Scripts/apply-settings.ts — fixed-operation settings helper; hatch and docker-setup write settings via Bash (not Edit/Write tools), letting both succeed inside a running strict-profile hermit. Operations: `task-id`, `allow`, `deny`, `sandbox`.

### Changed

- In hatch, settings operations via apply-settings.ts — Steps 5-task, 8, 9, 9a and docker-setup Step 6.4 call `apply-settings.ts` instead of the Edit/Write tools directly; the `always_on` guard on `.claude/settings.json` is intentionally left intact.
- In hatch, manifest-seed call deferred to Step 8 — seeding runs after the permission merge so `Bash(bun */scripts/manifest-seed.ts*)` is in the allow-list before the script executes.
- In docker-setup, batch read-only prerequisite probes — Step 1's read-only shell checks (docker version, config/WSL checks, gitconfig) batched into one Bash call; write-paths remain sequential.

### Fixed

- In docker-entrypoint, marketplace registration via `list --json` — `marketplace_registered()` reads `known_marketplaces.json`; fixes "No marketplaces configured" on a fresh named volume or partial prior add where the dir exists but isn't registered.
- In docker-entrypoint, plugin-enable failures now logged — `enable_plugin()` suppresses only the benign "already enabled" exit; any other non-zero exit surfaces as a warning in `docker compose logs`. Previously `|| true` swallowed all failures.
- In hatch, apply-settings.ts aborts on malformed target settings file — strict read prevents silent data-loss if the operator's settings file is present-but-corrupt.
- In docker-setup, manifest-seed call anchored to absolute PROJECT_ROOT path — was cwd-relative; cwd can drift after `docker compose`/`tmux` calls earlier in the skill.

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

- In CLAUDE-APPEND, auto-mode denial alert — hermit now notifies the operator (channel-first, per § Operator Notification) with the blocked action and reason when the auto-mode classifier denies a tool call.
- In heartbeat, dedicated update-alert-state.ts — deterministic alert-state merge replacing the model-performed write; mirrors reflect's update-reflection-state pattern. Payload is delivered on stdin via a quoted heredoc so free-text alert content (apostrophes, quotes) can't break the command.

### Fixed

- In reflect/append-metrics, free-text JSON events delivered via stdin heredoc — apostrophes in pattern labels and question strings no longer corrupt the metrics ledger (same shell-quoting class as #441). `append-metrics.ts` is now dual-mode: argv for enum/id/count/slug payloads, stdin for free-text. Call sites in reflect, reflect-scheduled-checks, channel-responder, and brief updated accordingly.

### Changed

- In docker, base image bumped to Ubuntu 26.04 LTS — was 24.04; 26.04 is the current LTS. Existing hermits migrate via a surgical `FROM` patch that preserves Dockerfile customizations; evolve suppresses the now-stale docker-setup drift notice for this release.

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

- Capture async subagent costs in subagent-cost (#435) — new `scripts/subagent-cost.ts` on `SubagentStop`; reads the agent transcript and logs cost rows only for async-launched dispatches (heartbeat eval runner, routine dispatchers). Sync dispatches remain in cost-tracker; no double-count. Requires CC >= v2.1.143.

### Upgrade Instructions

Run `/claude-code-hermit:hermit-evolve`. No further migration steps required.

No `config.json` changes required.

## [1.2.7] - 2026-06-19

### Added

- In session-close, third debrief question for skill-correction telemetry — close debrief now asks whether a skill produced defective output this session; a positive answer appends a `skill-correction:<name>` ledger row to `state/observations.jsonl` (fail-open, gated to operator-close only). The `## Lessons` line carries the what/why; the ledger row is a bare recurrence counter.
- In reflect, `skill-correction:*` graduation routing — graduated `skill-correction:<name>` ledger patterns resolve to a Tier 2 skill-improvement candidate: brief found → `## Skill Improvement` section with `source_artifact:` pointing to the procedure brief; no brief → plain Tier 2. Both routes carry `Artifact: state/observations.jsonl` and proceed via triage then micro-approval queue.
- In proposal-act, `source_artifact:` anchor for skill-creator improve — before invoking `skill-creator:skill-creator`, parses the `source_artifact:` line from `## Skill Improvement`; if the brief path is readable, passes its content as input context. Missing or unreadable: proceeds without it (no REJECT).
- In heartbeat, configurable eval model (`heartbeat.model`, default `haiku`) — cuts the EVALUATE subagent cost ~70% on sonnet sessions. Override to `"sonnet"` or `"opus"` for richer checklist evaluation, or set to `null` to inherit the session model. Dispatch now uses `claude-code-hermit:skill-eval-runner` explicitly with the configured model. Step 5 gains a fail-open JSON guard: malformed or incomplete subagent returns skip the state merge and emit `HEARTBEAT_OK` rather than corrupting `alert-state.json`.

### Fixed

- Report filename is invariant in session-mgr (#418) — archive steps now explicitly state that the report file is always `${session_id}-REPORT.md`; if it already exists, overwrite in place. Prevents the archiving model from improvising a dated `S-NNN-REPORT-YYYYMMDD-HHMM.md` duplicate when the canonical file is already present (e.g. re-archive of a previously operator-closed session).
- In hermit-evolve, confirm the `_hermit_versions` bump on disk (#426) — step 9 now performs the version bump via a deterministic `scripts/evolve-finalize.ts` instead of an LLM hand-edit. The runner reports the re-read on-disk version (`core.confirmed`) instead of `plan.to`. A dropped bump now surfaces as `Upgrade: blocked` instead of falsely reporting success and re-nagging the upgrade banner every session.
- Reap stray timestamped report stubs on upgrade in recall (#430) — existing `S-NNN-REPORT-YYYYMMDD-HHMM.md` stubs (created before #427) bypass strict consumers but pollute `/recall`'s broad scan; hermit-evolve now deletes them on next upgrade.

### Upgrade Instructions

Run `/claude-code-hermit:hermit-evolve`. The evolve skill handles:

1. Update the plugin — run `claude plugin update claude-code-hermit`.
2. Add `Bash(bun */scripts/evolve-finalize.ts*)` permission — hermit-evolve step 8 adds it automatically if missing.
3. Add `"model": "haiku"` to the `heartbeat` block in `.claude-code-hermit/config.json` (e.g. after `"clean_recheck_cooldown"`). Cuts EVALUATE subagent cost ~70% on sonnet sessions. To keep prior behavior (session model), set `"model": null` or omit the field.
4. Reap stray timestamped report stubs — in `.claude-code-hermit/sessions/`, delete any `S-*-REPORT-*.md` files that have a timestamped suffix (the variant only, not the canonical `S-NNN-REPORT.md`).

## [1.2.6] - 2026-06-17

### Added

- In reflect, break reflection input-starvation — three changes that unblock the pipeline on hermits where `observations.jsonl` never fills: (1) `reflect-precheck.ts` now writes storage-drift and schema-drift rows to the observations ledger (deduped by pattern — drift is structural, so a standing drift writes one row until it ages out of the 30-day prune window, not one per session, and never re-triggers a full reflect run every session; the drift slug preserves the full subpath, e.g. `storage-drift:raw/foo`); (2) a freshness RUN gate (`observations_fresh` phase key) flips EMPTY→RUN when new ledger rows exist; (3) new config key `reflection.graduation_min_sessions` (default 1) lowers the graduation threshold from a hardcoded 2, so single-session observations can surface. The judge, triage, and all security guards are unchanged.
- In reflect, `origin` field on ledger rows — `startup-drift` rows carry `origin:"own-work"`; `reflect-noticed` rows carry `origin` copied from SHELL.md `[origin: external]` markers. Step 3b aggregates origin across grouped rows (external-content wins) and carries it into the candidate's `Evidence Origin`, so judge §2 correctly quarantines external-origin observations to Tier 3.
- In config, `reflection.graduation_min_sessions` — positive integer, default 1. Dial to 2 to restore pre-v1.2.6 behavior. Applies to both observations-ledger graduation and procedure-capture recurrence. Documented in `docs/config-reference.md` and `hermit-settings reflection`.

### Changed

- In reflect step 3b, graduation threshold is now config-driven — removed "at least one not the current session" sub-clause; replaced hardcoded ≥2 with `graduation_min_sessions`.
- In reflection-judge §1.4, config-agnostic verification — verifies ≥1 ledger row per cited session instead of hardcoded ≥2 distinct sessions.
- In proposal-triage + proposal-create, accept ledger graduates — broadened the artifact exception so any judge-verified `Artifact: state/observations.jsonl` candidate satisfies condition 1 (was limited to efficiency/cost-class candidates).
- In channel-responder, delegation nudge at §2 — adds a one-sentence pointer before the handler list so archive traversals and multi-file research dispatched from channel questions delegate to Explore rather than running inline in the long-lived session.
- In CLAUDE-APPEND, trim reference sections — removed Agent State table, Subagents catalog, and Quick Reference list (~100 → ~75 lines); content covered by `architecture.md` and `docs/skills.md`, which don't reload every turn. Fixed 23 stale `.py`/`.js` doc references (all scripts migrated to `.ts`). Added missing core agents to `architecture.md` Layer 3. Added "Scheduling ownership boundaries" subsection to `architecture.md`.

### Upgrade Instructions

Run `/claude-code-hermit:hermit-evolve`. The evolve skill handles:

1. Update the plugin — run `claude plugin update claude-code-hermit`.
2. Add `reflection` to `config.json`: open `.claude-code-hermit/config.json` and add `"reflection": { "graduation_min_sessions": 1 }` at the top level (before the closing `}`). Ships enabled by default; set to 2 to restore the two-session recurrence bar.

## [1.2.5] - 2026-06-16

### Changed

- In CLAUDE-APPEND, codify main-as-orchestrator delegation guideline (#406) — §Context-hygiene now covers execution delegation: a three-condition test for when to dispatch a sub-step, the comms contract (subagent returns verdict + optional `operator_message`; main owns `AskUserQuestion`, channel resolution, `PushNotification`), and the `CLAUDE.md`-inheritance break-even.
- In proposal-act, dispatch the accept-flow tail to a general-purpose subagent (#402) — implement, quality gate, and verification run in one isolated subagent context; only a compact structured report returns. Skill-authoring (`## Skill Improvement`, `## Skill Draft`) and routine proposals remain in main.

### Upgrade Instructions

Run `/claude-code-hermit:hermit-evolve`. The evolve skill handles:

1. Update the plugin — run `claude plugin update claude-code-hermit`.

No `config.json` changes required.

## [1.2.4] - 2026-06-14

### Fixed

- Hermit-routines routines silently never registered (#395) — `load` resolved pluginRoot via `echo $CLAUDE_PLUGIN_ROOT`, which is empty at Bash runtime in all modes, so the guard aborted load and no CronCreate was registered. Now derives pluginRoot from the skill's Base directory (mirrors the #394 hermit-evolve fix).
- In cost-tracker, attribute dispatched-subagent tokens (#390) — Agent tool_result usage (model-override routines, heartbeat, ad-hoc Task) was silently dropped; now emitted as a per-subagent cost-log line at its resolved model, attributed to the dispatching source. Cost totals will rise to reflect previously-invisible spend; cost-reflect folds subagent cost into the dispatching source row automatically.
### Changed

- In min CC version, floor bumped to 2.1.172 (#389) — nested-subagent dispatch (used by the shipped `daily-auto-close: haiku` default) requires it; on older versions the nested `session-mgr` call fails silently, preventing auto-close. Prerequisite docs updated.
- In hermit-evolve, upgrades now run in an `evolve-runner` subagent — keeps the upgrade's transient context (changelog, migrations, diffs) out of the calling session, cutting recurring token cost; only a compact report returns. Undecidable migration choices escalate back to the operator. Interactive evolve no longer prompts mid-flight for new settings or template-conflict choices — safe defaults applied, conflicts parked as `.new`; adjust via `/hermit-settings`.
- In heartbeat, unreachable OK gate replaced by clean-recheck damper — the per-item OK fast-path in `heartbeat-precheck.ts` was unreachable for any hermit with a checklist (clean items never produce alert entries, which the gate required). A `clean_recheck_cooldown` damper (default `"6h"`) now makes the clean path reachable: after a clean EVALUATE, subsequent ticks return OK directly until the cooldown expires. All change-detecting gates — stale session, micro-proposal, pending-close, suppressed-digest, 20-tick self-eval — bypass the damper. This reduces LLM wakes from every-tick to ~3 per active-day for a healthy hermit. Set `heartbeat.clean_recheck_cooldown: null` to revert to per-tick EVALUATE.

### Changed

- In hermit-brain / hermit-evolution / capability-brainstorm, dispatch heavy reads to `skill-eval-runner` — the three Tier-2 skills that read session-report bodies, weekly-review files, compiled artifacts, and proposal contents inline now dispatch those reads (and `proposal-metrics-report.ts` / `cost-reflect.ts` script runs) to the shared isolated-context `skill-eval-runner`. Main session keeps channel routing, proposal creation, artifact writes, and channel sends. The dispatching skill passes the resolved `plugin_root` in the dispatch prompt so the runner can run scripts and read template/sibling paths — `${CLAUDE_PLUGIN_ROOT}` is not substituted in `reference.md` content read via the Read tool. Contract tests in `tests/contracts.test.ts` guard against dispatch-ref loss, schema drift, and `${CLAUDE_PLUGIN_ROOT}/` path use in any `reference.md`.
- In weekly-review, topic-page semantic check runs in an isolated-context subagent — Step 3's full-body topic-page reads are dispatched to `skill-eval-runner` via a new `skills/weekly-review/reference.md`. The runner reads every `compiled/topic-*.md` and returns `{ topic_findings }` (≤3 findings); all channel send and side effects stay in the main session. A `weekly-review delegation contract` in `tests/contracts.test.ts` guards against schema drift.

- In brief, dispatch archived-report/cost/proposal reads to skill-eval-runner — archived `S-*-REPORT.md` bodies, `cost-summary.md`, `proposals/*.md` frontmatter, `OPERATOR.md`, and `NEXT-TASK.md` are dispatched to the shared `skill-eval-runner` via a new `skills/brief/reference.md`. Live state, TaskList, micro-proposal lifecycle, and delivery stay in the main session. Dispatch is mode-conditional: `--morning`, `--evening`, daily, and default-no-session modes dispatch; `in_progress` default mode summarizes the live SHELL.md in main. A `brief delegation contract` in `tests/contracts.test.ts` guards against schema drift.

- In reflect, file analysis runs in a shared isolated-context subagent — Resolution Check, routine health, and procedure-capture detection are dispatched to a new `skill-eval-runner` agent (a generic, reference-driven runner any skill can reuse by pointing it at its own `reference.md`). The runner reads only files and returns structured JSON; all writes, frontmatter patches, and proposal routing stay in the main session. Eliminates the 3-verbatim-report read from the main session's inherited context, cutting per-reflect input tokens on always-on hermits. The dispatching skill passes the resolved `plugin_root` in the dispatch prompt so the runner can run `eval-success-signal.ts` — `${CLAUDE_PLUGIN_ROOT}` is not substituted in `reference.md` content read via the Read tool. A `reflect delegation contract` in `tests/contracts.test.ts` asserts the schema block is byte-identical between `reference.md` (producer) and `SKILL.md` (consumer), preventing drift.

- In heartbeat, eVALUATE runs in an isolated-context subagent — the checklist evaluation is dispatched as a fresh-context Agent subagent instead of running inline in the main session. The eval reads only files and needs none of the inherited main-session context; moving it to isolated context significantly reduces per-wake token cost. The main session handles all writes (alert-state, SHELL.md Monitoring) and notifications after receiving the subagent's structured JSON result, keeping cost attribution and channel access on the main turn.

### Upgrade Instructions

Run `/claude-code-hermit:hermit-evolve`. The evolve skill handles:

1. Add `"clean_recheck_cooldown": "6h"` under `heartbeat` in `.claude-code-hermit/config.json`. If already present, skip. To disable the damper (revert to per-tick EVALUATE), set the value to `null`.

## [1.2.3] - 2026-06-13

### Added

- Community Discord — dev-community invite published in both READMEs with channel shape, starter threads, moderation notes, and invite publishing checklist.

### Fixed

- In capability-brainstorm, use fully-qualified skill name for proposal-create — short-form `/proposal-create` fails when the model autonomously invokes a skill; changed to `/claude-code-hermit:proposal-create` so the Skill tool resolves it correctly.
- In proposal-act/reflect/proposal-create, fully-qualify skill-creator invocations — short-form `/skill-creator` fails when the model invokes the skill (procedure-capture install, skill-improvement, `NEXT-TASK.md` plan bullets); changed to `/skill-creator:skill-creator` so the Skill tool resolves it.
- In session-start, suppress duplicate startup ping after watchdog context-clear (#385) — when the watchdog sends `/clear` to refresh context, a scheduled task could re-invoke `session-start` and re-send the "Hermit online" ping. The watchdog now writes `context_cleared: true` to `state/runtime.json` before `/clear`; session-start detects and consumes the marker and suppresses the ping for that invocation only.
- In hooks, cwd-drift bug class resolved (#384) — `hermitDir()` added to `scripts/lib/cc-compat.ts` resolves `.claude-code-hermit/` via `AGENT_DIR` → `CLAUDE_PROJECT_DIR`+`existsSync` → cwd walk-up → fail-open, surviving any `cd` that drifts shell cwd inside `.claude-code-hermit/`. All 10 affected hook scripts updated; payload-anchored hooks anchor on the absolute `file_path` from the hook payload instead.

### Upgrade Instructions

Run `/claude-code-hermit:hermit-evolve`. The evolve skill handles:

1. **Update the plugin** — run `claude plugin update claude-code-hermit` to get the fixed hooks and skills.

No `config.json` changes required.

## [1.2.2] - 2026-06-13

### Added

- In routine-metrics, `started` marker before skill invocation — distinguishes "routine fired but errored before completion" (emits `started`, no `fired`) from "correctly never fired" (no entries). `reflect` now surfaces routines where `errored = count(started) − count(fired) >= 2` over 14 days as a diagnostic finding. Closes #378.
- In watchdog, context-size auto-clear — sends `/clear` when a hermit-owned turn's prompt-side tokens (`input + cache_write + cache_read`) exceed `watchdog.context_clear_tokens` (default 700 000), preventing scheduled routines from re-reading a bloated context at 5–22× normal cost. Fires independently of `watchdog.enabled`; gated on always-on mode, operator silence ≥ 10 min, and 2-tick pane-hash quiescence. Fixes #373.
- In watchdog, liveness signal + doctor detection — `hermit-watchdog run` now stamps `last_run` into `state/watchdog-state.json` on every invocation, before any gate, so a fresh stamp proves the scheduler/loop (systemd/launchd/cron or the Docker entrypoint loop) is firing the script. `hermit-doctor`'s `watchdog` check reads it: a stale (>20 min) or missing stamp reports `enabled but not firing` with remediation keyed to `runtime_mode` (tmux → `bin/hermit-watchdog install`; docker → recreate the container; unknown → both). Replaces the `systemctl`/`crontab`/`ps` self-diagnosis that false-alarmed on healthy Docker hermits (the loop runs no OS timer by design, and `watchdog.log` only captures stderr, so it stays stale even when firing).

### Fixed

- In hermit-evolve, stop seeding dead `watchdog/` templates into project state (#379) — v1.2.0 seeded four infra templates into `.claude-code-hermit/watchdog/`; nothing reads them (`hermit-watchdog install` renders from the plugin's `state-templates/watchdog/`), and the storage-drift checker flagged them on every session start. Seeding removed; existing stray dirs cleaned up on next evolve.
- In reflect, hermit-evolution, name the `event` field in routine-metrics fire counts — prevents silent zero counts when a model confuses `routine-metrics.jsonl`'s `event` field with `proposal-metrics.jsonl`'s `type` field; both skills now explicitly say `event == "fired"` (#375).

### Upgrade Instructions

Run `/claude-code-hermit:hermit-evolve`. The evolve skill handles:

1. **Remove dead watchdog template dir** — in `.claude-code-hermit/watchdog/`, delete only these four files if present: `hermit-watchdog@.service`, `hermit-watchdog@.timer`, `com.hermit.watchdog.plist`, `crontab.txt`. Then run `rmdir .claude-code-hermit/watchdog/`. `rmdir` refuses a non-empty dir — if the operator added their own files, leave the dir intact and note it. Use per-file `rm` plus `rmdir` only, never `rm -rf`.
2. **Add `context_clear_tokens` to `watchdog` config** — add `"context_clear_tokens": 700000` to the `watchdog` block in `.claude-code-hermit/config.json`. To disable, set to `null` or `0`.
3. **Seed watchdog liveness stamp** — run `.claude-code-hermit/bin/hermit-watchdog run` once to write `last_run` into `state/watchdog-state.json` before the first tick. Stamped before any gate, so it works even with `watchdog.enabled: false`.

## [1.2.1] - 2026-06-12

### Fixed

- In Docker, entrypoint reboot-loop after 1.2.0 upgrade — `docker-entrypoint.hermit.sh.template` contained `SESSION_NAME="{{TMUX_SESSION_NAME}}"` (a placeholder previously substituted only by `/docker-setup`). The 1.2.0 Upgrade Instructions told Docker operators to `cp` the raw template without a substitution step, leaving the literal string `{{TMUX_SESSION_NAME}}`. The keep-alive watch loop (`tmux has-session -t "{{TMUX_SESSION_NAME}}"`) exited immediately, PID 1 fell through, and `restart: unless-stopped` reboot-looped the container. The entrypoint now resolves the session name from `config.json` at runtime using the same logic as `lib/tmux.getSessionName`; the file is safe to raw-copy with no substitution.
- In Docker, `${PWD}` bind-mount mounts wrong tree when compose runs from wrong directory — added a comment in `docker-compose.hermit.yml.template` clarifying that `docker compose` must run from the project root (`hermit-docker up` always does this). This was the secondary cause of collateral container failures during manual recovery after the reboot-loop above.
- In `hermit-docker update`, ephemeral plugin update reverted on restart — it refreshed marketplaces and sent `/reload-plugins`, which serves the newest *staged* version but never moves the version pin in `installed_plugins.json`; the next container restart reverted to the old plugin. Now runs `claude plugin update <id>@<marketplace> --scope <scope>` per installed plugin (the only durable operation — verified against CC 2.1.175), records per-plugin `before`/`after`/`status` in `update-history.jsonl`, and auto-chains `/claude-code-hermit:hermit-evolve unattended` into the tmux session when the core version moved. Reads post-update pins before the reload to dodge `plugin list` view lag.
- `hermit-docker` prompt-detection was stale for current Claude Code — `_wait_for_claude_prompt` matched only the old `╭─/╰─` rounded-corner input box, which CC 2.1.175 no longer renders (it uses `────` rules + `❯` + a mode hint), so the wait always timed out and `/reload-plugins` was never sent. Detector now matches the prompt char plus any current box marker; verified live (reload → gated follow-up command executes in the REPL).

### Added

- In `hermit-evolve`, explicit `unattended` argument — `/claude-code-hermit:hermit-evolve unattended` runs the full upgrade with zero prompts (settings → defaults, permissions added + reported, migration prompts deferred/non-destructive, conflicts parked as `.new`), reporting everything via the channel notification. The no-prompt rule now also covers Step 2b changelog migrations and Step 7 sibling migrations, which previously could block on an `AskUserQuestion`.
- In `bin/hermit-update`, one-command update for local / tmux hermits — host twin of `hermit-docker update`. Moves the durable pin for project/local plugins (skips user-scope with a manual-command hint), reloads the live tmux session, and auto-chains `hermit-evolve unattended` on a version gap. Delegates to `hermit-docker update` when a Docker stack is running; refuses (rather than touching host pins) when Docker scaffolding exists but the container is stopped.
- Always-on directive upgrade banner — `check-upgrade.sh` now reads `always_on` and, when true, emits a `REQUIRED:` banner instructing the session to run `hermit-evolve unattended` before other work; `session-start` and `brief` treat it as the hard first action. Interactive hermits keep the advisory wording.
- In `hermit-evolve`, docker entrypoint is manifest-managed (Step 5c) — now that the entrypoint is placeholder-free it joins the customization-aware `template-manifest.json` system as a boot-critical file: operator edits are kept (`customized-kept`), conflicts install the new upstream and back up the operator's copy to a gitignore-safe `.claude-code-hermit/state/*.bak`. Closes the "rebuild bakes in the stale on-disk entrypoint" footgun. Compose/Dockerfile remain wizard-rendered and get a report-only upstream-drift signal (`docker_templates`) with a refresh-then-rebuild ordering note. `/docker-setup` records the three upstream template hashes; `doctor-check` warns when docker files are deployed but their baselines are unrecorded.

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

- In hermit-evolve, customization-aware template/bin updates — `state/template-manifest.json` records the sha256 of every `templates/` and `bin/` file at hatch time; upgrades classify each changed file as `unmodified` (safe to overwrite), `customized-kept` (operator edited, template didn't move — kept silently), or `conflict` (both changed — parked as `.new` for templates, replaced with `.bak` for boot-critical bin/ wrappers). Deleted wrappers are restored. Closes the silent-overwrite surface that previously destroyed operator customizations on every upgrade touching those files. `hatch` now enumerates `state-templates/bin/` dynamically (fixes missing `hermit-watchdog` in prior seeding). `doctor-check` validates manifest shape.
- In hatch, `.worktreeinclude` template — carries `OPERATOR.md` + `compiled/` into `claude --worktree` worktrees so worktree sessions start with hermit context. A managed marker block (`# >>> claude-code-hermit`) is appended to the project-root `.worktreeinclude`; only read-only context is included (runtime state, config, and channels are deliberately excluded to preserve the single-writer hermit invariant).

- In living topic pages (`type, topic`) — undated `compiled/topic-<slug>.md` updated in place at session-close (merge findings, bump `updated`, refresh one-line `summary`) instead of accumulating dated copies; exempt from archive rotation; staleness linted on `updated ?? created` across all topic pages; new `topic-missing-updated` lint; declared in the knowledge-schema template alongside a `## Conventions` section for `[[wikilink]]` cross-references (#316).
- Recall write-back — after a synthesis drawing on 3+ distinct sources, recall offers (operator-confirmed, never automatic) to file it: small durable fact → auto-memory, domain synthesis → topic page.
- In weekly-review, topic-page semantic check — read-only scan for contradictions, stale claims, and broken `[[wikilinks]]` across topic pages; up to 3 findings join the channel summary.

### Upgrade Instructions

Run `/claude-code-hermit:hermit-evolve`. The evolve skill handles:

1. **Seed `state/template-manifest.json`** — the first evolve after this version ships finds no manifest and runs in bootstrap mode: every managed `templates/` and `bin/` file that differs from upstream is classified as operator-unmodified and silently overwritten. Any file that gets overwritten on this first run will also have a one-time `<name>.bak` written alongside it — if you had customizations before this version shipped, check for `.bak` files in `templates/` and `bin/` to recover them. After this run the manifest is seeded and subsequent upgrades classify correctly.

### Changed

- In startup knowledge injection, catalog-only for non-foundational artifacts — recent-artifact bodies are replaced by a one-line-per-artifact catalog (stem, type, date, tags + summary line); nothing silently drops out of the injection window anymore. Foundational pages keep full-body/stub injection at the 40% pinned budget, now without the per-type newest-wins collapse (multiple same-type foundational pages all pin); unused pinned budget rolls into the catalog. `procedure-brief` artifacts are excluded from injection, enforcing the schema's existing not-session-injected contract. `search.ts` recency and result dates read `updated` before `created`. `injection_stub` is now only read for foundational artifacts.

### Added

- Post-close context reset via `/clear` (#340) — after `daily-auto-close` archives a session, the watchdog sends `/clear` on the next tick when the session is idle and unattended, so the next sparse wake reads only the startup-context injection instead of the full stale conversation (drops the 1.25× cold cache-write). Preserves process-scoped `CronCreate` routines and `Monitor` tasks; no re-arm needed. Enabled by default (`post_close_clear: true`); only fires when the watchdog runs on a schedule (Docker: automatic; bare-metal: requires `hermit-watchdog install`).
- Raw/.archive purge policy + raw-size doctor check (#344) — new `knowledge.archive_retention_days` config key (default `null` = keep forever) deletes `.archive/` entries past retention (`-latest.*` pins never purged); `reflect-precheck` runs `archive-raw` on a 7-day debounce so archival happens regardless of weekly-review; doctor gains a `raw-size` check warning when `raw/` exceeds 50 MB or archival is 14+ days stale with raw files present.
- Heartbeat liveness check in `/hermit-doctor` (#346) — `heartbeat-monitor.sh` writes `state/heartbeat-liveness.json` (`last_peek_at`) on every poll iteration; `doctor-check.ts` gains a `heartbeat` check (14 JSON checks total) that fails with a seccomp/container diagnosis when an active session's heartbeat has not ticked in 3× the configured interval, or when no tick lands within a short (~2m) startup grace after the monitor registers. A tick older than the monitor's `started_at` is ignored so a prior session's liveness file can't mask a dead restart. Closes the silent-death hole where a Monitor subprocess blocked by kernel restrictions reported fully healthy. `parseDuration` moved to `scripts/lib/time.ts` (shared with precheck). Report grows to fifteen lines (fourteen JSON + sandbox).

- In deny-patterns, block Edit/Write to installed plugin source — a hermit can no longer modify its own files under `~/.claude/plugins/marketplaces/` (#351).
- In doctor-check, `runtime` check (bun) — verifies bun presence and version against `required_bun_version` in `hermit-meta.json` (report grows to 13 checks); `hermit-start` preflight hard-errors when bun is missing or below 1.3.0.

- In doctor-check + cost-summary, opus automated-wake warning — new 14th doctor check (`opus-wake`) and a `## This Week` line surface automated-source turns (`heartbeat` / `routine:*`) running on Opus over the trailing 7 days; soft warn, no block. Closes the silent $529-Opus-spend failure mode (#342).

- In reflect, observations ledger with mechanical graduation — sub-threshold observations (cost spikes, quick-mode deferrals, failed three-condition candidates) append to `state/observations.jsonl` instead of project memory; step 3b prunes (30-day TTL, recurrence keeps a pattern's history) and promotes patterns seen in ≥2 distinct sessions to candidates carrying a ledger `Artifact:` citation. New `scripts/prune-observations.js`.
- In reflection-judge, ledger artifact verification + covered-by-memory exemption — §1.4 verifies `state/observations.jsonl` citations directly (sub-threshold patterns live only in the ledger); ledger-graduated candidates are never suppressed `covered-by-memory`. Closes the lifecycle bug where recording a pattern to memory got it suppressed at graduation.
- In reflect, ephemerality exception for procedure capture — single-session eligibility when the procedure's artifacts are ephemeral (outside repo/state, e.g. `/tmp`) and the cost is already quantified in session content; Tier 3, kill criteria still apply.
- In weekly-review, reflect vital-signs line — review gains `reflect_runs/candidates/surfaced/accepted/cost_usd` frontmatter and a `### Reflect` section with a suppression digest (slug:code), computed week-scoped from session-report Progress Log lines and proposal-metrics.jsonl events; evolution block relays it. Makes a healthy-quiet reflect loop distinguishable from a dead one. Also surfaces the observations-ledger size (`obs: N ledger (+M this week)` + `reflect_observations` frontmatter), rendering even when reflect runs are zero — the dashboard input for the #343 reflect-yield kill decision.
- In session-close, close debrief in Lessons — step 1 asks what was built ad-hoc this session (throwaway scripts, manual procedures, long waits a tool would remove) and what had to be re-derived that a compiled note should have covered; persists one quantified Lesson line per item (substantial re-derived knowledge goes to `compiled/`); arms procedure-capture recurrence upstream.
- In cost-tracker, `api_calls` and `context_usage` per log entry — each cost-log.jsonl entry now records the number of API calls summed for that turn and the context-window fill fraction from the Stop payload (null when absent); enables per-turn call-count analysis and context/cost correlation (#341).

### Fixed

- Sums all API calls in a turn in cost-tracker (#341) — the previous code returned usage from the last API call only; multi-step tool-calling turns (each billed separately) were undercounted. The `sumTurnUsage` helper now sums every billed entry back to the turn boundary. **Reported costs will rise — this is not a regression.** A `schema: 2` marker entry is written to `cost-log.jsonl` at upgrade so operators see the boundary clearly.
- Cost derived from immutable cost-log in session reports (#341) — `cost_usd` and `tokens` in session report frontmatter are now summed from cost-log.jsonl per session-id by the main session before passing to session-mgr (via `session-cost.ts`), eliminating the double-count caused by the skippable per-task `.status.json` reset. Session-mgr falls back to `.status.json` only when the payload value is absent. The redundant prose reset steps are removed from session-mgr.

- Active_hours evaluated in the configured timezone in hermit-watchdog (#347) — `inActiveHours()` read the host wall clock (`new Date().getHours()`) while its sibling `heartbeat-precheck` already evaluated the same window through `currentHHMM(config.timezone)`; on any host where system TZ differed from `config.timezone` (headless Docker pinned to UTC) the watchdog fired in the wrong window. It now delegates to `currentHHMM`, fails open on an unparseable tz or malformed `HH:MM` bounds, and treats the window end as exclusive to match `heartbeat-precheck`.
- Hermit-watchdog reads runtime.json through lib/runtime (code-review cleanup) — the watchdog wrote runtime.json via the shared `writeRuntimeJson` but still read it through a local `readJson`; it now uses `lib/runtime.readRuntimeJson` so the read/write semantics for that file live in one place.
- Double-acquire, wedged-lock, and masked-fs-error fixes in lib/lockfile (code-review findings) — stale takeover now claims the lock by atomic `rename` instead of unlink-by-path, so two racers over one stale lock can't both end up holding it; a foreign-user pid (EPERM) is treated as not-a-hermit-holder (single-uid invariant) instead of wedging the lock for the staleness window against a possibly-reused pid; and `tryCreate` rethrows real fs errors (ENOSPC/EACCES/EROFS) instead of masking them as "another lifecycle operation in progress".
- In doctor-check, hooks check now verifies exec-form hooks — `checkHooks` only parsed string-form `command` paths, silently skipping every real hook (all use `command` + `args`); it now resolves `args` entries too, so a missing hook script actually fails the check.
- Stale-wake damper in heartbeat (#344) — an unchanged stale-operator/stale-session condition no longer fires EVALUATE on every tick; `last_stale_wake_at` gates re-wakes to once per `stale_threshold` (or when the operator advances), while digest/checklist gates still reach through. Stops short-interval heartbeats from waking the LLM 4×+ to re-confirm the same staleness.
- Session-mgr disambiguated as subagent in session lifecycle skills (#348) — `session`, `session-start`, and `session-close` now carry a tool note that `session-mgr` is invoked via the Agent tool, eliminating the wasted-turn `Unknown skill: claude-code-hermit:session-mgr` error on slow-path start/close.

### Changed

- In startup knowledge injection, catalog-only for non-foundational artifacts — recent-artifact bodies are replaced by a one-line-per-artifact catalog (stem, type, date, tags + summary line); nothing silently drops out of the injection window anymore. Foundational pages keep full-body/stub injection at the 40% pinned budget, now without the per-type newest-wins collapse (multiple same-type foundational pages all pin); unused pinned budget rolls into the catalog. `procedure-brief` artifacts are excluded from injection, enforcing the schema's existing not-session-injected contract. `search.ts` recency and result dates read `updated` before `created`. `injection_stub` is now only read for foundational artifacts.
- Recall surfaces auto-memory alongside hermit artifacts — drops `model: haiku` and adds a "From memory" step over the loaded memory index (#350). Zero-config; existing hermits pick it up on `/plugin update`.
- Daily-auto-close defaults to Haiku — the silent, stateless midnight close routine ships `model: "haiku"`; near-zero risk on Sonnet fleets, insures against session-model tier-drift cost on Opus fleets (#342).
- In hermit-evolution, merged into a full evolution report — the skill now produces a unified 6-section digest (cost trend + 30d source split, autonomy, proposal velocity, routines/watches with cadence, top-3 produced (inferred), grown since hatch (approximated)) instead of the prior terse 4-section snapshot; trigger phrases extended to include "evolution report", "monthly report", "how have I grown", "what did I produce last month".

- Bun is now a required runtime (>=1.3) — first step of the bun migration (#18): declared in `hermit-meta.json`, gated by `hermit-evolve` Step 0b (upgrade refuses to proceed without it), pinned in the Docker template (`BUN_VERSION` arg, native installer; the Claude Code CLI stays on npm).
- Hooks and test harnesses run on bun — every hooks.json command string, `heartbeat-monitor.sh`, and all test suites invoke `bun` instead of `node`; hook scripts stay stdlib `.js` at this step. `run-with-profile` spawns `process.execPath` so inner hooks inherit the outer runtime.
- Docker layer is Python-free — the image drops `python3/venv/pip` from apt; every inline `python3 -c` in the entrypoint template (cred expiry, mtime watch, init JSON, recommended-plugins) and `check-upgrade.sh` converts to `bun -e`/heredoc equivalents with byte-identical outputs; docker-security's host-side verify blocks likewise. The entrypoint PATH line now includes `~/.bun/bin`. Bun quirk hardened: `-e` mode exits 0 on uncaught fs errors, so snippets catch internally and the init block fail-louds explicitly.
- Hermit-start → TypeScript; zero Python remains in the plugin. the 870-line boot script ported with byte-level side-by-side verification (config merge, channel gating, tmux argv, sandbox-cache fingerprint incl. CPython float repr); the 118-test Python contract harness translated 1:1 to `tests/hermit-start.test.ts` + `tests/contracts.test.ts`. `run-all.sh` retired — the entire suite is `bun test` (848 tests, ~20s); CI and the dev-mode hook run it directly.
- In hermit-stop and hermit-watchdog, python retired — both lifecycle scripts are TypeScript, behavior-pinned by black-box contract suites written against the Python first. `fcntl.flock` is replaced by `lib/lockfile.ts`: atomic link-based creation, PID-liveness (flock's release-on-death), an mtime staleness window (PID reuse after reboot), and takeover of the empty `.lifecycle.lock` files the old Python holders left on disk.
- In sandbox-probe and read-cost, python retired — `sandbox-probe.py` → `sandbox-probe.ts` (same JSON contract, exit-0-always; hermit-start and the doctor/hatch skills invoke it via bun); `read-cost.py`'s 6 lines inlined into `startup-context.ts`, removing the boot-path `python3` shell-out.
- All core scripts are TypeScript — `scripts/` and `scripts/lib/` renamed `.js` → `.ts` (typed, ESM); every spawn-path reference (hooks.json, harnesses, SKILL.md run-instructions, hatch permission allowlist, docs) moved with them. No build step: bun runs `.ts` directly.
- Entire bash test layer → bun test — all 21 bash harnesses (~5,800 lines: run-hooks.sh, run-scripts.sh, test-*.sh, lib.sh) replaced by `tests/*.test.ts` + shared helpers with 1:1 case parity (708 tests, ~17s; the bash equivalent took minutes of serial spawning). Subprocess spawning survives only at real process boundaries (hook stdin→exit contract, CLI runs); unit probes are in-process imports. `run-all.sh` is now `bun test` + `run-contracts.py` (the last Python harness, which dies with the boot-script ports).
- In doctor-check, real semver range evaluation — `satisfiesRange` now uses `Bun.semver.satisfies`, so `~`/`^`/compound ranges in `required_core_version`/`required_bun_version` are enforced instead of silently passing. Behavior change: a sibling pin like `~2.0.0` that previously reported `ok` (unrecognized form) now `warn`s when the installed core is outside it. Unparseable ranges still pass (fail-open).
- In bin/ wrappers, runtime-agnostic dispatch, python3-free — operator-resident shims delegate to the new plugin-shipped `scripts/hermit-exec.sh`, which owns the script-name → runtime mapping (future runtime changes need no wrapper refresh); inline `python3 -c` in `hermit-status`/`hermit-attach`/`hermit-docker` rewritten to bun. Also fixes a stray `"--"` element in `update-history.jsonl` marketplace arrays.
- Shared `tmuxSessionAlive`/`getSessionName` helpers in lib/tmux (#352) — dedupes the per-script copies in `hermit-start`/`hermit-stop`/`hermit-watchdog`; deferred cleanup from the bun-migration code review.
- In reflect/judge, artifact-cited evidence path — efficiency/cost candidates may pass the judge with `Sessions: none` plus an `Artifact:` citation to a machine-written state file (`cost-log.jsonl`, `proposal-metrics.jsonl`, `observations.jsonl`); the judge verifies the file contains the cited values instead of suppressing `no-sessions`. The evidence-integrity rule softens accordingly — prose self-certification stays barred.
- In proposal-create, push for measurable success_signal — cost-measurable proposals must fill `## Success Signal` with a `--validate`-checked predicate; an empty section is the documented exception and `## Verification` must say why.
- In reflect, pattern-absence resolution requires same-area overlap — absence across 3 sessions only counts when at least one checked session shares a tag with the proposal (tags pooled from the proposal itself and its `related_sessions`); otherwise skip-and-revisit. Stops "stopped doing that kind of work" from auto-resolving as "fixed".

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

- In hermit-settings, watchdog subcommand — new interactive menu exposes watchdog enable/disable, `stale_factor`, `escalate_after`, and `operator_grace` fields.
- In docker-setup, enable watchdog at step 9 — after container verification, step 9 now flips `watchdog.enabled: true` in `config.json` for Docker hermits; the entrypoint loop already runs the watchdog so no `bin/hermit-watchdog install` is needed.

### Fixed

- In watchdog, install/uninstall no longer crash on systemd-less Linux — falls back to printing a crontab line when `systemctl` is absent; uninstall exits cleanly with a "no timer to remove" message instead of throwing.
- In heartbeat-monitor, suppress first-iteration EVALUATE to avoid cold-start double-fire — first tick after session start skips EVALUATE (alerts empty, checklist unseen); AUTO_CLOSE is never suppressed.
- In hermit-stop, `Started` and `Status` read from wrong source — `read_active_session()` now reads `session_state` and `created_at` from `runtime.json` (the documented single source of truth). The `**Status:**` field was removed from SHELL.md and always fell back to `unknown`; `**Started:**` could show the raw template placeholder `YYYY-MM-DD HH:MM` if session-mgr missed the substitution. SHELL.md `**Started:**` is still preferred when it contains a real date.
- In hermit-status, `Status` fallback read from runtime.json — the no-cost-data fallback branch now reads `session_state` from `state/runtime.json` instead of grepping `**Status:**` from SHELL.md (which no longer exists in that file).
- In session-mgr/session-start, `Started` placeholder now explicitly named — `session-mgr.md` step 5 and `session-start` fast-path step now name the literal placeholder `YYYY-MM-DD HH:MM` so substitution is unambiguous, matching the precision already applied to the `**ID:**` field.

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

- In proposal-metrics-report.js, per-source triage-survival + acceptance rates — `scripts/proposal-metrics-report.js` aggregates `proposal-metrics.jsonl` per autonomous source (reflect, capability-brainstorm, procedure-capture, scheduled-check), computing triage-survival (CREATE÷total) and acceptance (accepted÷created) with the ≥8-sample gate and 25%/30% kill thresholds. Kill criteria in `capability-brainstorm` and `reflect` (procedure-capture) now call the script instead of hand-grepping; `hermit-evolution` surfaces the full per-source table. Every keep/kill debate now runs on computed data.
- In watchdog, external dead-session and wedge detector — `scripts/hermit-watchdog.py` single-shot supervisor. Detects dead tmux sessions and restarts them; detects wedged sessions (frozen pane, monitor dead, operator silent) with nudge-then-escalate; re-arms the 4am `heartbeat-restart` when it misses. Shutdown-intent gate prevents resurrecting an intentionally-stopped hermit. Every action logged to `state/watchdog-events.jsonl`; restarts surface to operator channel via `session-start` step 3. Default disabled — opt in via `config.watchdog.enabled: true` + `bin/hermit-watchdog install`.
- In watchdog, oS timer install/uninstall — `bin/hermit-watchdog install` registers a systemd user timer (Linux/WSL2), LaunchAgent (macOS), or prints a crontab line (fallback). `bin/hermit-watchdog uninstall` tears it down.
- In cost-log, incremental byte-offset index — new `scripts/lib/cost-log.js` builds `state/cost-index.json` incrementally so `writeCostSummary` and `getCumulativeCost` are O(1) instead of O(n). Index rebuilt automatically on first run or log truncation. Resolves Known Limitation #1.
- In cost-log, corrupt-line counter — `cost-index.json` carries `skipped_corrupt_lines`; doctor's cost check warns when >0. Resolves Known Limitation #3.
- In doctor, watchdog health check — new `checkWatchdog()` reports enabled status, OS timer presence, recent restart count, and consecutive-stale count from `state/watchdog-events.jsonl`.
- In procedure capture, reflect drafts a skill from a recurring procedure and installs it operator-gated — when a multi-step procedure recurs across ≥2 sessions with no skill covering it, reflect writes a `procedure-brief` to `compiled/` and routes a `category: capability` PROP through triage→judge→proposal-create. On accept, `/skill-creator` authors the SKILL.md and the operator confirms the artifact before install to `.claude/skills/`. Two non-skippable gates; metric-driven kill criteria.
- In channel-hook, channel-replies.jsonl — append-only log of outbound reply-tool calls, written by `channel-hook.js` after every `last_reply_at` update. Provides the engagement history needed for routine-ROI analysis.
- In reflect, routine ROI signal — extends the routine-health check with a channel-engagement join: reads `channel-replies.jsonl`, computes a delivery-anchored, same-channel engagement ratio per routine, joins per-routine cost from `cost-log.jsonl`, and proposes Tier-1 disable or re-time when a channel-delivering routine has ≥10 fires and ≤20% engagement.
- In recall, full-text search over sessions, compiled artifacts, and proposals — `scripts/lib/search.js` + `scripts/search.js` CLI + `skills/recall/SKILL.md`. Pure-Node scan (no deps), TF scoring with frontmatter-field boosts, recency decay, and `file:line` snippets. Invoke via `/recall <query>` or channel DM ("what did I decide about X", "when did we last touch Y"). Closes the memory retrieval gap identified in the architecture review.
- In cc-compat, centralized Claude Code format accessors — new `scripts/lib/cc-compat.js` wraps every surface Anthropic owns and can change (hook-payload field names, transcript JSONL usage shape, cost-log path, best-effort CC version). A CC release now breaks one file loudly instead of five quietly.
- In stop-pipeline, persist structured Stop-payload snapshot — after each Stop, `state/cc-stop-snapshot.json` records `session_crons` and `background_tasks` as tri-state (`populated / empty / unsupported_or_unreachable`), `captured_at`, and `cc_version`. Sole writer: `stop-pipeline.js`.
- In doctor, scheduler/background-task health check — new `checkScheduler()` reads the snapshot and reports cron and task state with labeled staleness. Missing snapshot → ok ("not yet captured"); `unsupported_or_unreachable` → warn (never falsely reported as "0 crons").

### Removed

- Drop the cosmetic `Status` field in SHELL.md. `runtime.json session_state` is the sole lifecycle source; close outcome flows through the session-close → session-mgr payload, never extracted from SHELL.md. Existing SHELL.md files self-heal on next close (field is absent from the new template). Scripts and skills repointed to `runtime.json`.
- Drop `--full` flag in pulse. infra health is now `/hermit-health`'s sole responsibility. `/pulse` stays session-focused (SHELL, tasks, live cost) with a one-line alert bridge when `alert-state.json` has active entries.

### Changed

- In hermit-health, absorb pulse --full unique sections — adds micro-pending count, knowledge file counts, enriched reflect counters (runs/empty/output), and `in_progress` proposals to the existing alerts/routines/channel surface.
- In docker-setup/docker-security, classified failure hints + `ports:` auto-edit — error-recovery messages now suggest targeted fixes (daemon down, build error, port conflict, OAuth expiry) rather than "dump logs and re-run the whole wizard". In docker-security, the hard-gate ports conflict offers to auto-remove the base `ports:` block (with `.bak` backup) so LAN-containment containers can start without a manual hand-edit.
- In cost-tracker, suggest-compact, route hook-payload reads through cc-compat — `entryText`, `isToolResult`, usage-field extraction, `session_id`, and `transcript_path` now delegate to `cc-compat.js`; `COST_LOG` path resolved via `costLogPath()`. Completes the centralization so every CC-owned read fails in one place. No behavior change; existing tests still pass.
- In proposal-act/reflect, falsifiable success signals — optional cost-per-session predicate (`success_signal` frontmatter field) on a proposal auto-resolves it when met; reflect evaluates via `scripts/eval-success-signal.js` against session-report `cost_usd` anchored at `accepted_date`. Closes #317-adjacent (§17.1 of architecture review).
- Gate-agent memory proposal-triage and reflection-judge now persist private heuristics (`memory: project`) — triage learns suppression patterns, judge learns hollow-evidence shapes; guardrail forbids private memory as the sole suppress basis; over-suppression bounded by reflect's existing Component Health check.
- In reflection-judge, weight evidence by session provenance — Tier 2/3 candidates backed only by auto-closed sessions lean toward DOWNGRADE; operator-supervised or mixed evidence is unaffected.
- In heartbeat, gate in_progress stale-check on operator activity — skip the per-tick LLM wake when `last-operator-action.json` shows activity within `stale_threshold`; the faithful Progress-Log check still runs when the operator is quiet beyond the threshold or a stale alert is already active. Falls back to the original unconditional wake on pre-upgrade installs (no `last-operator-action.json`) and on future-dated timestamps (clock skew). Closes #315.
- In knowledge, raise compiled injection budget default 1000 → 2500, ceiling 4000 → 6000 — more domain context at session start for domain hermits; maxed budget is clamped to remaining headroom under the 9000-char hard cap so operator and session sections are never crowded. Pairs with `/recall` (push for orientation, pull for depth).

### Security

- Reflection and judge candidates from web fetches, third-party `raw/` captures, or non-operator channel messages now require Tier 3 review through `proposal-create`, closing the learning-loop injection path. The new `Evidence Origin: own-work | external-content` axis defaults safely to `own-work`.

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

- In brief, anchor proposal-count status read to frontmatter — resolved proposals quoting `status: proposed` in their body no longer inflate the morning-brief pending count. Closes #287.

### Added

- In session-start, `--task` handler — non-interactive start seeds the task and bypasses all operator prompts; scheduled `--task` routines now work by design, not LLM inference.
- In hatch, git init on fresh dirs — when hatching in an empty, non-git directory, offers a local `git init` so hermit build artifacts are versioned from day one. Closes #282.
- In cost-reflect, structural cost audit skill — breaks 7-day spend into token-type drivers (cache_read / cache_write / output / input), flags cold-start overhead, and attributes cost per session. Opt-in as a weekly routine via `/hermit-settings`. Closes #295.
- In cost-tracker/cost-reflect, trigger-source attribution — every `cost-log.jsonl` entry records its trigger source (`heartbeat`, `routine:<id>`, or `other`); cost-reflect adds a **Cost by source** breakdown. Closes #294.
- In session-discipline, context-hygiene rule — delegate broad scans/research to `Explore` subagent; keeps main context lean.

### Changed

- In cost-tracker, pricing moved to `lib/pricing.js` — shared with cost-reflect; no behavior change.
- In hermit-routines, optional per-routine `model` override — run lightweight routines on Haiku via subagent dispatch to cut idle cost; ignored on `heartbeat-restart`. Closes #289.

### Removed

- Budget-enforcement layer. `idle_budget`, `ask_budget`, SHELL.md `Budget:` field, cost-tracker budget warnings, and `hermit-status` budget display removed; doctor's cost check is now visibility-only.
- Idle-tasks checklist. `IDLE-TASKS.md` template, heartbeat pickup, and session-mgr idle-task reconciliation removed; autonomous work flows through reflection → proposal → NEXT-TASK.

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

- In session-close, `shutdown_skill` config hook — fires before archival on both operator and `--auto` close paths, as the counterpart to `boot_skill`, for stopping always-on services. Best-effort: a wedged stop cannot lose the session report. Closes #259.
- In channel-responder, capture interactive channel patterns as SHELL.md findings — after responding via channel, appends durable preference or recurrence signals to `## Findings` so reflect can treat them as current-session evidence. Closes #253.
- In reflect, batch reflection-judge calls — spawns all pending judge calls in one parallel pass instead of serially, cutting reflect wall-clock on large proposal queues. Closes #236.
- In brief, surface plugin upgrade in always-on morning brief — the morning brief now mentions an available plugin update when one is detected. Closes #254.
- In brief, suppress evening "session still open" note when `always_on` + `daily-auto-close` enabled — avoids a spurious reminder in configurations that intentionally keep sessions running 24/7.
- In session-close, memory-review fallback when reflect short-circuits — captures single-session discoveries on operator closes where reflect's cadence precheck returns EMPTY. Skipped on `--auto` by construction. Closes #230.
- In docs, clarify OPERATOR.md vs CLAUDE.md — FAQ entry and how-to-use pointer; behavioral rules belong in CLAUDE.md, not OPERATOR.md. Closes #262.

### Fixed

- In hermit-routines, validate `pluginRoot` before the load reset — `load` aborts if `$CLAUDE_PLUGIN_ROOT` is empty or its `scripts/` are missing, before the Step 3 CronDelete sweep, preventing a bad plugin root from tearing down working routine CronCreates. Closes #251.
- In session bootstrap, drop `disable-model-invocation` from session skill — always-on multi-step boot invokes via the Skill tool, which the flag rejected; bare hermits were unaffected, making the failure look intermittent. Closes #229.
- Hatch always default `push_notifications: true` on fresh hatch — removed the channel-choice derivation that wrote `false` whenever a channel was selected; the runtime guard in CLAUDE-APPEND already enforces channel-first delivery with push as fallback.
- In brief, drop doubled `hermit-evolve` call in brief upgrade notice — deduplicate the evolve instruction that appeared twice in the upgrade nudge.
- In hatch, render actual `push_notifications` value in Step 10 report — the step now shows the resolved value rather than always printing `true`.

### Upgrade Instructions

Run `/claude-code-hermit:hermit-evolve`. The evolve skill handles:

1. Read `.claude-code-hermit/config.json`.
2. If `push_notifications` is `false`, ask: "Push notifications are currently disabled — with this update they act as a channel fallback when your primary channel is unreachable. Enable? (y/n)".
3. If yes: set `push_notifications: true` and write the file.
4. If no: leave config.json unchanged.

**Note:** `shutdown_skill` is a new config key (counterpart to `boot_skill`). Evolve presents it automatically; leave `null` unless a service teardown skill exists.

## [1.1.8] - 2026-06-01

### Added

- In startup-context, schema-drift warning at session start — surfaces a "Schema Drift" block when any `compiled/` artifact has a `type` not declared in `knowledge-schema.md ## Work Products`, closing the up-to-7-day lag before the weekly Knowledge Health check fires. Silent when schema is absent/empty (weekly review handles that) or when all types are declared. Reuses the existing `parseSchema` logic from `knowledge-lint.js`. Closes #208.
- Archive-compiled.js — weekly-review now rotates compiled artifacts, keeping the newest 2 per type; `foundational`-tagged artifacts exempt. Companion to `archive-raw.js`. (#201)

### Changed

- Hermit-evolve deterministic pre-pass (`scripts/evolve-plan.js`) — a read-only analyzer precomputes the version gap, bounded CHANGELOG slice, new config keys, changed templates/bin, and the CLAUDE-APPEND block diff in one JSON pass; the skill acts on it instead of reading and diffing whole files in-context. Cuts a typical evolve run to ~15–25K tokens and fixes the CHANGELOG 2000-line read truncation that could silently skip the oldest `### Upgrade Instructions`. Closes #211.

### Fixed

- In archive-raw, cover dated `.json` snapshots and pin `-latest.*` aliases — retention now globs `(md|json)`, so domain-hermit JSON snapshots obey `raw_retention_days` instead of accumulating forever; `-latest.*` pointer files are pinned (never archived); `.json` artifacts with no frontmatter fall back to a `YYYY-MM-DD` filename date for age resolution. Closes #209.

### Upgrade Instructions

Run `/claude-code-hermit:hermit-evolve`. No `config.json` changes required. The skill's Step 8 adds the new `Bash(node */scripts/evolve-plan.js*)` permission automatically; you may see a single approval prompt for the helper on the first run.

## [1.1.7] - 2026-05-31

### Fixed

- In cost-tracker, reset per-session cost/tokens on session change — `getCumulativeCost` now resets the running total when `.status.json` belongs to a different hermit session, so session reports record per-session spend instead of all-time cumulative carryover. Closes #190.
- In brief/proposal-list/heartbeat/reflect, fresh-read annotations on state-reading steps — adds an inline nudge to each skill's load-bearing current-state reads instructing the agent to re-read the file now rather than reuse a value from a pre-compaction context summary; prevents stale proposal statuses and session state from appearing in operator-facing outputs after compaction. Closes #192.
- In scripts/log-routine-event.sh, resolve hermit root by walking up from CWD — CronCreate prompts fire with the session's primary working directory as `$PWD`, which may be a subdirectory of the hermit root; the script now walks up to the nearest ancestor containing `.claude-code-hermit/` so the metrics append lands in the right place instead of failing with "No such file or directory". Closes #180.

### Changed

- In brief, push-notification fallback — the always-on brief now delivers via the standard Operator Notification pattern (channel DM or push fallback) instead of requiring a configured channel, so push-only operators get a condensed one-liner rather than a silent no-op when no channel is reachable. Closes #174.
- In session/heartbeat, bind completion notification to idle transition — completion notification is now the final step of the Work-done flow (§6), not a standalone action; the autonomous heartbeat-pickup branch explicitly routes to §6 instead of a bare notify. Prevents sessions staying `in_progress` after autonomous task completion, which caused stale-session heartbeat alerts and delayed report archival. Closes #173.
- In heartbeat, digest renders proposal titles — suppressed `proposal-pending:<PROP-NNN>` entries in the daily digest now render as `PROP-NNN "title"` (read from proposal frontmatter) instead of the bare dedup key, so operators can identify pending proposals without opening the repo; falls back to the bare key on zero or multiple file matches. Closes #191.

### Upgrade Instructions

Run `/claude-code-hermit:hermit-evolve`. The evolve skill handles:

1. **Refresh skills.** Updated skill files are delivered automatically on the next `/plugin update`.

No `config.json` changes required.

## [1.1.6] - 2026-05-28

### Added

- In hermit-doctor, archive + reflect checks — two new diagnostic checks for archival stall (runtime.json stuck `in_progress`/`waiting` >2d, or `idle` with non-null `session_id` >2d) and reflect-loop empty-rate (>80% empty over ≥10 runs with 0 proposals created). Closes #148.
- In routines, `reflect_after: true` optional flag — appends `/claude-code-hermit:reflect --quick` to the routine's CronCreate prompt, closing the same-day feedback gap for late-day routines whose Tier-1 `current-session` observations would otherwise wait until the next morning's scheduled reflect. The append is skipped when the routine's own skill is `reflect`. Closes #142.
- In reflect, `--quick` mode — bypasses the cadence precheck, binds `$PHASE = adult`, skips cost_spike / proposal scan / Resolution Check / Component Health, and scans only live SHELL.md `## Findings` / `## Blockers` for Tier-1 `current-session` candidates. Does not call `update-reflection-state.js` so the next scheduled reflect fires normally.
- In reflection-judge, per-code suppress counters — `reflection-state.json → counters.judge_suppress_by_code` now accumulates suppression counts by canonical code (`no-evidence`, `no-sessions`, `covered-by-memory`). The reflect skill passes the per-code map in its State Update payload; `update-reflection-state.js` merges it cumulatively. `/hermit-health` surfaces the non-zero mix (e.g. `suppress mix — no-evidence:12, covered-by-memory:3`) on the reflect routine bullet.

### Fixed

- In proposal-triage, status-aware dedup (#159) — open proposals (`proposed`/`deferred`/`dismissed`) still hard-block as `DUPLICATE`; `accepted`/`resolved` surface via `closest_prop` metadata and let evaluation continue, instead of silently killing follow-up proposals on shared infrastructure.
- In heartbeat, start subcommand reads state file before writing — fixes "File has not been read yet" failure on always-on restart when `state/heartbeat-monitor.runtime.json` exists from a prior session.
- Heartbeat start deterministic dedup via persisted task_id — step 4 now reads `state/heartbeat-monitor.runtime.json` and TaskStops the recorded `task_id` before falling back to a TaskList description scan. Prevents duplicate monitors when the daily `heartbeat-restart` routine fires while a prior monitor is still alive.

### Changed

- Hermit-evolve step 10 — after printing the upgrade summary, fires the standard Operator Notification (channel DM or push fallback) with a condensed one-line message. Always-on operators no longer miss upgrades that completed while they weren't watching the terminal. Closes #141.
- In skills/simplify, sync to upstream reference — deleted (`-`) lines are the behavior baseline; reverting an added `== True` back to plain truthiness is no longer mis-flagged as a behavior change. Phase 3a repairs malformed findings from intent instead of dropping them.

### Upgrade Instructions

Run `/claude-code-hermit:hermit-evolve`. The evolve skill handles:

1. **Refresh skills and agents.** The updated files are delivered automatically on the next `/plugin update`.
2. **Optionally enable `reflect_after` on routines.** To get same-session reflect after a routine, add `"reflect_after": true` to any routine entry in `config.json` (except the reflect routine itself). Re-run `/claude-code-hermit:hermit-routines load` after saving.

No `config.json` changes required.

## [1.1.5] - 2026-05-25

### Added

- Daily-auto-close routine — fires at midnight (local) and closes the session via `/session-close --auto` once the operator has been idle ≥10 min. If the operator is active at midnight, writes `state/pending-close.json`; the next heartbeat tick drains the flag on the first lull, bypassing active-hours and other skip gates. Fixes silent-no-archives on long-running daemons.
- Skills/daily-auto-close/SKILL.md — new routine driver (queue / drain-direct / stale-flag-cleanup branches).

### Changed

- In reflect/weekly-review, removed `closed_via: auto` skip — all archives count as evidence regardless of close trigger. The `operator_turns == 0` check in `isEmptyAutoArchive` still excludes genuinely-empty 12h-inactivity closes from the self-directed denominator; chatty daemon midnight closes (with real operator content) now reach reflect and weekly-review.
- In lib/frontmatter.js, `isEmptyAutoArchive` shared helper — extracts the `closed_via: auto && operator_turns: 0` predicate from both `reflect-precheck.js` and `weekly-review.js` to a single site.
- Auto-close wording — heartbeat, session-close, channel-responder, always-on docs updated to reflect both AUTO_CLOSE triggers (12h-inactivity and midnight lull).

### Fixed

- In heartbeat-precheck, pending-close drain before SKIP gates — a missing or empty `HEARTBEAT.md` was short-circuiting with `SKIP` before the drain could fire, leaving the midnight close stuck on at-most-daily cadence.
- In heartbeat-precheck, stale-flag guard on fail-open drain — absent/malformed `last-operator-action.json` still fail-opens to `AUTO_CLOSE`, but only when `pending-close.json` was queued within 24h. Prevents a stale flag from a crashed prior session auto-closing a fresh one.
- In weekly-review, uTC date in ISO week calculation — `getISOWeek` was using local-time `getDate/getMonth/getFullYear` instead of their UTC equivalents, causing sessions to fall outside the computed week window in timezones ahead of UTC near week boundaries.

### Upgrade Instructions

Run `/claude-code-hermit:hermit-evolve`. The evolve skill handles:

1. **Add `daily-auto-close` routine to `config.json`.** Read `config.routines`. If any entry has `id: "daily-auto-close"`, skip. Otherwise append: `{"id": "daily-auto-close", "schedule": "0 0 * * *", "skill": "claude-code-hermit:daily-auto-close", "run_during_waiting": true, "enabled": true}`.
2. **Re-arm routines.** Invoke `/claude-code-hermit:hermit-routines load` so the new entry registers via CronCreate this session.
3. **Report.** "Added `daily-auto-close` routine — long-running daemon sessions now archive at midnight when idle ≥10 min, restoring reflect / weekly-review / brain evidence on chatty hermits. **Note:** weekly self-directed rate may shift for 1–2 reviews as midnight archives age into the window."

## [1.1.4] - 2026-05-23

### Changed

- In heartbeat, migrated to CC Monitor — OK/SKIP ticks no longer wake the LLM; bypasses the `/loop` cloud-schedule prompt (CC 2.1.150). EVALUATE interrupts mid-task instead of deferring to idle. `heartbeat.show_ok` removed; use `/heartbeat status` for liveness.
- In env defaults, `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` 50 → 65 — auto-compact was firing well before the quality-degradation zone (~73%).
- In env defaults, `COMPACT_THRESHOLD` 50 → 75 — tool-call-based nudge was firing mid-session for any non-trivial work.
- In hatch, `push_notifications` now defaults to `true` — derived from channel choice (no channel → on, channel → off). Toggle via `/hermit-settings push-notifications`.

### Fixed

- In docs, `COMPACT_THRESHOLD` description corrected to tool-call-count fallback — config-reference previously called it a "context % threshold," contradicting `suggest-compact.js`.

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

- In docker-setup, screen 2 acknowledgement now covers `auto` mode — guided-path attach instructions and the manual deployment guide both walk operators through the "Enable auto mode?" first-launch gate (press `1` + Enter to persist in the named volume). Previously only `bypassPermissions` had Screen 2 guidance; `auto`-mode Docker hermits saw a frozen-looking REPL with no instructions.

### Changed

- V1.1.2 auto-migration upgrade step retracted. the prompt that asked operators to switch `permission_mode` from `acceptEdits`/`bypassPermissions` to `auto` is gone. Reason: CC's interactive "Enable auto mode?" first-launch gate blocks headless boot, breaking Docker hermits mid-upgrade with no operator attached. The retraction was already applied to v1.1.2's CHANGELOG; called out here for visibility. `auto` remains a selectable mode via `/hermit-settings permissions` — operators opt in when they can attend the first-run acknowledgement.

### Upgrade Instructions

Run `/claude-code-hermit:hermit-evolve`. The evolve skill handles:

1. **Refresh docker-setup skill text.** No operator action — the updated skill ships with the plugin update.

**Note:** if your Docker hermit was migrated to `permission_mode: auto` by the v1.1.2 evolve step and now hangs on container boot, edit `.claude-code-hermit/config.json` to set `permission_mode: "bypassPermissions"` (or your pre-1.1.2 value), then run `.claude-code-hermit/bin/hermit-docker down && .claude-code-hermit/bin/hermit-docker up`.

No config.json changes required.

## [1.1.2] - 2026-05-23

### Added

- In `/simplify` skill, plugin-owned port of the bundled skill — CC v2.1.146 renamed it to `/code-review` (read-only). Three parallel reviewers (reuse, quality, efficiency) propose edits; main agent applies them with conflict resolution. Reports `applied N · deduped M · principle-rejected K · stale-anchor skips L · parse failures P`.
- In push_notifications, new opt-in config flag (GH #106) — when `true`, fires `PushNotification` as fallback when no channel is enabled, the channel is unreachable, or a post-resolve reply fails. Default false; toggle via `/hermit-settings push-notifications`.
- In sandbox, auto-configured by `/hatch` when supported — writes the standard profile (filesystem denies for `~/.aws`, `~/.ssh`, `~/.gnupg`; network unrestricted) silently on probe pass; prints an install hint and skips on probe fail. Existing `sandbox.*` keys are preserved. Set `sandbox.enabled: false` to opt out.
- In `scripts/sandbox-probe.py`, shared capability probe — returns `pass/warn/fail` with install hint on failure; result cached per boot. Used by `/hatch`, `hermit-start`, and `/hermit-doctor`.
- In Docker image, ships `bubblewrap` + `socat` — required for sandbox inside unprivileged containers. `hermit-start` auto-sets `sandbox.enableWeakerNestedSandbox: true` on container boots and removes it otherwise.
- `/hermit-doctor` sandbox check (ninth check) — Runs the capability probe and cross-references `sandbox.enabled` in settings files. Reports `pass/warn/fail` with remediation.
- FAQ entry for bash sandboxing — explains the macOS/Linux split, custom-CA tooling edge cases, and the WSL2 prerequisite.
- `sandbox-profiles.json` in `state-templates/` defines the `off` and `standard` profiles — `deny-patterns.json` gains a `sandbox.filesystem.denyRead` section as the canonical source for credential-path denies.
- In sandbox, contract tests + doc clarification — 5 new tests for probe cache/warn/fail paths (suite now 81). Clarified that the ninth `/hermit-doctor` check runs in the skill orchestrator, not `doctor-check.js`, so `doctor-report.json` omits the sandbox line.

### Changed

- In `/proposal-act` step (e.5), swapped `/code-review` for `/simplify` — gates shift from correctness (JSON bug-finding) to cleanup (refactor proposals the skill applies itself). Failures log a warning and fall back to skip; `code-review:code-review` remains available for deeper bug checks.
- In `permission_mode, auto` available as an opt-in (CC 2.1.150+) — classifier-reviewed autonomy; selectable via `/hermit-settings permissions` or chosen at `/hatch` time. NOT the default for Docker or tmux always-on deployments: CC shows an interactive "Enable auto mode?" acknowledgement on first launch, which blocks headless boot until acknowledged. Quick Docker / tmux always-on hatches keep `bypassPermissions`; interactive hatches default to `acceptEdits`. Existing installs are NOT auto-migrated to `auto` — operators opt in explicitly when they can attend the first-run acknowledgement. Requires CC 2.1.150+; not available on Pro, Haiku, or non-Anthropic providers. `min_claude_code_version` bumped to `>=2.1.150` in `hermit-meta.json`.

### Fixed

- In sandbox probe, corrected Ubuntu 24.04+ remediation message — the warn branch previously suggested a non-existent sysctl. Now points at the AppArmor profile for 24.04+ while keeping `kernel.unprivileged_userns_clone=1` for older kernels. `install_hint` field now populated so all callers surface it consistently.

### Upgrade Instructions

1. ~~Apply the standard sandbox profile when supported~~ — **superseded, no-op.** Hermit no longer probes for or configures the Claude Code bash sandbox; that's the operator's call via Claude Code's own `/sandbox` command. Do not write any `sandbox.*` key. Existing installs keep whatever `sandbox.*` they already have.

2. **Rebuild the Docker image** (Docker operators only).

   The base image now includes `bubblewrap` and `socat`. Without a rebuild the sandbox silently degrades inside the container. Run `hermit-docker update` or `docker compose build` to pick up the new packages. Note: the entrypoint itself did not change, so no template refresh is needed.

3. **Note on custom-CA tooling** (informational, no action required unless affected).

   Tools that use a MITM proxy with a custom certificate authority (e.g. `gcloud` with a corporate proxy, `terraform` with a company CA) may require `"enableWeakerNetworkIsolation": true` in the `sandbox` block. See [Claude Code sandbox docs](https://code.claude.com/docs/en/settings#sandbox-settings) and the FAQ entry in `docs/faq.md`.

4. **Refresh the CLAUDE-APPEND block to point `quality-gate-judge` at `/claude-code-hermit:simplify`.** The injected `## Subagents` table in operator `CLAUDE.md` (or `CLAUDE.local.md`) contains a `quality-gate-judge` row that previously read `decides whether /code-review should run`. After this release, `hermit-evolve` Step 7's sibling-sync re-syncs the canonical block to the resolved `hatch_target` — operators with the marker present see the wording flip to `/claude-code-hermit:simplify` automatically. No operator-prompt required; the marked block is template-authoritative.

## [1.1.1] - 2026-05-21

### Added

- In hatch, scope-aware output routing (GH #111) — detects install scope and routes outputs: `local` → `CLAUDE.local.md` + `settings.local.json`; `project` → `CLAUDE.md` + `settings.json`; `user` → `.local`. Target persisted to `hatch-options.json`; `hermit-evolve` and `docker-setup` are now target-aware.

### Changed

- Adapted to CC 2.1.146 `/simplify` → `/code-review` rename — all runtime invocations and templates updated. `min_claude_code_version` bumped to `>=2.1.146`. Requires CC 2.1.146+; run `/hermit-evolve` to refresh existing CLAUDE-APPEND.
- In hatch routing, review-pass refinements (GH #111) — `docker-setup` uses the same fallback chain as `hermit-evolve` to avoid leaking personal hardening into the repo; `hatch` preserves original `stamped_by`/`stamped_at` when re-stamping; new contract test guards rename drift across all five consumers.

### Fixed

- AUTO_CLOSE defeated by routine SHELL.md writes (#109) — heartbeat-precheck read SHELL.md mtime, which routines bump sub-12h. Fix: new `scripts/record-operator-action.js` hook writes `state/last-operator-action.json` on real operator activity only, filtering cron prompts, slash-commands, and channel messages. Heartbeat-precheck now gates `AUTO_CLOSE` on this file, falling back to SHELL.md mtime for pre-upgrade installs.

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

- In `channels.primary`, operator-configurable primary outbound channel — adds `scripts/resolve-outbound-channel.js`; checks `channels.primary` first, then falls back to the first eligible entry in config order. No hardcoded slug list; any channel plugin with `dm_channel_id` set is eligible. `/hermit-settings channels` gains `primary <name>` and `primary clear` verbs.

- In new skills, `/hermit-brain`, `/hermit-evolution`, `/hermit-health` — on-demand analytics replacing the retired Cortex surface. `/brain`: fragile zones and learnings; `/evolution`: cost/autonomy trends; `/health`: alert state and channel availability. All emit ≤1500-char channel-optimised markdown.
- Automatic session close — heartbeat archives sessions idle for 12h+ via a new `AUTO_CLOSE` verdict from `heartbeat-precheck.js`. Auto-closed reports carry `closed_via: auto`; reflect skips them; weekly-review excludes them from the autonomy denominator.
- Channel-reply reminder — new `scripts/channel-reply-reminder.js` UserPromptSubmit hook injects a reminder with the exact reply tool and `chat_id` on every inbound channel message. No-op when no channel envelope is present. Addresses silent-stranding when MCP-level guidance alone was insufficient.

### Fixed

- In auto-close, sHELL.md Monitoring append now runs before `/session-close --auto` — the append previously landed in the new session's template instead of the archived report, losing the auto-close evidence trace.

### Changed

- In Cortex, cron-driven regeneration replaced by on-demand skill dispatch — `/hermit-brain`, `/hermit-evolution`, `/hermit-health` read state directly per invocation; no pre-built file artifact.
- Appends a "This week's evolution" block in `weekly-review` (cost, autonomy, proposal counts with week-over-week Δ) and sends via channel — Computed from `compiled/review-weekly-*.md` frontmatter.
- True` in `weekly-review` routine default changed to `enabled for new installs — Existing operators retain their current setting; to receive the new channel-friendly weekly evolution summary, enable the `weekly-review` routine via `/claude-code-hermit:hermit-settings`.
- In frontmatter contract, relaxed from strict enforcement to convention — `validate-frontmatter.js` removed; include `title`, `created`, `tags`, `source`, `session` by convention. See `docs/frontmatter-contract.md`.
- In `/reflect`, tier 1 + `current-session` accepted at any hermit phase — previously only `newborn` allowed it; long-running daemons without archived sessions were left silent. Tier 1 + `archived-session` still requires 2+ archives; Tier 2/3 unchanged.

### Fixed

- In `hermit-evolve`, migration check uses correct `obsidian/` path (PR #102) — wrong path meant upgrade-time Findings note never fired. Also: `weekly-review` channel selection uses explicit priority order; `/brain` trigger list no longer collides with `/knowledge`; `TestAnalyticsSkillsContract` guards analytics skill drift.

### Removed

- Skills: `/claude-code-hermit:obsidian-setup`, `:cortex-refresh`, `:cortex-sync`
- Scripts: `build-cortex.js`, `cortex-refresh-stage.js`, `validate-frontmatter.js`
- Templates: `state-templates/obsidian/` (six Cortex page templates)
- Templates: `state-templates/cortex-manifest.json.template`
- Docs: `docs/obsidian-setup.md`
- Stop-hook stage: cortex-refresh stage removed from `scripts/stop-pipeline.js`
- Weekly-review: `Latest Review.md` pointer write removed from `scripts/weekly-review.js`

### Upgrade Instructions

Run `/claude-code-hermit:hermit-evolve` after `/plugin update`. The evolve skill handles:

1. **Detect** existing project-root `obsidian/` directory — leave it untouched. Log a Findings note: `"obsidian/ no longer maintained by hermit; safe to delete or keep as personal vault."` Leave `.claude-code-hermit/cortex-manifest.json` in place.
2. **Inform** the operator: `weekly-review` template default is now `enabled: true` for new installs; your current setting is not auto-flipped. To receive the new channel-friendly weekly evolution summary, run `/claude-code-hermit:hermit-settings` and enable the `weekly-review` routine.
3. **Note** that `/obsidian-setup`, `/cortex-refresh`, and `/cortex-sync` have been removed — no migration required.

No config.json changes required.

## [1.0.40] - 2026-05-16

### Added

- In cost reporting, show token counts alongside USD on all surfaces (GH #77) — USD is noisy with caching; tokens give a stable, pricing-independent signal. Affects `pulse`, `brief`, `hermit-doctor`, `weekly-review`, and session frontmatter. `cost-tracker.js` accumulates `total_tokens`; pulse reads live cost from `.status.json`.

- In Docker, `gh` CLI installed in baseline image (GH #82) — anonymous by default (60 req/hr); set `HERMIT_GH_TOKEN` in `.env` for authenticated calls. Compose maps it to `GH_TOKEN` inside the container.

- In CLAUDE-APPEND, calibration rule added — new `Rules` bullet: verify or label specific claims (version-pinned behavior, API signatures, menu paths, prices/dates). General domain knowledge answerable directly.

### Changed

- In CLAUDE-APPEND, `Proposals mandatory` rule tightened — added explicit "Never hand-write `proposals/PROP-*.md` files"; manual IDs reuse NNNs and violate the canonical `PROP-NNN-<slug>-HHMMSS` schema.

### Removed

- `hermit-takeover` and `hermit-hand-back` skills removed. duplicated `bin/hermit-docker down/up` but skipped the SIGTERM-triggered `/session-close --shutdown`. Doc references repointed at `bin/hermit-docker`/`bin/hermit-start`.

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

- `skills/proposal-act/SKILL.md` frontmatter parse error — unquoted internal colon in description (`how to proceed: start implementing`) caused `YAML frontmatter failed to parse`; description was silently dropped at runtime. Wrapped in single quotes.

### Changed

- In `/proposal-act` accept, "Start implementing now" added as default third option — executes the Proposed Solution in the current turn, then auto-resolves and notifies the operator.
- "Create a session task" branch preserves an existing `NEXT-TASK.md` rather than overwriting it — If one is already pending, the branch skips the write, marks the proposal `accepted`, and tells the operator to consume the existing task first via `/session-start`.
- Resolve Flow drops the hardcoded "Pattern confirmed absent" suffix — `Resolved on <date>.` is now the default append. Reflect's auto-resolve path may still add the pattern-absence note in SHELL.md Findings (unchanged); the proposal file itself stays generic.
- Scope proposal review to `status: proposed` — in `HEARTBEAT.md.template` Accepted proposals were re-surfaced as actionable by the LLM-evaluated checklist item. New wording explicitly skips accepted, resolved, deferred, and dismissed.
- `/proposal-act` accept-flow wording tightened (review pass) — step ordering, waiting-branch copy, and NEXT-TASK collision recovery path all clarified.
- `quality_gate.tier` config key + `quality-gate-judge` subagent (GH #66) — three tiers: `budget` (default, `/simplify` never runs), `balanced` (judge decides per implementation), `quality` (`/simplify` always runs). Toggle via `/hermit-settings quality-gate`.
- NEXT-TASK numbered-bullet append simplified — replaced brittle conditional numbering with sequential `4.` onwards with `(if ...)` prefixes.

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

- `safeForLLM()` sanitizer for LLM-bound rejection text — wraps known Claude context-marker tags (e.g. `<system-reminder>` → `[system-reminder]`) so they can't be interpreted as injected system context.

### Changed

- In `validate-config.js`, rejection text routed through `safeForLLM` — user-controlled fields (channel name, schedule, etc.) sanitized before reaching Claude's context to prevent `<system-reminder>` injection via `config.json`.
- In `validate-config.js` hook, `continueOnBlock: true` — config validation failure previously halted the turn; now surfaces the error as feedback so Claude can fix the config without operator recovery.
- In `hermit-evolve`, `min_claude_code_version` gate at Step 0 — reads `hermit-meta.json` and aborts with an upgrade message if the CLI is below the declared minimum. First core-side `hermit-meta.json` added with `min_claude_code_version: ">=2.1.139"`.
- In hooks, converted to exec form (`args: []`) — fixes path-with-spaces fragility where `${CLAUDE_PLUGIN_ROOT}` expanded unquoted in shell form. All 8 convertible hook entries updated; dev-mode contract runner stays in shell form.
- New `tests/test-hook-registration-form.sh` contract test — guards against future regressions to naked shell-form interpolation across the plugin fleet. Also fails loudly when the path-resolution glob returns zero hook entries, so a future refactor that breaks `MONOREPO_ROOT` resolution cannot silently pass the test vacuously.

### Fixed

- In `hermit-docker update`, cache-bust fix for CC binary — `docker compose build` reused cached `npm install` layers, causing silent version rollbacks. Fixed by adding `CLAUDE_CODE_VERSION` build arg to `Dockerfile.hermit.template`; BuildKit invalidates the layer when the version changes.

- In `hermit-docker update`, false downgrade report fixed — `CC_AFTER` now sourced from the resolved build-arg version instead of querying the container (which returned the baked image version before self-update).

- In `/reload-plugins`, gated on CC prompt readiness — previously `tmux has-session` succeeded before `claude` was ready, causing sent keys to land in the bash shell. Now polls for the `╭─`/`╰─` input-box characters before sending (up to 60s).

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

- `capability-brainstorm` skill — on-demand brainstorm synthesizing memory, capabilities, and codebase shape into at most 2 ideas; each routed through `proposal-triage` before becoming a PROP. Writes `compiled/capability-brainstorm-*.md` on non-empty runs.

### Changed

- In proposal IDs, collision-safe composite form — IDs now use `PROP-NNN-<slug>-HHMMSS` (ID = filename stem). Slug is up to 5 content words; `HHMMSS` prevents same-second collisions with an `a`/`b`/… suffix. Merge-safe: different machines produce different filenames.
- In `/proposal-act`, anchored prefix-glob resolution — `accept PROP-009` resolves both legacy `PROP-009.md` and `PROP-009-*.md` without false positives. Disambiguation prompt shown on multi-match. Short-form `accept PROP-NNN` unchanged.
- Legacy `PROP-NNN.md` files continue to work — no migration, no rename. All resolution, listing, and cortex scripts accept both the old and new filename forms.

### Fixed

- In `knowledge-schema.md.template`, declare `review` type — `weekly-review` writes `type: review` artifacts but the template only declared `note`, causing a permanent Knowledge Health false positive on every freshly-hatched hermit.

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

   > "Patching `.claude-code-hermit/knowledge-schema.md` to declare the `review` type under `## Work Products` (fixes the Knowledge Health false positive after every weekly-review). Apply? [Yes / Skip]"

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

- In `hermit-start`, third-party channel plugins via `channels.<name>.marketplace` (#47) — previously any non-official channel name appended a bare token that killed the launch process. Now falls back to `channels.<name>.marketplace` from `config.json`.
- In `cache-edit-guard.js`, warn on Edit/Write to marketplace cache (#48) — edits to `.claude/plugins/cache/...` are no-ops at runtime. New PreToolUse hook warns with the canonical source path. Set `HERMIT_CACHE_GUARD=block` to hard-block instead.
- In `hermit-start`, marketplace pre-flight for `--channels` — validates each channel's marketplace token at boot; drops unregistered channels with a `[hermit] WARNING` rather than silently booting with no active channels. Fail-soft if `claude` is missing.
- In `hermit-start`, refuse channel names starting with `-` as bare args — defense-in-depth; keeps validation local to `hermit-start` rather than relying on downstream `claude` flag parsing.

### Fixed

- In hook stderr, control-character sanitization — `tool_input`-derived values in `cache-edit-guard.js` and `channel-hook.js` could inject forged ANSI lines into terminal output. Added `scripts/lib/sanitize.js` (`safe()` replaces C0/DEL/C1 with `?`); routed all stderr interpolations through it.

### Upgrade Instructions

Run `/claude-code-hermit:hermit-evolve`. The evolve skill handles:

1. **No state-file changes required.** All four items in this release ship inside the plugin (`scripts/`, `hooks/`, `skills/`, `docs/`) — they take effect on the next boot without modifying anything under `.claude-code-hermit/`.

2. **No `config.json` changes required.** The new `channels.<name>.marketplace` field is purely additive and only consulted when an operator configures a non-built-in channel; existing discord/telegram/imessage configs need no edits.

3. **Optional: enable cache-edit hard block.** Operators who want Edit/Write attempts on `.claude/plugins/cache/...` to fail rather than warn can export `HERMIT_CACHE_GUARD=block` in their shell environment. Default behaviour (warn-only) is the safer choice for most operators.

**Note:** The marketplace pre-flight and stderr sanitization are silent on benign input — operators should see no behavioural difference unless they have a misconfigured channel marketplace or an adversarial tool_input value.

## [1.0.35] - 2026-05-09

### Fixed

- In Docker entrypoint, post-recovery sanity check + npm reinstall (#44) — orphan-recovery renamed the binary but never verified it. When `claude --version` reports `0.0.0`, entrypoint now reinstalls from npm to self-heal without requiring `docker compose down && up`.

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

- In plugin detection, scoped to project/local only across five skills — bare `scope == "local"` predicate leaked plugins from sibling repos. All five sites now apply `enabled == true AND (scope == "project" OR scope == "local") AND projectPath == cwd`. Disk glob replaced with `claude plugin list --json`.

- In `docker.recommended_plugins.marketplace`, normalized to `org/repo` — entrypoint now resolves canonical marketplace name at boot via `claude plugin marketplace list --json`. Pre-v1.0.34 literal-name entries get one warning and are skipped; re-run `/docker-setup` to rebuild cleanly.

### Upgrade Instructions

Run `/claude-code-hermit:hermit-evolve`. The evolve skill handles:

1. **Refresh skill spec** — the updated skill text loads on the next invocation of each affected skill. No state files or templates change.

If you use Docker:

2. **Rebuild your container** — run `.claude-code-hermit/bin/hermit-docker update`. The new entrypoint resolves marketplace names at boot from the CLI's source of truth (`claude plugin marketplace list --json`) instead of guessing from the repo basename.

3. **Re-run `/claude-code-hermit:docker-setup` once** — only required if your existing `docker.recommended_plugins` has any entry where `marketplace` is not an `org/repo` (the most common case is pre-v1.0.34 official entries that store the literal `"claude-plugins-official"`). The new entrypoint warns once at boot and skips such entries; re-running `/docker-setup` rebuilds the entries cleanly from the current host plugin list. Skip this step if every `marketplace` value in your config already contains a `/`.

## [1.0.33] - 2026-05-07

### Changed

- Right-sized thinking budgets across `reflect`, `reflection-judge`, and `proposal-create` — `reflection-judge.md` drops `ultrathink` (uses `effort: medium`); `reflect/SKILL.md` downgrades to `think hard` (~10K vs ~32K); `proposal-create/SKILL.md` drops keyword from body-writing, downgrades to `think hard` for capability-plan branch. Reduces cost without compromising quality.

### Upgrade Instructions

No upgrade actions required. Skill and agent text changes propagate via plugin update — no `config.json`, `runtime.json`, `state-templates/`, or operator-editable file changes.

## [1.0.32] - 2026-05-07

### Added

- Memory-first for suggestions — suggestion-generating skills and triage/judge subagents now consult auto-memory before declaring a finding novel; suppress with `covered-by-memory` if already covered. Acting skills (`session-close`, `proposal-act`, etc.) exempt.

### Changed

- `proposal-triage`: adds Step 1.5 memory cross-reference; new `covered-by-memory` suppress code + `memory_ref` metadata field.
- `reflection-judge`: adds §1.5 memory cross-check for all Evidence Source types; `[memory: <filename>]` breadcrumb in suppress reason.

### Upgrade Instructions

Run `/claude-code-hermit:hermit-evolve`. The evolve skill executes:

1. **Refresh the CLAUDE-APPEND anchored block.** Step 6 reads `state-templates/CLAUDE-APPEND.md` and replaces the marker→EOF block in the project's `CLAUDE.md`. The new Memory-first paragraph propagates idempotently.

No `config.json` changes required.

## [1.0.31] - 2026-05-07

### Fixed

- Remove quick-task gate from session-triggered scheduled checks — the "no tasks created, under 5 minutes" skip caused `revise-claude-md` (when installed) to miss short declarative operator corrections (e.g. "from now on never X"), which are exactly the sessions with the highest-signal CLAUDE.md updates.

### Changed

- In `reflect`, operator-value self-check now covers micro-proposals — dismiss-ratio tally counts `micro-resolved` events, distinguishing `rejected` (noise) from `expired` (timing).
- `runtime.json` schema gains `last_shell_snapshot_at` (ISO or null) — Owned by `archive-shell.js`. Used for the 24h dedup gate on routine SHELL.md snapshots.

### Added

- Guild/group channel setup in `docker-setup` and `channel-setup` — after DM pairing, optionally register Discord server channels or Telegram group chats via `/<plugin>:access group add`, each with its own `requireMention` choice.
- Reflect lessons-to-memory pass. Reflect's existing Memory update outcome now explicitly covers durable lessons (operator-stated rules, preferences that recurred, decision rationales) alongside sub-threshold patterns. Uses Claude's trained auto-memory flow ("remember it"). No new infrastructure — extension of existing reflect outcomes.
- Mechanical SHELL snapshot — when SHELL.md exceeds 400 lines and ≥24h has elapsed, `reflect-precheck.js` snapshots it to `sessions/snapshots/` and compacts the Progress Log to a pointer. Pure JS, no LLM; bounds always-on growth without operator action.
- `scripts/archive-shell.js`: new helper — snapshots SHELL.md, compacts the Progress Log, updates `runtime.json.last_shell_snapshot_at`. Atomic `link()` doubles as the concurrency lock.
- In `reflect-precheck`, `phases.archive_due` gated on `archiveTaken` — omitted from phases JSON on archive failure so the LLM doesn't reason about a snapshot that didn't land.

### Upgrade Instructions

Run `/claude-code-hermit:hermit-evolve`. The evolve skill executes:

1. **Add `last_shell_snapshot_at` to `runtime.json`.** Read `.claude-code-hermit/state/runtime.json`. If the file exists and does not contain the key `last_shell_snapshot_at`, add `"last_shell_snapshot_at": null` and write back atomically (temp file + rename). Idempotent.
2. **Add `archive-shell.js` permission to project settings.** Read `.claude/settings.json` (or `.claude/settings.local.json`, whichever holds the plugin allowlist). If `permissions.allow` does not contain `Bash(node */scripts/archive-shell.js*)`, append it. Idempotent.

No routine changes. No `config.json` changes. `/session-close` behavior unchanged.

## [1.0.30] - 2026-05-05

### Removed

- `/docker-security` Prompt 2 (read-only root filesystem). removed; `read_only: true` caused 401 `Invalid authentication credentials` after token expiry (~8h) because credential-refresh writes failed silently. Remaining three toggles (LAN containment, resource bounds, audit log) unaffected.

### Fixed

- In `hermit-start`, bootstrap now passed as `claude` argv — eliminates a race where `tmux send-keys` bootstraps were silently swallowed on slow boots before the TUI was ready.

- `hermit-docker restart` fails under security overlay — `compose restart` ignored `depends_on`, causing the hermit to rejoin the netguard netns while it was down. Fixed: `restart` now does `down && up -d`.

- In `/docker-setup` Step 8, `ackReaction` race fixed — `set ackReaction` was sent before the container LLM could write `access.json`. Replaced with a direct host-side edit of the bind-mounted `access.json`.

- PR-review polish — `hermit-docker restart` rejects service args; bootstrap only fires in always-on/tmux mode; Step 8 ackReaction uses `Read`+`Edit` instead of overwriting; `/docker-security` step numbering fixed.

### Upgrade Instructions

Run `/claude-code-hermit:hermit-evolve`. The evolve skill handles:

1. **Delete `docker.security.read_only` from `.claude-code-hermit/config.json`** — the key is now inert and surfaces as a stale `/hermit-doctor` warning.

**Note:** If that key had `enabled: true`, the container is still running with `read_only: true`. Re-run `/claude-code-hermit:docker-security`, answer through the remaining prompts, then `hermit-docker down && hermit-docker up`. Existing `claude-config` volume and credentials are preserved.

No other `config.json` changes required.

## [1.0.29] - 2026-05-04

### Added

- `/hatch` Quick mode — 5-turn fast path (identity, sign-off/deployment/channel, OPERATOR.md, confirm) that auto-chains to `/docker-setup quick`, `/channel-setup`, or `/session`. Advanced wizard unchanged; re-init forces Advanced.
- `/docker-setup quick` positional arg — skips the setup-mode gate; applies safe defaults (OAuth, bridge, auto-mirror SAFE plugins, auto-accept apt). Third-party plugins still confirmed per-entry; security non-negotiables preserved.
- `tests/test-template-skill-sync.sh` — contract test asserting every top-level key in `config.json.template` is referenced in `hatch/SKILL.md`; prevents silent field drops when the template gains a new key.

### Changed

- In `/channel-setup` Step 5, collapsed to single 3-option question — `Already paired` / `Ready to pair` / `Skip`, saving one round trip and removing a silent-skip bug.
- In `/hatch` Step 5, overlay-on-template refactor — reads `config.json.template` as base instead of duplicating an inline default object that had drifted (missing 9 fields).
- `/hatch` resequenced — setup-mode gate moved before file writes; hermit detection split into silent pre-flight and an activation prompt (Advanced only; Quick handles it in Turn 1).
- In `/docker-setup` Step 4, template rendering deferred to new Step 7b.6 — renders Dockerfile, compose, and entrypoint after plugin + apt-package resolution so `{{PACKAGES_BLOCK}}` substitution uses the finalized package set.

### Fixed

- In `/docker-security`, dNS containment hardening — four bugs: missing `no-resolv` caused NXDOMAIN blocks to time out; `claude.ai`/`claude.com` absent from allowlist; verifier misclassified timeouts; RO-write canary wrote to read-only root path. Verifier now uses `mktemp + trap EXIT`.
- In `/docker-security` step 7c, force `--no-cache` netguard build — `hermit-docker up` reused cached layers, silently preserving stale images; wizard now runs explicit `--no-cache` build.
- In `/docker-security` tune instruction, `hermit-docker down && hermit-docker up` — `restart hermit-netguard` left hermit with stale resolver state; updated across SKILL.md, docs, and template.
- In `tests/test-docker-security-templates.sh`, 12 new assertions — covers `no-resolv`, OAuth domains, DNS-block timeout, canary path, `--no-cache` rebuild, tune instruction.
- In `tests/test-template-skill-sync.sh`, explicit `exit 1` + cached skill read — added `exit 1` after `print_results`; cached `SKILL_CONTENT` to avoid per-key `grep` subprocess.
- `hatch/SKILL.md` Phase 6 trailing comma. The `AskUserQuestion` block had a trailing comma after the last question object before `]` — an invalid JSON payload that any strict executor would reject.
- Corrected cross-references — in `hatch/SKILL.md` Quick defaults table Source column used "Step 4 Phase X" labels that don't exist in the Quick branch (Quick never runs Step 4). Changed to "Advanced Phase X equivalent".
- Removed sub-step number collision. in `docker-setup/SKILL.md` "3. Project dependencies:" inside Step 2's body shadowed the top-level `### 3.` heading — renamed to `**Project dependencies scan:**`.
- Removed redundant parenthetical in `channel-setup/SKILL.md` Step 5 from the question text (restart instructions already appear in the prose immediately above).
- Added routing. in `channel-setup/SKILL.md` Step 6 → 6b Step 6 had no "continue to step 6b" exit line — a model executing the skill could skip 6b entirely.
- Removed stale CHANGELOG cross-reference — in `hatch/SKILL.md` Quick Turn 5 The "full mock in CHANGELOG `[Unreleased]`" pointer was inaccurate (the section contains a description, not a full mock) and would go stale after release. The inline template block is self-contained.

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

### Upgrade Instructions

Run `/claude-code-hermit:hermit-evolve`. The evolve skill handles:

1. **Skip if no docker-security overlay** — if `docker-compose.security.yml` does not exist at the project root, steps 2–4 are no-ops.
2. **Re-render the security overlay** — run `/claude-code-hermit:docker-security` and accept the same toggles already enabled. The wizard re-renders `dnsmasq.allowlist` with `no-resolv` and the new `claude.ai`/`claude.com` entries, and forces a `--no-cache` netguard rebuild.
3. **Restart hermit** — run `hermit-docker down && hermit-docker up` after the wizard completes (the wizard prompts for this).
4. **Verify** — `/claude-code-hermit:docker-security` verification block should show `DNS-block: OK` (NXDOMAIN, not timeout) and `DNS-allow: OK`.

No `config.json` changes required.

## [1.0.28] - 2026-05-04

### Fixed

- In docker-security netguard, four rootless Docker startup bugs fixed — dropped unwritable `state:/var/log/netguard` bind mount (logs to stdout now); replaced `$!` PID capture with `pgrep dnsmasq`; added `NET_BIND_SERVICE`/`SETUID`/`SETGID` caps; added `start_period: 5s` + `interval: 10s` to healthcheck.
- In docker-security netguard entrypoint, `--log-facility=-` — routes dnsmasq query logs to stdout instead of silently dropping to syslog (no syslogd in Alpine).

### Upgrade Instructions

1. **Skip if no docker-security overlay.** If `docker-compose.security.yml` does not exist at the project root, this entry is a no-op.
2. **Re-render the overlay.** Run `/claude-code-hermit:docker-security` and accept the same toggles already enabled — the wizard re-renders the overlay with the corrected `cap_add` list, no `state:/var/log/netguard` bind, and the new healthcheck.
3. **Rebuild the netguard image.** Run `bin/hermit-docker down && bin/hermit-docker up`. Compose rebuilds `hermit-netguard` because the entrypoint template content changed.
4. **Verify.** `docker compose -f docker-compose.hermit.yml -f docker-compose.security.yml ps` should show `hermit-netguard` as `healthy` within ~10s.

No `config.json` changes required.

## [1.0.27] - 2026-05-04

### Fixed
- In docker-security, port-conflict guard — detect operator-added `ports:` on `hermit` and offer to move them to `hermit-netguard` (the netns owner) when LAN containment is enabled. Wizard hard-gates `hermit-docker up` until the operator removes the base `ports:` block, preventing the `conflicting options: port publishing and the container type network mode` error.
- In docker-security, auto-pick free subnet — scan all host Docker networks and walk `172.28-31` then `10.244-247` before prompting, instead of hardcoding `172.28.0.0/24`. Eliminates `Pool overlaps with other one on this address space` on hosts with multiple hermit projects or colliding networks.
- In docker-security, `publish_ports` survives reruns — operators who removed the base `ports:` block on a previous run no longer lose the netguard publish mapping on the next wizard pass.
- In docker-security, early daemon guard — `docker info` preflight now exits with a clear message instead of cryptic subprocess errors when the Docker daemon is unreachable.

### Added
- In hermit-doctor, expanded docker-security check — now flags subnet collisions (`warn`) and hermit-side `ports:` blocks that conflict with LAN containment (`fail`). Daemon-unreachable degrades to `warn` rather than `fail`. Existing 8-check structure unchanged.
- Container guard for host-only skills — `docker-setup`, `docker-security`, `hermit-takeover`, and `hermit-hand-back` each detect `/.dockerenv` / `/run/.containerenv` at step 0 and refuse to run inside the container, printing a redirect to the correct vantage point. Prevents partial-success file writes that corrupt host scaffolding when invoked from inside the hermit container.

### Changed
- In docker-security, design rationale relocated — limitations, DNS allowlist tuning, and reversal prose moved from the skill body into `docs/docker-security.md`. SKILL.md trimmed from 572 → 552 lines; a pointer to the docs URL is the only reference kept in the skill.

### Upgrade Instructions

1. Run `/claude-code-hermit:hermit-doctor`.
2. If the `docker-security` check surfaces a WARN or FAIL, run `/claude-code-hermit:docker-security` and accept the defaults.
3. Run `hermit-docker down && hermit-docker up`.

**Note:** Operators without a docker-security overlay need no action.

No `config.json` changes required.

## [1.0.26] - 2026-05-03

### Fixed

- Shift routine schedules from `config.timezone` to machine timezone in hermit-routines before CronCreate — uses new `scripts/cron-tz-shift.js` helper (IANA zones, fractional offsets, DOW wrap, fail-open).
- In `hermit-doctor` `docker-security` check, overlay path anchored to `hermitDir` — was resolving relative to `process.cwd()`, causing false "not configured" when doctor ran from a different CWD.

### Added

- Container hardening — docker-compose template adds `no-new-privileges:true`, `cap_drop: ALL`, and `pids_limit: 2048` for `bypassPermissions` containers.
- `/claude-code-hermit:docker-security` advanced wizard — opt-in overlay (`docker-compose.security.yml`) with four toggles: LAN containment + DNS sidecar (`hermit-netguard`), read-only root filesystem, resource bounds, boot-time audit log. Fleet-aware: reads `## Docker network requirements` from sibling plugin manifests.
- In `hermit-doctor` eighth check, `docker-security` — flags drift between `docker.security.*` posture in `config.json` and presence of `docker-compose.security.yml`.
- In `hermit-docker` wrapper, pins `SERVICE="hermit"` — avoids ambiguity once security overlay adds `hermit-netguard`; auto-chains the overlay when present.
- In Per-fleet-plugin contract, `## Docker network requirements` — plugins declare needed domains/LAN endpoints; `/docker-security` wizard offers per-entry confirmation.

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

- In `reflect`, `cortex-sync`, delegate recon-heavy scans to `Explore` subagent — proposal scan, resolution-check session fetch, and tag-vocabulary scan return compact summaries instead of raw file contents; orchestrator falls back to inline `Read` for truncated files.
- In `proposal-triage`, extended evidence scope, richer verdict output — adds session cross-reference, OPERATOR.md alignment check, and compiled-artifact overlap scan before the three-condition gate; `SUPPRESS` verdicts include quoted excerpts; `maxTurns` 8 → 14.
- In `reflect`, `reflect-scheduled-checks`, `proposal-create`, triage verdict counters — all three callers append `triage-verdict` events to `proposal-metrics.jsonl`; `reflect` Component Health flags if `SUPPRESS` dominates `CREATE` at 2×.
- In `channel-setup` and `docker-setup`, default `ackReaction` to 👀 on first pair — freshly paired hermits had no inbound emoji feedback; sets 👀 unless already customized.
- In Recommended plugins, added `feature-dev` (Anthropic-official) — surfaces in `/hatch` Phase 4 for opt-in install.

### Fixed

- In `proposal-triage` agent, yAML frontmatter parse error — the `description` field contained a bare colon-space sequence (`<code>: <reason>`) which YAML interprets as a key-value separator, causing all frontmatter fields (model, effort, maxTurns, tools, disallowedTools) to be silently dropped at load time. Quoted the description string to fix the parse error.

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

- Heartbeat and reflect precheck scripts — `scripts/heartbeat-precheck.js` emits `SKIP`/`OK`/`EVALUATE` before each tick; `scripts/reflect-precheck.js` determines due phases and owns the `EMPTY` audit trail; both zero-dependency, fail-open. `heartbeat/SKILL.md` thinned 209 → 94 lines; detail extracted to `skills/heartbeat/reference.md` loaded on demand.

- In `GITIGNORE-APPEND.txt`, complete local-scope coverage — added `templates/`, `bin/`, `HEARTBEAT.md`, `IDLE-TASKS.md`, `knowledge-schema.md`, and `.claude.local/` (channel state dir). Previously hatch's gitignore append left bin/ and operator-editable files unignored, so `.claude-code-hermit/` kept showing as untracked in projects with local scope.

- In `hatch`, operator consent before `.gitignore` writes — step 7 now shows the entries to be appended and waits for `AskUserQuestion` confirmation before modifying or creating the project `.gitignore`.

### Removed

- `scope` config field and `project` scope removed. hermit state is now always gitignored; `project` scope risked committing LLM-generated artifacts (potentially containing credentials) to git history. `GITIGNORE-APPEND-PROJECT.txt` deleted.

### Fixed

- In `channel-setup`, inject `<CHANNEL>_STATE_DIR` into `settings.local.json` — without `DISCORD_STATE_DIR`/`TELEGRAM_STATE_DIR` in the session env, channel servers ignored `state_dir` and defaulted to `~/.claude/channels/<channel>/`, causing "Failed to reconnect" errors and misplaced `access.json` files.

- In `hatch`, add `heartbeat-precheck.js` and `reflect-precheck.js` to required permissions — both scripts are called on every heartbeat tick and reflect run but were missing from the `permissions.allow` block, causing operators to be prompted on every invocation.

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

- Agent worktree setup removed in hermit-start. `setup_agent_worktree()` and `HERMIT_AGENT_WORKTREE` export deleted; dev-hermit v0.3.0 dropped the worktree topology, leaving the 45s boot overhead with no consumers.

### Changed

- In `docs/architecture.md`, agent layer description — the line claiming dev-hermit "adds repo-mapper, implementer, reviewer" was always wrong (dev-hermit historically shipped only an `implementer`; v0.3.0 ships zero agents). Replaced with a generic statement pointing operators at each plugin's CLAUDE.md for its actual agent set.

### Upgrade Instructions

Run `/claude-code-hermit:hermit-evolve`. The evolve skill handles:

1. **Remove the stale agent worktree** if it exists. Run `git -C "$PROJECT_ROOT" worktree list --porcelain` to detect a registered worktree at `.claude/worktrees/agent/`. If present, run `git -C "$PROJECT_ROOT" worktree remove --force .claude/worktrees/agent`. If absent from `git worktree list` but the directory still exists on disk, `rm -r .claude/worktrees/agent` (no `-f` per repo rules) and `git worktree prune` to clear any stale ref. Best-effort: do not block the upgrade if the operation fails — print a one-line warning telling the operator to clean up manually.
2. **Note the env-var removal.** Tell the operator: "v1.0.23 removes the `HERMIT_AGENT_WORKTREE` env var from the per-session tmux env file. Any custom skill or script you wrote that reads this var (none ship in the official hermit fleet) will see it as unset — adjust to either drop the dependency or read project root from `Path.cwd()` instead."

The `.claude/worktrees/` line in `state-templates/GITIGNORE-APPEND.txt` and `GITIGNORE-APPEND-PROJECT.txt` is intentionally preserved — it covers Claude Code's native `isolation: worktree` agent feature (used by other plugins), not just the deleted hermit-managed subpath.

No `config.json` changes required.

## [1.0.22] - 2026-04-28

### Added

- In hermit-start, persistent agent worktree setup — `setup_agent_worktree()` creates `.claude/worktrees/agent/` and sets `HERMIT_AGENT_WORKTREE`; idempotent across first boot, stale-ref re-register, and existing worktree.
- In gitignore templates, `.claude/worktrees/` — added to `GITIGNORE-APPEND.txt` and `GITIGNORE-APPEND-PROJECT.txt`.

### Changed

- In hermit-start, `auto` permission mode — `hermit-start.py` now passes `--permission-mode auto` to Claude Code instead of treating it as unknown. Max plan → Opus 4.7 only; Team/Enterprise/API → Sonnet 4.6 or Opus 4.6/4.7. Not available on Pro, Haiku, or non-Anthropic providers.
- In hatch + hermit-settings, `auto` surfaced in permission mode options — replaces the outdated "Teams/Enterprise only" note with accurate plan/model requirements.
- In channel-setup, docker-mode guard — step 1 reads `state/runtime.json` and redirects to `/docker-setup` if `runtime_mode == "docker"`, with a fallback check for `docker/Dockerfile.hermit` for scaffolded-but-unbooted projects.
- In hatch, deployment-mode next-steps — Step 10 next-steps restructured into "Pick a mode / After picking / Anytime" groups so `/channel-setup` is visible for tmux and interactive users; channel-save note now names all three modes (Docker/tmux/interactive) with their activation paths.
- In hatch, config.json leak prevention — Phase 2 draft rule prohibits restating config fields in OPERATOR.md; Phase 4 scrub removes any matching sentence before writing; `config.json` excluded from Phase 1 scan; `proposal-create` extended to redirect config-mirroring proposals to `/hermit-settings`.
- In OPERATOR.md template, four-question scaffold — comment rewritten with Focus/Constraints/Approval/Comms model; warns against restating config fields.
- In CLAUDE.md, cLAUDE-APPEND contract — `CLAUDE-APPEND.md` must not restate `config.json` values (schedules, flags, channel IDs); describes behaviors only.

### Upgrade Instructions

Run `/claude-code-hermit:hermit-evolve`. The evolve skill handles:

1. **Refresh** `scripts/hermit-start.py` from the updated plugin.
2. **Refresh** `skills/channel-setup/SKILL.md`, `skills/hatch/SKILL.md`, and `skills/hermit-settings/SKILL.md` from the updated plugin.
3. **Append** `.claude/worktrees/` to the project `.gitignore` if dev-hermit agent worktrees are in use.

No `config.json` changes required.

## [1.0.21] - 2026-04-27

### Changed

- In doctor-check, read `required_core_version` from `hermit-meta.json` only — drops `plugin.json` fallback; sidecar keeps hermit-internal fields validator-invisible.
- In docs, bump Claude Code prerequisite to v2.1.110+ — `claude plugin tag` and the dependency resolver both require v2.1.110+.
- In docs, `boot_skill` declaration guidance → `hermit-meta.json` — `config-reference.md` and `creating-your-own-hermit.md` updated to match the sidecar migration.

### Upgrade Instructions

Run `/claude-code-hermit:hermit-evolve`. The evolve skill handles:

1. **Refresh** `scripts/doctor-check.js` from the updated plugin.

No `config.json` changes required.

## [1.0.20] - 2026-04-26

### Changed

- In CHANGELOG, clarify v1.0.19 upgrade for always-on operators — `bin/hermit-stop` shares the broken `bin/hermit-run`; upgrade instructions now lead with a stop step before the replace.
- In `release-auditor` agent, slug-aware refactor for monorepo — takes a plugin slug, reads version from repo-root `marketplace.json`; fixes two false-positive FAILs from the pre-monorepo path layout.

### Upgrade Instructions

Run `/claude-code-hermit:hermit-evolve`. No operator action required — this is a documentation-only patch on top of v1.0.19.

No `config.json` changes required.

## [1.0.19] - 2026-04-26

### Fixed

- In `smoke-test`, scheduled-check skill resolution uses harness loaded-skills list — path-walking `${CLAUDE_PLUGIN_ROOT}/../<plugin>/skills/` only found same-marketplace siblings, causing false-negative WARNs for cross-marketplace plugins.
- In `hermit-evolve` step 7, gate sibling upgrades on `_hermit_versions` key — monorepo cache exposes all sibling plugins regardless of install; `default "0.0.0"` treated them as fresh installs and re-executed their upgrade steps indefinitely.
- In `hermit-doctor` and `dev-doctor`, stale "six-check" references fixed — copy in both skill files now aligns with the seven-check report that includes `dependencies`.
- In `plugins/claude-code-hermit`, missing `LICENSE` and stale install snippet — restored MIT LICENSE under the plugin path; updated `Creating Your Own Hermit` snippet from pre-monorepo `gtapps/claude-code-dev-hermit` to canonical `gtapps/claude-code-hermit`.
- In `Test Hooks` CI workflow, re-pointed to monorepo path — `paths:` filters and `run:` steps updated to `plugins/claude-code-hermit/**`; `CONTRIBUTING.md` updated to match.

### Changed

- Monorepo layout — plugin source moved from repo root to `plugins/claude-code-hermit/`; `${CLAUDE_PLUGIN_ROOT}` and sibling-scan patterns resolve correctly; marketplace cache now contains `plugins/<name>/` subdirs.
- In `bin/hermit-run`, monorepo layout scan — glob updated from `marketplaces/*/` to `marketplaces/*/plugins/*/`; existing hatched projects must replace this file.
- In `docker/docker-entrypoint.hermit.sh.template`, monorepo-aware `HERMIT_PLUGIN_ROOT` — replaced shallow `find -maxdepth 2` with a direct path check at `${MARKETPLACE_DIR}/claude-code-hermit/plugins/claude-code-hermit/`.
- In `hermit-doctor` seventh check, `dependencies` — reads `required_core_version` from sibling plugin manifests; warns if core version doesn't satisfy the semver range.
- In Docker entrypoint, survive interrupted Claude CLI self-update — boot-time shim detects orphan `.claude-<rand>` symlink and recovers; Python plugin-install block wrapped in `try/except FileNotFoundError`.

### Upgrade Instructions

Run `/claude-code-hermit:hermit-evolve`. The evolve skill handles:

1. **Always-on operators only: stop the running hermit cleanly before continuing.** If a hermit is currently running for this project (`bin/hermit-status` reports it active), tear it down manually first — `bin/hermit-stop` is broken in this version because it shares the broken `bin/hermit-run` dispatcher with `bin/hermit-start`. For tmux operators: `tmux kill-session -t <session-name>` (find it via `tmux ls`). For Docker operators: `.claude-code-hermit/bin/hermit-docker down`. Then continue with step 2 below; restart with `bin/hermit-start` (or `bin/hermit-docker up`) after `hermit-evolve` finishes. If no hermit is currently running for this project, this step is a no-op.

2. **Replace `.claude-code-hermit/bin/hermit-run` with the new template.** Read `${CLAUDE_PLUGIN_ROOT}/state-templates/bin/hermit-run` and overwrite the target project's `.claude-code-hermit/bin/hermit-run`. Preserve executable bit (`chmod +x`). Without this step, `bin/hermit-start` will continue to fail with `[hermit] Plugin root not found or invalid:` because the old scan glob doesn't match the monorepo cache layout.

3. **For Docker-deployed hermits: rebuild the container.** The `docker-entrypoint.hermit.sh.template` baked into the image carries a stale `find` invocation that won't locate the plugin under the monorepo cache. Run `.claude-code-hermit/bin/hermit-docker update --cc-only` (or a full `update`) so the next boot picks up the new entrypoint. Non-Docker (tmux/local) operators can skip this step.

No `config.json` changes required. The `dependencies` doctor check requires no operator action — it's read-only and reports ok by default.

## [1.0.18] - 2026-04-24

### Changed

- In hermit-doctor, rename from doctor — avoids collision with Claude Code's built-in `/doctor` command; follows the `hermit-*` naming convention.
- In hermit-start, align DEFAULT_CONFIG model with template — `model` fallback was `None`; now `'sonnet'` to match `config.json.template`.

### Upgrade Instructions

Run `/claude-code-hermit:hermit-evolve`. The evolve skill handles:

1. **Patch `/doctor` → `/hermit-doctor` in target-project `CLAUDE.md`:** find the Quick Reference line containing the backtick-quoted token `` `/doctor` ``. If `` `/hermit-doctor` `` is already present, or if neither token appears, skip without error. Otherwise replace `` `/doctor` `` with `` `/hermit-doctor` `` on that line only and write the file back.

No `config.json` changes required.

## [1.0.17] - 2026-04-24

### Added

- In `scripts/prompt-context.js` — UserPromptSubmit hook injects `[Now, <Day>, <date> <HH:MM> <TZ>]` — CC's `# currentDate` is TZ-naive; this provides a fresh, weekday-aware timestamp on every prompt. Fails open.

- `bin/hermit-attach` helper — single command to reconnect to the running hermit (tmux or Docker); reads `state/runtime.json` and dispatches accordingly.
- `/create-pr` skill — project-local skill for opening PRs: Conventional Commits title, Summary/Test-plan body, `#N` auto-links, AskUserQuestion gate before `gh pr create`.
- `hermit-docker update` subcommand — full rebuild, `--cc-only`, or `--plugins-only` (zero-downtime marketplace refresh); logs to `state/update-history.jsonl`.

### Changed

- In `state-templates/GITIGNORE-APPEND.txt`, ignore `.claude-code-hermit/cost-log.jsonl` — cost log was only ignored under `.claude/`; the hermit-prefixed path was missing. Entries reordered so all `.claude/` lines precede `.claude-code-hermit/` lines.

- Heartbeat stale-session alert includes recovery hint — updated alert text to name context-compaction desync as a cause and give the operator two direct recovery commands (`resume` via `/claude-code-hermit:session-start`, or `idle` to drop the session). Avoids adding state-machine scaffolding to a subsystem scheduled for retirement post-KAIROS GA.

- In channel-responder, recognize slash commands — added `Slash command` branch at top of step 2 classification; messages starting with `/` routed to the matching skill/subagent instead of drawing an improvised "don't recognize this command" reply.

- `/doctor` skill — six-check health report. `scripts/doctor-check.js` runs config, hooks, state, budget, proposals, and permissions checks; writes `state/doctor-report.json`; exits 0 always.
- `/doctor` → `/hermit-doctor` rename — avoids collision with CC's built-in `/doctor`; `doctor-check.js` and `state/doctor-report.json` paths unchanged.
- `docs/artifact-naming.md` — new reference doc for the four-bucket layout (`raw/`, `compiled/`, `state/`, `proposals/`), naming conventions, and frontmatter requirements.
- Weekly reviews migrated to `compiled/` — `weekly-review.js` now writes `compiled/review-weekly-YYYY-Www.md`; `reviews/` directory removed from gitignore and startup scanner; session-start surfaces latest review via `newestByType`.
- In Session reports, `## Artifacts` section — added between `## Changed` and `## Blockers` to cite durable `compiled/` outputs from the session.
- `ultrathink` at planning-heavy steps — added to `reflection-judge.md`, `reflect/SKILL.md`, and `proposal-create/SKILL.md` at the three decisive judgment points.
- `config.model` defaults to `"sonnet"` for new hatches — was `null`; explicit default makes the launch model visible and reproducible.
- Model and effort tuning documented in `docs/how-to-use.md` — covers `config.model` and `CLAUDE_CODE_EFFORT_LEVEL` env var.

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

- In reflect-scheduled-checks, decoupled from reflect — now a self-contained routine skill; `reflect` no longer runs or adjusts scheduled checks. New `scheduled-checks` routine fires at `5 9 * * *`.
- In reflect-scheduled-checks, split unavailable/error gating — `unavailable` backs off 4 hours only; `error` backs off `interval_days`. Adds `last_error_at` field to state.
- In micro-proposals, drop single-slot constraint — schema changes from `{active: null}` to `{pending: []}`, allowing multiple concurrent proposals; channel-responder matches by ID.
- In hermit-start.py, export `CLAUDE_PLUGIN_ROOT` to always-on tmux session — Bash tool calls inside cron-triggered skills now have the variable available.

### Fixed

- In reflect-scheduled-checks, false-negative unavailable classification — uses loaded-skills list instead of filesystem grep for presence checks.
- In proposal-triage, prevent turn exhaustion on multi-file dedup runs — `maxTurns` raised from 5 to 8; verdict directive added to prevent early exit.

### Upgrade Instructions

Run `/claude-code-hermit:hermit-evolve`. The evolve skill handles:

1. **Migrate `micro-proposals.json`:** Read `micro-proposals.json`. If it has a top-level `active` key: if value is null, rewrite as `{"pending": []}`. If value is an object, rewrite as `{"pending": [<that object with tier: 1 if missing>]}`. Remove `active` in both cases.

2. **Add `scheduled-checks` routine:** If `config.json` routines contains no entry with `id: "scheduled-checks"`, append `{"id": "scheduled-checks", "schedule": "5 9 * * *", "skill": "claude-code-hermit:reflect-scheduled-checks", "run_during_waiting": true, "enabled": true}`. Skip if already present.

3. **Add `last_error_at` field:** For each entry under `state/reflection-state.json → scheduled_checks`, if `last_error_at` is absent, add `"last_error_at": null`.

4. **Restart always-on session:** Run `hermit-stop` then `hermit-start` so the new `CLAUDE_PLUGIN_ROOT` export takes effect in the tmux environment.

No `config.json` schema changes required beyond the routine addition in step 2.

## [1.0.15] - 2026-04-22

### Added

- IMessage channel support in channel-hook — `channel-hook.js` now recognizes `imessage` tool names; `dm_channel_id` persistence works for iMessage MCP bots; `hooks.json` matcher extended to `(discord|telegram|imessage).*reply`.
- In plugin-validator, native `claude plugin validate` as Check 0 — the agent now runs the official Claude Code validator first and treats its findings as authoritative for schema compliance; hermit-specific checks (1–7) layer cross-references on top.
- In release-auditor, marketplace.json version cross-check — audits `plugins[0].version` in marketplace.json against `plugin.json.version`. The plugin manifest wins silently when they differ, so a mismatch is a FAIL.

### Changed

- In marketplace.json, full metadata — adds top-level `metadata.description`, and per-plugin `author`, `license`, `homepage`, `repository`, and `keywords` so marketplace listings render correctly.
- In release skill, native validator + marketplace version sync — step 1 runs `/plugin validate .` before tests; step 4 cross-checks plugin.json and marketplace.json versions via `jq`; step 6 derives tag from `jq` to prevent drift.
- In docs/security.md, docker plugin trust model — reflects the current policy: the entrypoint installs every enabled entry in `docker.recommended_plugins` regardless of marketplace; the trust gate is at configuration time (explicit operator confirmation during `/docker-setup` or `/hermit-settings docker`), with preselection restricted to `claude-plugins-official` and `gtapps/*`.
- Brief skill no longer auto-closes sessions — notes "run /session-close to archive" when `in_progress` instead of delegating to `/session-close --idle`. Output cap relaxed to 6 lines.
- In smoke-test skill, cron schedule validation — routine validator now requires the `schedule` key (5-field cron) and FAILs on legacy `time`/`days` fields, matching the routines schema in config.

### Fixed

- Hermit-stop in interactive mode no longer corrupts runtime state — exits early with a "terminate Claude manually" message instead of writing `idle` to `runtime.json` while Claude was still running.
- In docs/skills.md, smoke-test vs test-run descriptions swapped — the table had the two descriptions transposed; smoke-test is post-hatch validation, test-run is the full test suite.
- In docs/testing.md, frontmatter validator path — script moved from `tests/` to `scripts/`; doc updated to match.
- In README.md, `/claude-code-hermit:evolve` → `/claude-code-hermit:hermit-evolve` — upgrade instructions referenced the old skill name.
- In SHELL.md.template, `/monitor` → `/watch` — monitoring section pointed to the old skill name.

### Added

- In knowledge-lint, `schema-empty` and `schema-missing` findings — all-commented `knowledge-schema.md` silently disabled type enforcement; both findings now surface at normal verbosity (suppressed on empty hermit).
- In knowledge-schema.md template, starter bullets — ships with one `note` and one `input` entry uncommented so type enforcement is active on fresh hatches.
- In startup-context, `---Storage Drift---` section — warns when artifacts land in paths invisible to session injection (unknown top-level dirs, subdirs under `raw/`/`compiled/`); silent when clean.

### Changed

- In knowledge-lint, `parseSchema` sentinel split — returns `false` for missing file, `null` for present-but-empty schema; removes `fs.accessSync` TOCTOU pre-check and redundant info line.
- In update-reflection-state, simplified `last_sparse_nudge` fallback — the fallback `state.last_sparse_nudge ?? null` was unreachable when `mergedNudge` is empty (empty merge implies existing state was also empty); simplified to `null`.
- `plugin_checks` renamed to `scheduled_checks` — config key, state key, `/hermit-settings` subcommand, sub-skill (`reflect-plugin-checks` → `reflect-scheduled-checks`), and Evidence Source tag (`plugin-check/<id>` → `scheduled-check/<id>`); pipeline unchanged.

### Added

- In reflection-judge, `ACCEPT (operator-request)` verdict tag — adds `operator-request` as a valid source tag alongside `current-session` and `scheduled-check`; test suite validates all three.
- In tests, dOWNGRADE grammar and verdict-tag coverage checks — `recurrence-gate-matrix.sh` gains sections verifying `DOWNGRADE` example and all three source-tag verdict lines.
- In docs, `source` field semantics clarified in frontmatter-contract — `source:` is origin-only; gate bypass is governed by `Evidence Source:` field.
- In CLAUDE.md, "Avoid overengineering" constraint — added to development constraints.
- In .gitignore, `.codex` entry — excludes Codex CLI working directory from version control.

- In reflect/proposal pipeline, evidence Source provenance tags — all four pipeline stages accept `Evidence Source:` (`archived-session` | `current-session` | `scheduled-check/<id>` | `operator-request`); scheduled-check and operator-request bypass Rule #1; structured suppress codes replace free-text reasons.
- In reflect, evidence integrity rule — `current-session` candidates must not be injected into SHELL.md before `reflection-judge` reads them; inferred patterns are ineligible.
- In reflect, suppression detail in Progress Log — `suppressed: [<slug>: <code>, ...]` suffix appended on suppressions (capped at 3).
- In tests, recurrence-gate-matrix test suite — `tests/recurrence-gate-matrix.sh` validates Evidence Source bypass behaviour across all gates.

### Upgrade Instructions

Run `/claude-code-hermit:hermit-evolve`. The evolve skill executes these steps:

1. **Rename config key in `.claude-code-hermit/config.json`:** if a top-level `plugin_checks` array exists, rename it to `scheduled_checks`. If both `plugin_checks` and `scheduled_checks` exist, merge entries by `id` (scheduled_checks wins on conflict); log the merge to stderr and continue. Preserve all other top-level keys unchanged. If neither exists, no-op.
2. **Rename state key in `.claude-code-hermit/state/reflection-state.json`:** if a top-level `plugin_checks` object exists, rename it to `scheduled_checks` (pure key move, values unchanged). If `reflection-state.json` is missing, no-op. Preserve all other top-level keys unchanged.
3. **Evidence Source tag in proposals:** no automated migration. If `.claude-code-hermit/proposals/PROP-*.md` contains the string `plugin-check/`, it refers to historical provenance and can be left as-is — the tag is human-readable and does not affect gate behavior for accepted/resolved proposals. Operators may manually search-replace to `scheduled-check/` if desired.
4. **Operators invoking `/hermit-settings plugin-checks` will get "unknown subcommand"** after upgrade. Use `/hermit-settings scheduled-checks` instead.
5. **Seed starter bullets if `knowledge-schema.md` parses empty:** if `.claude-code-hermit/knowledge-schema.md` exists and has no uncommented bullet lines under `## Work Products` or `## Raw Captures` (all bullets inside HTML comments), append `- note: general-purpose compiled note. location: compiled/note-<slug>-<date>.md` under `## Work Products` and `- input: general-purpose raw capture. location: raw/input-<slug>-<date>.md` under `## Raw Captures`. Preserve all existing content and comments. If the section headers are missing, append them with the bullets. If the file is missing, no-op (hatch creates it on first run).

## [1.0.14] - 2026-04-20

### Added

- In docker-setup, plugin-declared apt dependencies (step 7b.packages) — domain plugins declare `## Docker apt dependencies` in their `hatch` SKILL.md or `DOCKER.md`; `docker-setup` unions these with project-level deps before a single confirmation prompt.
- In `boot_skill`, domain hermits can override the bootstrap skill — `hermit-start.py` reads `config.boot_skill`; domain hermits declare it in `hermit-meta.json`; `hatch` writes it to project config. Managed via `/hermit-settings boot-skill`.

### Changed

- In docker-setup, package confirmation deferred to after plugin selection — the project-signal apt scan (step 2.3) now collects candidates without immediately writing `docker.packages`; final confirmation happens in new step 7b.packages after the plugin list is finalized, so plugin-declared deps can be included in a single unified prompt.

### Fixed

- In hermit-docker, revert login to REPL `/login` — `claude auth login` can't complete OAuth in Docker/tmux (no browser callback path); reverted to `docker compose exec` REPL with post-exit credential verification.
- In docker-setup, setup-mode bootstrap suppression — first boot now lands on an idle REPL prompt; `hermit-start.py` reads-and-deletes `.setup-mode` marker, skipping bootstrap send (one-shot).
- In docker-setup, channel pairing confirmation gates — skill blocks with `AskUserQuestion` before pair command and before `access.json` verification; eliminates race past unfinished pairing.
- In docker-setup, login gate — skill asks "Done / Failed" after `hermit-docker login`; on failure surfaces logs and stops.
- In docker-setup, drop `/reload-plugins` pre-pair — was a workaround for bootstrap-turn collision; no longer needed.
- In docker-setup step 9, clarify no-session on fresh setup — explicit note prevents LLM adding sleep loops waiting for a session.
- In docker-setup, pre-create channel state dirs before compose up — Docker creates missing bind-mount dirs as root, making them unwritable by the `claude` user; skill now `mkdir -p` before `compose up`.
- In tmux send-keys, split text and Enter into two calls — CC's TUI treats one-shot `send-keys '<text>' Enter` as bracketed paste; now sends text and Enter as separate calls with 0.5s pause.
- In docker-setup, verify channel token before pairing — step 8 checks `.claude.local/channels/<plugin>/.env` for `*_BOT_TOKEN` before prompting for a pairing code.
- In config template, add boot_skill field — `boot_skill` was used by `hermit-start.py` but absent from `config.json.template` and `DEFAULT_CONFIG`; new projects now have the field populated as `null`.

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

- In reflect, adaptive phase gates — `newborn` (<3d) / `juvenile` (3–13d) / `adult` (14+d) gate recurrence and sub-threshold surfacing; closes the cold-start silence on fresh installs. Tier 2/3 still require real cross-session evidence in every phase.
- In reflect, operator-value self-check — reflection questions now include dismiss-ratio and deferred-proposal-buildup checks from `proposal-metrics.jsonl`.
- In reflect, cost-spike detection — today's cost vs 7-day median; `>2×` records a sub-threshold observation eligible for recurrence graduation.
- In reflect, component Health agent check — flags `reflection-judge` when `judge_suppress > 2× judge_accept` with ≥5 verdicts.
- In reflect, mandatory Progress Log entry — every run (including empty) appends `[HH:MM] reflect (<phase>) — ...` to SHELL.md.

### Changed

- In reflect, silent by default — unconditional top-of-skill operator notification removed; notify only on outcomes.
- In reflect, three-Condition Rule hoisted — defined once before first reference.
- In reflect, sub-threshold → project memory — recorded with pattern label + session_id so recurrence can graduate them.
- In reflect, resolution Check 14-day guard — requires both pattern absence from 3 sessions AND ≥14 days since `accepted_date`.
- In reflect, skill Health → Component Health — broadened to agents and hooks (hooks out-of-scope pending telemetry).
- In reflection-judge, `(current-session)` verdict variants — explicit trigger for SHELL.md fallback when no archived report exists; callers can tell evidence isn't archived yet.
- CLAUDE-APPEND.md quick reference — added `/session-start`, `/reflect`, `/channel-setup`, `/hatch`, `/smoke-test`.

### Fixed

- In heartbeat, reflect no longer inline — long reflect runs (30–40 min) occupied the REPL and delayed CronCreate routines 90+ min. Reflect is now routine-only (default `0 9 * * *`, seeded in `config.json.template` and `DEFAULT_CONFIG`). Heartbeat reverts to a pure health tick.

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

- `routines` skill renamed to `hermit-routines` — avoids collision with Claude Code's native schedule/routines concepts. The slash command is now `/claude-code-hermit:hermit-routines` (and bare `/hermit-routines`). The `config.json` `routines` array key, `hermit-settings routines` subcommand, `routine-metrics.jsonl`, and `[hermit-routine:<id>]` CronCreate tags are unchanged.
- Stale routine-watcher prose removed — several docs and skills still referenced the old bash watcher (removed in 0.0.9). Cleaned up `docs/always-on-ops.md`, `docs/architecture.md`, `docs/testing.md`, `skills/proposal-act/SKILL.md`, `hooks/hooks.json`.
- Cortex Portal.md is now a live Dataview template — replaced the generated `obsidian/Cortex Portal.md` (rewritten by `build-cortex.js` on every refresh) with a static Dataview/dataviewjs template. Recent sessions, active proposals, reflect health, and recent artifacts now update live in Obsidian without any rebuild trigger.
- Connections.md refreshes automatically — a new mtime-gated stage in the Stop hook (`scripts/cortex-refresh-stage.js`) rebuilds `Connections.md` at the end of any turn that modified sessions, proposals, or artifact manifest. Cost on no-change turns is a handful of `stat()` calls. The nightly `cortex-refresh` routine remains as a safety net.

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

- Always-on bootstrap prompt never submitted — CC's TUI treated `send-keys '<text>' Enter` as bracketed paste, leaving the bootstrap in the input box unsubmitted; split into two calls with 0.5s gap.

### Upgrade Instructions

`hermit-evolve` executes these steps in order:

1. **No `bin/hermit-start` regeneration needed** — `bin/hermit-start` is a thin wrapper that invokes the plugin's `scripts/hermit-start.py`. The fix lands automatically when the plugin updates; run `.claude-code-hermit/bin/hermit-stop && .claude-code-hermit/bin/hermit-start` to pick it up. Verify by attaching (`tmux attach -t <session>`) and confirming the composite bootstrap prompt is auto-submitted rather than sitting unprocessed in the composer.

No `config.json` changes required.

---

## [1.0.10] - 2026-04-19

### Fixed

- Always-on bootstrap silently dropped `/heartbeat start` and `/routines load` — three back-to-back `tmux send-keys` calls raced against the slow `/session` skill; replaced with one composite prompt that orders heartbeat-start → routines-load → session in a single Claude turn.
- `/routines` missing from `CLAUDE-APPEND.md` Quick Reference — skill landed in v1.0.9 but wasn't listed; operators couldn't discover it.

### Upgrade Instructions

`hermit-evolve` executes these steps in order:

1. **Refresh `CLAUDE-APPEND.md`** — re-append the updated appendix to the project's `.claude/CLAUDE.md` so operators see `/routines` in the Quick Reference. The skill itself has been usable since v1.0.9; this only fixes discoverability.
2. **No `bin/hermit-start` regeneration needed** — `bin/hermit-start` is a thin wrapper that invokes the plugin's `scripts/hermit-start.py`. The fix lands automatically when the plugin updates; just run `.claude-code-hermit/bin/hermit-stop && .claude-code-hermit/bin/hermit-start` to pick up the new bootstrap behavior. Verify by checking the operator-visible log shows `Bootstrap: ... queued` lines AND that `/claude-code-hermit:routines status` reports active CronCreate registrations after launch.

No `config.json` changes required.

---

## [1.0.9] - 2026-04-19

### Fixed

- Routine delivery silently dropped in `--remote-control` + channels mode — `routine-watcher.sh` `send-keys` calls were silently swallowed between turns; replaced with per-session `CronCreate` registrations via new `/hermit-routines` skill. `hermit-start.py` auto-loads routines on always-on launch.

### Added

- `/claude-code-hermit:routines` skill. manages per-session CronCreate registrations. Subcommands: `load` (register all enabled config.routines), `list` (show configured routines), `status` (show active CronCreate entries via CronList), `stop [id]` / `stop --all` (CronDelete). Changes take effect immediately — `hermit-settings routines` auto-runs `/routines load` after writing config.

- `scripts/log-routine-event.sh` — helper invoked by routine cron prompts to append timestamped fire events to `state/routine-metrics.jsonl` without asking the LLM to construct JSON.

### Removed

- `scripts/routine-watcher.sh`, `scripts/cron-match.py`, `scripts/routine-queue-flush.js`, `state-templates/routine-queue.json.template`, the `routines` tmux window in `hermit-start.py`, `routine-queue-flush` Stage 5 in `stop-pipeline.js`, the `routine-stale:<id>` heartbeat alert, and corresponding tests.

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

- In docker, hermit plugin installed but not enabled — entrypoint now runs idempotent `claude plugin enable` every boot so containers self-heal on restart.
- In docker-setup, stale REPL swallowed channel pairing — sends `/reload-plugins` once before first pair command.
- In docker-compose, `stop_grace_period` raised to 60s — 10s SIGKILL'd mid graceful session-close.
- Docker-setup avoids `hermit-docker up` echo hints — uses `docker compose up -d` directly during setup so the outer LLM doesn't follow the trailing "attach" suggestion.
- In docker-setup, recommended plugins mirror host install — step 7b reads host project/local plugins instead of a canned list; entrypoint adds marketplace before install; safelist preselects `claude-plugins-official` + `gtapps/*` only, third-party requires explicit opt-in; `org/repo` regex validator rejects malformed values.
- In entrypoint, recommended-plugin re-install loop — `install_target in installed` set-membership check never matched raw line output; switched to substring match.
- In hermit-docker login, double-OAuth race — REPL's auth check + `/login` opened two URLs racing on `.credentials.json`. Now uses one-shot `claude auth login` gated by `claude auth status --json`.

### Added

- In docker-setup step 8b, clean restart — `hermit-docker down` + `up -d` so first real session has plugins loaded and no setup chatter in transcript.
- Routine fire metrics — `routine-watcher.sh` appends `queued`/`fired`/`dequeued` to `state/routine-metrics.jsonl`; reflect uses it to propose retiming idle routines.

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

- Baseline audit offer (first session) — on the first session of a new hermit in an existing codebase, operator is offered a one-time audit using the plugins accepted at hatch (`claude-md-improver`, `claude-automation-recommender`). One proposal per plugin invocation. One-shot, marker-gated (`.baseline-pending`).

- Reflect diagnostic counters — `state/reflection-state.json` now tracks per-hermit reflect metrics under a `counters` key. No behavioral change to reflect itself.

  Tracked: `total_runs`, `empty_runs`, `runs_with_candidates`, `judge_accept`, `judge_downgrade`, `judge_suppress`, `proposals_created`, `micro_proposals_queued`, `last_run_at`, `last_output_at`, `since`.

  `pulse --full` surfaces a Reflect Health summary. `cortex-refresh` injects it into Cortex Portal.md.

### Changed

- In `GITIGNORE-APPEND.txt` (local scope), ignore `tasks-snapshot.md` — `tasks-snapshot.md` is regenerated every turn by the `cost-tracker` hook from the native Tasks store, same category as `cost-summary.md` (already ignored). Adding it eliminates per-turn churn in `git status` for local-scope hermits. Project-scope gitignore unchanged — its "everything else is versioned" contract still applies.

- In `CLAUDE-APPEND.md`, `hermit-config-validator` added to Subagents section — the agent was present in `agents/` and listed in `CLAUDE.md` but missing from the template injected into target projects. Deployed hermits had no LLM-visible documentation for this agent.

### Upgrade Instructions

Run `/claude-code-hermit:hermit-evolve`. The evolve skill handles:

1. **`tasks-snapshot.md` gitignore** — For local-scope hermits, append the new line to `.gitignore` and run `git rm --cached .claude-code-hermit/tasks-snapshot.md` if the file was previously tracked. Project-scope hermits are unaffected.

2. **Backfill `counters` on existing `reflection-state.json`** — Read `.claude-code-hermit/state/reflection-state.json`. If `counters` is absent, add it with all integer fields = `0`, both timestamp fields (`last_run_at`, `last_output_at`) = `null`, and `since` = current ISO timestamp (with offset). Preserve all other keys (`last_reflection`, `last_resolution_check`, `plugin_checks`, etc.). If the file is missing entirely, initialize with the full schema from `skills/hatch/SKILL.md`. If `counters` already exists, leave it untouched — no reset on upgrade.

3. **Add `update-reflection-state.js` permission** — In `.claude/settings.json`, add `"Bash(node */scripts/update-reflection-state.js*)"` to `permissions.allow`. Without this, reflect's state-update call will prompt for approval on every run.

4. **Refresh CLAUDE-APPEND** — Re-run `hatch` step that appends `CLAUDE-APPEND.md` to the project's `.claude/CLAUDE.md`, or manually append the `hermit-config-validator` entry to the `## Subagents` section.

No `config.json` changes required.

## [1.0.6] - 2026-04-17

### Changed

- Storage convention tightened — `type` frontmatter is the explicit discriminator; subdirs inside `raw/`/`compiled/` and new top-level dirs in `.claude-code-hermit/` are prohibited (artifacts there were invisible to injection and archival). New `docs/plugin-hermit-storage.md` is the canonical reference.
- In `CLAUDE-APPEND.md`, stale `reviews/` row removed from Agent State table — `reviews/` was listed as a first-class directory but is prohibited by the storage rules in the same file. Removed to eliminate the contradiction.
- In `CLAUDE-APPEND.md`, `memory/` added to prohibited top-level directory list — Matches the prohibition list in `docs/creating-your-own-hermit.md`.
- In `knowledge-schema.md.template`, `location:` field casing normalized — Per-example `Location:` entries (capitalized) normalized to lowercase `location:` to match the field declaration style in the section headers.

### Upgrade Instructions

Run `/claude-code-hermit:hermit-evolve`. The evolve skill handles:

1. **CLAUDE-APPEND.md refresh** — Replace the existing `CLAUDE-APPEND.md` appendix in the target project's `.claude/` directory with the updated template. This picks up the corrected Agent State table (no `reviews/` row) and the expanded prohibited-directory list (now includes `memory/`).

No `config.json` changes required. The `knowledge-schema.md.template` change only affects new hermits hatched from this version onward — existing `knowledge-schema.md` files in target projects are operator-editable and are not overwritten by `hermit-evolve`.

## [1.0.5] - 2026-04-16

### Fixed

- In docker-entrypoint, channel schema + silent marketplace failure — channels read as list instead of object so `enabled: false` was ignored; `marketplace add` failures swallowed by `|| true`. Now filters disabled channels and surfaces marketplace errors explicitly.
- In docker-entrypoint, plugins installed but left disabled — `claude plugin install` leaves plugins dormant; now calls `claude plugin enable` after each channel/recommended install.
- `claude login` → `claude /login` — correct CLI invocation; updated across `hermit-docker`, entrypoint, skills, and docs.
- In hermit-docker, `_require_running` preflight — `attach`/`bash`/`login`/`restart` now check `$SERVICE` is up before `docker compose exec` and print a clear start-it-first message.
- In docker-setup step 8, readiness gates — manual branch skips exec'd steps; "build now" polls `docker compose ps` 10s; workspace trust + channel pairing gate on `tmux has-session` to avoid "no server running" races.
- In docker-setup step 8, `access.json` verification — channel pairing polls `.claude.local/channels/<plugin>/access.json` (~3s, retry ~8s) and shows `tmux capture-pane` on miss instead of declaring success.
- In docker-setup, broken doc link — `recommended-plugins.md` path fixed to `../../docs/...`.

### Changed

- Hatch completion message — "Go always-on" leads with `docker-setup`; `smoke-test` moved to troubleshooting note; `bypassPermissions` promoted to first permissions option.
- In migrate, scope confirmation gate (step 0) — reads `config.json.scope` as authoritative, surfaces divergence with `.gitignore`, prompts to switch. Switching reconciles `config.json`, `.gitignore`, and `git rm --cached` for newly-ignored tracked paths behind one confirmation.

### Upgrade Instructions

Run `/claude-code-hermit:hermit-evolve`. The evolve skill handles:

1. **`hermit-docker` script** — Copy updated `state-templates/bin/hermit-docker` to `.claude-code-hermit/bin/hermit-docker`. This picks up the `_require_running` helper and the `claude /login` fix.
2. **`docker-entrypoint.hermit.sh`** — If Docker is in use, patch the rendered entrypoint at the project root: replace `claude login` with `claude /login` (two echo lines in the timeout paths). This is a cosmetic fix; the container still works — it only affects the error message shown when the 10-minute credential wait times out.

No `config.json` changes required.

## [1.0.4] - 2026-04-16

### Fixed

- In runtime.json, `waiting_reason` field — records why session entered `waiting` (`unclean_shutdown`/`dead_process`/`conservative_pickup`/`operator_input`) so `channel-responder` routes `(1)`/`(2)` replies to archive-or-resume instead of treating them as task instructions.
- In session-mgr, `session_id` patched into SHELL.md on open — header now correct from first tick instead of holding the placeholder until close.
- In session-mgr, `cost_usd` reads `.status.json` first — hook-written cost was silently discarded when SHELL.md parse won; now status file takes precedence.
- In session-start fast-path, patches SHELL.md ID placeholder — updates in-context without spawning session-mgr when runtime has the ID.
- Routine-watcher drains stale queue entries on startup — prunes entries >2h old to prevent phantom stale-routine alerts across restarts.
- In heartbeat, micro-proposal pending alert — step 6 flags tier-1 entries in `micro-proposals.json` via `micro-proposal-pending:<id>` so they don't silently expire; stale queue message now includes elapsed time.

### Changed

- In proposal-act, accept no longer stamps `resolved_date` — only sets `accepted_date`. `reflect` stamps `resolved_date` later once the pattern is absent from 3 sessions. Fixes `weekly-review.js` resolution count always being zero.
- In reflect, concrete Resolution Check procedure — bounded round-robin (≤5/cycle) reads each accepted proposal's evidence, scans last 3 reports, marks resolved if absent. Position tracked in `reflection-state.json.last_resolution_check`.
- In reflection-judge, explicit `Sessions: none` gate — step 0 short-circuits to `SUPPRESS` without evidence verification; reflect notes the suppression in SHELL.md Findings for revisit.
- In proposal-create, `source` + `category` in `created` events — metrics now distinguish manual / auto-detected / operator-request and improvement / routine / capability / constraint / bug.
- In generate-summary.js, per-source acceptance + resolved count — new `proposals_resolved` and `auto_detect_accept_rate` frontmatter fields answer "are autonomous proposals good?".
- In reflect + session-start, notification routing de-duplicated — "Always-On Notification Rule" block replaced with one-liner deferring to CLAUDE-APPEND's Operator Notification section.
- Reflect preserves micro-proposal `question` text in JSONL + active slot — enables post-hoc analysis of what was asked vs operator response.
- In heartbeat, `noise_ticks` self-eval field — counters increment when a dismissed-proposal-linked alert fires; at 20+ across 3+ sessions, proposes retuning or removing the check (mirrors `clean_ticks`).
- Docs/frontmatter-contract.md — `resolved_date` writer updated to `reflect (pattern absence)`.

### Upgrade Instructions

Run `/claude-code-hermit:hermit-evolve`. The evolve skill handles:

1. **No config.json changes required** — all changes are in skill/agent files.
2. **`state/reflection-state.json`** — if it exists and lacks a `last_resolution_check` key, no action needed; the resolution check procedure initializes it on first run.
3. **`state/alert-state.json` self_eval entries** — existing entries lack `noise_ticks`. The heartbeat self-eval step initializes missing fields as 0 on first read; no manual migration needed.
4. **Existing `proposal-metrics.jsonl` events** — old `created` events without `source`/`category` fields are handled by `generate-summary.js` bucketing them as `unknown`. No backfill required.
5. **Accepted proposals with `resolved_date` already set** — these were stamped at accept time under the old behavior. They may show a `resolved_date` even though `status` is `accepted`, not `resolved`. On first reflect run, the resolution check will re-evaluate them. If the pattern is gone, they'll be promoted to `resolved` (updating `resolved_date` to the current time). If not, `resolved_date` stays set but `status` remains `accepted` — a cosmetically odd but non-breaking state that will self-heal.

## [1.0.3] - 2026-04-16

### Added

- `proposal-triage` agent (Haiku) — pre-creation gate: deduplicates against existing PROP-NNN files and applies the three-condition rule; returns `CREATE | SUPPRESS:<reason> | DUPLICATE:<id>`.
- `reflection-judge` agent (Sonnet) — post-reflect validator: verifies cited sessions actually describe the claimed pattern before proposals are queued; returns `ACCEPT | DOWNGRADE:<tier> | SUPPRESS`.
- `knowledge` skill — read-only lint of `raw/` and `compiled/`; flags stale, unreferenced, missing-type, and oversized artifacts; delegates to `scripts/knowledge-lint.js`.
- `scripts/knowledge-lint.js` — shared lint module extracted from `weekly-review.js`; eliminates duplicated inline logic.
- In Test infrastructure, `tests/run-all.sh`, `tests/lib.sh`, `tests/run-scripts.sh` — unified entry point for hook, contract, and script suites; shared assertions via `lib.sh`.

### Changed

- In `reflect`, evidence validation pipeline — delegates each candidate to `reflection-judge` before acting; Tier 1/2 pass through `proposal-triage` before micro-approval; Tier 3 passes through triage before `proposal-create`.
- In `proposal-create`, pre-creation gate — calls `proposal-triage` before writing; stops on DUPLICATE or SUPPRESS.
- `pulse --full` — new flag that appends infrastructure health sections after the session block: proposal counts by status, pending micro-proposals, routines on/off, last reflect/heartbeat timestamps, and knowledge file counts (`raw/`, `compiled/`, `raw/.archive/`).
- In `heartbeat`, iDLE-TASKS management — when the operator asks about idle tasks (add, remove, manage), heartbeat now reads/writes `.claude-code-hermit/IDLE-TASKS.md` instead of HEARTBEAT.md. Creates the file from template if absent. Warns if `idle_behavior` is not `"discover"`.
- In `weekly-review.js`, simplified via shared lint — knowledge health section now calls `knowledgeLint()` from `knowledge-lint.js` instead of duplicating the logic inline. Output format updated to per-finding lines with file, age, and reason.
- In `HEARTBEAT.md.template`, removed two redundant built-in checks — "Check for NEXT-TASK.md" and "Check if current task has blocked items that may have resolved" are handled natively by the heartbeat skill. Removed to reduce LLM reasoning load per tick.
- Test runner unified — `tests/run-hooks.sh` refactored to use shared lib. All suites now accessible via `bash tests/run-all.sh`. Smoke-test-runner agent updated to use the unified entry point.
- `CLAUDE.md` and `CLAUDE-APPEND.md` — `proposal-triage` and `reflection-judge` added to agent listings. `/knowledge` added to CLAUDE-APPEND.md Quick Reference. Subagent section in CLAUDE-APPEND.md expanded with descriptions for all four agents.

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

- Fully qualified agent/skill names enforced throughout skill instructions — Bare names (e.g., `:session-mgr`) were silently misrouted by the harness. All skill instruction files now use the canonical `claude-code-hermit:<name>` form. Affects every skill that spawns a subagent or invokes another skill.
- In session-mgr, null `session_id` fallback on runtime.json write — If `session_id` was null or missing when setting `session_state` to `in_progress`, the session would archive under `S-null`. Step 7 now pre-computes the ID in the same write if it wasn't set in step 6.
- In session-mgr, invocation payload takes precedence over stale SHELL.md — On both close and idle-transition, if the caller passes structured task data (status, blockers, lessons, changed files), those values are used directly instead of re-reading potentially stale SHELL.md fields.

### Changed

- In session-start, fast-path gate skips session-mgr on normal startup — when `runtime.json` is healthy and SHELL.md exists, no agent spawn; eliminates a full agent turn on every normal session start.
- In session / session-close, compile final data in-context before handing off to session-mgr — callers pass a compact structured payload, preventing stale SHELL.md re-reads from overwriting in-context data.
- In session-mgr, maxTurns reduced from 15 to 12 — Consistent with actual observed turn counts; the previous ceiling was never reached.
- In hermit-settings, improved guidance — Clearer instructions for configuring hermit behavior.

### Upgrade Instructions

Run `/claude-code-hermit:hermit-evolve`. The evolve skill handles:

1. **CLAUDE-APPEND refresh** — No changes to CLAUDE-APPEND.md in this release; refresh is not required.
2. **No template changes** — State templates and `config.json` are unchanged.
3. **Behavioral changes are in skill/agent instruction files only** — These take effect immediately via the plugin; no per-project migration needed.

No `config.json` changes required.

## [1.0.1] - 2026-04-15

### Fixed

- State JSON files now copied from templates during hatch — `alert-state.json`, `routine-queue.json`, and `micro-proposals.json` were previously written inline by the LLM, producing malformed content that silently broke routine queuing.
- Smoke-test validates and repairs state file schema — new step 6 checks all three schema-sensitive files; repairs without discarding existing data; emits WARN per repaired file.

### Added

- The `state-templates/routine-queue.json.template` default is `{"queued": []}`.
- The `state-templates/alert-state.json.template` default includes `alerts`, `self_eval`, `total_ticks`, and `last_digest_date`.
- The `state-templates/micro-proposals.json.template` default is `{"active": null}`.

### Upgrade Instructions

Run `/claude-code-hermit:hermit-evolve`. The evolve skill handles:

1. **CLAUDE-APPEND refresh** — No changes to CLAUDE-APPEND.md in this release; refresh is not required.
2. **Template copy** — The three new `.template` files are only used during `hatch`. Existing hermit state files are not touched automatically; if you suspect a malformed state file, run `/claude-code-hermit:smoke-test` to detect and repair it.

No `config.json` changes required.

## [1.0.0] - 2026-04-14

Initial public release.
