---
name: hermit-scribe
description: File a GitHub issue or post a comment on an existing issue via a GitHub App bot identity. Use when the operator says "file as a GH issue", "open an issue for PROP-NNN", "report this to the tracker", "add a comment to issue #NNN", "comment on #NNN", "reply to issue #NNN", or similar. Requires HERMIT_GH_APP_ID, HERMIT_GH_APP_INSTALL_ID, HERMIT_GH_APP_KEY_FILE in env.
---

# hermit-scribe

Files a GitHub issue or posts a comment on an existing issue via a configured GitHub App bot identity.

## When to activate (filing)

Activate when the operator says:
- "file PROP-NNN as a GH issue"
- "open an issue for this"
- "report this to the tracker"
- "file a GH issue for [description]"

## When to activate (commenting)

Activate when the operator says:
- "add a comment to issue #NNN"
- "comment on #NNN: [text]"
- "reply to issue #NNN"

## How to file

**Step 1: resolve content.**

If the operator named a proposal (`PROP-NNN`):
1. Glob `.claude-code-hermit/proposals/PROP-NNN-*.md` to find the file.
2. Read frontmatter: `id`, `title`, `category`, `session`.
3. Read body sections: `## Context`, `## Problem`, `## Proposed Solution`, `## Impact`.
4. Construct draft title using Conventional Commits format:

   **Pick type** from `category`:
   - `bug` → `fix`
   - `infrastructure`, `investigation` → `chore`
   - `improvement`, `capability`, `routine`, `constraint` → `feat`
   - any other / unknown category → `feat`

   **Pick scope** with this priority:
   1. Read `.claude-code-hermit/config.json` and take the keys of `_hermit_versions` as the recognized slug set. (If config is missing or unreadable, omit scope.)
   2. Scan the raw `title` field from frontmatter and the proposal body (pre-translation) for whole-word occurrences of any slug in the set, or for `plugins/<slug>/` path references where `<slug>` is in the set — not substrings of a path component, URL, or longer identifier. Collect the distinct matched slugs.
      - Exactly one slug → use it.
      - More than one slug → omit scope and stop (do NOT fall through; the signal is present but ambiguous).
   3. If step 2 found **zero** matches, filter the slug set for keys matching `^claude-code-.+-hermit$` excluding `claude-code-hermit`. If exactly one fleet hermit remains → use it.
   4. Otherwise omit scope.

   Strip a leading `claude-code-` from the chosen scope (e.g. `claude-code-homeassistant-hermit` → `homeassistant-hermit`).

   Build: `<type>(<scope>): <title>` if scope present, else `<type>: <title>`.

5. Construct draft body with the four body sections, then append:
   ```
   ---
   *Filed via hermit-scribe · proposal={id} · session={session}*
   ```

For ad-hoc issues (no proposal): use the title and body the operator provides verbatim — no CC type/scope construction.

Then, for both proposal-backed and ad-hoc issues:

**Step 1b: language normalization.**

If the title or body is not already in English, translate to English. Preserve verbatim:
- Technical identifiers (entity IDs, API names, file paths, function names, package names, plugin slugs, repo names)
- Code blocks and command lines
- Frontmatter field names and values
- Proper nouns

Translate prose, headings, and bullet text. Keep the structure (Context / Problem / Proposed Solution / Impact) and section ordering identical to the source.

The proposal file under `.claude-code-hermit/proposals/` is NOT modified — translation applies only to what is sent to GitHub.

**Step 2: dedup check.** (proposal-backed only — skip for ad-hoc issues)

Run:
```bash
node "$CLAUDE_PLUGIN_ROOT/skills/hermit-scribe/file-issue.js" --check {id}
```

- Exit 0 + URL printed → an issue already exists for this proposal. Show the URL to the operator and ask whether to skip filing or proceed anyway.
- Exit 2 → no existing issue. Continue.

**Step 3: sanitize.**

Pass the draft title and body to the `hermit-scribe:issue-sanitizer` subagent:

```
DRAFT_TITLE: {draft title}
DRAFT_BODY:
{draft body}
```

Parse the response: split on the `<<<HERMIT_SCRIBE_BODY>>>` line. Everything before it (after stripping `TITLE: `) is the cleaned title; everything after is the cleaned body.

**Step 4: operator preview.**

Present the post-translation, post-sanitization content to the operator as a **single message** containing, in order:
1. Proposed title
2. Complete issue body — everything that will be written to the issue, including the `---\n*Filed via hermit-scribe...*` footer
3. Confirmation prompt: `File this issue? (yes / edit / cancel)`

