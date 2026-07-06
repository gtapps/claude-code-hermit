---
name: hermit-evolve
description: Evolves hermit configuration and templates after a plugin update. Detects version gaps and runs the upgrade (migrations, templates, new settings) in an isolated subagent. Run after updating the plugin.
---

# Evolve Hermit

Upgrade the project's hermit configuration after a plugin update.

## Execution routing

Every run of this skill (interactive or unattended) delegates steps 0–9 to the `claude-code-hermit:evolve-runner` subagent, so the upgrade's transient churn (changelog slice, migration execution, file diffs) never lands in the calling session. The main loop keeps only step 10 (summary + operator notification).

> **Tool note:** `claude-code-hermit:evolve-runner` is a **subagent** — invoke it via the Agent tool, never the Skill tool. The `plugin:name` form it shares with skills does not imply the Skill tool.

- **If you are running AS the `evolve-runner` subagent**, skip this section and execute steps 0–9 directly (you are the delegate — do not re-dispatch).
- **Otherwise (main loop, any mode):**
  1. **Determine the mode** and remember it for step 10: positional argument `unattended`, or running in an always-on session invoked via channel ⇒ *unattended*; else *interactive*.
  2. **Bake the absolute plugin root** to thread to the subagent (it cannot resolve it itself — the bare env var `$CLAUDE_PLUGIN_ROOT` is **not** set at Bash runtime, and the value is empty inside subagents). Derive it from this skill's **Base directory**, which the harness injects in the skill invocation context as `<plugin_root>/skills/hermit-evolve`: strip the trailing `/skills/hermit-evolve` to get `plugin_root`. This works in both installed and `--plugin-dir` modes. (In installed mode this equals the harness's `${CLAUDE_PLUGIN_ROOT}` substitution, which step 1 relies on; the Base-directory derivation is the mode-independent source.) **Guard:** confirm both `test -f "<plugin_root>/skills/hermit-evolve/SKILL.md"` and `test -f "<plugin_root>/skills/hermit-evolve/reference.md"` — the subagent reads `reference.md` for steps 0–9, so a missing reference file is just as fatal as a missing SKILL.md. If either fails, **abort** — log `"hermit-evolve aborted: plugin root unresolved; cannot dispatch evolve-runner."` and stop. Do not dispatch with a broken path.
  3. **Dispatch** the `claude-code-hermit:evolve-runner` subagent via the Agent tool. Pass the baked absolute plugin root and the report contract (below). Do **not** execute steps 0–9 yourself.
  4. **Go to step 10** with the subagent's returned report.

## Delegated mode

Steps 0–9 (in `reference.md`, read only by the `evolve-runner` subagent) are executed with no `AskUserQuestion` — the subagent cannot pause to ask. Each step's **"Delegated mode:"** note states the non-interactive behavior. The rule in every case: never guess on a destructive choice, never block.

- For any interactive choice with a safe non-destructive default (new settings, file deletions, `## Plan` strip, template conflicts), take the default silently and report it.
- For a genuine either/or with **no safe default** (an `### Upgrade Instructions` migration step in 2b/7), **defer**: skip that step and record a verbatim deferred-migration block in the report (see the report contract in step 10). Never guess. Step 10 resolves it — interactive asks the operator, unattended relays it to the channel.

### 10. Report

**Step 10 runs in the main loop** (not the subagent), consuming the `evolve-runner`'s returned report. The subagent's report is the single source for what follows.

**Report contract** — the subagent's final message is exactly this; non-deferred runs carry no deferred block, so the common payload is tiny:

```
Upgrade: vOLD -> vNEW | core current vNEW | blocked: <reason>
Settings added: <keys | none>
Templates: <refreshed/restored/kept-N/conflicts-parked-N | none>
Bin wrappers: <restored/replaced(.bak) | none>
Docker entrypoint: <refreshed | conflict-replaced(<backup path>) | n/a>
Docker rebuild: <needed + order | base-patched | no>
CLAUDE-APPEND: <updated | unchanged>
Sibling hermits: <one or more of the following per sibling, space-separated, or "none">
  <name vOLD->vNEW>           (confirmed by finalizer — only from siblings_confirmed)
  <name current>              (no version gap)
  <name block-drifted>        (no gap but CLAUDE-APPEND differs from template — advisory only, not edited)
  <name path-unresolved>      (in _hermit_versions but no project-effective plugin-list match)
  <name SKIPPED-by-finalizer> (finalizer's siblings_skipped — never report as upgraded)
Siblings detected but not activated: <name ... | none>
Siblings warnings: <one line per siblings_warnings entry | none>
Permissions added: <entries | none>
Deferred for operator: <none | one or more verbatim blocks, each:>
  --- deferred-migration ---
  source: <plugin>@<version>
  instruction: |
    <exact verbatim ### Upgrade Instructions step text — copied, not summarized>
  options: <the either/or choices presented>
  skipped: <the safe/no-op branch taken, or "skipped pending operator">
  --- end ---
```

