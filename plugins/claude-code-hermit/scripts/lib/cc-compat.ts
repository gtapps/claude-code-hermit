// cc-compat.js — Centralized accessors for Claude Code-owned formats.
//
// Contract: this module wraps surfaces that Anthropic owns and can change
// without notice. Every parse of a CC-owned format should go through here so
// a CC release breaks THIS FILE loudly, not five others quietly.
//
// In-scope surfaces:
//   - Hook-payload field names (session_id, transcript_path, session_crons,
//     background_tasks)
//   - Transcript JSONL entry shape (message.usage, cache field names,
//     assistant/user/tool_result type discrimination)
//   - Cost-log path resolution (record shape is hermit-owned — see costLogPath)
//   - Best-effort CC version string (diagnostic only — never branch on it;
//     the install-gate is min_claude_code_version in hermit-meta.json)
//
// Out-of-scope (NOT in this module):
//   - pricing.js: Anthropic published pricing — a hermit-owned data table
//   - Cron grammar (5-field POSIX, stable; CronCreate semantics are doc)
//   - Monitor sentinel constants (HEARTBEAT_EVALUATE is hermit's own protocol)

import fs from 'node:fs';
import path from 'node:path';

type Json = any;
type TriState = { state: string; count: number; entries: Json[] };

// ---------------------------------------------------------------------------
// Project-root resolution (robust to drifted hook cwd — fix for #384)
// ---------------------------------------------------------------------------

/**
 * Fleet resolver — one of three; same walk-up logic, different return and fallback:
 *   core hermitDir    (scripts/lib/cc-compat.ts)              → the .cch dir (this file)
 *   HA   projectRoot  (homeassistant-hermit/src/config.ts)    → the project root (parent)
 *   dev  findHermitDir(dev-hermit/scripts/git-push-guard.ts)  → the .cch dir or null
 * INVARIANT: hermitDir() === path.join(projectRoot(), '.claude-code-hermit').
 * Fix one (env-var precedence, iteration cap) → check the other two.
 *
 * Robust to a drifted hook cwd (#384). A *relative* AGENT_DIR (the legacy
 * drift-prone default, e.g. `AGENT_DIR=".claude-code-hermit"`) is intentionally
 * NOT honored — it falls through to CLAUDE_PROJECT_DIR, then walk-up, then fail-open.
 */
