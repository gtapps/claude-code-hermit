---
name: smoke-test
description: Post-hatch validation — checks config, OPERATOR.md, plugin references, routines, and optionally sends a channel test message. Run after hatch to verify setup.
---
# Smoke Test

Validate the post-hatch setup. Produces a structured report with PASS/WARN/FAIL per check.

## Plan

### 1. Initialize counters

Track `passed`, `warnings`, `failures` counts. Collect output lines for the final report.

### 2. Config validation

- Read `.claude-code-hermit/config.json`
  - If missing or invalid JSON: **FAIL** `config.json missing or invalid`
  - If valid: **PASS** `config.json parsed`
- Read `${CLAUDE_PLUGIN_ROOT}/.claude-plugin/plugin.json` to get the current plugin version
- Compare `config._hermit_versions["claude-code-hermit"]` with the plugin version
  - Match: **PASS** `version matches plugin (X.Y.Z)`
  - Mismatch: **WARN** `config version X.Y.Z != plugin X.Y.Z — run /claude-code-hermit:hermit-evolve`
- Check required top-level keys exist: `agent_name`, `channels`, `env`, `heartbeat`
  - Each missing key: **FAIL** `missing required key: <key>`

### 3. OPERATOR.md sanity

- Check if `.claude-code-hermit/OPERATOR.md` exists
  - Missing: **WARN** `OPERATOR.md missing — run hatch or create manually`
  - Empty: **WARN** `OPERATOR.md is empty — fill in project context`
- If exists and non-empty:
  - Check for `{{` placeholder patterns (NOT `<!--` which are legitimate HTML comments)
    - Found: **WARN** `OPERATOR.md contains unfilled {{ placeholders`
    - Not found: **PASS** `OPERATOR.md readable`

### 4. Plugin check references

- Read `plugin_checks` array from config.json
- For each entry:
  - Extract the plugin name and skill name from the `skill` field (format: `/plugin:skill-name` or `plugin:skill-name`)
  - Check if the skill directory exists at `${CLAUDE_PLUGIN_ROOT}/../<plugin>/skills/<skill-name>/SKILL.md`
  - Exists: **PASS** `plugin_checks[N]: <id> resolves`
  - Missing: **WARN** `plugin_checks[N]: skill not found at <path> — may be installed globally` (sibling directory layout is not guaranteed for marketplace installs)

### 5. Routine validation (static)

- Read `routines` array from config.json
- For each routine:
  - Check required keys (`id`, `time`, `skill`, `enabled`): **FAIL** per missing key
  - Validate `time` matches `^\d{2}:\d{2}$` and hours 00-23, minutes 00-59: **FAIL** with expected format
  - Validate `skill` contains `:` (plugin:skill-name format): **FAIL** with expected format
  - **PASS** `routine "<id>" valid (<time>, <skill>)`
- Check for duplicate routine IDs: **WARN** per duplicate

### 6. State file validation

Template defaults: `${CLAUDE_PLUGIN_ROOT}/state-templates/` — `alert-state.json.template`, `micro-proposals.json.template`.

For each file: parse JSON. If missing or unparseable, rewrite from the corresponding template. If parseable but wrong shape, repair in place — backfill missing keys from template defaults, overwrite keys that exist with the wrong type, preserve all other existing data. Emit one **WARN** per file that needed repair (noting what was fixed), or **PASS** if valid.

- **`.claude-code-hermit/state/alert-state.json`** — object with: `alerts` (object), `self_eval` (object), `total_ticks` (number), `last_digest_date` (any, presence required)
  - For each missing or wrong-type key: overwrite with template default (e.g. `alerts: {}`, `self_eval: {}`, `total_ticks: 0`, `last_digest_date: null`) → **WARN** `alert-state.json repaired: <keys>`

- **`.claude-code-hermit/state/micro-proposals.json`** — object with `active` key present (any value)
  - Missing `active` key: add `"active": null` → **WARN** `micro-proposals.json missing active key — backfilled`

### 7. Channel test (optional)

- Check if any channels are configured and enabled in config.json
- If no channels: skip silently
- If channels configured:
  - For each enabled channel, attempt to send a test message via the channel's MCP tool:
    - Discord: use the Discord MCP send tool
    - Telegram: use the Telegram MCP send tool
  - Message content: `"Smoke test — channel is working."` (include agent name if configured)
  - Success: **PASS** `<channel> test message sent`
  - Failure: **FAIL** `<channel> test message failed: <error>`
  - If the MCP tool is not available (plugin not installed): **WARN** `<channel> plugin not available for test`

### 8. Print report

Output each check result as exactly one line:

```
PASS  config.json parsed and version matches plugin (0.3.4)
WARN  OPERATOR.md contains unfilled {{ placeholders
WARN  plugin_checks[0]: skill not found at ../claude-code-setup/skills/claude-automation-recommender — may be installed globally
PASS  routine "heartbeat-restart" valid (04:00, claude-code-hermit:heartbeat start)
PASS  routine "morning" valid (08:30, claude-code-hermit:brief --morning)
FAIL  routine "bad" has invalid time "25:00" — must be HH:MM (00:00-23:59)
```

Summary line at end:

```
Smoke test: 4 passed, 1 warning, 1 failed
```

For each **FAIL**, include a remediation hint on the same line or the line after.
