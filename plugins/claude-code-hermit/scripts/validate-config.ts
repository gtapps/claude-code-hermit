import fs from 'node:fs';
import path from 'node:path';
import { safeForLLM } from './lib/sanitize';

type Json = any;

/**
 * PostToolUse hook — validates config.json after any Edit/Write to it.
 * Checks required keys, types, routine time formats, and channel structure.
 * Exit 2 = validation failed, surface errors to agent.
 */

const MAX_STDIN = 64 * 1024;

const REQUIRED_KEYS: Record<string, string[]> = {
  'agent_name': ['string', 'null'],
  'language': ['string', 'null'],
  'timezone': ['string', 'null'],
  'escalation': ['string'],
  'channels': ['object'],
  'env': ['object'],
  'heartbeat': ['object'],
  'routines': ['array'],
  'quality_gate': ['object'],
};

const VALID_ESCALATION = ['conservative', 'balanced', 'autonomous'];
const VALID_QUALITY_GATE_TIER = ['budget', 'balanced', 'quality'];
const VALID_ROUTINE_MODEL = ['opus', 'sonnet', 'haiku'];
const VALID_IDLE_BEHAVIOR = ['wait', 'discover'];
const VALID_BUDGET_ACTION = ['alert', 'pause'];
const VALID_TELEMETRY_DEST = ['webhook'];
const TIME_RE = /^\d{2}:\d{2}$/;
const ENV_VAR_RE = /^[A-Z_][A-Z0-9_]*$/;
// Routine ids travel in bracket markers, --ids CSVs, and JSONL output — shared with routine-due.ts.
const ROUTINE_ID_RE = /^[A-Za-z0-9._-]{1,64}$/;

/** True for loopback hosts (localhost/127.0.0.1/::1) where a plaintext bearer token stays on-box. */
function isLoopbackUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname;
    return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]';
  } catch {
    return false;
  }
}

// --- Cron validation (5-field: minute hour dom month dow) ---
function parseCronField(token: string, lo: number, hi: number): Set<number> {
  const values = new Set<number>();
  for (const part of token.split(',')) {
    if (!part) throw new Error('empty segment in list');
    if (part.includes('/')) {
      const [base, stepStr] = part.split('/', 2);
      const step = Number(stepStr);
      if (!Number.isInteger(step) || step <= 0) throw new Error(`zero or invalid step: ${part}`);
      let start: number, end: number;
      if (base === '*') { start = lo; end = hi; }
      else if (base.includes('-')) { [start, end] = base.split('-', 2).map(Number); }
      else { start = Number(base); end = hi; }
      if (!Number.isInteger(start) || !Number.isInteger(end)) throw new Error(`non-numeric: ${part}`);
      if (start < lo || end > hi || start > end) throw new Error(`out of range or reverse: ${part}`);
      for (let i = start; i <= end; i += step) values.add(i);
    } else if (part.includes('-')) {
      const [a, b] = part.split('-', 2).map(Number);
      if (!Number.isInteger(a) || !Number.isInteger(b)) throw new Error(`non-numeric range: ${part}`);
      if (a < lo || b > hi || a > b) throw new Error(`out of range or reverse range: ${part}`);
      for (let i = a; i <= b; i++) values.add(i);
    } else if (part === '*') {
      for (let i = lo; i <= hi; i++) values.add(i);
    } else {
      const v = Number(part);
      if (!Number.isInteger(v) || v < lo || v > hi) throw new Error(`value ${part} out of range [${lo},${hi}]`);
      values.add(v);
    }
  }
  return values;
}

function validateCronSchedule(schedule: string): string | null {
  if (schedule.startsWith('@')) return 'macros not supported';
  const fields = schedule.split(/\s+/);
  if (fields.length !== 5) return `expected 5 fields, got ${fields.length}`;
  for (const f of fields) {
    if (/[a-zA-Z]/.test(f)) return `named values not supported: ${f}`;
  }
  try {
    parseCronField(fields[0], 0, 59);
    parseCronField(fields[1], 0, 23);
    parseCronField(fields[2], 1, 31);
    parseCronField(fields[3], 1, 12);
    parseCronField(fields[4], 0, 7);
  } catch (e: any) {
    return e.message;
  }
  const domRestricted = fields[2] !== '*';
  const dowRestricted = fields[4] !== '*';
  if (domRestricted && dowRestricted) return 'both DOM and DOW restricted — not supported in v1';
  return null;
}

