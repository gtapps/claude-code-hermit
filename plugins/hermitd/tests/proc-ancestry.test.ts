import { describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { parsePsRow, procfsReader, residentAncestorPid } from '../scripts/lib/proc-ancestry';
import { PLUGIN_ROOT, SCRIPTS_DIR } from './helpers/run';

function fixture(): string {
  return fs.mkdtempSync(path.join(PLUGIN_ROOT, '.monitor-test-'));
}

describe('proc-ancestry', () => {
  test('returns the nearest claude and parses parent comms containing spaces', () => {
    const dir = fixture();
    try {
      for (const [pid, ppid, comm] of [[40, 30, 'bash'], [30, 20, 'tmux: server'], [20, 10, 'claude'], [10, 1, 'claude']] as const) {
        fs.mkdirSync(path.join(dir, String(pid)));
        fs.writeFileSync(path.join(dir, String(pid), 'comm'), `${comm}\n`);
        fs.writeFileSync(path.join(dir, String(pid), 'stat'), `${pid} (${comm}) S ${ppid} 0 0\n`);
      }
      expect(residentAncestorPid(40, procfsReader(dir))).toBe(20);
      expect(residentAncestorPid(10, procfsReader(dir))).toBe(10);
      expect(residentAncestorPid(999, procfsReader(dir))).toBeNull();
    } finally {
      fs.rmSync(dir, { recursive: true });
    }
  });

  test('ps rows compare the basename of the invoked command', () => {
    const rows: Record<number, string> = {
      40: '   30 /bin/bash\n',
      30: '   20 /Users/op/.local/bin/claude\n',
      20: '    1 claude\n',
    };
    const read = (pid: number) => (rows[pid] ? parsePsRow(rows[pid]) : null);
    expect(residentAncestorPid(40, read)).toBe(30);
    expect(residentAncestorPid(20, read)).toBe(20);
    expect(parsePsRow('')).toBeNull();
  });
});

// The launcher renames a real process with Linux prctl, so these run where /proc exists.
describe('monitor-supervisor', () => {
  for (const scenario of ['missing', 'further', 'nearest', 'stopped', 'fallback', 'guest']) {
    test.skipIf(process.platform !== 'linux')(`${scenario} resident identity and control`, async () => {
      const dir = fixture();
      try {
        fs.mkdirSync(path.join(dir, 'state'));
        const stub = path.join(dir, 'due.ts');
        fs.writeFileSync(stub, 'await Bun.write(`${process.argv[2]}/ran`, "yes");\n');
        // Two real named ancestors exercise the production /proc guard without
        // an environment override that could let a guest bypass it.
        const launcher = path.join(dir, 'launch.py');
        fs.writeFileSync(launcher, `import ctypes, json, os, subprocess, sys
ctypes.CDLL(None).prctl(15, b'claude', 0, 0, 0)
outer = os.getpid()
child = os.fork()
if child:
    _, status = os.waitpid(child, 0)
    sys.exit(os.waitstatus_to_exitcode(status))
directory, scenario, supervisor = sys.argv[1:]
runtime = {} if scenario == 'missing' else {'session_pid': outer if scenario == 'further' else os.getpid()}
with open(directory + '/state/runtime.json', 'w') as f:
    json.dump(runtime, f)
if scenario in ['stopped', 'fallback']:
    name = 'heartbeat-monitor.control.json' if scenario == 'stopped' else 'routine-monitor.runtime.json'
    with open(directory + '/state/' + name, 'w') as f:
        json.dump({'mode': 'stopped' if scenario == 'stopped' else 'croncreate-fallback'}, f)
sys.exit(subprocess.call(['bash', supervisor, 'heartbeat' if scenario == 'stopped' else 'routines', directory]))
`);
        const proc = Bun.spawn({
          cmd: ['python3', launcher, dir, scenario, path.join(SCRIPTS_DIR, 'monitor-supervisor.sh')],
          env: {
            ...process.env,
            HERMIT_RESIDENT: scenario === 'guest' ? '' : '1',
            MONITOR_SUPERVISOR_ONCE: '1',
            ROUTINE_MONITOR_ONCE: '1',
            HEARTBEAT_MONITOR_ONCE: '1',
            ROUTINE_DUE_SCRIPT: stub,
          },
          stdout: 'pipe', stderr: 'pipe',
        });
        const [stdout, stderr, code] = await Promise.all([
          new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited,
        ]);
        expect(code).toBe(0);
        expect(stdout).toBe('');
        expect(stderr).toBe('');
        expect(fs.existsSync(path.join(dir, 'ran'))).toBe(scenario === 'nearest');
        expect(fs.existsSync(path.join(dir, 'state/heartbeat-liveness.json'))).toBe(false);
      } finally {
        fs.rmSync(dir, { recursive: true });
      }
    });
  }
});
