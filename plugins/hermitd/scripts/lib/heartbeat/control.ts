import fs from 'node:fs';
import path from 'node:path';
import { readJson } from '../cli';

/** An explicit forced start applies only to the boot that requested it. */
export function effectiveHeartbeatMode(hermitDir: string): 'auto' | 'forced' | 'stopped' {
  const control = readJson(path.join(hermitDir, 'state/heartbeat-monitor.control.json'));
  if (control?.mode === 'stopped') return 'stopped';
  if (control?.mode !== 'forced') return 'auto';
  let boot: string | null = null;
  try {
    boot = fs.readFileSync(path.join(hermitDir, 'state/.boot-id'), 'utf8').trim() || null;
  } catch {}
  return (control.boot_id ?? null) === boot ? 'forced' : 'auto';
}
