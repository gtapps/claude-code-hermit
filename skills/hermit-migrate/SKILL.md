---
name: hermit-migrate
description: Audit a hermit-backed repo for safe migration to another machine. Classifies files, generates a migration manifest, and produces a verification checklist. Git-first, conservative by default.
---
# Migrate Hermit Repo

Audit the current repo for safe migration to another machine. Produce a classification of files to migrate, a manifest, bootstrap requirements, and a verification checklist.

Git is the source of truth. Migration should be minimal. This skill is read-only — it does not modify files unless you explicitly ask.

## Rules

- Do not write or modify any files unless the operator explicitly requests it
- Classify conservatively: when in doubt, put a file in DO_NOT_MIGRATE or REVIEW_MANUALLY
- Never suggest migrating `.claude/` — it is machine-local, always recreate on destination
- Never suggest migrating runtime state, caches, or ephemeral files
- config.json requires field-level analysis, not just a "review manually" label

## Plan

### 1. Read context

Check if `.claude-code-hermit/` exists. If it doesn't, note in the summary that this repo hasn't been hatched — the hermit state assessment section will be N/A, but the rest of the audit (Git hygiene, ignored files, bootstrap) still applies.

Read the following files if they exist:
- `.claude-code-hermit/config.json`
- `.claude-code-hermit/OPERATOR.md`
- `.claude-code-hermit/HEARTBEAT.md`
- `.claude-code-hermit/IDLE-TASKS.md`
- `.claude/settings.json`
- `.gitignore`

### 2. Git hygiene audit

