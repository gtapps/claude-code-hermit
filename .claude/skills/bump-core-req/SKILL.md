---
name: bump-core-req
description: >
  Updates the minimum core version requirement for a fleet plugin in all three canonical places:
  `required_core_version` and `requires["claude-code-hermit"]` in `hermit-meta.json`, and
  the `dependencies` entry in `plugin.json`. Use this skill whenever the user says
  "bump core requirement", "raise required_core_version", "make <fleet> require core X.Y.Z",
  "update min core for <fleet> plugin", or finishes shipping a core feature that fleet plugins
  need to declare they depend on. Also trigger when the user says "align fleet deps" or asks
  which version the fleet plugins are pinned to and wants to update them.
---

# bump-core-req

Update a fleet plugin's minimum core version in all three canonical locations.

## Background: why three places?

Per this monorepo's conventions (`CLAUDE.md` → Conventions), the core version requirement lives in:
1. `plugins/<slug>/.claude-plugin/hermit-meta.json` → `required_core_version` — **authoritative**, read by `doctor-check.ts` at runtime to detect incompatible siblings
2. `plugins/<slug>/.claude-plugin/hermit-meta.json` → `requires["claude-code-hermit"]` — documentation mirror
3. `plugins/<slug>/.claude-plugin/plugin.json` → `dependencies[name=claude-code-hermit].version` — native Claude Code resolver field

All three must stay in sync. This skill is the single operation that touches all of them atomically. It leaves committing to the operator via `/commit`.

## Usage

```
/bump-core-req <fleet-slug> [version]
```

- `<fleet-slug>` — directory name of the fleet plugin under `plugins/` (e.g. `claude-code-fitness-hermit`)
- `[version]` — optional target version like `1.0.26`. If omitted, read `plugins/claude-code-hermit/.claude-plugin/plugin.json` → `.version` and use that.

## Steps

### Step 0: Resolve slug

If no slug was passed, or it's invalid:

1. Glob `plugins/*/.claude-plugin/plugin.json`. Collect directory names.
2. Remove `claude-code-hermit` from the list — that's core, not a fleet plugin.
3. Ask via `AskUserQuestion`: "Which fleet plugin to update?" with one option per slug.

If `claude-code-hermit` was explicitly passed as slug, abort: "Core doesn't depend on itself — pass a fleet plugin slug."

Validate `plugins/<slug>/.claude-plugin/hermit-meta.json` exists. If not:
> Abort: "`<slug>` has no `hermit-meta.json` — not a fleet plugin or migration is incomplete."

### Step 1: Resolve target version

If version was passed as an argument, strip a leading `v` if present. Validate the result matches `X.Y.Z` (digits only, two dots). If it doesn't match, abort with a clear message.

If no version arg, read `plugins/claude-code-hermit/.claude-plugin/plugin.json` → `.version`. This is the current shipped core version. Report it to the operator: "Autodetected core version: X.Y.Z".

### Step 2: Read current state

Read both files:
- `plugins/<slug>/.claude-plugin/hermit-meta.json`
- `plugins/<slug>/.claude-plugin/plugin.json`

Extract the **current** values of:
- `required_core_version` (from hermit-meta.json) → call this `old_range` (e.g. `>=1.0.22`)
- `requires["claude-code-hermit"]` (from hermit-meta.json) → same value, confirm they match
- `dependencies[name=claude-code-hermit].version` (from plugin.json) → call this `old_dep_ver` (e.g. `^1.0.22`)

Identify the **prefix** on `old_dep_ver`: it's always one of `^`, `~`, `>=`, or exact (no prefix). Preserve it exactly when constructing the new value. The new dep version will be `<prefix>X.Y.Z`.

### Step 3: No-op short-circuit

If all three fields already encode the target version (`old_range == ">=X.Y.Z"` and `old_dep_ver == "<prefix>X.Y.Z"`), print:

> `<slug> already requires core >=X.Y.Z — nothing to do.`

Exit cleanly. No edits made.

### Step 4: Edit the three fields

Do **surgical string replacements** — do not rewrite whole files. Use the `Edit` tool, targeting the exact text you read in Step 2.

**hermit-meta.json** (two replacements):
- Replace `"required_core_version": "<old_range>"` → `"required_core_version": ">=X.Y.Z"`
- Replace `"claude-code-hermit": "<old_range>"` → `"claude-code-hermit": ">=X.Y.Z"`

Both old values will be identical (e.g. `>=1.0.22`), but they appear in different key positions, so the surrounding context makes each Edit unambiguous.

**plugin.json** (one replacement):
- Locate the exact string `"<old_dep_ver>"` that appears as the version value inside the `claude-code-hermit` dependency entry. Because there is exactly one `claude-code-hermit` dependency, replace the precise version string in context. Use enough surrounding text (the `"name": "claude-code-hermit"` line or inline prefix) to make the replacement unambiguous if the version string is short.

New value: `"<prefix>X.Y.Z"` — same prefix, new version.

### Step 5: Verify

Re-read both files and confirm each of the three fields now contains the target version. If any field doesn't match, abort loudly with the field name and what was found vs expected.

Then run plugin validation:
```bash
claude plugin validate plugins/<slug> 2>&1
```
Accept any `Unrecognized keys` warnings (these appear repo-wide due to an ongoing hermit-meta.json migration). Abort on any other error.

### Step 6: Report

Print a concise summary block:

```
Bumped core requirement for <slug>:
  hermit-meta.json  required_core_version : <old_range> → >=X.Y.Z
  hermit-meta.json  requires              : <old_range> → >=X.Y.Z
  plugin.json       dependencies          : <old_dep_ver> → <prefix>X.Y.Z

Next steps:
  Run /commit to stage and commit this change.
  When ready to ship to operators: /release <slug>
```

No version bump, no CHANGELOG entry — those are for `/release` when the operator decides to ship.
