import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export type ProcEntry = { ppid: number; name: string };
export type ProcReader = (pid: number) => ProcEntry | null;

/** Linux: `comm` from /proc; the parenthesized comm in `stat` may contain spaces or closing parentheses. */
export function procfsReader(procRoot: string): ProcReader {
  return (pid) => {
    try {
      const dir = path.join(procRoot, String(pid));
      const name = fs.readFileSync(path.join(dir, 'comm'), 'utf8').trim();
      const stat = fs.readFileSync(path.join(dir, 'stat'), 'utf8');
      const fields = stat.slice(stat.lastIndexOf(')') + 1).trim().split(/\s+/);
      return { ppid: Number(fields[1]), name };
    } catch {
      return null;
    }
  };
}

/** Parses one `ps -o ppid= -o comm=` row; macOS prints comm as the invoked path, so compare its basename. */
export function parsePsRow(row: string): ProcEntry | null {
  const m = row.trim().match(/^(\d+)\s+(.+)$/);
  return m ? { ppid: Number(m[1]), name: path.basename(m[2].trim()) } : null;
}

/** Platforms without /proc (macOS). */
export const psReader: ProcReader = (pid) => {
  const r = spawnSync('ps', ['-o', 'ppid=', '-o', 'comm=', '-p', String(pid)], { encoding: 'utf8', timeout: 5000 });
  return r.status === 0 ? parsePsRow(r.stdout) : null;
};

/** Find the closest named process, including startPid, without trusting older ancestors. */
export function residentAncestorPid(startPid: number, read: ProcReader, comm = 'claude'): number | null {
  const visited = new Set<number>();
  let pid = startPid;
  while (Number.isSafeInteger(pid) && pid > 0 && !visited.has(pid)) {
    visited.add(pid);
    const entry = read(pid);
    if (!entry) return null;
    if (entry.name === comm) return pid;
    pid = entry.ppid;
  }
  return null;
}

if (import.meta.main) {
  try {
    const runtime = JSON.parse(fs.readFileSync(path.join(process.argv[2], 'state/runtime.json'), 'utf8'));
    const read = fs.existsSync('/proc/self/stat') ? procfsReader('/proc') : psReader;
    const ancestor = residentAncestorPid(process.ppid, read);
    process.exit(ancestor !== null && ancestor === runtime.session_pid ? 0 : 1);
  } catch {
    process.exit(1);
  }
}
