---
name: hatch
description: One-time SEO/site-health hermit setup. Collects Search Console + PageSpeed credentials, verifies GSC access with a live round-trip, and wires the weekly site-health routine into config.json. Run once per project after /claude-code-hermit:hatch.
---

# Hatch — seo-hermit

Idempotent setup wizard for the SEO/site-health plugin. Run **after** `/claude-code-hermit:hatch` has been completed.

---

## Step 1 — Prerequisite check

Read `.claude-code-hermit/config.json`.

If the file does not exist or `_hermit_versions["claude-code-hermit"]` is absent or empty:

> "The base hermit is not set up in this project yet. Run `/claude-code-hermit:hatch` first, then return here."

Use `AskUserQuestion`: "Would you like to run `/claude-code-hermit:hatch` now? (yes / no)"

- **yes** → Follow the domain hatch continuation protocol (documented in `claude-code-hermit:hatch`):
  1. Write `.claude-code-hermit/state/hatch-resume.json` with `{ "skill": "seo-hermit:hatch" }`.
  2. Print: "(If setup doesn't continue automatically when core finishes, re-run `/seo-hermit:hatch`.)"
  3. Invoke `/claude-code-hermit:hatch` **via the Skill tool** — terminal action, stop after the call.
- **no** → stop.

If present but below `1.2.14` (compare major.minor.patch numerically):

> "Base hermit version is {version}; this plugin requires ≥1.2.14. Run `/claude-code-hermit:hermit-evolve` to upgrade, then re-run this hatch."

Stop.

---

## Step 2 — Idempotency check

Read `_hermit_versions["seo-hermit"]` from `.claude-code-hermit/config.json`.

Read `version` from `${CLAUDE_PLUGIN_ROOT}/.claude-plugin/plugin.json`.

If the versions match:

> "seo-hermit {version} is already installed. Reply 'verify' to re-run checks only, or 'full' to re-run the full wizard."

Use `AskUserQuestion`: "(verify / full)"

- **verify** → skip to Step 5.
- **full** → continue from Step 3.

If absent or stale: continue from Step 3.

---

## Step 3 — Credentials + .env verification

**Do NOT `cat`, `grep`, `echo`, or Read the service-account JSON file.** It contains an RSA `private_key`; pulling it into context risks leaking it into session artifacts. Verify the file *exists* only (an `ls <path>` is fine — the path holds no denied substring). The live `check` in Step 5 proves the key actually works. The four `SEO_HERMIT_*` variable names avoid the `TOKEN`/`SECRET`/`API_KEY` deny substrings, so reading `.env` itself with the **Read tool** is safe — but never place a credential value on a Bash command line.

Tell the operator:

> "This plugin needs Google Search Console access and, optionally, a PageSpeed Insights key.
>
> **Search Console (required):**
> 1. In Google Cloud console, create (or pick) a project and **enable the Search Console API**.
> 2. Create a **service account** and download its JSON key.
> 3. Save the key to `.claude.local/gsc-service-account.json` (gitignored local-secrets dir).
> 4. In Search Console, add the service account's `client_email` as a **user** on your property (read access is enough).
>
> **PageSpeed Insights (optional — enables Core Web Vitals checks):**
> - Create an API key in the same Cloud project and enable the PageSpeed Insights API.
>
> Then fill `.env` in the project root:
>
> ```
> SEO_HERMIT_SITE_URL=sc-domain:example.com     # or https://www.example.com/ for a URL-prefix property
> SEO_HERMIT_SITEMAP_URL=https://www.example.com/sitemap.xml
> SEO_HERMIT_GSC_CREDENTIALS=.claude.local/gsc-service-account.json
> SEO_HERMIT_PSI_KEY=                            # optional; leave blank to skip CWV
> ```
>
> Reply 'done' when set, or 'abort' to stop."

Use `AskUserQuestion`: "(done / abort)"

- **abort** → stop.
- **done** → continue.

