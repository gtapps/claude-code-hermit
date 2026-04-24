# Plugin Hermit Storage Convention

Plugin hermits must store all domain artifacts in exactly two directories:

- `.claude-code-hermit/raw/` — ephemeral inputs (fetched content, snapshots, logs, API dumps).
- `.claude-code-hermit/compiled/` — durable outputs (briefings, digests, assessments, audit results).

Everything else is infra managed by the base hermit (`state/`, `sessions/`, `proposals/`, `templates/`, operator-curated docs). Plugins don't add new directories.

## Why these two and nothing else

The `compiled/` directory is scanned at session start to inject foundational context. `scripts/archive-raw.js` and the weekly review run retention only against `raw/`. Anything outside these two paths is invisible to both mechanisms — your audits won't surface at session start, and your snapshots will never be archived.

This mirrors the Karpathy raw-vs-compiled split: raw is the immutable ground truth, compiled is the LLM-maintained derivative. The filesystem layout is fixed; the `type` field in frontmatter is what differentiates work products within each directory.

## File naming

Use flat filenames inside each directory. The pattern is:

```
raw/<type>-<slug>-<date>.md
compiled/<type>-<slug>-<date>.md
```

Examples:
```
raw/snapshot-home-2026-04-17.md
raw/source-ha-sensors-2026-04-17.md
compiled/audit-kitchen-2026-04-17.md
compiled/briefing-home-2026-04-17.md
```

**No subdirectories inside `raw/` or `compiled/`.** The `type` field in frontmatter is the discriminator — never a folder. The only exception is `raw/.archive/`, which is managed automatically by the weekly review.

## Required frontmatter

Every artifact must carry frontmatter:

```yaml
---
title: Home Sensors Snapshot
type: snapshot          # matches knowledge-schema.md entry
created: 2026-04-17T09:00:00-03:00
tags: [home, sensors]
---
```

Inside a session add `session: S-NNN`, and cite the artifact from the session report's `## Artifacts` section so the next session's `startup-context.js` injection surfaces it. For compiled artifacts, add a `source:` citation pointing to the raw artifact(s) they were derived from:

```yaml
source: raw/snapshot-home-2026-04-17.md
```

Tag compiled artifacts `foundational` to pin them to every session start regardless of age.

Artifacts without frontmatter appear as "Unlinked" in the Cortex. See `docs/frontmatter-contract.md` for the full contract.

## Handling large artifact volumes

If a hermit produces many artifacts of the same type (per-room audits, per-account snapshots):

- **Write a rollup digest** to `compiled/` and the per-entity raw data to `raw/`. One `compiled/audit-home-2026-04-17.md` covering all rooms beats 10 per-room files bloating session context.
- Let retention do the work: raw snapshots expire per `knowledge.raw_retention_days` and land in `raw/.archive/`. The compiled digest survives.
- If the rollup is too coarse, use tags (e.g. `tags: [kitchen, audit]`) to let Cortex filter — not subdirectories.

## Compliant vs non-compliant paths

| Path | Status | Reason |
|------|--------|--------|
| `.claude-code-hermit/raw/snapshot-home-2026-04-17.md` | ✅ | correct location, flat |
| `.claude-code-hermit/compiled/audit-kitchen-2026-04-17.md` | ✅ | correct location |
| `.claude-code-hermit/compiled/briefing-ha-2026-04-17.md` | ✅ | use `type: briefing` in frontmatter |
| `.claude-code-hermit/raw/audits/latest.md` | ❌ | subfolder inside `raw/` — invisible to archive-raw.js |
| `.claude-code-hermit/audits/` | ❌ | new top-level folder — not scanned at session start |
| `audits/` (repo root) | ❌ | completely outside hermit state |
| `reports/` (repo root) | ❌ | same — outside hermit state |
| `memory/` (inside `.claude-code-hermit/`) | ❌ | base hermit infra — plugins don't add top-level dirs |

## Declare your types in knowledge-schema.md

Every artifact type a plugin produces must appear in `knowledge-schema.md`:

```markdown
## Work Products
- audit: room-by-room issue list produced by the weekly home scan.
  Triggered by `ha-audit` routine. Format: bullet list per room.
  Location: compiled/audit-<slug>-<date>.md

## Raw Captures
- snapshot: Home Assistant sensor dump. Feeds the audit work product.
  Location: raw/snapshot-<slug>-<date>.md. Retained 3 days.
```

This is the behavioral contract operators read to understand what the hermit does automatically.

## Reviewer checklist

When reviewing a plugin hermit for storage compliance, run these checks:

1. **Grep for non-compliant write paths** in skills and agents:
   ```
   grep -r "audits/\|reports/\|reviews/\|statements/\|relatorios/\|tmp/\|memory/" skills/ agents/
   grep -r "raw/[a-zA-Z].*/" skills/ agents/   # catches raw/<subdir>/
   ```
2. **Check for repo-root folders** that shouldn't exist (anything that isn't hermit infra):
   ```
   ls -d */ | grep -vE '^(skills|agents|hooks|scripts|docs|state-templates|tests|\.claude-plugin|\.git)/'
   ```
3. **Verify every write path in skills/agents ends in `raw/` or `compiled/`** — not a subdir.
4. **Check `knowledge-schema.md`** in the target project has entries for every type the plugin writes.
5. **Check frontmatter** on a sample of produced artifacts — all required fields present.

## Migrating a non-compliant plugin

1. Identify all ad-hoc folders and their contents (one grep pass with the checklist above).
2. For each artifact:
   - If it's a domain input → move to `raw/<type>-<slug>-<date>.md`, add frontmatter.
   - If it's a domain output → move to `compiled/<type>-<slug>-<date>.md`, add frontmatter, cite source.
3. Update every skill and agent that referenced the old path.
4. Update `knowledge-schema.md` to declare the types.
5. Delete the empty old folders.
6. Run a final checklist pass to confirm nothing points at the old paths.
