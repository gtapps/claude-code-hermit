import path from 'node:path';
import { ARG_RE, renderCommand } from './lib/harness-command';
import { writeDeferredSwitch, type HarnessRequest } from './lib/harness-mod';
import { readRuntimeJson } from './lib/runtime';

function refuse(reason: string): never {
  console.error(reason);
  process.exit(1);
}

const [hermitDir, ...args] = process.argv.slice(2);
if (!hermitDir) refuse('A hermit directory is required.');
let model: string | undefined;
let effort: string | undefined;
for (let i = 0; i < args.length; i += 2) {
  const flag = args[i];
  const value = args[i + 1];
  if (flag !== '--model' && flag !== '--effort') refuse('Expected --model or --effort.');
  if (!value || !ARG_RE.test(value)) refuse('Model and effort must be single valid argument tokens.');
  if (flag === '--model') model = value;
  else effort = value;
}
if (!model && !effort) refuse('At least one of --model or --effort is required.');
const root = path.resolve(hermitDir);
const runtime = readRuntimeJson(path.join(root, 'state'));
if (!runtime) refuse('No runtime.json found for this hermit.');
const pending: HarnessRequest = {
  dir: root,
  commands: [
    ...(model ? [{ command: '/model', arg: model }] : []),
    ...(effort ? [{ command: '/effort', arg: effort }] : []),
  ],
  by: 'terminal',
  requested_at: new Date().toISOString(),
};
writeDeferredSwitch(root, pending);
console.log(`At the next idle, the resident mod will apply ${pending.commands.map(renderCommand).join(' then ')}.`);