If the content exceeds the channel's message-size limit (Discord: 2000 chars), split into multiple messages. The confirmation prompt MUST appear in the FINAL message only — never in the first. Do NOT replace the body with placeholders like "(see below)" — inline the full body.

Wait for the operator's response.
- On `cancel`: abort.
- On `yes`: proceed to Step 5.
- On `edit`: ask the operator what to change (e.g. "title", a specific body section, or a free-text correction). Apply the requested edit, re-render the preview from the start of Step 4, and ask again. Loop until `yes` or `cancel`.

**Step 5: write title and body to temp files.**

Run `mktemp -d` and capture the path it prints to stdout (something like `/tmp/tmp.AbCdEf`). Shell state does not persist between Bash tool calls, so record the exact path from the output before using the Write tool.

Use the Write tool to create two files inside that directory:
- `/tmp/tmp.AbCdEf/title` — the cleaned issue title (single line, no markdown formatting).
- `/tmp/tmp.AbCdEf/body.md` — the cleaned issue body markdown.

**Step 6: run the script.**

Substitute the same path from step 5:

```bash
node "$CLAUDE_PLUGIN_ROOT/skills/hermit-scribe/file-issue.js" /tmp/tmp.AbCdEf/title /tmp/tmp.AbCdEf/body.md
```

Capture stdout: it is the issue URL on success. Stderr has any error message.

**Step 7: back-write and report.**

On success:
1. Use the Edit tool to insert `gh_issue: {url}` into the proposal's YAML frontmatter, on a new line directly after the `id:` field. Skip this step for ad-hoc issues (no proposal file).
2. Output `Filed: {url}`.

On error, surface the stderr. Common causes:
- `HERMIT_GH_APP_KEY_FILE='...' does not exist` → key file path is wrong or file is missing — check `.env`.
- `GH 401: Bad credentials` → wrong App ID, install ID, or key file.
- `GH 404` → App not installed on target repo, or repo name typo.
- `GH 422` → empty title or GH validation error.

## How to comment

**Step 1: resolve content.**

Use the body the operator provides verbatim. No proposal lookup, no CC title construction, no frontmatter fields.

**Step 1b: language normalization.**

Same rules as filing — translate prose to English, preserve identifiers/code/paths/proper nouns unchanged.

**Step 2: sanitize.**

Pass the draft body to the `hermit-scribe:issue-sanitizer` subagent with a placeholder title:

```
DRAFT_TITLE: (issue comment)
DRAFT_BODY:
{draft body}
```

Parse the response as usual (split on `<<<HERMIT_SCRIBE_BODY>>>`). Use only the cleaned body; discard the returned title.

**Step 3: operator preview.**

Present the post-sanitization content as a **single message** containing, in order:
1. Target: `Issue #NNN`
2. Complete comment body — everything that will be posted
3. Confirmation prompt: `Post this comment? (yes / edit / cancel)`

If the content exceeds the channel's message-size limit (Discord: 2000 chars), split into multiple messages. The confirmation prompt MUST appear in the FINAL message only.

Wait for the operator's response.
- On `cancel`: abort.
- On `yes`: proceed to Step 4.
- On `edit`: ask what to change, apply the correction, re-render from the top of Step 3. Loop until `yes` or `cancel`.

**Step 4: write body to temp file.**

Run `mktemp -d` and capture the path. Use the Write tool to create:
- `/tmp/tmp.AbCdEf/body.md` — the cleaned comment body.

**Step 5: run the script.**

```bash
node "$CLAUDE_PLUGIN_ROOT/skills/hermit-scribe/file-issue.js" --comment {issue-number} /tmp/tmp.AbCdEf/body.md
```

Capture stdout: it is the comment URL on success. Stderr has any error message.

**Step 6: report.**

On success: output `Commented: {url}`. No back-write to any proposal frontmatter.

On error, surface the stderr (same causes as filing: missing key file, bad credentials, 404, 422).

## Notes

- `HERMIT_GH_REPO` overrides the default target (`gtapps/claude-code-hermit`).
- If the operator overrides the dedup check and re-files the same proposal, `gh_issue` in the frontmatter is overwritten with the new URL (latest wins).
- Comments skip the dedup check by design — there is no uniqueness constraint on comments.
- The `issue-sanitizer` subagent strips anything personal or specific to the operator's machine and project unless it's clearly part of an upstream hermit plugin. It does not edit for style or clarity — only for privacy.
