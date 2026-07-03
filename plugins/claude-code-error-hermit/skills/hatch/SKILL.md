---
name: hatch
description: One-time error hermit setup. Verifies Sentry/GlitchTip credentials with a live check, injects the Error Watch block, and stamps config.json. Run once per project after /claude-code-hermit:hatch.
---

# Hatch — claude-code-error-hermit

Idempotent setup wizard for the error hermit. Run **after** `/claude-code-hermit:hatch` has already been completed, inside the repo of the application you want to watch.

---

## Step 1 — Prerequisite check

Read `.claude-code-hermit/config.json`.

If the file does not exist or `_hermit_versions["claude-code-hermit"]` is absent or empty:

> "The base hermit is not set up in this project yet. Run `/claude-code-hermit:hatch` first, then return here."

Use `AskUserQuestion`: "Would you like to run `/claude-code-hermit:hatch` now? (yes / no)"

- **yes** → Follow the domain hatch continuation protocol (documented in `claude-code-hermit:hatch`):
  1. Write `.claude-code-hermit/state/hatch-resume.json` with `{ "skill": "claude-code-error-hermit:hatch" }`.
  2. Print: "(If setup doesn't continue automatically when core finishes, re-run `/claude-code-error-hermit:hatch`.)"
  3. Invoke `/claude-code-hermit:hatch` **via the Skill tool** — terminal action, stop after the call.
- **no** → stop.

If `_hermit_versions["claude-code-hermit"]` is present but the version string is earlier than `1.2.14` (compare major.minor.patch numerically), warn:

> "Base hermit version is {version}; this plugin requires ≥1.2.14. Run `/claude-code-hermit:hermit-evolve` to upgrade, then re-run this hatch."

Stop.

---

## Step 2 — Idempotency check

Read `_hermit_versions["claude-code-error-hermit"]` from `.claude-code-hermit/config.json`.

Read `version` from `${CLAUDE_PLUGIN_ROOT}/.claude-plugin/plugin.json`.

If the versions match, say:

> "claude-code-error-hermit {version} is already installed. Skip to Step 3 to re-verify connectivity, or reply 'full' to re-run the full wizard."

Use `AskUserQuestion`: "(verify / full)"

- **verify** → run Step 3's live check only, then jump to Step 9.
- **full** → continue from Step 3.

If absent or stale: continue from Step 3.

---

## Step 3 — Credentials + live verification

**IMPORTANT: Do NOT use `grep`, `cat`, `echo`, or any Bash command to read `.env`. The `ERROR_HERMIT_TOKEN` variable contains the literal string `TOKEN`, which trips the base hermit's deny-patterns hook on any Bash command argument. Use the `Read` tool only.**

Tell the operator:

> "This plugin needs four values in `.env`. If you haven't done this yet:
>
> 1. `cp .env.example .env` (or copy the file manually)
> 2. Open `.env` and fill in:
>    - `ERROR_HERMIT_TOKEN` — a Sentry or GlitchTip auth token (scopes: `project:read`, `event:read`, `org:read`; add `project:write` to allow operator-approved resolve/mute)
>    - `ERROR_HERMIT_BASE_URL` — `https://sentry.io` or your GlitchTip URL (no trailing slash)
>    - `ERROR_HERMIT_ORG` — organization slug
>    - `ERROR_HERMIT_PROJECT` — project slug
>
> Reply 'done' when the file is filled in, or 'abort' to stop."

Use `AskUserQuestion`: "(done / abort)"

- **abort** → stop.
- **done** → continue.

Use the **Read tool** to read `.env`. Verify all four keys are present, non-empty, and not `replace_me`. If any is missing, report which and loop back to the prompt above.

Then run the **live check** (this reaches the tracker; it self-reports without ever printing the token):

```bash
bun ${CLAUDE_PLUGIN_ROOT}/scripts/error-api.ts check
```

Interpret the single output line:
- `ok: connected to <org>/<project>` → continue.
- `missing: <keys>` → the env is not being picked up; re-check `.env` and loop.
- `invalid: token rejected (401)` / `invalid: organization ... (404)` / `invalid: project ... (404)` → the credential or a slug is wrong; report and loop.
- `unreachable: ...` → base URL wrong or network blocked; report and loop.

Do not proceed until `check` reports `ok`.

---

## Step 4 — Gitignore

**Add `.env` to `.gitignore`** if not already present. Read the project `.gitignore` (treat as empty if absent), and append `.env` on its own line using Edit if missing.

---

## Step 5 — Drop state templates

Copy the templates the plugin ships from `${CLAUDE_PLUGIN_ROOT}/state-templates/compiled/` into the consumer's `.claude-code-hermit/compiled/`. Currently: `error-noise-ledger.md` (the classification memory the `error-triage` skill maintains).

For each `*.md` file present in that source directory:
- Read the source (Read tool), check if `.claude-code-hermit/compiled/<filename>` exists.
- **Does not exist** → write it (Write tool). Report `✓ dropped <filename>`.
- **Already exists** → skip (never overwrite operator edits). Report `⊘ skipped <filename> (already present)`.

---

## Step 6 — CLAUDE.md / CLAUDE.local.md inject

