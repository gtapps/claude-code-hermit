import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { readSettledConfig, readConfigRaw } from './lib/config-read';
import { getSessionName as deriveSessionName } from './lib/tmux';
import { STATE_DIR } from './lib/runtime';

type Json = any;
const HERMIT_ROOT = path.dirname(STATE_DIR);
const CONFIG_PATH = '.hermit/config.json';

function readText(file: string): string | null {
  try { return fs.readFileSync(file, 'utf-8'); } catch { return null; }
}

// --- Install / uninstall ---

/** Read tmux session name from config for install commands. */
function getSessionName(): string {
  if (!fs.existsSync(CONFIG_PATH)) return 'hermit';
  return deriveSessionName(readSettledConfig(HERMIT_ROOT));
}

/** Locate state-templates/watchdog/ relative to this script's plugin root. */
function findTemplatesDir(): string | null {
  const candidate = path.resolve(import.meta.dir, '..', 'state-templates', 'watchdog');
  try {
    if (fs.statSync(candidate).isDirectory()) return candidate;
  } catch {}
  return null;
}

/**
 * The PATH to bake into generated units.
 *
 * systemd user services, launchd agents and cron all run with an environment
 * that does not carry ~/.bun/bin, so the bare `bun` at the end of the
 * hermitd-watchdog shim exits 127 on every tick — silently, forever. Baking a
 * PATH fixes that, but a hardcoded directory list cannot: it varies by OS, by
 * architecture (Intel vs Apple Silicon homebrew prefixes) and by how the
 * operator installed each tool. Snapshotting the installer's own environment is
 * correct by construction — cmdInstall runs under bun in the operator's shell,
 * so process.execPath is exactly the bun being used and process.env.PATH is an
 * environment where claude and tmux resolve too. The restart path needs those:
 * hermitd-start's preflight hard-fails without them.
 */
function resolveUnitPath(): string {
  const seen = new Set<string>();
  const out: string[] = [];
  // Absolute entries only: a relative one (npm/bun script wrappers prepend
  // `node_modules/.bin`) would resolve against the unit's WorkingDirectory —
  // the project root — turning a repo-writable dir into a lookup path the
  // watchdog consults every five minutes.
  for (const entry of [path.dirname(process.execPath), ...(process.env.PATH ?? '').split(path.delimiter)]) {
    if (!entry || !path.isAbsolute(entry) || seen.has(entry)) continue;
    seen.add(entry);
    out.push(entry);
  }
  return out.join(path.delimiter);
}

// One value, three renderers, three escaping grammars. systemd expands
// %-specifiers in unit files, so a literal percent must be doubled
// (systemd.unit(5)). cron converts an unescaped % to a newline and feeds
// everything after it to the command as stdin, truncating the line
// (crontab(5)). The plist value sits inside an XML <string>. Applied to every
// substituted value, not just PATH — a project path can carry the same
// characters.
const escapeSystemd = (v: string) => v.replaceAll('%', '%%');
const escapeCron = (v: string) => v.replaceAll('%', '\\%');
const escapeXml = (v: string) =>
  v.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');

function printCronFallback(root: string, unitPath: string): void {
  // The assignment must sit on the watchdog invocation itself: a shell
  // assignment prefix applies only to the single command it precedes, and `cd`
  // is a builtin, so `PATH=... cd x && cmd` leaves cmd on cron's default PATH.
  const cronLine =
    `*/5 * * * * cd "${escapeCron(root)}" && PATH="${escapeCron(unitPath)}" ` +
    `.hermit/bin/hermitd-watchdog run ` +
    `2>>.hermit/state/watchdog.log`;
  console.log('[watchdog] Add the following line via `crontab -e`:');
  console.log(`  ${cronLine}`);
  // In the Docker container this same fallback prints from the "systemctl not found"
  // branch, where /docker-setup has already set enabled: true — so only say it when it
  // is actually false.
  if (readWatchdogEnabled() === false) console.log(ENABLE_GUIDANCE);
}

const run = (cmd: string, args: string[]) => spawnSync(cmd, args, { stdio: 'inherit' });

const ENABLE_GUIDANCE =
  '[watchdog] Restarts stay off until watchdog.enabled is true — enable it via ' +
  '`/hermitd:hermit-settings watchdog`.';

/** The settled watchdog.enabled value, or undefined when the project has no config.json. */
function readWatchdogEnabled(): boolean | undefined {
  if (!fs.existsSync(CONFIG_PATH)) return undefined;
  const config: Json = readSettledConfig(HERMIT_ROOT);
  return config.watchdog?.enabled === true;
}