**Sibling report integrity:** parse the finalizer JSON `siblings_confirmed` and `siblings_skipped`. Only names in `siblings_confirmed` may be reported as `vOLD->vNEW`. Any name in `siblings_skipped` must be reported as `SKIPPED-by-finalizer` — never as upgraded, even if Step 7 said it ran.

**Failure fallback.** If the Agent call returned null/empty (subagent died — same partial-state risk as an in-loop failure), report "evolve delegation failed — run `/claude-code-hermit:hermit-evolve` manually" and fire that as the channel notification. Stop.

**Print the summary** from the report fields. Omit lines where nothing changed. End with "Run /claude-code-hermit:hermit-settings to adjust any settings." if settings were added.

**Resolve deferrals by mode.** If "Deferred for operator" is non-empty:
- **Interactive:** for each deferred-migration block, present its `instruction` + `options` to the operator via `AskUserQuestion`, then apply the chosen branch inline (this is the only place changelog/migration text re-enters the main loop, and only for the rare deferred step).
- **Unattended:** relay each deferred block to the channel verbatim ("migration deferred for operator review: <source> — <instruction>"). **Do not apply — never run the migration's settings writes from this session.** If the deferred `instruction` text contains an explicit channel resolution stanza (a fenced `options: [...]` array and an `on_resolve: "..."` skill invocation with an `{answer}` placeholder — the CHANGELOG's artifact-publish-authorization migration is the current example), additionally queue a micro-proposal entry per `reflect` § Queuing procedure using that exact `options` and `on_resolve` (`tier: 1`, `"kind":"ask"` on the `micro-queued` event) and render the numbered options in the channel relay, so the operator's reply resolves it through `channel-responder` § Micro-approval response — the same bridge any other skill's bounded ask uses. An `on_resolve` reached this way may only alter hermit config/state, never `.claude/settings*.json` — a boot-time wrapper (e.g. `hermit-start`) applies any resulting permission grant out-of-session, never this session.
- **Version-bump caveat (both modes):** the subagent already bumped `_hermit_versions` to `<to>` in step 9, having *skipped* the deferred migration. We keep that bump — withholding it would replay the whole oldest-first slice next evolve and double-apply non-idempotent migrations. So if an interactive apply **fails or the operator declines**, report loudly (summary + channel): "version already bumped to v`<to>`; migration `<source>` was NOT applied; apply manually: `<instruction>`" — otherwise a rerun-says-up-to-date would silently hide it. On success, report it applied.

**Docker rebuild notice.** From the report's `Docker entrypoint` / `Docker rebuild` fields, append a `Docker:` section when a rebuild is needed:
- Entrypoint refreshed → "Docker entrypoint refreshed. Rebuild to apply: `.claude-code-hermit/bin/hermit-docker update`."
- `Docker rebuild: base-patched` → "Docker base image updated. Rebuild to apply: `.claude-code-hermit/bin/hermit-docker update`. Do **not** re-run `/docker-setup` — your Dockerfile customizations are preserved." When this value is present, **suppress** the "Compose/Dockerfile changed upstream" bullet below for `Dockerfile.hermit` (the migration already handled it).
- Compose/Dockerfile changed upstream → "Docker template(s) changed upstream. Refresh FIRST, then rebuild: (1) re-run `/claude-code-hermit:docker-setup`, (2) THEN `hermit-docker update`. Rebuilding first bakes stale on-disk files into the image."
- Baseline not recorded → "Docker template baseline not recorded. Run `/claude-code-hermit:docker-setup` once to arm the drift signal."
- Never auto-rebuild.

**Notify the operator** per CLAUDE-APPEND.md § Operator Notification with a condensed one-line message such as `"Hermit upgraded: vOLD → vNEW. N settings added, M templates refreshed."` Omit segments where nothing changed. **Append the deferred/auto-applied segments**: settings set to defaults (Step 4), permission entries added (Step 8), template conflicts parked as `.new` (Step 5), and any deferred migrations — so the operator can follow up via `/hermit-settings`.