**Resolve target file:** Read `.claude-code-hermit/state/hatch-options.json`. Use the `"target"` field:
- `"local"` → `target_file = CLAUDE.local.md`
- `"committed"` or absent → `target_file = CLAUDE.md`
- If the file doesn't exist (operator's core hermit predates `hatch-options.json`): detect `core_install_scope` from `claude plugin list --json` using the same precedence as core hatch (filter entries where plugin name is `claude-code-hermit` and `enabled == true`; precedence `local` > `project` (both require `projectPath == project root`) > `user` (any `projectPath`) > `null`; map `project` → `committed`, `local`/`user`/`null` → `local`). Ask with `AskUserQuestion` (header: "Visibility"), scope-derived default at position 0 with `(recommended)`: **`.local` files** (gitignored) / **Committed files** (shared). Write the canonical 5-field schema to `.claude-code-hermit/state/hatch-options.json`:

  ```json
  {
    "target": "<choice>",
    "core_install_scope": "<project|local|user|null>",
    "stamped_at": "<current ISO 8601 timestamp with timezone offset>",
    "stamped_by": "claude-code-error-hermit:hatch",
    "version": "<current error-hermit plugin version from ${CLAUDE_PLUGIN_ROOT}/.claude-plugin/plugin.json>"
  }
  ```

Read `target_file`. Search for the opening marker `<!-- claude-code-error-hermit: Error Watch -->` (closing marker `<!-- /claude-code-error-hermit: Error Watch -->`).

- **`target_file` does not exist** → treat as marker-absent; Edit will create it.
- **Marker absent** → append the full contents of `${CLAUDE_PLUGIN_ROOT}/state-templates/CLAUDE-APPEND.md` to `target_file` using Edit.
- **Marker present** → skip (`hermit-evolve` handles block replacement on upgrade).

---

## Step 7 — Knowledge-schema extension

Read `.claude-code-hermit/knowledge-schema.md`.

Check if `error-noise-ledger:` is already present. If **absent**, append under `## Work Products` (create the header if the base schema is only a stub):

```
- error-noise-ledger: living ledger of known-noise / known / fixed-in error fingerprints. Maintained by the error-triage skill. location: compiled/error-noise-ledger.md
- incident-summary: post-incident writeup (timeline, root cause, fix link). location: compiled/incident-<YYYY-MM-DD>-<slug>.md
```

And under `## Raw Captures` (create if absent):

```
- error-triage-log: raw per-run triage findings (classified groups, correlations). Retention: 30 days. location: raw/error-triage-<YYYY-MM-DD>.md
```

If already present: skip (idempotent). Use Edit.

---

## Step 8 — Stamp config.json

Use the `config.json` content already loaded in Step 1 (do not re-read).

### 8a — Stamp version

Set `_hermit_versions["claude-code-error-hermit"]` to the plugin version from Step 2 (update if present, add alongside the existing core entry if absent).

### 8b — Register the watch routine

In the `routines` array, check for an entry with `id: "error-triage"`. If **absent**, add it. If **present** (by `id`), skip — do not clobber operator edits (they may have retuned the schedule).

```json
{
  "id": "error-triage",
  "schedule": "0 * * * *",
  "skill": "claude-code-error-hermit:error-triage",
  "enabled": true,
  "run_during_waiting": true
}
```

Hourly is the default poll; the operator can retune `schedule` via `/claude-code-hermit:hermit-settings`. No `model` field — triage reads the ledger, writes state, and DMs, so it runs in-session (the precheck script, not a cheaper model, is the cost gate). No `prompt_file` — that field is not consumed by core.

Write the updated `config.json` using the Write tool (full-file replacement to guarantee valid JSON).

---

## Step 9 — Final report

Print a structured summary:

```
claude-code-error-hermit {version} setup complete.

Installation summary:
  ✓ Prerequisite: claude-code-hermit {base_version} confirmed
  ✓ .env: all four credentials present
  ✓ Live check: connected to {org}/{project}
  ✓ .gitignore: .env covered
  ✓ compiled/error-noise-ledger.md: {dropped | already present}
  ✓ CLAUDE.md: Error Watch block injected (or was already present)
  ✓ knowledge-schema.md: error types added (or were already present)
  ✓ config.json: _hermit_versions stamped, error-triage routine registered

The watch loop:
  Routine `error-triage` (hourly by default) runs a zero-cost precheck and
  triages only when new error groups appear. Retune the schedule via
  /claude-code-hermit:hermit-settings.

Skills:
  /claude-code-error-hermit:error-triage           — classify new groups (routine-driven)
  /claude-code-error-hermit:error-reproduce        — worktree repro + failing test + bisect
  /claude-code-error-hermit:error-draft-fix        — draft a fix on a branch (PR is approval-gated)
  /claude-code-error-hermit:error-incident-summary — post-incident writeup
  /claude-code-error-hermit:error-digest           — overnight digest (optional routine)
  (resolve / mute via error-api.ts are approval-gated — surface first, then --confirm)

Go always-on (recommended):
  - Docker:     /claude-code-hermit:docker-setup
  - Bare tmux:  .claude-code-hermit/bin/hermit-start
  Or test the routine now: /claude-code-hermit:hermit-routines load

Security reminder: .env holds a real tracker token. It is gitignored — verify before any git push.
```
