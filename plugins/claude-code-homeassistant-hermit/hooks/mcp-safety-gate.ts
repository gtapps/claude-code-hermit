#!/usr/bin/env bun
// PreToolUse hook: gate mcp__homeassistant__* calls targeting sensitive entities.
//
// WP8 port of hooks/mcp-safety-gate.py. Imports the policy from ../src/policy
// (same plugin, same language) — the Python original imported the deleted
// ha_agent_lab.policy package, which never resolved on standard operator
// installs (no PYTHONPATH in hooks.json, package never pip-installed by
// hatch), so an ImportError crashed the hook with exit 1. Claude Code treats
// non-2 nonzero hook exits as NON-blocking, i.e. the gate failed OPEN. This
// port makes the gate self-contained and genuinely fail-closed.
//
// Reads tool call JSON from stdin. Extracts entity references from the tool
// input parameters and checks each against src/policy.
//
// Behavior depends on `ha_safety_mode` in .claude-code-hermit/config.json:
//   - "strict" (default): sensitive entities → exit 2 (block, reason on stderr)
//   - "ask": sensitive entities → emit `permissionDecision: "ask"` JSON so
//     Claude Code prompts the operator before allowing the call
//
// Fail-safe: blocks (exit 2) on any parse error or unresolvable target. The
// dial does NOT relax this — it only changes how concrete sensitive entity
// IDs are handled.
//
// Output stays byte-identical to the Python hook (json.dumps default
// separators + ensure_ascii), pinned by tests/gate-corpus.test.ts.
// Deliberate divergence from the Python original: a valid-JSON payload that
// is not an object (e.g. `[]`, `"x"`, `42`, `null`) crashed Python with an
// uncaught AttributeError (exit 1 → fail-open); here it blocks (exit 2).

import { readFileSync, writeSync } from 'node:fs';

import { Severity, classifyEntity } from '../src/policy';

/** Pull entity_id values from MCP tool parameters. */
export function extractEntityIds(toolInput: Record<string, unknown>): string[] {
  const ids: string[] = [];
  for (const key of ['entity_id', 'device_id']) {
    const val = toolInput[key];
    if (typeof val === 'string' && val.includes('.')) {
      ids.push(val);
    } else if (Array.isArray(val)) {
      ids.push(...val.filter((v): v is string => typeof v === 'string' && v.includes('.')));
    }
  }
  const target = toolInput['target'];
  if (typeof target === 'object' && target !== null && !Array.isArray(target)) {
    const eid = (target as Record<string, unknown>)['entity_id'];
    if (typeof eid === 'string' && eid.includes('.')) {
      ids.push(eid);
    } else if (Array.isArray(eid)) {
      ids.push(...eid.filter((v): v is string => typeof v === 'string' && v.includes('.')));
    }
  }
  return ids;
}

/** Encode a string exactly like CPython json.dumps (ensure_ascii=True). */
export function pyJsonString(s: string): string {
  const SHORT: Record<string, string> = {
    '\\': '\\\\',
    '"': '\\"',
    '\b': '\\b',
    '\t': '\\t',
    '\n': '\\n',
    '\f': '\\f',
    '\r': '\\r',
  };
  let out = '"';
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    const code = s.charCodeAt(i);
    if (SHORT[ch] !== undefined) {
      out += SHORT[ch];
    } else if (code >= 0x20 && code <= 0x7e) {
      out += ch;
    } else {
      // Python escapes everything outside printable ASCII, including DEL and
      // astral chars (emitted as their UTF-16 surrogate pair, same as here).
      out += `\\u${code.toString(16).padStart(4, '0')}`;
    }
  }
  return out + '"';
}

function fail(message: string): never {
  writeSync(2, `${message}\n`);
  process.exit(2);
}

function main(): void {
  let payload: unknown;
  try {
    payload = JSON.parse(readFileSync(0, 'utf8'));
  } catch {
    fail('Failed to parse hook input');
  }
  // Fail-closed hardening over the Python original (which crashed exit 1 /
  // fail-open here): valid JSON that is not an object is still unparseable
  // as a hook payload — block it.
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    fail('Failed to parse hook input');
  }

  let toolInput = (payload as Record<string, unknown>)['tool_input'];
  if (typeof toolInput !== 'object' || toolInput === null || Array.isArray(toolInput)) {
    toolInput = {};
  }

  const entityIds = extractEntityIds(toolInput as Record<string, unknown>);

  if (entityIds.length === 0) {
    fail(
      'Cannot verify target safety: no resolvable entity IDs found ' +
        '(area_id / device_id targets are not evaluated). Use a proposal instead.',
    );
  }

  const hits: Array<[string, Severity]> = [];
  for (const eid of entityIds) {
    const [sev] = classifyEntity(eid);
    if (sev !== Severity.ALLOW) hits.push([eid, sev]);
  }

  if (hits.length === 0) {
    process.exit(0);
  }

  // All hits share the same severity under the two-tier model — the current
  // mode applies uniformly to every sensitive entity in this call.
  const currentSev = hits[0]![1];
  const names = hits.map(([e]) => e).join(', ');

  if (currentSev === Severity.BLOCK) {
    fail(`Blocked sensitive entities: ${names}. Use a proposal instead.`);
  }

  // Byte-identical to Python's json.dumps(...) of the same dict: `, ` / `: `
  // separators and ensure_ascii string escaping.
  const reason = pyJsonString(`Sensitive entities: ${names}`);
  writeSync(
    1,
    '{"hookSpecificOutput": {"hookEventName": "PreToolUse", ' +
      '"permissionDecision": "ask", ' +
      `"permissionDecisionReason": ${reason}}}\n`,
  );
  process.exit(0);
}

if (import.meta.main) {
  main();
}