Use the **Read tool** to read `.env`. Verify `SEO_HERMIT_SITE_URL`, `SEO_HERMIT_SITEMAP_URL`, and `SEO_HERMIT_GSC_CREDENTIALS` are present and non-empty (`SEO_HERMIT_PSI_KEY` may be blank). Confirm the path in `SEO_HERMIT_GSC_CREDENTIALS` exists (existence check only — do not Read it). If anything is missing, report which and loop back to the `AskUserQuestion` above.

---

## Step 4 — Verify consumer .gitignore

Read the consumer's `.gitignore` (this file is not a secret). Check that `.env`, `.env.*`, and `.claude.local/` are present. Append any missing patterns via Edit:

```
.env
.env.*
.claude.local/
```

---

## Step 5 — Live credential check

Run: `bun ${CLAUDE_PLUGIN_ROOT}/scripts/site-api.ts check`

Line 1 is the GSC status; an optional `psi:<status>` line follows when a PSI key is set.

- **`missing`** → a required var is unset or the service-account file is absent/unparseable. Return to Step 3.
- **`invalid`** → credentials were rejected (401/403). Most common cause: the service account's `client_email` has not been added as a user on the Search Console property. Fix that, then re-run.
- **`unreachable`** → the API could not be reached (network/egress blocked). In Docker, verify the DNS allowlist below. Re-run once connectivity is confirmed.
- **`ok`** → continue.

GSC `ok` is **required** to proceed. A `psi:invalid`/`psi:unreachable` line is informational — CWV checks will be skipped until the PSI key works, but hatch continues.

---

## Step 6 — CLAUDE.md / CLAUDE.local.md inject

**Resolve target file:** Read `.claude-code-hermit/state/hatch-options.json`. Use the `"target"` field:
- `"local"` → `target_file = CLAUDE.local.md`
- `"committed"` or absent → `target_file = CLAUDE.md`
- If the file doesn't exist (operator's core hermit predates scope-aware hatch): detect `core_install_scope` from `claude plugin list --json` using the same precedence as core hatch (filter `claude-code-hermit` entries where `enabled == true`; precedence `local` > `project` (both require `projectPath == project root`) > `user` (any `projectPath`) > `null`; map `project` → `committed`, `local`/`user`/`null` → `local`). Ask with `AskUserQuestion` (header: "Visibility") — scope-derived default at position 0 with `(recommended)`: **`.local` files** (gitignored) / **Committed files** (shared). Write the canonical 5-field schema to `.claude-code-hermit/state/hatch-options.json`:

  ```json
  {
    "target": "<choice>",
    "core_install_scope": "<project|local|user|null>",
    "stamped_at": "<current ISO 8601 timestamp with timezone offset>",
    "stamped_by": "seo-hermit:hatch",
    "version": "<current seo-hermit plugin version from ${CLAUDE_PLUGIN_ROOT}/.claude-plugin/plugin.json>"
  }
  ```

Read `target_file`. Search for the opening marker `<!-- seo-hermit: SEO Workflow -->`.

- **`target_file` does not exist** → treat as marker-absent; Edit will create the file.
- **Marker absent** → append the full contents of `${CLAUDE_PLUGIN_ROOT}/state-templates/CLAUDE-APPEND.md` using Edit.
- **Marker present** → skip (up-to-date; `hermit-evolve` handles block replacement on upgrade).

---

## Step 7 — Knowledge-schema extension

Read `.claude-code-hermit/knowledge-schema.md`.

Check for `site-health:` in the file. If absent, append under `## Work Products`:

```
- site-health: weekly site-health report — only the metrics that changed since last run. Producer: seo-hermit:site-health-check routine. location: compiled/site-health-<YYYY-MM-DD>.md
- site-triage: regression-to-commit correlation for a flagged week. Producer: seo-hermit:site-regression-triage. location: compiled/site-triage-<YYYY-MM-DD>.md
- site-fix: record of a drafted mechanical fix (branch, diff summary, approval outcome). Producer: seo-hermit:site-draft-fix. location: compiled/site-fix-<YYYY-MM-DD>.md
```

