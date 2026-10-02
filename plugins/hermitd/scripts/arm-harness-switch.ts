import path from 'node:path';
import { ARG_RE, renderCommand, writePendingCommand, type PendingCommand } from './lib/harness-command';
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
if (runtime.runtime_mode === 'interactive') refuse('Deferred switches require a tmux resident, not interactive mode.');
if (typeof runtime.tmux_session !== 'string' || !runtime.tmux_session.trim()) refuse('No resident tmux pane is configured.');
const pending: PendingCommand = {
  command: model ? '/model' : '/effort',
  arg: model ?? effort!,
  by: 'terminal',
  requested_at: new Date().toISOString(),
  ...(model && effort ? { then: { command: '/effort' as const, arg: effort } } : {}),
};
if (!writePendingCommand(root, pending)) refuse('Could not write the pending switch.');
console.log(`At the next idle, the resident will type ${renderCommand(pending)}${pending.then ? ` then ${renderCommand(pending.then)}` : ''}.`);
