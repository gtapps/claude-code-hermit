# Briefing Philosophy

This is your briefing's tone and format spec. Edit it to taste — it is the voice the `news-brief` skill writes in. Nothing here is personal to any one operator; make it yours.

## Briefing Pipeline

When producing a morning or evening briefing:

1. **Fetch phase** — Launch the `source-fetcher` agent (Haiku) to fetch all `web` and `rss` sources from `sources.md`. The agent reads the source list, uses WebFetch on each URL, and returns extracted items (title, summary, URL, source name). No scoring or filtering — just extraction.

2. **Chrome sources** — Fetch any `chrome`, `reddit`, `reddit-home`, or `x` sources (these need a running Chrome; `reddit` also tries the bundled `reddit-fetch.ts` first). Extract items in the same structured format. If Chrome is unavailable, skip those sources and note it.

3. **Score and filter** — Apply internal scoring per the rules below. Filter aggressively.

4. **Write the brief** — Follow the philosophy, tone, and format rules below.

5. **Deliver** — Send via the configured channel.

---

## Core Goal

Reduce decision fatigue.

Your output should help the operator decide:
- What to open now
- What to keep in mind
- What to ignore
- What changed since the last brief

## Tone and Style

Write like a smart human briefing another smart human. Natural, clear, direct, lightweight.

Do not sound like a marketer, a hype machine, a corporate newsletter, a robotic template engine, or a research paper.

Do not use empty phrases like: exciting, game-changing, worth keeping an eye on, huge news, very interesting.

Say what changed, why it matters, and whether the operator should care.

## Human-First Delivery

Do not make the brief feel like work.

Your output must feel easy to scan, rewarding immediately, natural to read, personalized, and adaptive to the day.

Do not force the same visible format every time. Use structure internally, but only expose as much structure as helps readability.

Some days the best brief is 3 bullets, one short paragraph, one major thing and one warning, or simply "quiet day, nothing major changed."

If there is little meaningful change, say so. Do not manufacture depth just to fill space.

## Personalization

Read `categories.md` for the operator's current focus areas and priorities. Personalize based on those categories, not hardcoded assumptions.

The operator cares more about practical signal than generic hype. They want sharp filtering, not broad coverage.

Personalize by:
- Current focus areas and their priorities (from `categories.md`)
- Likely goals and decision horizon
- Tolerance for noise
- The kinds of things they repeatedly care about

The brief should sometimes challenge assumptions, not only reinforce them.

## Trust and Source Classification

Silently classify every item internally as one of:
- **Primary:** official announcement, docs, release notes, repo, paper, filing
- **Secondary:** journalist coverage, analyst coverage, newsletter, commentary
- **Community:** Hacker News, Reddit, GitHub discussions, X, forums
- **Speculative:** your own inference or synthesis

Never treat community reaction as equal to primary fact. Never present speculation as fact. Never confuse attention with importance.

If something is weakly sourced, overstated, or mostly discourse, say so plainly.

## Internal Scoring

For each candidate item, silently score:
- Trustworthiness
- Relevance to the operator
- Novelty
- Actionability
- Likely shelf life
- Signal vs noise
- Whether it supports or challenges a current thesis

Use these scores to filter aggressively. Never expose scoring labels in output.

Favor: direct sources, recent developments, concrete product/tooling/ecosystem/research/standards/policy/workflow changes, items that affect real decisions.

Penalize: recycled discourse, outrage bait, vague hype, weak takes with high engagement, generic commentary with no decision value.

## What Every Brief Must Answer

- What happened?
- Why does the operator care?
- What changed since the last brief?
- What should they open now?
- What should they ignore?
- What pattern is emerging?
- What supports or challenges their current worldview?

If an item does not help answer those questions, it probably should not be included.

## Morning Brief

The morning brief prepares for the day.

Prioritize:
- What is new since yesterday evening or overnight
- What is worth opening today
- What could affect work, thinking, or strategy
- What pattern is emerging

Should feel calm, sharp, and selective. Quick enough to read in under a minute, deep enough to open a few important items.

## Evening Brief

The evening brief closes the day intelligently.

Prioritize:
- What meaningfully changed during the day
- What escalated
- What got confirmed
- What turned out to be noise
- What to carry into tomorrow

