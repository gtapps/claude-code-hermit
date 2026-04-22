---
name: reflect-scheduled-checks
description: Standalone routine skill for interval-triggered scheduled checks. Runs one due check, gates findings through reflection-judge + proposal-triage, applies state, and logs. Run as a daily routine — not called by reflect.
---
# Reflect Scheduled Checks

Standalone routine skill. Runs at most one due interval-triggered scheduled check per invocation, gates any findings through the normal proposal pipeline, applies state, and appends a Progress Log entry. Invoked by the `scheduled-checks` routine (daily, offset from reflect).

## What counts as a scheduled check

Any skill registered in `config.scheduled_checks` that satisfies this contract:

- **Idempotent** — running twice in a row is safe.
- **Returns findings or nothing** — either a concrete actionable/contextual observation, or silence.
- **No self-scheduling** — cadence is owned by `scheduled_checks.interval_days`.
- **Short-running, read-mostly** — does not block or produce side effects on success.

## Steps

### 1. Load context

Read `config.json → scheduled_checks` (filter to `enabled: true`, `trigger: "interval"`).

Read `state/reflection-state.json → scheduled_checks` (per-check state: `last_run`, `last_unavailable_at`, `last_error_at`, `consecutive_empty`).

### 2. Filter due checks

From the enabled interval entries, keep those where:
- `last_run` is null or older than `interval_days` days, AND
- `last_unavailable_at` is null or older than **4 hours** (transient cooldown — skill may have been briefly unavailable), AND
- `last_error_at` is null or older than `interval_days` days (persistent back-off for true errors)

### 3. Pick one

Select the entry with the oldest `last_run` (null sorts first). If none are due, skip to the Progress Log (§ 7) with outcome `skipped`.

### 4. Invoke

Invoke the `skill` command string as-is, using the `Skill` tool. Do not "verify installation" first — the harness's loaded-skills list (shown in system-reminders) is authoritative. In particular, **never grep `~/.claude/plugins/cache/` or any plugin directory to check whether a plugin is installed** — the cache layout is `cache/<marketplace>/<plugin>/`, not `cache/<plugin>/`, and assumption-based path checks have produced false-negative `unavailable` outcomes.

Classify the result:

- The skill name is not present in the available-skills list, or the `Skill` tool rejects it as unknown → `outcome: unavailable`
- The skill runs but errors or times out → `outcome: error`
- The skill runs to completion → evaluate the output (step 5)

### 5. Evaluate

- Actionable improvement found → `outcome: actionable`, summarize finding
- Context improvement (e.g., CLAUDE.md fix) → `outcome: contextual`, summarize finding; apply directly if trivial
- Nothing found → `outcome: empty`

### 6. Act on outcome

**`actionable` / `contextual`:**

Pass through the Evidence Validation gate:

```
Candidate: <title derived from finding>
Tier: 1
Evidence Source: scheduled-check/<id>
Evidence: <one-paragraph summary>
Sessions: none
```

Delegate to `claude-code-hermit:reflection-judge`. On ACCEPT (scheduled-check) or DOWNGRADE, proceed to `claude-code-hermit:proposal-triage` with:

```
Title: <title>
Evidence Source: scheduled-check/<id>
Evidence: <summary>
```

- Triage `CREATE` → classify tier. Tier 1/2: queue micro-approval (§ Micro-approval queuing). Tier 3: call `/claude-code-hermit:proposal-create` directly.
- Triage `SUPPRESS` or `DUPLICATE` → drop silently; note in SHELL.md Progress Log.

On SUPPRESS from reflection-judge → drop silently.

**`empty`:**

No proposal candidate. Increment `consecutive_empty` counter in state (§ State update). Check interval-adjustment logic (§ Interval adjustment proposals).

**`unavailable`:**

Note in SHELL.md `## Findings`: `Scheduled check skipped: <id> — skill unavailable (cooldown 4h)`. No candidate.