function validate(config: Json): { errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];

  for (const [key, types] of Object.entries(REQUIRED_KEYS)) {
    if (!(key in config)) {
      errors.push(`Missing required key: ${key}`);
      continue;
    }
    const val = config[key];
    const actualType = val === null ? 'null' : Array.isArray(val) ? 'array' : typeof val;
    if (!types.includes(actualType)) {
      errors.push(`${key}: expected ${types.join('|')}, got ${actualType}`);
    }
  }

  if (config.escalation && !VALID_ESCALATION.includes(config.escalation)) {
    errors.push(`escalation: "${config.escalation}" not in [${VALID_ESCALATION.join(', ')}]`);
  }

  if (config.remote !== undefined && typeof config.remote !== 'boolean') {
    errors.push(`remote: expected boolean, got ${typeof config.remote}`);
  }

  if (config.idle_behavior !== undefined && config.idle_behavior !== null) {
    if (!VALID_IDLE_BEHAVIOR.includes(config.idle_behavior)) {
      errors.push(`idle_behavior: "${config.idle_behavior}" not in [${VALID_IDLE_BEHAVIOR.join(', ')}]`);
    }
  }

  // permission_mode's valid set is Claude Code's, not the hermit's — hermit-start.ts
  // warns-and-falls-back on unknown values at runtime rather than hard-failing, so
  // only type-check here; an enum would reject values Claude Code adds later.
  if (config.permission_mode !== undefined && config.permission_mode !== null) {
    if (typeof config.permission_mode !== 'string') {
      errors.push(`permission_mode: expected string, got ${typeof config.permission_mode}`);
    }
  }

  if (config.quality_gate && typeof config.quality_gate === 'object' && config.quality_gate.tier !== undefined) {
    if (!VALID_QUALITY_GATE_TIER.includes(config.quality_gate.tier)) {
      errors.push(`quality_gate.tier: "${config.quality_gate.tier}" not in [${VALID_QUALITY_GATE_TIER.join(', ')}]`);
    }
  }

  if (Array.isArray(config.routines)) {
    const ids = new Set();
    config.routines.forEach((r: Json, i: number) => {
      if (!r.id) errors.push(`routines[${i}]: missing id`);
      else if (!ROUTINE_ID_RE.test(r.id)) {
        errors.push(`routines[${i}]: id "${r.id}" must match ^[A-Za-z0-9._-]{1,64}$ — routine ids travel in bracket markers, --ids CSVs, and JSONL output`);
      }
      if (!r.skill) errors.push(`routines[${i}]: missing skill`);
      if (r.time !== undefined) {
        errors.push(`routines[${i}]: legacy "time" field found — migrate to "schedule" (5-field cron)`);
      }
      if (r.days !== undefined) {
        errors.push(`routines[${i}]: legacy "days" field found — migrate to "schedule" (5-field cron)`);
      }
      if (!r.schedule) {
        errors.push(`routines[${i}]: missing schedule`);
      } else {
        const cronErr = validateCronSchedule(r.schedule);
        if (cronErr) {
          errors.push(`routines[${i}]: invalid schedule "${r.schedule}" — ${cronErr}`);
        }
      }
      if (typeof r.enabled !== 'boolean') {
        warnings.push(`routines[${i}]: "enabled" should be boolean`);
      }
      if (r.id && ids.has(r.id)) {
        warnings.push(`routines[${i}]: duplicate id "${r.id}"`);
      }
      if (r.id) ids.add(r.id);
      if (r.model !== undefined && r.model !== null) {
        if (typeof r.model !== 'string' || !VALID_ROUTINE_MODEL.includes(r.model)) {
          errors.push(`routines[${i}]: model "${r.model}" not in [${VALID_ROUTINE_MODEL.join(', ')}] (omit to use session model)`);
        } else if (r.id === 'heartbeat-restart') {
          warnings.push(`routines[${i}]: model on "heartbeat-restart" is ignored — re-arm must run in the session`);
        }
      }
    });
  }

  if (config.channels && typeof config.channels === 'object') {
    for (const [name, ch] of Object.entries<Json>(config.channels)) {
      // channels.primary is a magic string key (preferred-channel pointer), not a
      // channel-config object. Skip object-shape validation here; the primary-specific
      // checks below handle it.
      if (name === 'primary') continue;
      if (typeof ch !== 'object' || ch === null) {
        errors.push(`channels.${name}: must be an object`);
        continue;
      }
      if (ch.allowed_users !== undefined) {
        if (!Array.isArray(ch.allowed_users)) {
          errors.push(`channels.${name}.allowed_users: must be an array`);
        } else if (!ch.allowed_users.every((u: unknown) => typeof u === 'string')) {
          errors.push(
            `channels.${name}.allowed_users: every entry must be a string (a numeric ID breaks the string-based sender allow-list check)`,
          );
        }
      }
      if (ch.dm_channel_id !== undefined && ch.dm_channel_id !== null && typeof ch.dm_channel_id !== 'string') {
        errors.push(`channels.${name}.dm_channel_id: must be string or null`);
      }
    }
    if (config.channels.primary !== undefined) {
      const primary = config.channels.primary;
      if (typeof primary !== 'string') {
        errors.push('channels.primary: must be a string channel name');
      } else {
        const referenced = config.channels[primary];
        if (referenced === undefined) {
          errors.push(`channels.primary: references unknown channel "${primary}"`);
        } else if (typeof referenced !== 'object' || referenced === null || Array.isArray(referenced)) {
          errors.push(`channels.primary: "${primary}" must reference a channel-config object`);
        }
      }
    }
  }

  if (config.heartbeat && typeof config.heartbeat === 'object') {
    const hb = config.heartbeat;
    if (typeof hb.enabled !== 'boolean') {
      warnings.push('heartbeat.enabled: should be boolean');
    }
    if (hb.active_hours && typeof hb.active_hours === 'object') {
      const { start, end } = hb.active_hours;
      if (start && !TIME_RE.test(start)) errors.push(`heartbeat.active_hours.start: invalid time "${start}"`);
      if (end && !TIME_RE.test(end)) errors.push(`heartbeat.active_hours.end: invalid time "${end}"`);
    }
    if (hb.model !== undefined && hb.model !== null) {
      if (typeof hb.model !== 'string' || !VALID_ROUTINE_MODEL.includes(hb.model)) {
        errors.push(`heartbeat.model: "${hb.model}" not in [${VALID_ROUTINE_MODEL.join(', ')}] (omit for haiku default; set null to use session model)`);
      }
    }
  }

  if (config.doctor && typeof config.doctor === 'object') {
    const floor = config.doctor.routine_cost_floor_usd;
    if (floor !== undefined && (typeof floor !== 'number' || floor < 0)) {
      errors.push(`doctor.routine_cost_floor_usd: expected non-negative number, got ${JSON.stringify(floor)}`);
    }
  }

  if (config.watchdog && typeof config.watchdog === 'object') {
    const wd = config.watchdog;
    if (typeof wd.enabled !== 'boolean') {
      warnings.push('watchdog.enabled: should be boolean');
    }
    if (wd.stale_factor !== undefined) {
      if (typeof wd.stale_factor !== 'number' || wd.stale_factor <= 0) {
        warnings.push('watchdog.stale_factor: should be a positive number');
      }
    }
    if (wd.escalate_after !== undefined) {
      if (!Number.isInteger(wd.escalate_after) || wd.escalate_after < 1) {
        errors.push('watchdog.escalate_after: must be a positive integer');
      }
    }
    if (wd.operator_grace !== undefined && typeof wd.operator_grace !== 'string') {
      warnings.push('watchdog.operator_grace: should be a duration string (e.g. "15m")');
    }
    if (wd.context_clear_tokens !== undefined && wd.context_clear_tokens !== null) {
      if (typeof wd.context_clear_tokens !== 'number' || wd.context_clear_tokens < 0) {
        warnings.push('watchdog.context_clear_tokens: should be a non-negative number or null (0 or null disables)');
      }
    }
  }

  if (config.budget && typeof config.budget === 'object') {
    const b = config.budget;
    for (const capKey of ['daily_usd', 'weekly_usd', 'monthly_usd']) {
      if (b[capKey] !== undefined && b[capKey] !== null) {
        if (typeof b[capKey] !== 'number' || b[capKey] <= 0) {
          errors.push(`budget.${capKey}: must be a positive number or null (null disables that cap)`);
        }
      }
    }
    if (b.action !== undefined && !VALID_BUDGET_ACTION.includes(b.action)) {
      errors.push(`budget.action: "${b.action}" not in [${VALID_BUDGET_ACTION.join(', ')}]`);
    }
  }

  if (config.context_hygiene !== undefined) {
    if (typeof config.context_hygiene !== 'object' || config.context_hygiene === null) {
      errors.push('context_hygiene: must be an object');
    } else if (config.context_hygiene.compact !== undefined) {
      const c = config.context_hygiene.compact;
      if (typeof c !== 'object' || c === null) {
        errors.push('context_hygiene.compact: must be an object');
      } else {
        if (c.enabled !== undefined && typeof c.enabled !== 'boolean') {
          errors.push('context_hygiene.compact.enabled: must be a boolean');
        }
        if (c.min_context_tokens !== undefined) {
          if (typeof c.min_context_tokens !== 'number' || c.min_context_tokens <= 0) {
            errors.push('context_hygiene.compact.min_context_tokens: must be a positive number');
          }
        }
        if (c.min_interval !== undefined && typeof c.min_interval !== 'string') {
          warnings.push('context_hygiene.compact.min_interval: should be a duration string (e.g. "4h")');
        }
      }
    }
  }

  if (config.telemetry_export !== undefined) {
    if (typeof config.telemetry_export !== 'object' || config.telemetry_export === null || Array.isArray(config.telemetry_export)) {
      errors.push('telemetry_export: must be an object');
    } else {
      const t = config.telemetry_export;
      if (t.enabled !== undefined && typeof t.enabled !== 'boolean') {
        errors.push('telemetry_export.enabled: must be a boolean');
      }
      if (t.redact_operator_text !== undefined && typeof t.redact_operator_text !== 'boolean') {
        errors.push('telemetry_export.redact_operator_text: must be a boolean');
      }
      if (t.interval_hours !== undefined) {
        if (typeof t.interval_hours !== 'number' || t.interval_hours <= 0) {
          errors.push('telemetry_export.interval_hours: must be a positive number');
        }
      }
      const dest = t.destination;
      if (dest !== undefined) {
        if (typeof dest !== 'object' || dest === null || Array.isArray(dest)) {
          errors.push('telemetry_export.destination: must be an object');
        } else {
          if (dest.type !== undefined && !VALID_TELEMETRY_DEST.includes(dest.type)) {
            errors.push(`telemetry_export.destination.type: "${dest.type}" not in [${VALID_TELEMETRY_DEST.join(', ')}]`);
          }
          if (dest.url !== undefined && dest.url !== null && typeof dest.url !== 'string') {
            errors.push('telemetry_export.destination.url: must be a string or null');
          }
          if (typeof dest.url === 'string' && dest.url.trim() && !dest.url.startsWith('https://')) {
            // A plaintext http:// endpoint would leak the bearer token in the clear. Hard-fail
            // that combination for non-loopback hosts; http:// stays a warning for local receivers.
            const hasBearer = typeof dest.bearer_env === 'string' && dest.bearer_env.length > 0;
            if (hasBearer && !isLoopbackUrl(dest.url)) {
              errors.push('telemetry_export.destination.url: must be https:// when destination.bearer_env is set — a plaintext http:// endpoint would leak the token (http:// is allowed only for loopback receivers)');
            } else {
              warnings.push('telemetry_export.destination.url: should be an https:// URL');
            }
          }
          if (dest.bearer_env !== undefined && dest.bearer_env !== null) {
            if (typeof dest.bearer_env !== 'string') {
              errors.push('telemetry_export.destination.bearer_env: must be a string or null');
            } else if (!ENV_VAR_RE.test(dest.bearer_env)) {
              warnings.push('telemetry_export.destination.bearer_env: should look like an env var name (e.g. "HERMIT_TELEMETRY_TOKEN")');
            }
          }
        }
        if (t.enabled === true && (typeof dest?.url !== 'string' || !dest.url.trim())) {
          errors.push('telemetry_export.destination.url: required (non-empty string) when telemetry_export.enabled is true');
        }
      } else if (t.enabled === true) {
        errors.push('telemetry_export.destination: required when telemetry_export.enabled is true');
      }
    }
  }

  if (config.env && typeof config.env === 'object') {
    for (const [k, v] of Object.entries(config.env)) {
      if (typeof v !== 'string') {
        warnings.push(`env.${k}: value should be a string, got ${typeof v}`);
      }
    }
  }

  if (config.knowledge !== undefined) {
    if (typeof config.knowledge !== 'object' || config.knowledge === null) {
      errors.push('knowledge: must be an object');
    } else {
      const k = config.knowledge;
      if (k.raw_retention_days !== undefined) {
        if (!Number.isInteger(k.raw_retention_days) || k.raw_retention_days <= 0) {
          errors.push('knowledge.raw_retention_days: must be a positive integer');
        }
      }
      if (k.compiled_budget_chars !== undefined) {
        if (!Number.isInteger(k.compiled_budget_chars) || k.compiled_budget_chars < 500 || k.compiled_budget_chars > 6000) {
          errors.push('knowledge.compiled_budget_chars: must be an integer between 500 and 6000');
        }
      }
      if (k.working_set_warn !== undefined) {
        if (!Number.isInteger(k.working_set_warn) || k.working_set_warn <= 0) {
          errors.push('knowledge.working_set_warn: must be a positive integer');
        }
      }
      if (k.archive_retention_days !== undefined) {
        if (k.archive_retention_days !== null && (!Number.isInteger(k.archive_retention_days) || k.archive_retention_days <= 0)) {
          errors.push('knowledge.archive_retention_days: must be a positive integer or null');
        }
      }
      if (k.channel_log_enabled !== undefined) {
        if (typeof k.channel_log_enabled !== 'boolean') {
          errors.push('knowledge.channel_log_enabled: must be a boolean');
        }
      }
      if (k.channel_log_retention_days !== undefined) {
        if (!Number.isInteger(k.channel_log_retention_days) || k.channel_log_retention_days <= 0) {
          errors.push('knowledge.channel_log_retention_days: must be a positive integer');
        }
      }
    }
  }

  if (config.monitors !== undefined && !Array.isArray(config.monitors)) {
    errors.push('monitors: must be an array');
  } else if (Array.isArray(config.monitors)) {
    const ids = new Set();
    config.monitors.forEach((m: Json, i: number) => {
      if (!m.id || typeof m.id !== 'string') {
        errors.push(`monitors[${i}]: missing or invalid id`);
      } else {
        if (ids.has(m.id)) warnings.push(`monitors[${i}]: duplicate id "${m.id}"`);
        ids.add(m.id);
      }
      if (!m.description || typeof m.description !== 'string') errors.push(`monitors[${i}]: missing description`);
      if (!m.command || typeof m.command !== 'string') errors.push(`monitors[${i}]: missing command`);
      if (m.persistent !== undefined && typeof m.persistent !== 'boolean') warnings.push(`monitors[${i}]: "persistent" should be boolean`);
      if (m.enabled !== undefined && typeof m.enabled !== 'boolean') warnings.push(`monitors[${i}]: "enabled" should be boolean`);
      if (m.class !== undefined && !['stream', 'poll'].includes(m.class)) errors.push(`monitors[${i}]: class must be "stream" or "poll"`);
      if (m.timeout_ms !== undefined && (typeof m.timeout_ms !== 'number' || m.timeout_ms < 1000)) errors.push(`monitors[${i}]: timeout_ms must be a number >= 1000`);
    });
  }

  if (config.push_notifications !== undefined && typeof config.push_notifications !== 'boolean') {
    errors.push('push_notifications: must be a boolean');
  }

  if (config.ask_gate !== undefined && typeof config.ask_gate !== 'boolean') {
    errors.push('ask_gate: must be a boolean');
  }

  if (config.artifacts !== undefined) {
    if (typeof config.artifacts !== 'object' || config.artifacts === null || Array.isArray(config.artifacts)) {
      errors.push('artifacts: must be an object');
    } else {
      if (config.artifacts.dashboard !== undefined && typeof config.artifacts.dashboard !== 'boolean') {
        errors.push('artifacts.dashboard: must be a boolean');
      }
      if (config.artifacts.proposals !== undefined && typeof config.artifacts.proposals !== 'boolean') {
        errors.push('artifacts.proposals: must be a boolean');
      }
      if (config.artifacts.weekly_review !== undefined && typeof config.artifacts.weekly_review !== 'boolean') {
        errors.push('artifacts.weekly_review: must be a boolean');
      }
      if (
        config.artifacts.publish_authorized !== undefined &&
        config.artifacts.publish_authorized !== null &&
        typeof config.artifacts.publish_authorized !== 'boolean'
      ) {
        errors.push('artifacts.publish_authorized: must be a boolean or null');
      }
    }
  }

  if (config.reflection !== undefined) {
    if (typeof config.reflection !== 'object' || config.reflection === null) {
      errors.push('reflection: must be an object');
    } else if (config.reflection.graduation_min_sessions !== undefined &&
        (!Number.isInteger(config.reflection.graduation_min_sessions) || config.reflection.graduation_min_sessions < 1)) {
      errors.push('reflection.graduation_min_sessions: must be a positive integer (≥1)');
    }
  }

  if (config.post_close_clear !== undefined && typeof config.post_close_clear !== 'boolean') {
    errors.push('post_close_clear: must be a boolean');
  }

  return { errors, warnings };
}

