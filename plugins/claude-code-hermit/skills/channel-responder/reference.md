# Channel responder reference

Read on demand from `SKILL.md`; never loaded on a turn that does not need it.

## Standing work

Standing work is what the hermit does without being asked in the moment: routines, watches, and standing roles. Session-triggered `scheduled_checks` fire on session events and are not standing work. Answer in channel voice (`SKILL.md` § 3): no cron strings, ids, file paths, or slash commands, except the relayed `!doctor` when a live check is the next step.

### Gather (bounded reads only)

- Routines: `bun <plugin_root>/scripts/settings-edit.ts .claude-code-hermit/config.json get routines` for id, schedule, skill, enabled, precheck.
- Routine outcomes: `bun <plugin_root>/scripts/routines.ts health .claude-code-hermit` (JSON; add `--days N` for a longer window). Use `last_fire`, `failure_total`, `last_precheck_error`, `open_attempt`.
- Watches: `Read state/monitors.runtime.json` for id, description, source, class, started_at.
- Roles: the `[role` lines already in this turn's context. Hermit-wide ones always apply; a pinned `[role <key>:<chat_id>]` line applies only to that chat (`SKILL.md` § 1b).
- Current activity: `session_state` in `state/runtime.json` and the Task line of `sessions/SHELL.md`.
- Health evidence: `Read state/doctor-report.json` only for the "anything to deal with" and "what can you access" shapes. Do not run `doctor-check.ts` from this intent; a live check is the relayed `!doctor` command, which the operator sends.

Never `tail` `state/routine-metrics.jsonl`, the cost log, or the channel log. A field none of these sources records is unknown; say so instead of guessing.

### Default view

Order: problems first, then current activity, then domain standing work.

- A problem is a routine with `failure_total > 0` or a `last_precheck_error`, a `fail` or `warn` entry in the saved doctor report, or a watch whose registry entry says it exited.
- Lead with work aimed at the operator's domain (briefs, domain analyses, watches, rules). Routines that exist to keep the hermit itself running (monitor re-arms, self-reflection, self-checks, session closing) are housekeeping: mention them only when one carries a problem or the operator asks for the internal housekeeping.
- Per item: plain name, purpose (from the skill name or description), cadence or condition in words, destination when config names one, last known outcome (`last_fire` plus `failure_total`), and persistence: routines and roles persist across restarts, watches die with the session (config watches return at the next start).

### Matching a named item

Match the operator's phrase, case-insensitive, against routine `id` and skill name, watch `id` and `description`, and role slug or rule text. Exactly one match acts. Several matches: name them in plain language and ask which. None: say so and list what exists.

### Routing a change

| Operator intent | Owner | Reply must state |
|---|---|---|
| Disable, enable, or retime a routine | **Settings change request** path: `hermit-settings routines` (index from a fresh `get routines`, then `hermit-routines load`) | Persists across restarts. A native permission prompt, if one appears, is the operator's answer. |
| Stop a routine "for now" | `/claude-code-hermit:hermit-routines stop <id>`: single routines share one monitor, so relay its explanation and offer the durable disable | Nothing changed unless they choose the disable. |
| Stop a watch | `/claude-code-hermit:watch stop <id>` | Gone for this session; a config watch returns at the next start. |
| Forget or change a rule | **Standing role** branch | Persists. |
| Anything an owner does not support | Explain the limit; do not emulate it | Nothing changed. |

### Settings and model questions

Relay the `settings-edit ... show` row for the setting: saved value, what changes it, and when it applies. For the running model or effort: if this session's context holds a `[harness-command] … transcript now reports model X` line, that is the observed serving model; otherwise say the saved value is what the next boot uses and the current session's value is unverified. `settings-edit ... history <path>` answers who changed it and when. Never claim a runtime value the harness did not report.

### Access question

From config: channels with `enabled !== false` and whether each has an allowlist, `permission_mode`, `remote`, enabled artifact pages, `auth_mode`. From `state/doctor-report.json`: the last `channel-liveness`, `credential-expiry`, and `permissions` results with their timestamp. Configured is not verified; say which is which. No credentials, chat ids, or file paths in the reply. In a group, or for a sender who is not the trusted controller, give only the coarse shape (the same audience rule as `!status`).
