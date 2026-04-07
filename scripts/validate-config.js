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
      if (!r.time) {
        errors.push(`routines[${i}]: missing time`);
      } else if (!TIME_RE.test(r.time)) {
        errors.push(`routines[${i}]: invalid time "${r.time}" — must be HH:MM`);
      } else {
        const [h, m] = r.time.split(':').map(Number);
        if (h > 23 || m > 59) {
          errors.push(`routines[${i}]: time "${r.time}" out of range`);
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

      if (warnings.length === 0 && errors.length === 0) {
        process.stderr.write(`[config-validate] OK\n`);
      }
    } catch (e) {
      // Don't block the agent on parse errors
    }
  });
}

main();
