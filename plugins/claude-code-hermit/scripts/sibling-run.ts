import fs from 'node:fs';
import path from 'node:path';
import { readCoreName, siblingPluginDirs } from './lib/plugin-siblings';

const [pluginName, relativeScript, ...args] = process.argv.slice(2);
if (!relativeScript || path.isAbsolute(relativeScript) || relativeScript.includes('..') || !relativeScript.endsWith('.ts')) {
  console.error('sibling-run: expected <plugin-name> <relative.ts> [args...], without absolute paths or ..');
  process.exit(3);
}

const coreRoot = path.resolve(import.meta.dir, '..');
const matches = siblingPluginDirs(coreRoot, readCoreName(coreRoot))
  .filter(dir => readCoreName(dir) === pluginName);
if (matches.length === 0) {
  console.error(`sibling-run: no sibling plugin named ${pluginName}`);
  process.exit(2);
}
if (matches.length > 1) {
  console.error(`sibling-run: ambiguous plugin ${pluginName}:\n${matches.join('\n')}`);
  process.exit(1);
}

const script = path.join(matches[0], relativeScript);
if (!fs.existsSync(script)) {
  console.error(`sibling-run: script does not exist: ${script}`);
  process.exit(3);
}

const child = Bun.spawn([process.execPath, script, ...args], {
  stdin: 'inherit',
  stdout: 'inherit',
  stderr: 'inherit',
});
process.exit(await child.exited);