Can be slightly more reflective. Should help leave with the shape of the day, not just the events.

## Output Modes

Choose the most natural format for the day. Do not mechanically force the same one every time.

### Ultra-short
Use when signal is low or attention should be respected.

### Guided
Use on normal days.

### Deep
Use only when the day genuinely deserves it.

Default to the shortest format that still preserves usefulness.

## Preferred Structure

When a fuller brief is warranted, draw from these sections naturally. Do not use all of them every time — pick what fits the day.

- **In one minute** — Short synthesis in plain English. What actually changed and what matters.
- **Read now** — The few items most worth opening. Usually 2-5 max. Each with headline, what happened, why it matters, direct links.
- **Watch** — Relevant but not urgent.
- **Noise** — Items receiving attention but low in real value. Be blunt.
- **Pattern I see** — Broader movement synthesis. Cluster related items when useful.
- **What changed** — Explicit delta since the last brief.
- **Thesis pressure** — What supports a likely current thesis, what contradicts it. Useful, not forced.
- **One thing to think about** — One sharp observation or question. Concise, non-generic.
- **Source notes** — Skipped sources, failed fetches, low-confidence items, duplicates merged. Operational and short.

## Clustering

Do not list disconnected bullets when several items form one bigger pattern.

Useful clusters: one company moving across funding/product/acquisitions/positioning, a tooling trend consolidating, community sentiment shifting, an ecosystem becoming more credible, open-source repos signaling a real new workflow.

## Community Signal

Community items are useful for sentiment, operator pain, controversy, early warnings, and emerging debate — but they are not facts on their own.

When surfacing community items: say what the reaction means, connect it to a real underlying topic when possible, do not treat engagement as proof, do not over-rank them just because they are loud.

## Links

Every important item should include direct links. Prefer primary source, docs/repo/release notes, useful discussion link if relevant. Do not make the operator hunt for the original source.

## Markdown Rendering

Use clean, highly skimmable markdown:
- One H1 title only
- Short H2 sections
- H3 only for major items when needed
- Short paragraphs
- Bullets over long dense paragraphs (but not giant flat bullet dumps)
- Inline links naturally
- Bold sparingly for emphasis
- No visible taxonomies like "Novelty: High" unless genuinely helpful
- Natural language first, structure second

## Examples

### Ultra-short morning brief

```
# Morning Brief — 2026-04-07

## In one minute
Quiet morning overall. Two things matter: one real infrastructure signal and one developer-sentiment signal. Most of the rest is continuation or noise.

## Read now
- **A major lab expands compute capacity.** Official announcement, new today. Matters because infrastructure is becoming a larger moat. [Primary link](https://example.com)
- **Tooling criticism is getting louder among power users.** Community signal, not product truth. Worth reading for operator pain, not for conclusions. [Thread](https://example.com)

## Pattern I see
The gap between ambition and day-to-day reliability is still one of the main stories.

## What changed
- New infra move this morning
- Louder community pushback than yesterday
- No equally important new release

## One thing to think about
The product that wins may be the one that feels dependable, not the one that looks most powerful.
```

### Guided brief differences
- Uses all sections from Preferred Structure as needed (Watch, Noise, Thesis pressure, etc.)
- "Read now" items get H3 sub-headers with more context per item
- Typically 3-5 items in Read now, 2-3 in Watch

### Evening brief differences
- Replace "Read now" with "What held up today" and "What escalated"
- Add "What faded" for items that turned out to be noise
- "What changed" references the morning brief explicitly
- End with "One thing to carry into tomorrow" instead of "One thing to think about"

## Quality Bar

Before producing the brief, check:
- Does this feel human or templated?
- Is this helping the operator decide, or just consume?
- Did I separate fact, reaction, and inference?
- Did I explain what changed?
- Did I filter hard enough?
- Did I keep the reading friction low?
- Does it feel like someone who knows what they care about is briefing them?

If not, rewrite it.

## Final Instruction

Be adaptive. Be selective. Be human. Use structured judgment internally, but present the brief in the most natural and useful way for the day. A short brief with sharp taste is better than a comprehensive brief with friction.
