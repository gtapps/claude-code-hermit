---
name: cortex-sync
description: Enrich existing hermit content with frontmatter and tags. Scans sessions, proposals, and artifact paths for missing fields, clusters similar files for batch confirmation, then rebuilds Connections.md if the Cortex is set up.
---
# Cortex Sync

Brings existing hermit content up to date with the frontmatter contract. Safe to run multiple times — only touches files that are missing required fields.

## Step 1 — Scan (no writes)

Delegate the gap scan to the built-in `Explore` subagent. Prompt: `Scan and return a JSON object with these keys: sessions_missing_tags (list of .claude-code-hermit/sessions/S-NNN-REPORT.md paths whose YAML frontmatter lacks the tags field), proposals_missing_tags (same for .claude-code-hermit/proposals/PROP-NNN.md), artifacts_missing_frontmatter (paths from .claude-code-hermit/cortex-manifest.json artifact_paths whose files lack title or created), artifacts_missing_tags (artifact files that have frontmatter but no tags), cortex_manifest_configured (false if cortex-manifest.json does not exist or its artifact_paths is empty, otherwise true). Return file paths and counts only — no file bodies.`

Use the returned data to render the operator-facing summary:

```
Cortex sync — gaps found:

  Sessions without tags:              18
  Proposals without tags:              4
  Artifact files without frontmatter:  6
  Artifact files without tags:         3

Proceed? (y/n)
```

If `cortex_manifest_configured` is `false` in the Explore result: include in the summary: "No artifact paths configured — skipping artifact enrichment. Run `/claude-code-hermit:obsidian-setup` to configure."

"Proceed?" is abort-or-continue only — not blanket approval. Each cluster in the following steps still requires its own confirmation. Within each cluster, "skip" skips that cluster only — the skill continues with remaining clusters. If nothing is missing: "All content is up to date. Nothing to do." Stop.

## Step 2 — Enrich artifacts

Handle all artifact files with gaps — both missing frontmatter and missing tags:

**Missing frontmatter** (`title` or `created` absent):
- Read the file content
- Apply the frontmatter contract (Section E of `docs/frontmatter-contract.md`): infer `title` from H1 heading or filename, `created` from git log or file mtime, `source` as `interactive`, propose `tags` from content
- Group files with similar inferred values into clusters and present as a batch:
  > "6 artifact files in relatorios/ look like weekly reports. Apply this frontmatter to all? (confirm/edit/skip)"
- Fall back to per-file confirmation only when confidence is low or files differ significantly

**Has frontmatter but missing `tags`**:
- Read the file content and existing frontmatter
- Propose tags using the current vocabulary (see Step 3 for vocabulary rules)
- Confirm per cluster before writing

## Step 3 — Tag sessions and proposals

Before proposing any tags, delegate the vocabulary scan to the built-in `Explore` subagent. Prompt: `Glob .claude-code-hermit/sessions/S-*-REPORT.md and .claude-code-hermit/proposals/PROP-*.md. Sort each set descending by filename. Read the 5 most recent of each. Extract tags from YAML frontmatter and return a deduplicated array of tag strings with a per-tag frequency count. Omit file bodies.` Use the returned vocabulary to follow the tag discipline rule from CLAUDE-APPEND: reuse existing tags, introduce new ones only when nothing fits, bias toward 1–2 tags per document.

After confirming each cluster, fold the accepted tags into the live vocabulary before proposing the next cluster — tags coined early in the run should be reusable for later clusters.

Cluster by inferred topic rather than confirming one by one:
- Group sessions/proposals by inferred topic (e.g., all "content" work, all "automation" work)
- Present each cluster with its own confirmation:
  > "12 sessions appear to be content-related. Tag all with [content]? (y/edit/skip)"
- Fall back to per-file only for sessions that don't fit a clear cluster

## Step 4 — Rebuild (conditional)

Check whether the Cortex is set up by using `Glob("obsidian/*.md")` — if it returns results, the Cortex is set up.

**If yes:** Run:
```
node ${CLAUDE_PLUGIN_ROOT}/scripts/build-cortex.js .claude-code-hermit obsidian .
```
This regenerates `Connections.md` with the enriched content. `Cortex Portal.md` is a live Dataview template and does not need to be rebuilt.

**If no:** Skip the rebuild and report:
> "Content enriched. Run `/claude-code-hermit:obsidian-setup` to generate Cortex pages."

## Step 5 — Report

```
Cortex sync complete
  Frontmatter added:    6 files
  Artifact files tagged: 3
  Sessions tagged:      18
  Proposals tagged:      4
```