And under `## Raw Captures`:

```
- site-health-snapshot: assembled weekly snapshot fed to the ledger diff. Retention: 14 days. location: raw/site-health-snapshot-<date>.json
- gsc-search-analytics: raw Search Console rows for the current + prior window. Retention: 14 days. location: raw/gsc-search-analytics-<date>.json
- site-linkcheck: sitemap link-check results. Retention: 14 days. location: raw/site-linkcheck-<date>.json
- site-psi: PageSpeed Insights field/lab metrics per sampled page. Retention: 14 days. location: raw/site-psi-<date>.json
- site-inspect: URL Inspection index-status results for the rotating budget. Retention: 14 days. location: raw/site-inspect-<date>.json
```

Use Edit. Skip if already present (idempotent).

---

## Step 8 — Stamp + register in config.json

Use the `config.json` content loaded in Step 1.

**Stamp version**: set `_hermit_versions["seo-hermit"]` to the plugin version from Step 2.

**Merge routine**: in the `routines` array, check for `id: "site-health-weekly"`. If absent, append it. If present (by `id`), skip — do not clobber operator edits.

```json
{"id": "site-health-weekly", "schedule": "0 8 * * 1", "skill": "seo-hermit:site-health-check", "enabled": true, "run_during_waiting": true}
```

The routine invokes the `site-health-check` skill directly (core `weekly-review` pattern) — no
`prompt_file`. Monday 08:00 in the operator's `config.timezone`.

**Set plugin config**: ensure `config["seo-hermit"]` exists. Ask the operator with `AskUserQuestion`:
"Path to the local clone of this site's source repo? (enables regression→commit correlation and
drafted fixes; leave blank to skip)". Then write:

```json
"seo-hermit": {"site_repo": "<absolute path or null>", "inspect_budget": 20, "link_check_budget": 200}
```

If the key already exists, preserve `site_repo` and any operator-tuned budgets; only fill missing fields.

Write the updated `config.json` via Write tool (full file replacement for valid JSON).

---

## Step 9 — Final report

```
seo-hermit {version} setup complete.

Installation summary:
  ✓ Prerequisite: claude-code-hermit {base_version} confirmed
  ✓ .env: SEO_HERMIT_SITE_URL, SEO_HERMIT_SITEMAP_URL, SEO_HERMIT_GSC_CREDENTIALS present
  ✓ GSC credential check: ok{, PSI: <status> if a key was set}
  ✓ .gitignore: .env and .claude.local/ covered
  ✓ CLAUDE.md: SEO Workflow block injected (or already present)
  ✓ knowledge-schema.md: site-health types added (or already present)
  ✓ config.json: _hermit_versions stamped, site-health-weekly routine registered

Next steps:
  - Restart Claude Code so the updated CLAUDE.md loads.
  - Run /claude-code-hermit:hermit-routines load to activate the weekly site-health check.

Installed skills:
  /seo-hermit:hatch                  — this setup wizard
  /seo-hermit:site-health-check      — weekly deltas-only site-health report (routine: Mon 08:00)
  /seo-hermit:site-regression-triage — correlate a regression with recent site-repo commits
  /seo-hermit:site-draft-fix         — draft a mechanical fix on a branch (approval-gated)

Security reminder: the service-account JSON (in .claude.local/) and the PSI key (in .env)
are local-only credentials. Verify .claude.local/ and .env are gitignored before any git push.
```

---

## Docker network requirements

Read by `/claude-code-hermit:docker-security` when the operator enables LAN containment + DNS policy.

### Domains (DNS allowlist)

- searchconsole.googleapis.com
- googleapis.com  (covers oauth2.googleapis.com, www.googleapis.com, pagespeedonline.googleapis.com)
- the site's own domain (for sitemap fetch + link checking)
