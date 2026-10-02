#!/usr/bin/env bash
# One-time migration of every registered 1.4.8 agent in one Claude config dir.
set -euo pipefail
for tool in bun claude; do
  command -v "$tool" >/dev/null || { echo "Required command missing: $tool" >&2; exit 1; }
done
export BUN_RUNTIME_TRANSPILER_CACHE_PATH=0
export HERMITD_MIGRATION_SOURCE
HERMITD_MIGRATION_SOURCE="$(cat <<'JS'
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const ids = {
  'claude-code-hermit': 'hermitd', 'claude-code-dev-hermit': 'hermitd-dev',
  'claude-code-homeassistant-hermit': 'hermitd-homeassistant', 'claude-code-fitness-hermit': 'hermitd-fitness',
  'feed-hermit': 'hermitd-feed', 'laravel-forge-hermit': 'hermitd-laravel-forge', 'hermit-scribe': 'hermitd-scribe',
};
const configDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
const inventoryFile = path.join(configDir, 'hermitd-migration.json');
const quote = text => `'${text.replaceAll("'", "'\\''")}'`;
const rerun = 'curl -fsSL https://gtapps.github.io/hermitd/migrate.sh | bash';
// Compose files interpolate ${PWD}, which spawnSync would otherwise inherit from the caller's shell.
function run(cmd, args, cwd = process.cwd()) {
  const result = spawnSync(cmd, args, { cwd, encoding: 'utf8', env: { ...process.env, PWD: cwd } });
  if (result.error || result.status !== 0) throw new Error(`Failed: ${[cmd, ...args].map(quote).join(' ')} (cwd ${cwd})\n${result.error?.message ?? result.stderr}`);
  return result.stdout.trim();
}
function json(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT' && fallback !== undefined) return fallback; throw error; }
}
function save(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file + '.tmp', JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(file + '.tmp', file);
}
const state = project => path.join(project, fs.existsSync(path.join(project, '.claude-code-hermit')) ? '.claude-code-hermit' : '.hermit');
const stamp = project => path.join(project, '.hermit/state/hermitd-migrated');
const done = project => fs.existsSync(stamp(project));
const pluginList = cwd => JSON.parse(run('claude', ['plugin', 'list', '--json'], cwd));
const marketplaces = () => JSON.parse(run('claude', ['plugin', 'marketplace', 'list', '--json']));
const hasMarketplace = (rows, name) => rows.some(row => row.name === name);
const compose = (project, args) => run('docker', ['compose', '-f', 'docker-compose.hermit.yml', ...args], project);
const inContainer = (project, command) => compose(project, ['run', '--rm', '--no-deps', '--entrypoint', 'bash', 'hermit', '-lc', command]);
const newId = id => `${ids[id.split('@')[0]]}@hermitd`;
function core(rows, project) {
  return rows.find(row => ['hermitd@hermitd', 'claude-code-hermit@claude-code-hermit'].includes(row.id) && row.projectPath === project)
    ?? rows.find(row => ['hermitd@hermitd', 'claude-code-hermit@claude-code-hermit'].includes(row.id));
}
function installs(rows, projects, settingsRoot = configDir) {
  return rows.filter(row => row.id.endsWith('@claude-code-hermit') && ids[row.id.split('@')[0]]).map(row => {
    const targets = row.projectPath ? [row.projectPath] : projects;
    const base = json(path.join(settingsRoot, 'settings.json'), {}).enabledPlugins ?? {};
    const enabled = targets.some(project => {
      const projectFlags = json(path.join(project, '.claude/settings.json'), {}).enabledPlugins ?? {};
      const localFlags = json(path.join(project, '.claude/settings.local.json'), {}).enabledPlugins ?? {};
      return (localFlags[row.id] ?? projectFlags[row.id] ?? base[row.id] ?? row.enabled) === true;
    });
    if (!['user', 'project', 'local'].includes(row.scope)) throw new Error(`Unsupported scope: ${row.scope}`);
    if (row.scope !== 'user' && !row.projectPath) throw new Error(`Missing projectPath: ${row.id}`);
    return { id: row.id, scope: row.scope, projectPath: row.projectPath, enabled, installPath: row.installPath };
  });
}
async function stopped(project, mode, root) {
  if (mode === 'docker') {
    if (compose(project, ['ps', '-q', 'hermit'])) throw new Error(`Agent running. Stop with: cd ${quote(project)} && docker compose -f docker-compose.hermit.yml down`);
    return;
  }
  if (!root) throw new Error(`No old core install for ${project}`);
  const probe = `import fs from 'node:fs'; import path from 'node:path'; import { residentLiveness, REAL_LIVENESS_DEPS } from ${JSON.stringify(path.join(root, 'scripts/lib/resident-liveness.ts'))}; import { LIVENESS_FRESH_SECS } from ${JSON.stringify(path.join(root, 'scripts/lib/liveness.ts'))};
    const dir=${JSON.stringify(state(project))}; const config=JSON.parse(fs.readFileSync(path.join(dir,'config.json'),'utf8'));
    let runtime=null; try { runtime=JSON.parse(fs.readFileSync(path.join(dir,'state/runtime.json'),'utf8')); } catch(e) { if(e.code!=='ENOENT') throw e; }
    const result=residentLiveness(runtime, runtime?.tmux_session || config.tmux_session_name || ${JSON.stringify('hermit-' + path.basename(project))}, REAL_LIVENESS_DEPS(dir));
    console.log(JSON.stringify({ state: result.state, wait: Math.ceil(LIVENESS_FRESH_SECS - (result.evidence.livenessAgeSecs ?? 0)) }));`;
  const { state: verdict, wait } = JSON.parse(run('bun', ['-e', probe], project));
  // Orphan means fresh liveness files but no tmux session: usually a crashed resident whose files age out.
  if (verdict === 'orphan') throw new Error(`Agent may still be running (orphan): no tmux session, but its liveness files changed recently. If no claude process is running for ${project}, rerun in ${wait}s.`);
  if (!['none', 'cleanly-stopped', 'dead'].includes(verdict)) throw new Error(`Agent running (${verdict}). Stop with: cd ${quote(project)} && ${state(project).endsWith('.hermit') ? '.hermit/bin/hermitd-stop' : '.claude-code-hermit/bin/hermit-stop'}`);
}
async function locked(project, root, action) {
  const { acquireLock, releaseLock } = await import(path.join(root, 'scripts/lib/lockfile.ts'));
  const lock = path.join(state(project), 'state/.lifecycle.lock');
  if (!acquireLock(lock)) throw new Error(`Lifecycle lock held: ${project}`);
  try { await action(); }
  finally { releaseLock(path.join(state(project), 'state/.lifecycle.lock')); }
}
function swap(record) {
  // Inspect actual state on every retry: remove/add/install can succeed and
  // still lose their acknowledgement or the following inventory write.
  let markets = marketplaces();
  if (hasMarketplace(markets, 'claude-code-hermit')) run('claude', ['plugin', 'marketplace', 'remove', 'claude-code-hermit']);
  markets = marketplaces();
  if (!hasMarketplace(markets, 'hermitd')) run('claude', ['plugin', 'marketplace', 'add', 'gtapps/hermitd']);
  // Local installs outlive their folder (a removed worktree); there is nowhere to reinstall them.
  for (const row of record.installs.filter(row => row.enabled && (!row.projectPath || fs.existsSync(row.projectPath)))) {
    const cwd = row.projectPath || process.cwd();
    const found = pluginList(cwd).some(current => current.id === newId(row.id) && current.scope === row.scope && (row.scope === 'user' || current.projectPath === row.projectPath));
    if (!found) run('claude', ['plugin', 'install', newId(row.id), '--scope', row.scope], cwd);
  }
}
function moveAndHelp(project, root) {
  const old = path.join(project, '.claude-code-hermit');
  const next = path.join(project, '.hermit');
  if (fs.existsSync(old)) {
    if (fs.existsSync(next)) throw new Error(`Both state directories exist: ${project}`);
    fs.renameSync(old, next);
  }
  return run('bun', [path.join(root, 'scripts/migrate-from-claude-code-hermit.ts'), project], project);
}
// migrate-from-claude-code-hermit.ts in installed cores ends with its own completion line; the final summary replaces it.
const notesOf = output => output.split('\n').filter(line => line && line !== 'Project migration complete.');
async function containerMain() {
  const project = process.cwd();
  const record = json(path.join(state(project), 'state/hermitd-inventory.json'));
  const root = core(pluginList(project), project)?.installPath ?? core(record.installs, project)?.installPath;
  if (!root) throw new Error('Container core install is missing');
  await locked(project, root, async () => {
    swap(record);
    const installed = core(pluginList(project), project);
    if (!installed || installed.id !== 'hermitd@hermitd') throw new Error('New container core install is missing');
    console.log(moveAndHelp(project, installed.installPath));
  });
}
async function main() {
  let inventory;
  if (fs.existsSync(inventoryFile)) inventory = json(inventoryFile);
  else {
    const rows = pluginList();
    const registry = path.join(configDir, 'plugins/data/claude-code-hermit-claude-code-hermit/instances.json');
    const registered = json(registry, []);
    const currentRegistry = json(path.join(configDir, 'plugins/data/hermitd-hermitd/instances.json'), []);
    const candidates = [...new Set([...registered, ...currentRegistry].map(row => row.project_dir).concat(rows.filter(row => (ids[row.id.split('@')[0]] || row.id === 'hermitd@hermitd') && row.projectPath).map(row => row.projectPath)))];
    // The registry keeps missing projects until pruned, and an install can predate hatch.
    // Removing the old marketplace by hand deletes its registry, so new core installs count too.
    const projects = candidates.filter(project => fs.existsSync(path.join(state(project), 'config.json')));
    for (const project of candidates.filter(project => !projects.includes(project))) console.log(`Skipped (no agent state): ${project}`);
    if (!projects.length) throw new Error('No registered agents found in this Claude config dir. If you removed the claude-code-hermit marketplace by hand, run `claude plugin marketplace add gtapps/hermitd`, then `claude plugin install hermitd@hermitd --scope local` in each agent project.');
    if (projects.every(done)) { console.log('Already migrated: every registered project has its completion stamp.'); return; }
    inventory = { version: 1, projects: [], installs: installs(rows, projects), hadMarketplace: hasMarketplace(marketplaces(), 'claude-code-hermit') };
    for (const project of projects) {
      if (fs.existsSync(path.join(project, '.claude-code-hermit')) && fs.existsSync(path.join(project, '.hermit')) && !done(project)) throw new Error(`Both state directories exist: ${project}`);
      const mode = fs.existsSync(path.join(project, 'docker-compose.hermit.yml')) ? 'docker' : 'tmux';
      // A project finished in an earlier run may be running again on the new core.
      if (done(project)) { inventory.projects.push({ project, mode, watchdog: false, installs: [] }); continue; }
      const config = json(path.join(state(project), 'config.json'));
      if (config._hermit_versions?.['claude-code-hermit'] !== '1.4.8') throw new Error(`Requires core 1.4.8: ${project}`);
      if (mode === 'docker' && !Bun.which('docker')) throw new Error('Required command missing: docker');
      const oldRoot = core(rows, project)?.installPath;
      await stopped(project, mode, oldRoot);
      let containerInstalls = [];
      if (mode === 'docker') {
        const containerRows = JSON.parse(inContainer(project, 'claude plugin list --json'));
        containerInstalls = installs(containerRows, [project]);
        if (!containerInstalls.some(row => row.id === 'claude-code-hermit@claude-code-hermit' && row.enabled)) throw new Error(`No enabled container core: ${project}`);
      }
      const session = config.tmux_session_name || `hermit-${path.basename(project)}`;
      const watchdog = ['.service', '.timer'].some(ext => fs.existsSync(path.join(os.homedir(), '.config/systemd/user', `hermit-watchdog@${session}${ext}`)))
        || fs.existsSync(path.join(os.homedir(), 'Library/LaunchAgents', `com.hermit.watchdog.${session}.plist`));
      inventory.projects.push({ project, mode, oldRoot, watchdog, installs: containerInstalls });
    }
    // No inventory or project writes occur until every preflight succeeds.
    save(inventoryFile, inventory);
  }
  // Persist every container slice before the first marketplace removal.
  for (const row of inventory.projects.filter(row => row.mode === 'docker' && !done(row.project))) {
    const file = path.join(state(row.project), 'state/hermitd-inventory.json');
    if (!fs.existsSync(file)) save(file, { installs: row.installs });
  }
  // Notes exist only for projects migrated in this run; a resumed run lost earlier ones.
  const notes = new Map();
  for (const row of inventory.projects.filter(row => row.mode === 'docker' && !done(row.project))) {
    await stopped(row.project, row.mode);
    console.log(`Migrating ${path.basename(row.project)} (Docker)...`);
    notes.set(row.project, notesOf(inContainer(row.project, `bun -e ${quote(process.env.HERMITD_MIGRATION_SOURCE)} -- --container`)));
    console.log(`Rebuilding the Docker image for ${path.basename(row.project)}. This can take several minutes.`);
    compose(row.project, ['build']);
    // A rerun before the stamp recreates the slice from the host inventory.
    fs.rmSync(path.join(state(row.project), 'state/hermitd-inventory.json'), { force: true });
    fs.writeFileSync(stamp(row.project), 'hermitd\n');
  }
  if (inventory.hadMarketplace) swap(inventory);
  let hostCore = core(pluginList());
  if (hostCore?.id !== 'hermitd@hermitd') hostCore = null;
  for (const row of inventory.projects.filter(row => row.mode === 'tmux' && !done(row.project))) {
    if (!hostCore) throw new Error(`New host core install missing for ${row.project}`);
    await stopped(row.project, row.mode, hostCore.installPath);
    console.log(`Migrating ${path.basename(row.project)} (tmux)...`);
    await locked(row.project, hostCore.installPath, async () => {
      notes.set(row.project, notesOf(moveAndHelp(row.project, hostCore.installPath)));
      fs.writeFileSync(stamp(row.project), 'hermitd\n');
    });
  }
  if (hostCore) {
    const { installHost } = await import(path.join(hostCore.installPath, 'scripts/lib/host-install.ts'));
    const { registerInMarketplace } = await import(path.join(hostCore.installPath, 'scripts/lib/host-registry.ts'));
    const first = inventory.projects[0].project;
    installHost(first, hostCore.installPath, { id: hostCore.id, scope: hostCore.scope, projectPath: hostCore.projectPath });
    const shim = path.join(os.homedir(), '.local/bin/hermitd');
    if (!fs.existsSync(shim) || !fs.readFileSync(shim, 'utf8').split('\n').includes('# hermitd: managed host CLI')) throw new Error(`Host CLI installation did not complete: ${shim}`);
    for (const row of inventory.projects) {
      registerInMarketplace('hermitd', row.project, row.mode);
      if (row.mode === 'tmux' && row.watchdog) run('bun', [path.join(hostCore.installPath, 'scripts/hermitd-watchdog.ts'), 'install'], row.project);
    }
  } else {
    // Docker-only hosts still need a host registry. Execute its sole writer in
    // a one-off container, pointing it at a dedicated mount of host config.
    for (const row of inventory.projects) {
      const code = `const rows=JSON.parse(require('child_process').execFileSync('claude',['plugin','list','--json'],{encoding:'utf8'}));
        const root=rows.find(r=>r.id==='hermitd@hermitd')?.installPath;if(!root)throw new Error('No container core');
        const {registerInMarketplace}=await import(root+'/scripts/lib/host-registry.ts');
        process.env.CLAUDE_CONFIG_DIR='/hermitd-host-config';delete process.env.CLAUDE_CODE_PLUGIN_CACHE_DIR;
        registerInMarketplace('hermitd',${JSON.stringify(row.project)},'docker');`;
      compose(row.project, ['run', '--rm', '--no-deps', '-v', `${configDir}:/hermitd-host-config`, '--entrypoint', 'bash', 'hermit', '-lc', `bun -e ${quote(code)}`]);
    }
  }
  const oldShim = path.join(os.homedir(), '.local/bin/hermit');
  const shimRemoved = fs.existsSync(oldShim) && !fs.lstatSync(oldShim).isSymbolicLink() && fs.readFileSync(oldShim, 'utf8').split('\n').includes('# claude-code-hermit: managed host CLI');
  if (shimRemoved) fs.unlinkSync(oldShim);
  if (!inventory.projects.every(row => done(row.project))) throw new Error('Incomplete migration: a project stamp is missing');
  const renames = rows => [...new Set(rows.filter(row => row.enabled).map(row => `${row.id.split('@')[0]} -> ${newId(row.id).split('@')[0]}`))].join(', ');
  console.log(`\nMigrated ${inventory.projects.length} agent${inventory.projects.length === 1 ? '' : 's'}:`);
  for (const row of inventory.projects) {
    const docker = row.mode === 'docker';
    const plugins = renames(docker ? row.installs : inventory.installs.filter(install => install.scope === 'user' || install.projectPath === row.project));
    console.log(`\n${path.basename(row.project)} (${docker ? 'Docker' : 'tmux'})`);
    console.log('  State folder: .claude-code-hermit/ -> .hermit/');
    if (plugins) console.log(`  Plugins${docker ? ' in container' : ''}: ${plugins}`);
    else if (!docker && !inventory.hadMarketplace) console.log('  Plugins: none reinstalled, the old marketplace was already removed.\n    Reinstall siblings with: claude plugin install <name>@hermitd --scope local');
    console.log(`  Launchers: bin/hermit-* -> bin/hermitd-*${docker ? ', Docker entrypoint refreshed, image rebuilt' : hostCore && row.watchdog ? ', watchdog reinstalled' : ''}`);
    for (const line of notes.get(row.project) ?? ['(details printed in an earlier run)']) console.log(`  ${line}`);
    console.log(`  Start: cd ${quote(row.project)} && ${docker ? '.hermit/bin/hermitd-docker up' : 'hermitd start'}`);
  }
  console.log(`\nHost: ${hostCore ? `hermitd CLI installed at ~/.local/bin/hermitd${shimRemoved ? ', old hermit shim removed' : ''}` : 'hermitd CLI not installed; run the installer'}.`);
  for (const row of [...inventory.installs, ...inventory.projects.flatMap(row => row.installs)].filter(row => !row.enabled)) console.log(`Disabled install not reinstalled: ${row.id} (${row.scope}${row.projectPath ? ', ' + row.projectPath : ''})`);
  fs.unlinkSync(inventoryFile);
  console.log('\nNext: run /hermitd:hermit-evolve in each agent.');
}
try {
  if (process.argv.includes('--container')) await containerMain(); else await main();
} catch (error) {
  console.error(String(error));
  console.error(`Resume with: ${rerun}`);
  process.exitCode = 1;
}
JS
)"
bun -e "$HERMITD_MIGRATION_SOURCE"