Run `git status` and `git ls-files` to check:
- Tracked files that should be ignored (secrets, local config, credentials, generated output)
- Missing `.gitignore` rules (patterns that should be excluded but aren't)
- Files that look like secrets or tokens

Note: findings here do not block the migration audit, but they affect the migration risk level.

### 3. Enumerate ignored files

Run: `git ls-files --others --ignored --exclude-standard`

This lists all files git is actively ignoring. These are the candidates for classification.

### 4. Classify ignored files

Skip `.claude-code-hermit/` entries — those are handled in step 5.

Sort each remaining ignored file into one of three buckets:

**MUST_MIGRATE** — portable, required for operation on the destination, not regenerable
**DO_NOT_MIGRATE** — runtime state, caches, build artifacts, machine-local config, secrets, ephemeral files
**REVIEW_MANUALLY** — ambiguous portability: .env variants without clear template policy, local databases, repo-local memory files whose portability is unclear

Apply classification heuristics (see below). For each file include a one-line reason.

### 5. Hermit state assessment

Classify each `.claude-code-hermit/` artifact using the defaults table. For each artifact present, state the classification and why.

For `config.json` specifically, provide field-level analysis:
- **Portable fields** (safe to copy as-is): `agent_name`, `language`, `escalation`, `sign_off`, `idle_behavior`, `idle_budget`, `auto_session`, `ask_budget`, `chrome`, `heartbeat`, `compact`, `env` (most entries), `routines`, `plugin_checks`, `docker`
- **Machine-specific fields** (must be updated on destination): `timezone`, `channels.*.dm_channel_id`, `tmux_session_name`, `permission_mode` — see `docs/config-reference.md` for any fields added since this list was written
- **Note on `channels.*.state_dir`:** If the value is a relative path (e.g. `.claude.local/channels/discord`), it is portable and can be copied as-is. If it is an absolute path (legacy), treat it as machine-specific and update it on the destination.
- Recommend either: copy then edit machine-specific fields, or recreate from `hatch` and manually port identity/behavior settings

### 6. Bootstrap gap review

Inspect setup/context docs if present: README, Makefile, package.json, requirements.txt, pyproject.toml, Cargo.toml, go.mod, Dockerfile, docker-compose.yml, .env.example. Do not force a fixed list — read what exists and is relevant to bootstrap.

Based on these docs, identify what the destination machine must have:
- Required tools and versions (node, python, bun, docker, etc.)
- Required services
- Environment variables expected (check .env.example if present)
- Startup commands that must work on destination

Flag anything that is assumed but not documented.

### 7. Flag .claude/ recreation requirements

`.claude/` is machine-local. Never migrate it. Using `.claude/settings.json` read in step 1, identify what must be recreated manually on the destination:
- Plugin installs (list which plugins are configured)
- Permission grants
- Hooks configuration
- Any other Claude Code local config

State clearly: reinstall and reconfigure on destination, do not copy.

### 8. Generate output report

Produce the report in the format below.

## Output Format

```
## 1. Summary & Verdict

[One paragraph: is this migration straightforward or risky? What does it require beyond `git clone`?]

## 2. Git Hygiene Findings

[List of tracked files that shouldn't be, missing gitignore rules, secrets exposure. "None found" if clean.]

## 3. File Classification

### MUST_MIGRATE
- path/to/file — reason

### DO_NOT_MIGRATE
- path/to/file — reason

### REVIEW_MANUALLY
- path/to/file — reason and what to decide

## 4. Hermit State Assessment

| Artifact | Classification | Guidance |
|----------|---------------|----------|
| OPERATOR.md | MUST_MIGRATE | human-curated, cannot be regenerated |
| ... | ... | ... |

**config.json field breakdown:**
Portable: [list fields present in this config that are safe to copy]
Machine-specific: [list fields that must be updated on destination]
Recommendation: [copy-then-edit or recreate-from-hatch]

## 5. migration-manifest.txt

[Exact content of the manifest — repo-relative paths, one per line, derived from MUST_MIGRATE classifications above]

## 6. Bootstrap / Recreate-on-Destination Requirements

**Tools required:**
- [tool name] [version if known]

**Environment variables:**
- [VAR_NAME] — [source or description]

**Services:**
- [service name]

**.claude/ recreation:**
- Install plugins: [list]
- Re-grant permissions: [what needs approval]
- Reconfigure hooks: [if any]

## 7. Migration Steps

1. On source machine: ensure the working tree is clean — commit or stash before proceeding (`git status`)
2. `git push` to ensure remote is current
3. On destination: `git clone <repo-url>`
4. Copy files from manifest:
   ```
   rsync -av --files-from=migration-manifest.txt /source/path/ user@destination:/dest/path/
   ```
   (Other transport methods work equally well with the same manifest.)
5. On destination: run `/claude-code-hermit:hatch` to initialize hermit state
   - hatch preserves existing OPERATOR.md, config.json, HEARTBEAT.md, IDLE-TASKS.md if present
6. Update machine-specific fields in config.json
7. Reinstall plugins and reconfigure .claude/ (see section 6)
8. Run verification checklist

## 8. Verification Checklist

- [ ] `git status` is clean on destination
- [ ] All MUST_MIGRATE files are present and intact
- [ ] config.json machine-specific fields have been updated
- [ ] Hermit session starts without errors
- [ ] Bootstrap requirements are met (tools, env vars, services)
- [ ] .claude/ is reconfigured (plugins, permissions, hooks)
- [ ] Run a test session to confirm normal operation
```

## Hermit Artifact Defaults

| Artifact | Default | Notes |
|----------|---------|-------|
| `OPERATOR.md` | usually MUST_MIGRATE | human-curated, not regenerable |
| `HEARTBEAT.md` | usually MUST_MIGRATE | operator-customized |
| `IDLE-TASKS.md` | usually MUST_MIGRATE | operator-customized |
| `config.json` | REVIEW_MANUALLY | portable + machine-specific fields mixed — requires field-level analysis |
| `sessions/` | usually DO_NOT_MIGRATE | historical runtime state; operator may choose to archive |
| `proposals/` | usually DO_NOT_MIGRATE | historical; operator may choose to archive |
| `state/` | DO_NOT_MIGRATE | runtime ephemeral |
| `templates/` | DO_NOT_MIGRATE | regenerated by `hatch` |
| `bin/` | DO_NOT_MIGRATE | regenerated by `hatch` |
| `obsidian/` | usually DO_NOT_MIGRATE | unless operator treats it as durable knowledge — signal: obsidian/ has git history (was ever tracked) |
| `.claude/` | recreate locally | machine-local — never migrate |

The "usually" qualifiers matter. Context overrides defaults.

## Classification Heuristics

For files not covered by the defaults above:

**Always DO_NOT_MIGRATE:** build artifacts, caches, logs, lock files, pid files, temp files, node_modules/, vendor/, editor/OS junk, auth credentials, SSH keys, tokens, session exports, browser data.

**REVIEW_MANUALLY when:** `.env` files without a clear template equivalent, SQLite or local database files, hand-maintained local config directories, local seed data, repo-local memory or state files whose portability is unclear.

**MUST_MIGRATE only when:** the file is genuinely portable (no machine-bound paths or credentials), required for the repo to function on destination, and not regenerable from code or `hatch`.

## Notes

- Run `/claude-code-hermit:hatch` on the destination to handle hermit initialization — it preserves OPERATOR.md, config.json, and operator-customized files during re-init
- If the destination has a different plugin version, run `/claude-code-hermit:hermit-evolve` after hatch to apply any upgrade steps
- Dual-machine sync and ongoing state replication are out of scope for this skill