/**
 * Flip a watchdog boolean through the audited settings-edit path (validated, logged
 * to the settings ledger — same call /docker-setup makes). Only called from branches
 * that actually registered or removed a timer; the cron fallback prints guidance
 * instead, since flipping there would claim an activation that never happened.
 * Reads the raw on-disk value so a missing key is written rather than treated as
 * already matching the settled default. No-ops when there is no config, or the
 * raw value already matches.
 */
function setWatchdogConfig(key: 'enabled' | 'scheduler_enabled', value: boolean): void {
  if (!fs.existsSync(CONFIG_PATH)) return;
  const raw = readConfigRaw(HERMIT_ROOT);
  const current = raw?.watchdog?.[key];
  if (current === value) return;
  const r = run(process.execPath, [
    path.join(import.meta.dir, 'settings-edit.ts'),
    CONFIG_PATH,
    'set',
    `watchdog.${key}`,
    String(value),
  ]);
  if (r.status !== 0) {
    console.log(`[watchdog] Could not write watchdog.${key} to config.json — set it manually.`);
    process.exitCode = 1;
    return;
  }
  console.log(`[watchdog] ${value ? 'Enabled' : 'Disabled'} watchdog.${key} in config.json.`);
}

/**
 * After a successful timer registration: stamp scheduler_enabled true, and turn
 * the restart tier on for a *first* registration only. Re-running install is
 * the doctor's own remedy for a stale tick or an unbaked unit PATH, and hygiene-only
 * (`enabled: false` with the timer installed) is a state the doctor reports as ok — so a
 * repair run reports what is off instead of silently switching restarts on.
 */
function enableAfterInstall(firstRegistration: boolean): void {
  setWatchdogConfig('scheduler_enabled', true);
  if (firstRegistration) setWatchdogConfig('enabled', true);
  else if (readWatchdogEnabled() === false) console.log(ENABLE_GUIDANCE);
}

