#!/usr/bin/env bun
/**
 * Graceful shutdown for hermit autonomous sessions.
 *
 * Sends /session-close --shutdown to the running Claude instance before
 * killing the tmux session, ensuring a clean session report is generated.
 *
 * Usage:
 *     bun scripts/hermit-stop.ts              # graceful shutdown
 *     bun scripts/hermit-stop.ts --force      # immediate kill
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { acquireLock, releaseLock } from './lib/lockfile';
import { localISOStamp } from './lib/time';
import { readRuntimeJson, updateRuntimeField, STATE_DIR, LIFECYCLE_LOCK } from './lib/runtime';

type Json = any;

const CONFIG_PATH = '.claude-code-hermit/config.json';
const SESSIONS_DIR = '.claude-code-hermit/sessions';
const SHELL_PATH = path.join(SESSIONS_DIR, 'SHELL.md');
const DEFAULT_TIMEOUT = 60; // seconds to wait for graceful close

const sleep = (s: number) => new Promise((r) => setTimeout(r, s * 1000));

function loadConfig(): Json {
  if (!fs.existsSync(CONFIG_PATH)) {
    console.log('[hermit] No config found. Is this a hermit project?');
    process.exit(1);
  }
  return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
}

function getSessionName(config: Json): string {
  const name = config.tmux_session_name ?? 'hermit-{project_name}';
  return name.replaceAll('{project_name}', path.basename(process.cwd()));
}

function tmuxSessionAlive(name: string): boolean {
  return spawnSync('tmux', ['has-session', '-t', name], { stdio: 'ignore' }).status === 0;
}

function findLatestReport(): string | null {
  try {
    const reports = fs
      .readdirSync(SESSIONS_DIR)
      .filter((f) => /^S-.*-REPORT\.md$/.test(f))
      .sort();
    return reports.length ? path.join(SESSIONS_DIR, reports[reports.length - 1]) : null;
  } catch {
    return null;
  }
}

function listReports(): Set<string> {
  try {
    return new Set(fs.readdirSync(SESSIONS_DIR).filter((f) => /^S-.*-REPORT\.md$/.test(f)));
  } catch {
    return new Set();
  }
}

function readActiveSession(): Json | null {
  const stats: Json = {};

  // Status and started come from runtime.json — the documented single source of truth.
  // SHELL.md has no **Status:** field (removed; see session-mgr.md).
  const runtime = readRuntimeJson();
  if (runtime) {
    stats.status = runtime.session_state ?? 'unknown';
    stats.started = runtime.created_at ?? 'unknown';
  }

  // Prefer SHELL.md's **Started:** over runtime.json's only when it has been substituted
  // (i.e. does not still contain the template placeholder YYYY-MM-DD HH:MM).
  if (fs.existsSync(SHELL_PATH)) {
    for (const line of fs.readFileSync(SHELL_PATH, 'utf-8').split('\n')) {
      if (line.includes('**Tasks Completed:**')) {
        stats.tasks_completed = line.split('**Tasks Completed:**')[1].trim();
      } else if (line.includes('**Started:**')) {
        const value = line.split('**Started:**')[1].trim();
        if (!value.includes('YYYY')) stats.started = value;
      }
    }
  }

  return Object.keys(stats).length ? stats : null;
}

function saveConfig(config: Json): void {
  try {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + '\n');
  } catch {}
}

function acquireLifecycleLock(): void {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  if (!acquireLock(LIFECYCLE_LOCK)) {
    console.log('[hermit] Another lifecycle operation in progress. Aborting.');
    process.exit(1);
  }
}

function releaseLifecycleLock(): void {
  releaseLock(LIFECYCLE_LOCK);
}

function tmux(args: string[]): void {
  spawnSync('tmux', args, { stdio: 'inherit' });
}

async function main(): Promise<void> {
  const force = process.argv.includes('--force');

  const config = loadConfig();
  acquireLifecycleLock();
  const sessionName = getSessionName(config);

  if (!tmuxSessionAlive(sessionName)) {
    const runtime = readRuntimeJson();
    if (runtime && runtime.runtime_mode === 'interactive') {
      // Claude is still running in the operator's terminal — don't corrupt
      // lifecycle truth. The Stop hook (triggered when Claude exits) owns
      // the transition to idle.
      console.log('[hermit] Hermit is running in interactive mode.');
      console.log('[hermit] Terminate the Claude process in your terminal (Ctrl+C).');
      config.always_on = false;
      saveConfig(config);
      releaseLifecycleLock();
      process.exit(0);
    }
    console.log(`[hermit] No running session: ${sessionName}`);
    config.always_on = false;
    saveConfig(config);
    updateRuntimeField({
      session_state: 'idle',
      shutdown_completed_at: localISOStamp(),
      transition: null,
      transition_target: null,
      transition_started_at: null,
    });
    const report = findLatestReport();
    if (report) console.log(`[hermit] Last report: ${report}`);
    releaseLifecycleLock();
    process.exit(0);
  }

  // Show session stats
  const stats = readActiveSession();
  let tasks = '0';
  if (stats) {
    tasks = stats.tasks_completed ?? '0';
    const started = stats.started ?? 'unknown';
    const status = stats.status ?? 'unknown';
    console.log(`[hermit] Session started: ${started} | Status: ${status} | Tasks: ${tasks}`);
  }

  if (force) {
    console.log(`[hermit] Force-killing session: ${sessionName}`);
    config.always_on = false;
    saveConfig(config);
    tmux(['kill-session', '-t', sessionName]);
    updateRuntimeField({
      session_state: 'idle',
      shutdown_requested_at: localISOStamp(),
      shutdown_completed_at: localISOStamp(),
      last_error: 'unclean_shutdown',
      transition: null,
      transition_target: null,
      transition_started_at: null,
    });
    const report = findLatestReport();
    if (report) console.log(`[hermit] Last report: ${report}`);
    console.log('[hermit] Warning: session was not closed gracefully. SHELL.md may be stale.');
    releaseLifecycleLock();
    return;
  }

  // Stop heartbeat first (only if enabled in config)
  if (config.heartbeat?.enabled && tmuxSessionAlive(sessionName)) {
    console.log('[hermit] Stopping heartbeat...');
    tmux(['send-keys', '-t', sessionName, '/claude-code-hermit:heartbeat stop', 'Enter']);
    await sleep(2);
  }

  // Mark shutdown requested in runtime.json
  updateRuntimeField({ shutdown_requested_at: localISOStamp() });

  // Release the lifecycle lock before delegating to /session-close.
  // The close/archive path inside Claude needs to acquire this lock
  // for its own runtime.json writes. Holding it here would cause the
  // agent to see it as contention and skip the close.
  releaseLifecycleLock();

  // Graceful shutdown: send /session-close --shutdown for full close
  console.log(`[hermit] Sending /claude-code-hermit:session-close --shutdown to ${sessionName}...`);
  tmux(['send-keys', '-t', sessionName, '/claude-code-hermit:session-close --shutdown', 'Enter']);

  // Wait for the session to close (check for new report file)
  const reportsBefore = listReports();
  console.log(`[hermit] Waiting up to ${DEFAULT_TIMEOUT}s for session close...`);

  let newReport: string | null = null;
  let closedEarly = false;
  for (let i = 0; i < DEFAULT_TIMEOUT; i++) {
    await sleep(1);
    if (!tmuxSessionAlive(sessionName)) {
      console.log('[hermit] Session exited without generating a report.');
      closedEarly = true;
      break;
    }
    const fresh = [...listReports()].filter((r) => !reportsBefore.has(r));
    if (fresh.length) {
      newReport = path.join(SESSIONS_DIR, fresh[0]);
      console.log(`[hermit] Session closed. Report: ${newReport}`);
      closedEarly = true;
      break;
    }
  }
  if (!closedEarly) {
    console.log(`[hermit] Timeout after ${DEFAULT_TIMEOUT}s. Killing session.`);
  }

  // Re-acquire lock for final state writes and cleanup
  acquireLifecycleLock();

  // Reset always_on flag
  config.always_on = false;
  saveConfig(config);

  // Kill tmux session
  if (tmuxSessionAlive(sessionName)) {
    tmux(['kill-session', '-t', sessionName]);
    console.log(`[hermit] tmux session "${sessionName}" terminated.`);
  }

  // Mark shutdown completed in runtime.json
  const shutdownUpdates: Json = {
    session_state: 'idle',
    shutdown_completed_at: localISOStamp(),
    transition: null,
    transition_target: null,
    transition_started_at: null,
  };
  if (!newReport) shutdownUpdates.last_error = 'unclean_shutdown';
  updateRuntimeField(shutdownUpdates);

  // Show summary
  if (!newReport) {
    const report = findLatestReport();
    if (report) console.log(`[hermit] Latest report: ${report}`);
  }
  if (stats) console.log(`[hermit] Total tasks this session: ${tasks}`);

  releaseLifecycleLock();
}

if (import.meta.main) {
  await main();
}
