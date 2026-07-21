/**
 * Long-lived subscription OAuth token ("claude setup-token") support.
 *
 * Two artifacts, deliberately split by sensitivity:
 *
 *   - the token itself: a 0600 file in CLAUDE_CONFIG_DIR (the persistent
 *     claude-config volume under Docker, alongside .credentials.json). It is
 *     NOT stored in .env — compose applies env_file only at container
 *     creation, so an .env-stored token would force a host-side recreate on
 *     every renewal, which is the manual box access this whole feature exists
 *     to remove. hermit-start exports it into the session env instead.
 *
 *   - the record: { minted_at, expires_at } in the hermit's state dir. Carries
 *     no secret, so doctor/watchdog can read expiry without touching the token.
 *     Expiry is deterministic precisely because the hermit mints the token: the
 *     CLI exposes no expiry surface for it (no warning, no /status row, no
 *     credentials-file field — confirmed live), so this record is the only
 *     source of truth.
 *
 * Auth-mode detection is env/file presence, never parsing `claude /status` or
 * any other TUI output — those labels shift between releases.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const TOKEN_FILENAME = '.hermit-setup-token';
export const TOKEN_ENV_VAR = 'CLAUDE_CODE_OAUTH_TOKEN';
/** setup-token mints a 1-year credential. */
export const TOKEN_TTL_MS = 365 * 24 * 3600 * 1000;

export type TokenRecord = { minted_at: string; expires_at: string };

/** CLAUDE_CONFIG_DIR when set, else the CLI's default (~/.claude). */
export function defaultConfigDir(): string {
  return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
}

export function tokenFilePath(configDir: string): string {
  return path.join(configDir, TOKEN_FILENAME);
}

/**
 * tmux session name for the mint pane, and the path its output streams to.
 *
 * Both are namespaced by project directory, like getSessionName() does for the
 * managed session: two hermits under one user's tmux server would otherwise
 * share a mint session and a capture file, and either one's cleanupMint()
 * would tear down the other's in-flight sign-in.
 */
export function mintSessionName(): string {
  return `hermit-reauth-mint-${path.basename(process.cwd())}`;
}

export function mintCaptureFilePath(): string {
  return path.join(os.tmpdir(), `.${mintSessionName()}-capture`);
}

export function tokenRecordPath(hermitDir: string): string {
  return path.join(hermitDir, 'state', 'setup-token.json');
}

/** Trimmed token text, or null when absent/empty/unreadable. */
export function readTokenValue(configDir: string): string | null {
  try {
    const raw = fs.readFileSync(tokenFilePath(configDir), 'utf8').trim();
    return raw || null;
  } catch {
    return null;
  }
}

/**
 * True when this hermit authenticates with a long-lived setup-token — either
 * already exported into the environment, or installed on disk awaiting the
 * next process start. The file is the boot-time signal: the docker entrypoint
 * runs BEFORE hermit-start exports the env var, so a gate keyed only on the
 * env var would never see token mode.
 */
export function tokenModeActive(configDir: string): boolean {
  if (process.env[TOKEN_ENV_VAR]) return true;
  return readTokenValue(configDir) !== null;
}

/** Parsed record, or null when absent/malformed (callers treat null as "not token mode"). */
export function readTokenRecord(hermitDir: string): TokenRecord | null {
  try {
    const rec = JSON.parse(fs.readFileSync(tokenRecordPath(hermitDir), 'utf8'));
    if (typeof rec?.expires_at !== 'string' || Number.isNaN(Date.parse(rec.expires_at))) return null;
    return { minted_at: String(rec.minted_at ?? ''), expires_at: rec.expires_at };
  } catch {
    return null;
  }
}

/**
 * Shape check for a scraped token. The mint driver captures from a tmux pane,
 * so the real failure mode is grabbing an adjacent line rather than the token —
 * hence the prefix and whitespace checks, which reject prose outright.
 */
export function isPlausibleToken(token: string): boolean {
  const t = token.trim();
  if (t.length < 20) return false;
  if (/\s/.test(t)) return false;
  return t.startsWith('sk-ant-');
}

/**
 * Install a freshly minted token: 0600 file + expiry record. Returns the record
 * only — the token value never appears in a return value that a caller might
 * print, because every front door prints its result to a terminal or a channel.
 */
export function installToken(hermitDir: string, configDir: string, token: string): TokenRecord {
  const value = token.trim();
  if (!isPlausibleToken(value)) throw new Error('refusing to install implausible token');

  fs.mkdirSync(configDir, { recursive: true });
  const dest = tokenFilePath(configDir);
  const tmp = `${dest}.tmp`;
  // Create with 0600 up front rather than write-then-chmod, so the secret is
  // never briefly world-readable.
  fs.writeFileSync(tmp, `${value}\n`, { mode: 0o600 });
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, dest);

  const now = new Date();
  const record: TokenRecord = {
    minted_at: now.toISOString(),
    expires_at: new Date(now.getTime() + TOKEN_TTL_MS).toISOString(),
  };
  fs.mkdirSync(path.join(hermitDir, 'state'), { recursive: true });
  const recPath = tokenRecordPath(hermitDir);
  fs.writeFileSync(`${recPath}.tmp`, JSON.stringify(record, null, 2) + '\n');
  fs.renameSync(`${recPath}.tmp`, recPath);

  return record;
}

/** Milliseconds until the recorded expiry; null when there's no usable record. */
export function msUntilExpiry(hermitDir: string, now: number = Date.now()): number | null {
  const rec = readTokenRecord(hermitDir);
  if (!rec) return null;
  return Date.parse(rec.expires_at) - now;
}