/** Platform-dispatching install: systemd (Linux/WSL), launchd (macOS), cron fallback. */
export function cmdInstall(): void {
  const root = fs.realpathSync(process.cwd());
  const name = getSessionName();
  const templates = findTemplatesDir();
  const unitPath = resolveUnitPath();

  const render = (templateText: string, escape: (v: string) => string) =>
    templateText
      .replaceAll('{{NAME}}', escape(name))
      .replaceAll('{{ROOT}}', escape(root))
      .replaceAll('{{UNIT_PATH}}', escape(unitPath));

  if (process.platform === 'linux') {
    if (!Bun.which('systemctl')) {
      console.log('[watchdog] systemctl not found — systemd is unavailable on this host.');
      console.log(
        '[watchdog] In the hermit Docker container the entrypoint already runs the ' +
          'watchdog on a ~5 min cycle; no install is needed there.'
      );
      printCronFallback(root, unitPath);
      return;
    }

    const systemdDir = path.join(os.homedir(), '.config', 'systemd', 'user');
    fs.mkdirSync(systemdDir, { recursive: true });
    const serviceName = `hermit-watchdog@${name}`;
    const firstRegistration = !fs.existsSync(path.join(systemdDir, `${serviceName}.timer`));

    let rendered = true;
    for (const [tplName, outName] of [
      ['hermit-watchdog@.service', `${serviceName}.service`],
      ['hermit-watchdog@.timer', `${serviceName}.timer`],
    ]) {
      if (templates) {
        const tpl = fs.readFileSync(path.join(templates, tplName), 'utf-8');
        fs.writeFileSync(path.join(systemdDir, outName), render(tpl, escapeSystemd));
      } else {
        process.stderr.write(`[watchdog] template ${tplName} not found; skipping\n`);
        rendered = false;
      }
    }

    // `systemctl --user` fails routinely over SSH (no user D-Bus session, no lingering).
    // Reporting an install that did not happen would leave the operator with a config
    // flag on and nothing behind it.
    const reloaded = run('systemctl', ['--user', 'daemon-reload']).status === 0;
    const registered = run('systemctl', ['--user', 'enable', '--now', `${serviceName}.timer`]).status === 0;
    if (!rendered || !reloaded || !registered) {
      console.log(`[watchdog] Failed to install systemd user timer: ${serviceName}.timer`);
      process.exitCode = 1;
      return;
    }
    console.log(`[watchdog] Installed systemd user timer: ${serviceName}.timer`);
    enableAfterInstall(firstRegistration);
    console.log('[watchdog] To persist across reboots without a user session: loginctl enable-linger');
  } else if (process.platform === 'darwin') {
    const launchAgents = path.join(os.homedir(), 'Library', 'LaunchAgents');
    fs.mkdirSync(launchAgents, { recursive: true });
    const label = `com.hermit.watchdog.${name}`;
    const plistName = `${label}.plist`;
    const plistPath = path.join(launchAgents, plistName);
    const firstRegistration = !fs.existsSync(plistPath);

    let plist: string;
    if (templates) {
      const tpl = fs.readFileSync(path.join(templates, 'com.hermit.watchdog.plist'), 'utf-8');
      plist = render(tpl, escapeXml);
    } else {
      process.stderr.write('[watchdog] plist template not found; using inline fallback\n');
      plist = render(
        '<?xml version="1.0" encoding="UTF-8"?>\n' +
          '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" ' +
          '"http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n' +
          '<plist version="1.0"><dict>' +
          '<key>Label</key><string>com.hermit.watchdog.{{NAME}}</string>' +
          '<key>ProgramArguments</key><array>' +
          '<string>{{ROOT}}/.hermit/bin/hermitd-watchdog</string>' +
          '<string>run</string></array>' +
          '<key>WorkingDirectory</key><string>{{ROOT}}</string>' +
          '<key>EnvironmentVariables</key><dict>' +
          '<key>PATH</key><string>{{UNIT_PATH}}</string>' +
          '</dict>' +
          '<key>StartInterval</key><integer>300</integer>' +
          '<key>RunAtLoad</key><false/>' +
          '</dict></plist>\n',
        escapeXml
      );
    }

    // Every surviving tmux boot re-runs install, and a watchdog-ordered restart
    // spawns that boot from inside the tick itself, so an unconditional reload
    // unloads the LaunchAgent executing the very restart it was told to make,
    // cutting the tick off mid-notice. A byte-identical render means there is
    // nothing to re-register, so leave the running job alone.
    //
    // Matching content alone is not enough: the write lands before the load, so a
    // failed load (or an operator's own unload) leaves the file intact with nothing
    // running, and re-running install is the documented repair for exactly that.
    // Ask launchctl whether the label is live before skipping, after the cheap
    // content compare so a drifted plist never pays for the subprocess.
    const labelLoaded = () => spawnSync('launchctl', ['list', label], { stdio: 'ignore' }).status === 0;
    if (readText(plistPath) === plist && labelLoaded()) {
      console.log(`[watchdog] LaunchAgent unchanged: ${plistName}`);
      enableAfterInstall(firstRegistration);
      return;
    }

    fs.writeFileSync(plistPath, plist);
    // load is a no-op when the label is already loaded, so re-running install —
    // the documented remedy for a bad unit — would silently keep the old plist.
    // Ignore output: on a first install there is nothing to unload.
    spawnSync('launchctl', ['unload', plistPath], { stdio: 'ignore' });
    if (run('launchctl', ['load', plistPath]).status !== 0) {
      console.log(`[watchdog] Failed to install LaunchAgent: ${plistName}`);
      process.exitCode = 1;
      return;
    }
    console.log(`[watchdog] Installed LaunchAgent: ${plistName}`);
    enableAfterInstall(firstRegistration);
  } else {
    console.log('[watchdog] systemd and launchd not available on this platform.');
    printCronFallback(root, unitPath);
  }
}

/** Remove the installed OS timer for this project. */
export function cmdUninstall(): void {
  const name = getSessionName();

  if (process.platform === 'linux') {
    if (!Bun.which('systemctl')) {
      console.log('[watchdog] systemctl not found — no systemd timer to remove.');
      console.log('[watchdog] In Docker the watchdog runs via the entrypoint loop, not an OS timer.');
      return;
    }

    const serviceName = `hermit-watchdog@${name}`;
    run('systemctl', ['--user', 'disable', '--now', `${serviceName}.timer`]);
    const systemdDir = path.join(os.homedir(), '.config', 'systemd', 'user');
    for (const suffix of ['.service', '.timer']) {
      try {
        fs.unlinkSync(path.join(systemdDir, `${serviceName}${suffix}`));
      } catch {}
    }
    run('systemctl', ['--user', 'daemon-reload']);
    console.log(`[watchdog] Removed systemd timer: ${serviceName}.timer`);
    setWatchdogConfig('scheduler_enabled', false);
    setWatchdogConfig('enabled', false);
  } else if (process.platform === 'darwin') {
    const plistName = `com.hermit.watchdog.${name}.plist`;
    const plistPath = path.join(os.homedir(), 'Library', 'LaunchAgents', plistName);
    if (fs.existsSync(plistPath)) {
      run('launchctl', ['unload', plistPath]);
      fs.unlinkSync(plistPath);
    }
    console.log(`[watchdog] Removed LaunchAgent: ${plistName}`);
    setWatchdogConfig('scheduler_enabled', false);
    setWatchdogConfig('enabled', false);
  } else {
    console.log('[watchdog] Cron entries must be removed manually with `crontab -e`.');
  }
}

