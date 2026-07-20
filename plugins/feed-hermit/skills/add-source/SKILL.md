---
name: add-source
description: >-
  Interactively add a new source to feed-sources.md with type inference, https and
  name-uniqueness validation, and category checking against feed-categories.md. Appends
  a formatted row to the Active Sources table. Invoke with /feed-hermit:add-source.
---

# Add Source

Add a new entry to `feed-sources.md`, enforcing the correct table format and source type.

## Steps

1. **Collect inputs** — ask the operator for:
   - **Name**: short display name (e.g. "The Daily Dispatch").
   - **URL**: full URL to the source.
   - **Category**: must match one of the categories in `feed-categories.md` — read that file first and present the options.
   - **Type** (optional — infer if not provided):
     - URL contains `reddit.com` → `reddit`
     - URL contains `twitter.com` or `x.com` → `x`
     - URL ends in `.rss`, `.atom`, or `/feed` → `rss`
     - URL is a known WebFetch blocker (a domain that blocks server-side fetch and requires a browser) → `chrome`
     - Otherwise → `web`
   - **Notes** (optional): brief description of what the source covers.

2. **Validate:**
   - URL must start with `https://`.
   - Name must not already exist in `feed-sources.md` — read the file and check.
   - Category must match an existing category from `feed-categories.md`.

3. **Read `feed-sources.md`** to confirm the current table structure, then append the new row under `## Active Sources`:
   ```
   | {Name} | {URL} | {Category} | {Type} | {Notes} |
   ```
   Align columns with the existing table width. Insert alphabetically by Name within the same category, or at the end if unsure.

4. **Confirm** — show the operator the new row before writing. Write only after confirmation.

5. **Note in session** — append to SHELL.md Progress Log: `[HH:MM] Added source: {Name} ({Type}) to {Category}`.

6. **Mention in next brief** — new source additions are mentioned automatically in the next brief (no action needed here).