**`error`:**

Note in SHELL.md `## Findings`: `Scheduled check error: <id> — retrying after interval_days`. No candidate.

**`skipped`:** No action except Progress Log.

### Micro-approval queuing

Every micro-proposal question must include: **[observed pattern + duration] + [consequence] + [exact proposed change] + "Yes / No"**

Queuing procedure:
1. Generate ID: `MP-YYYYMMDD-N` where N increments within the same day (0, 1, 2). Check existing `micro-queued` events in `proposal-metrics.jsonl` for today to determine N.
2. Append `micro-queued` event to `proposal-metrics.jsonl` first (so a partial failure leaves a recoverable orphaned event, not a silent ghost entry):
   ```bash
   node ${CLAUDE_PLUGIN_ROOT}/scripts/append-metrics.js \
     .claude-code-hermit/state/proposal-metrics.jsonl \
     '{"ts":"<now ISO>","type":"micro-queued","micro_id":"MP-YYYYMMDD-N","tier":1,"question":"<full question text>"}'
   ```
3. Read `state/micro-proposals.json`. Append a new entry to `pending` with `id: "MP-YYYYMMDD-N"`, `tier: <1|2>`, `status: "pending"`, `follow_up_count: 0`, `ts: "<now ISO>"`, `question: "<full question text>"`. Write the file.
4. Notify the operator with the question.

### Interval adjustment proposals

Using the current `consecutive_empty` value (after update in § State update):

**Reset rules:**
- `empty` outcome → `consecutive_empty += 1`
- `actionable` / `contextual` outcome → `consecutive_empty = 0`
- Interval-increase proposal accepted or dismissed → reset to 0

**Proposals (standard Three-Condition Rule, not tagged `scheduled-check`):**
- **3+ consecutive empty runs** → create a proposal to increase `interval_days` (e.g., 7 → 14). Three occurrences = repeated pattern; high interval_days means the check never fires usefully = meaningful consequence; operator approves the config change = actionable. Pass through `claude-code-hermit:proposal-triage` before creating.
- **3+ actionable findings in a single run** → not applicable (one check per invocation by design).

Adjustments always go through PROP-NNN — this skill never auto-adjusts.

### 7. State update

Write the state delta directly to `state/reflection-state.json → scheduled_checks.<id>`:

```bash
node -e "
const fs=require('fs');
const f='.claude-code-hermit/state/reflection-state.json';
try {
  const s=JSON.parse(fs.readFileSync(f,'utf-8'));
  if(!s.scheduled_checks) s.scheduled_checks={};
  const id='<check-id>';
  if(!s.scheduled_checks[id]) s.scheduled_checks[id]={};
  const c=s.scheduled_checks[id];
  // Set fields according to outcome — only set fields that should change
  // outcome=unavailable: c.last_unavailable_at='<ISO>'; (leave last_run unchanged)
  // outcome=error:       c.last_error_at='<ISO>'; (leave last_run unchanged)
  // outcome=empty:       c.last_run='<ISO>'; c.consecutive_empty=<prior+1>;
  // outcome=actionable|contextual: c.last_run='<ISO>'; c.consecutive_empty=0;
  fs.writeFileSync(f, JSON.stringify(s,null,2)+'\n','utf-8');
} catch(e){ process.stderr.write('scheduled-checks state: '+e.message+'\n'); }
"
```

Substitute the actual `id`, ISO timestamp, and field assignments for the current outcome before running. Always exits cleanly — a failed write is logged to stderr only.

### 8. Progress Log Entry (always)

Append one line to `.claude-code-hermit/sessions/SHELL.md` under `## Progress Log`:

`[HH:MM] scheduled-checks — <id>: <outcome>; verdicts: accept=A downgrade=D suppress=S; outcome: <none|micro-queued|proposal-created|interval-proposal>`

Use `skipped` for the id field and `skipped` for outcome when no check was due.
