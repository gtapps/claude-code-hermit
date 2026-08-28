// hatch-report.ts — renders hatch's two operator-facing summaries.
//
//   confirm  (stdin: the answers payload) — the Quick-branch preview shown
//            BEFORE anything is written. It is explicitly a statement of intent,
//            so it renders what the operator chose, phrased as "will apply".
//
//   final    (no stdin) — the end-of-hatch report. It renders what is actually
//            on disk, by looking. It takes no file list from its caller: the
//            report used to be composed by the model, which could claim a file
//            was written that the operator had declined. Everything below is a
//            filesystem observation, so it says "Present"/"Configured" and can
//            only be wrong if the filesystem is.
//
// Usage:
//   bun hatch-report.ts confirm <project-root> < answers.json
//   bun hatch-report.ts final <project-root> --deployment <docker|tmux|interactive>
//
// `--deployment` is passed explicitly because it is wizard-only state: the Quick
// branch asks for it, nothing persists it (neither config.json nor
// hatch-options.json carry it), and the Step-10 next-steps block keys off it.
// Anything else the report needs, it reads.

import fs from 'node:fs';
import path from 'node:path';
import { readStdin, readJson, flagValue } from './lib/cli';
import { readConfigRaw } from './lib/config-read';

type Json = any;

const DEPLOYMENTS = ['docker', 'tmux', 'interactive'];
const CLAUDE_MARKER = 'claude-code-hermit: Session Discipline';
const WORKTREE_MARKER = '# >>> claude-code-hermit';

function has(file: string, needle: string): boolean {
  try { return fs.readFileSync(file, 'utf8').includes(needle); } catch { return false; }
}

function exists(p: string): boolean {
  try { fs.accessSync(p); return true; } catch { return false; }
}

/** What hatch actually left on disk, observed rather than reported. */
export interface Observed {
  stateDir: boolean;
  config: Json | null;
  hatchOptions: Json | null;
  claudeBlock: 'CLAUDE.md' | 'CLAUDE.local.md' | null;
  gitignore: boolean;
  worktreeinclude: boolean;
  settingsFile: string | null;
  gitRepo: boolean;
  binScripts: string[];
}

export function observe(root: string): Observed {
  const hermit = path.join(root, '.claude-code-hermit');
  const settingsCandidates = ['.claude/settings.local.json', '.claude/settings.json'];
  const settingsFile = settingsCandidates.find(f => has(path.join(root, f), 'claude-code-hermit')) ?? null;

  let binScripts: string[] = [];
  try { binScripts = fs.readdirSync(path.join(hermit, 'bin')).sort(); } catch { /* not scaffolded */ }

  return {
    stateDir: exists(hermit),
    // Raw, not settled: a null config here IS the "hatch did not complete" signal.
    config: readConfigRaw(hermit),
    hatchOptions: readJson(path.join(hermit, 'state', 'hatch-options.json')),
    claudeBlock: has(path.join(root, 'CLAUDE.md'), CLAUDE_MARKER) ? 'CLAUDE.md'
      : has(path.join(root, 'CLAUDE.local.md'), CLAUDE_MARKER) ? 'CLAUDE.local.md'
      : null,
    gitignore: has(path.join(root, '.gitignore'), '.claude-code-hermit'),
    worktreeinclude: has(path.join(root, '.worktreeinclude'), WORKTREE_MARKER),
    settingsFile,
    gitRepo: exists(path.join(root, '.git')),
    binScripts,
  };
}

function line(label: string, value: string): string {
  return `  ${(label + ':').padEnd(20)}${value}`;
}

function channelSummary(config: Json): string {
  const channels = config?.channels ?? {};
  const names = Object.keys(channels).filter(k => k !== 'primary');
  if (!names.length) return 'none';
  const on = names.filter(n => channels[n]?.enabled);
  return on.length ? on.join(', ') : `${names.join(', ')} (not enabled)`;
}

export function renderConfirm(answers: Json): string {
  const out: string[] = ['Quick setup will apply:', ''];
  const identity = [answers.agent_name ?? 'no name', answers.language, answers.timezone]
    .filter(Boolean).join(', ');
  out.push(line('Identity', identity + (answers.sign_off ? `, sign-off="${answers.sign_off}"` : '')));
  out.push(line('Behavior', `idle=${answers.idle_behavior ?? 'discover'}, escalation + remote at template defaults`));
  out.push(line('Deployment', `${answers.deployment ?? 'interactive'}, permission=${answers.permission_mode ?? 'auto'}`));
  out.push(line('Channel', answers.channel && answers.channel !== 'none'
    ? `${answers.channel} (allow-everyone; token + pairing later)` : 'none'));
  out.push(line('Plugins', answers.plugins?.length ? answers.plugins.join(', ') : 'all recommended'));
  out.push(line('Routines', answers.routines?.enabled === false
    ? 'heartbeat re-arm only' : 'morning, evening, heartbeat re-arm'));
  out.push(line('Visibility', answers.hatch_target === 'committed'
    ? 'committed files' : '.local files (gitignored)'));
  if (answers.activated_hermit?.slug) out.push(line('Hermit ext', answers.activated_hermit.slug));
  if (answers.git_init) out.push(line('Git', 'initialize a local repo here'));
  out.push('');
  out.push('Nothing has been written yet. Customize restarts the wizard in Advanced;');
  out.push('your Quick answers will not carry over.');
  return out.join('\n');
}

