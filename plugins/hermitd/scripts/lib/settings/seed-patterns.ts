import path from 'node:path';
import { readJson } from '../cli';

export function readSeedPatterns(pluginRoot: string): { deny: string[]; ask: string[] } {
  const patterns = readJson(path.join(pluginRoot, 'state-templates', 'deny-patterns.json'));
  return {
    deny: Array.isArray(patterns?.deny) ? patterns.deny : [],
    ask: Array.isArray(patterns?.ask) ? patterns.ask : [],
  };
}
