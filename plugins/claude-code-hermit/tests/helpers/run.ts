// Subprocess runner for hook contract tests.
// Spawning is intentional here — these tests exercise the process boundary
// Claude Code sees (stdin in, exit code/stdout/stderr out, fail-open).
// Do not convert callers to in-process imports.

import path from 'node:path';

export const PLUGIN_ROOT = path.resolve(import.meta.dir, '../..');
export const SCRIPTS_DIR = path.join(PLUGIN_ROOT, 'scripts');
export const MONOREPO_ROOT = path.resolve(PLUGIN_ROOT, '../..');

export interface RunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface RunOptions {
  stdin?: string;
  env?: Record<string, string>;
  cwd?: string;
  args?: string[];
}

export async function runScript(script: string, opts: RunOptions = {}): Promise<RunResult> {
  const proc = Bun.spawn({
    cmd: [process.execPath, path.join(SCRIPTS_DIR, script), ...(opts.args ?? [])],
    cwd: opts.cwd,
    env: { ...process.env, ...opts.env },
    stdin: Buffer.from(opts.stdin ?? ''),
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, stdout, stderr };
}