export function renderFinal(o: Observed, deployment: string): string {
  const c = o.config ?? {};
  const out: string[] = [];

  if (!o.stateDir || !o.config) {
    // Never claim success the filesystem doesn't support.
    return 'Hatch did not complete — .claude-code-hermit/config.json is not present.\n' +
      'Re-run /claude-code-hermit:hatch; nothing below would be accurate.';
  }

  out.push('Autonomous agent initialized.', '');
  out.push('Identity:');
  out.push(line('Agent name', c.agent_name ?? 'none'));
  out.push(line('Language', c.language ?? 'none'));
  out.push(line('Timezone', c.timezone ?? 'none'));
  out.push(line('Escalation', c.escalation ?? 'balanced'));
  out.push(line('Sign-off', c.sign_off ?? 'none'));
  out.push('');

  out.push('Configured:');
  out.push(line('Channels', channelSummary(c)));
  out.push(line('Push notifications', c.push_notifications === false ? 'disabled' : 'enabled'));
  out.push(line('Heartbeat', c.heartbeat?.enabled ? `every ${c.heartbeat.every}` : 'disabled'));
  out.push(line('Permission mode', c.permission_mode ?? 'auto'));
  out.push(line('Routines', `${(c.routines ?? []).length} registered`));
  out.push(line('Scheduled checks', `${(c.scheduled_checks ?? []).length} registered`));
  out.push(line('Hermit ext', Object.keys(c._hermit_versions ?? {}).filter(k => k !== 'claude-code-hermit').join(', ') || 'none'));
  out.push('');

  // Every row below is a filesystem observation. "Present" rather than
  // "Created" — this runs after the fact and cannot know who wrote a file, only
  // that it is there. A declined step correctly reports "not present".
  out.push('Present on disk:');
  out.push(line('State dir', `.claude-code-hermit/ (${o.binScripts.length} bin scripts)`));
  out.push(line('CLAUDE block', o.claudeBlock ?? 'not present'));
  out.push(line('.gitignore', o.gitignore ? 'hermit entries present' : 'not present'));
  out.push(line('.worktreeinclude', o.worktreeinclude ? 'managed block present' : 'not present'));
  out.push(line('Settings', o.settingsFile ?? 'no hermit permissions found'));
  out.push(line('Target', o.hatchOptions?.target ?? 'not stamped'));
  out.push(line('Git repo', o.gitRepo ? 'present' : 'not present'));
  out.push('');

  out.push('Next steps:');
  // Hatch installs the recommended plugins mid-run, and Claude Code only exposes
  // them to the *current* session after a reload — so this line goes first, ahead
  // of anything that would use them.
  out.push('  /reload-plugins                      load newly installed plugins in this session');
  if (deployment === 'docker') {
    out.push('  /claude-code-hermit:docker-setup      build and start the container');
  } else if (deployment === 'tmux') {
    out.push('  .claude-code-hermit/bin/hermit-start  boot the always-on session');
    // Always-on on a bare host is two moves, not one: hermit-start boots the
    // session, the watchdog timer is what brings it back after a crash or a
    // reboot. Docker gets the equivalent from restart: unless-stopped, so this
    // line belongs to the tmux branch alone.
    out.push('  .claude-code-hermit/bin/hermit-watchdog install  register the restart timer');
    if (channelSummary(c) !== 'none') out.push('  /claude-code-hermit:channel-setup     set the bot token and pair');
  } else {
    if (channelSummary(c) !== 'none') out.push('  /claude-code-hermit:channel-setup     set the bot token and pair');
    out.push('  /claude-code-hermit:session           start working');
  }
  out.push('');
  out.push('  Anytime: /hermit-settings to change settings, /hermit-evolve after plugin');
  out.push('  updates, /smoke-test to troubleshoot. Refine OPERATOR.md by telling me what changed.');

  return out.join('\n');
}

async function main(): Promise<void> {
  const verb = process.argv[2];
  const root = process.argv[3];

  if (!verb || !root) {
    console.error('Usage: bun hatch-report.ts <confirm|final> <project-root> [--deployment <d>]');
    process.exit(1);
  }

  if (verb === 'confirm') {
    const raw = await readStdin();
    let answers: Json = {};
    try { answers = JSON.parse(raw); } catch {
      console.error('confirm requires the answers payload as JSON on stdin');
      process.exit(1);
    }
    process.stdout.write(renderConfirm(answers) + '\n');
    return;
  }

  if (verb === 'final') {
    const deployment = flagValue(process.argv.slice(4), '--deployment') ?? 'interactive';
    if (!DEPLOYMENTS.includes(deployment)) {
      console.error(`--deployment must be one of ${DEPLOYMENTS.join('|')}`);
      process.exit(1);
    }
    process.stdout.write(renderFinal(observe(root), deployment) + '\n');
    return;
  }

  console.error(`Unknown verb "${verb}" — expected confirm or final`);
  process.exit(1);
}

if (import.meta.main) main();
