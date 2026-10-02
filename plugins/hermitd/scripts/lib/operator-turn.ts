import path from 'node:path';
import { readJson as readJSON } from './cli';

// Bound orphaned turn markers when no Stop hook arrives.
export const TURN_OPEN_TTL_MS = 60 * 60 * 1000;

export function operatorTurnOpen(hermitDir: string, nowMs: number): boolean {
  const marker = readJSON(path.join(hermitDir, 'state', 'operator-turn-open.json'));
  const at = marker && typeof marker.at === 'string' ? new Date(marker.at).getTime() : NaN;
  const age = nowMs - at;
  return age >= 0 && age <= TURN_OPEN_TTL_MS;
}
