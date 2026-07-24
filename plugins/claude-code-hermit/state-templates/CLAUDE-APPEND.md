---

<!-- claude-code-hermit: Session Discipline -->

## Session Discipline (claude-code-hermit)

- Startup state and resume context are injected by the SessionStart hook (active task, blockers, plan). If the session is idle or absent, ask what to help with.
- Use `/claude-code-hermit:session-start` and `/claude-code-hermit:session-close` for lifecycle transitions.

## Watches

Config-defined watches auto-register on session start. Ad-hoc watches via `/watch <instruction>`.
Registry: `state/monitors.runtime.json` (sole truth — not SHELL.md). Use `/watch status` to check, `/watch stop` to halt.

- Authoring rules (stream vs poll, `grep --line-buffered`, `|| true` in poll loops, the four required Monitor params, the `$CLAUDE_PLUGIN_ROOT`-unavailable-in-subprocess caveat): `/claude-code-hermit:watch` skill.
- Watches die with the session — for scheduled work use `/claude-code-hermit:hermit-routines`.
- `HEARTBEAT_EVALUATE` notification → invoke `/claude-code-hermit:heartbeat run`.
- `ROUTINE_DUE` notification → invoke `/claude-code-hermit:hermit-routines run` with the bracketed ids.

## Operator Notification

Main owns outbound sends and `AskUserQuestion`. To notify the operator proactively:

- **No channel enabled** (no channel entry with `enabled !== false`, excluding `primary`): if `push_notifications === true`, fire `PushNotification(message="<≤200 chars, no markdown, actionable first>", status="proactive")` and respond in conversation. Empty-channels config is intentional — don't log an issue.
- **Channel enabled:** compose the audience version(s) and run `bun ${CLAUDE_PLUGIN_ROOT}/scripts/channel-send.ts .claude-code-hermit --notice` with `{"client": "<plain>", "maintainer": "<technical/spend detail>"}` on stdin (either key alone is fine). Non-zero exit means nothing was delivered: push if enabled, log the unsent content to SHELL.md Findings, and record a deduped `channel-send-unavailable` issue unless the result's `no_channel` is true.

Full protocol: `/claude-code-hermit:channel-responder` § Outbound notification protocol.

**Channel voice.** No internal IDs (PROP-NNN, S-NNN, MP-…), no token counts, slash commands, file paths, or cron strings — plain language with the one next step the operator can do from chat. Terminal/maintainer output is exempt.

**Language & audience.** Compose channel messages and push notifications in the operator's configured `language` (`config.json`); when unset, match the language the operator writes in. When `channels.<platform>.maintainer_channel_id` is set, technical, operational, and spend content goes to the maintainer chat: put it in the `maintainer` key of the `--notice` payload (the script routes it — never a reply tool).

## Artifact Pages

Dashboard/proposals/weekly-review, gated by `config.artifacts.*` (default on). On-demand publish needs no gate. Refresh runs inside the publish skills, not from here.

## Knowledge Discipline

Auto-memory handles all learning; `compiled/` is for durable domain outputs, not lessons. **Memory-first for suggestions:** before any suggestion-generating path (`brief`, `reflect`, `weekly-review`, `proposal-create`, `session-start`, and the `proposal-triage`/`reflection-judge` subagents) declares a finding novel, consult auto-memory and suppress with the canonical code `covered-by-memory` (quoting the matching memory line) if memory already covers the decision, preference, or pattern. Skills acting on a decided intent (`session-close`, `proposal-act`, `hermit-routines`, `hatch`) are exempt.

- Domain inputs → `raw/<type>-<slug>-<date>.md`; one-off outputs → `compiled/<type>-<slug>-<date>.md`; evolving subjects → `compiled/topic-<slug>.md` updated in place. All require frontmatter (`title`, `type`, `created`, `tags`).
- **`type` in frontmatter is the discriminator — never a folder.** No subdirectories inside `raw/`/`compiled/`, no new top-level dirs inside `.claude-code-hermit/`. Artifacts outside `raw/`/`compiled/` are invisible to injection and retention.
- Naming and retention are enforced by the storage scripts; `.claude-code-hermit/knowledge-schema.md` defines what this hermit produces.

## Rules

- **Rate limits:** Log pause/resume in Progress Log. Never silently stall.
- **Self-awareness:** If stuck — say so, log it, alert via channel. Don't push through silently.
- **Auto-mode denial alert:** If a tool call is denied by the auto-mode classifier, alert the operator (per § Operator Notification) with the blocked action and the denial reason before attempting any alternative.
- **Sanctioned egress:** channel replies, doctor liveness probes, and Artifact publishes are routine, pre-authorized hermit operations, not a permission workaround.
- **Context hygiene & delegation:** Delegate a sub-step to a subagent when all three hold: (a) its intermediate context is much larger than its conclusion (multi-file edits, search sweeps, test output qualify; a frontmatter flip does not); (b) it needs no operator contact mid-flight; (c) main needs only the verdict. Comms contract: the sub-step returns a verdict plus optional `operator_message`; **main owns `AskUserQuestion`, channel resolution, and `PushNotification`** (§ Operator Notification). Break-even: subagents inherit `CLAUDE.md`/`CLAUDE.local.md` as a fixed per-dispatch token tax, so it's a net win only on the long-lived session above that threshold — but the inheritance is also why `general-purpose` is the right pick for write tasks (it gets git-safety and project conventions for free). Each dispatch also bookends main with ≥2 full-context turns (dispatch + ingestion) — batch them, skip dispatch for trivial sub-steps.
- **Calibration:** Before publishing specifics you didn't verify in this conversation (version-pinned behavior, external system state, recalled API/function signatures, menu paths, prices/dates/counts), either verify against a source (`WebSearch`, project docs, read the code, ask the operator) or label as recalled-not-verified. Trigger is specificity of the claim, not topic; general domain knowledge (principles, patterns, semantics) is fine to answer directly. `OPERATOR.md` can tighten or relax.
- **Secrets:** Never log API keys, tokens, passwords, or credentials to SHELL.md, reports, or proposals. Session files may be committed to git.
- **OPERATOR.md:** Never edit autonomously. If you notice stale or contradictory context, draft the minimal change, show a diff, and apply only after the operator confirms. In always-on mode, flag it via channel instead — the operator edits directly.
- **Proposals mandatory:** Every improvement goes through `/proposal-create` → operator accepts → implement. Trivial fixes (typos, one-liners) exempt. **Never hand-write `proposals/PROP-*.md` files** — always invoke the skill so the NNN-assignment, slug, timestamp, and collision-guard logic runs. Manually-assigned ids reuse NNNs across parallel sessions and produce short-form ids that violate the canonical `PROP-NNN-<slug>-HHMMSS` schema.
- **Tasks:** Use `TaskCreate`/`TaskUpdate` for multi-step work. `tasks-snapshot.md` is auto-generated — don't edit.
- **Artifact frontmatter:** Any `.md` file you create outside `.claude-code-hermit/` must include YAML frontmatter with at least `title` (string) and `created` (ISO 8601 with timezone). If inside a hermit session, add `session: S-NNN`. Optionally add `proposal`, `source` (`session` | `interactive` | `routine` | `manual`), and `tags` (array of strings).
- **Tag discipline:** Add `tags` to every session report, proposal, and artifact you create. Before tagging, scan the last 5 session reports and proposals for the existing vocabulary and reuse — introduce new tags only when nothing fits. Keep tags lowercase and hyphenated (1–2 per document).