function main() {
  let raw = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => {
    raw += chunk;
    if (raw.length > MAX_STDIN) process.exit(0);
  });
  process.stdin.on('end', () => {
    try {
      // Fast reject: skip if stdin doesn't mention config.json at all
      if (!raw.includes('config.json')) process.exit(0);

      const event = JSON.parse(raw);
      const filePath = (event.tool_input || {}).file_path || (event.tool_input || {}).path || '';

      if (path.basename(filePath) !== 'config.json' || !filePath.includes('.claude-code-hermit')) {
        process.exit(0);
      }

      let config: Json;
      try {
        config = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      } catch (e: any) {
        process.stderr.write(`[config-validate] FAIL: config.json is not valid JSON — ${safeForLLM(e.message)}\n`);
        process.exit(2);
      }

      const { errors, warnings } = validate(config);

      if (warnings.length > 0) {
        process.stderr.write(`[config-validate] Warnings:\n`);
        warnings.forEach(w => process.stderr.write(`  WARN  ${safeForLLM(w)}\n`));
      }

      if (errors.length > 0) {
        process.stderr.write(`[config-validate] Errors:\n`);
        errors.forEach(e => process.stderr.write(`  FAIL  ${safeForLLM(e)}\n`));
        process.stderr.write(`[config-validate] Config validation failed — fix before proceeding\n`);
        process.exit(2);
      }

      else {
        process.stderr.write(`[config-validate] OK\n`);
      }
    } catch (e) {
      // Don't block the agent on parse errors
    }
  });
}

// Allow tests to import individual functions
export { parseCronField, validateCronSchedule, validate, isLoopbackUrl, ROUTINE_ID_RE };

if (import.meta.main) {
  main();
}
