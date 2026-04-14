'use strict';

const fs = require('fs');
const path = require('path');

/**
 * PostToolUse hook — validates config.json after any Edit/Write to it.
 * Checks required keys, types, routine time formats, and channel structure.
 * Exit 2 = validation failed, surface errors to agent.
 */

const CONFIG_PATH = path.resolve('.claude-code-hermit/config.json');
const MAX_STDIN = 64 * 1024;

const REQUIRED_KEYS = {
  'agent_name': ['string', 'null'],
  'language': ['string', 'null'],
  'timezone': ['string', 'null'],
  'escalation': ['string'],
  'channels': ['object'],
  'env': ['object'],
  'heartbeat': ['object'],
  'routines': ['array'],
};

const VALID_ESCALATION = ['conservative', 'balanced', 'autonomous'];
const TIME_RE = /^\d{2}:\d{2}$/;

// --- Cron validation (5-field: minute hour dom month dow) ---
function parseCronField(token, lo, hi) {
  const values = new Set();
  for (const part of token.split(',')) {
    if (!part) throw new Error('empty segment in list');
    if (part.includes('/')) {
      const [base, stepStr] = part.split('/', 2);
      const step = Number(stepStr);
      if (!Number.isInteger(step) || step <= 0) throw new Error(`zero or invalid step: ${part}`);
      let start, end;
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

function validateCronSchedule(schedule) {
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
  } catch (e) {
    return e.message;
  }
  const domRestricted = fields[2] !== '*';
  const dowRestricted = fields[4] !== '*';
  if (domRestricted && dowRestricted) return 'both DOM and DOW restricted — not supported in v1';
  return null;
}

function validate(config) {
  const errors = [];
  const warnings = [];

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

  if (Array.isArray(config.routines)) {
    const ids = new Set();
    config.routines.forEach((r, i) => {
      if (!r.id) errors.push(`routines[${i}]: missing id`);
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
    });
  }

  if (config.channels && typeof config.channels === 'object') {
    for (const [name, ch] of Object.entries(config.channels)) {
      if (typeof ch !== 'object' || ch === null) {
        errors.push(`channels.${name}: must be an object`);
        continue;
      }
      if (ch.allowed_users !== undefined && !Array.isArray(ch.allowed_users)) {
        errors.push(`channels.${name}.allowed_users: must be an array`);
      }
      if (ch.dm_channel_id !== undefined && ch.dm_channel_id !== null && typeof ch.dm_channel_id !== 'string') {
        errors.push(`channels.${name}.dm_channel_id: must be string or null`);
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
        if (!Number.isInteger(k.compiled_budget_chars) || k.compiled_budget_chars < 500 || k.compiled_budget_chars > 4000) {
          errors.push('knowledge.compiled_budget_chars: must be an integer between 500 and 4000');
        }
      }
      if (k.working_set_warn !== undefined) {
        if (!Number.isInteger(k.working_set_warn) || k.working_set_warn <= 0) {
          errors.push('knowledge.working_set_warn: must be a positive integer');
        }
      }
    }
  }

  if (config.monitors !== undefined && !Array.isArray(config.monitors)) {
    errors.push('monitors: must be an array');
  } else if (Array.isArray(config.monitors)) {
    const ids = new Set();
    config.monitors.forEach((m, i) => {
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

      let config;
      try {
        config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
      } catch (e) {
        process.stderr.write(`[config-validate] FAIL: config.json is not valid JSON — ${e.message}\n`);
        process.exit(2);
      }

      const { errors, warnings } = validate(config);

      if (warnings.length > 0) {
        process.stderr.write(`[config-validate] Warnings:\n`);
        warnings.forEach(w => process.stderr.write(`  WARN  ${w}\n`));
      }

      if (errors.length > 0) {
        process.stderr.write(`[config-validate] Errors:\n`);
        errors.forEach(e => process.stderr.write(`  FAIL  ${e}\n`));
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

// Allow tests to require individual functions
if (require.main === module) {
  main();
} else {
  module.exports = { parseCronField, validateCronSchedule, validate };
}