function hermitDir(): string {
  const agent = process.env.AGENT_DIR;
  if (agent && path.isAbsolute(agent)) return path.resolve(agent);
  const proj = process.env.CLAUDE_PROJECT_DIR;
  if (proj) { const d = path.join(proj, '.claude-code-hermit'); if (fs.existsSync(d)) return d; }
  let dir = process.cwd();
  for (let i = 0; i < 8; i++) {
    if (fs.existsSync(path.join(dir, '.claude-code-hermit', 'config.json'))) return path.join(dir, '.claude-code-hermit');
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return path.resolve('.claude-code-hermit'); // fail-open: preserves today's behavior
}

// ---------------------------------------------------------------------------
// Hook-payload accessors (pure, null-safe)
// ---------------------------------------------------------------------------

/**
 * Extract session_id from a Stop (or any) hook payload.
 * CC has used both `session_id` and `sessionId` across versions.
 * @param {object} payload
 * @returns {string|null}
 */
function sessionId(payload: Json): string | null {
  if (!payload || typeof payload !== 'object') return null;
  return payload.session_id != null ? payload.session_id
    : payload.sessionId != null ? payload.sessionId
    : null;
}

/**
 * Extract transcript_path from a Stop hook payload.
 * @param {object} payload
 * @returns {string|null}
 */
function transcriptPath(payload: Json): string | null {
  if (!payload || typeof payload !== 'object') return null;
  return payload.transcript_path != null ? payload.transcript_path : null;
}

/**
 * Extract session_crons with tri-state presence semantics.
 *
 * The tri-state is critical:
 *   - 'unsupported_or_unreachable': field absent — old CC or task registry
 *     unreachable. NEVER render this as "0 crons" — that's the silent-wrong
 *     this module exists to prevent.
 *   - 'empty': field present and array is empty — CC supports it, nothing scheduled.
 *   - 'populated': field present and non-empty.
 *
 * @param {object} payload
 * @returns {{ state: string, count: number, entries: Array }}
 */
function triStateField(payload: Json, field: string): TriState {
  if (!payload || typeof payload !== 'object' || !(field in payload)) {
    return { state: 'unsupported_or_unreachable', count: 0, entries: [] };
  }
  const raw = payload[field];
  const entries = Array.isArray(raw) ? raw : [];
  if (entries.length === 0) {
    return { state: 'empty', count: 0, entries: [] };
  }
  return { state: 'populated', count: entries.length, entries };
}

function sessionCrons(payload: Json): TriState {
  return triStateField(payload, 'session_crons');
}

/**
 * Extract background_tasks with tri-state presence semantics.
 * Same rules as sessionCrons — see above.
 * @param {object} payload
 * @returns {{ state: string, count: number, entries: Array }}
 */
function backgroundTasks(payload: Json): TriState {
  return triStateField(payload, 'background_tasks');
}

// ---------------------------------------------------------------------------
// Transcript parsing (CC-owned JSONL shape)
// ---------------------------------------------------------------------------

/**
 * Stringify an entry's message.content regardless of whether it is a string
 * or a content-block array. Real CC transcripts use both shapes.
 * @param {object} entry
 * @returns {string}
 */
function entryText(entry: Json): string {
  const c = entry.message?.content;
  if (!c) return '';
  return typeof c === 'string' ? c : JSON.stringify(c);
}

/**
 * A user entry is a tool_result carrier (not a turn boundary) when its content
 * is an array containing any tool_result block. The triggering prompt that
 * opens a turn is a "real" user entry: string content, or an array with no
 * tool_result.
 * @param {object} entry
 * @returns {boolean}
 */
function isToolResult(entry: Json): boolean {
  if (entry.type !== 'user') return false;
  const c = entry.message?.content;
  return Array.isArray(c) && c.some((b: Json) => b && b.type === 'tool_result');
}

/**
 * Extract token usage from a transcript entry.
 * Returns an object if the entry is an assistant entry with usage, else null.
 * This centralizes the CC-owned field names: input_tokens, output_tokens,
 * cache_creation_input_tokens, cache_read_input_tokens.
 *
 * @param {object} entry
 * @returns {{ inputTokens: number, cacheWriteTokens: number, cacheReadTokens: number,
 *             outputTokens: number, model: string } | null}
 */
function extractUsage(entry: Json): { inputTokens: number; cacheWriteTokens: number; cacheReadTokens: number; outputTokens: number; model: string } | null {
  if (entry.type !== 'assistant' || !entry.message?.usage) return null;
  const u = entry.message.usage;
  return {
    inputTokens:      u.input_tokens || 0,
    cacheWriteTokens: u.cache_creation_input_tokens || 0,
    cacheReadTokens:  u.cache_read_input_tokens || 0,
    outputTokens:     u.output_tokens || 0,
    model:            entry.message.model || '',
  };
}

// ---------------------------------------------------------------------------
// Cost-log path and record shape
// ---------------------------------------------------------------------------

/**
 * Canonical cost-log path resolution.
 * Replaces the 5 divergent path.resolve strategies scattered across scripts.
 * The cost-log is always at .claude/cost-log.jsonl relative to the project
 * root; stateDir is .claude-code-hermit/state/ or the hermit root.
 *
 * Accepts either the hermit root (e.g. '.claude-code-hermit') or a deeper
 * path under it. Walks up until .claude-code-hermit is found, then resolves
 * sibling .claude/ from its parent.
 *
 * @param {string} [hermitRootOrState] path to hermit root or state subdir;
 *   defaults to '.claude-code-hermit' relative to cwd.
 * @returns {string} absolute path to .claude/cost-log.jsonl
 */
function costLogPath(hermitRootOrState?: string): string {
  if (!hermitRootOrState) {
    return path.resolve('.claude', 'cost-log.jsonl');
  }
  const abs = path.resolve(hermitRootOrState);
  // Walk up to find the directory named .claude-code-hermit
  let dir = abs;
  for (let i = 0; i < 5; i++) {
    if (path.basename(dir) === '.claude-code-hermit') {
      return path.join(path.dirname(dir), '.claude', 'cost-log.jsonl');
    }
    dir = path.dirname(dir);
  }
  // Fallback: treat hermitRootOrState as the hermit root itself
  return path.join(path.dirname(abs), '.claude', 'cost-log.jsonl');
}

// ---------------------------------------------------------------------------
// Capability / version sniff (diagnostic only — never branch on it)
// ---------------------------------------------------------------------------

/**
 * Best-effort CC version string.
 * Reads from payload if CC ever ships it there, else checks env.
 * Returns null rather than spawning `claude --version` on the hot path.
 * Use this for diagnostic labeling only; runtime behavior should key on
 * field presence, never on this string.
 *
 * @param {object} [payload]
 * @returns {string|null}
 */
function ccVersion(payload?: Json): string | null {
  if (payload && typeof payload === 'object') {
    const v = payload.claude_code_version || payload.cc_version;
    if (v && typeof v === 'string') return v;
  }
  return process.env.CLAUDE_CODE_VERSION || null;
}

// ---------------------------------------------------------------------------

export {
  // Project-root resolution
  hermitDir,
  // Hook-payload accessors
  sessionId,
  transcriptPath,
  sessionCrons,
  backgroundTasks,
  // Transcript parsing
  entryText,
  isToolResult,
  extractUsage,
  // Cost-log
  costLogPath,
  // Capability sniff
  ccVersion,
};
