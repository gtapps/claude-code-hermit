import { afterAll, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const roots: string[] = [];
afterAll(() => { for (const root of roots) fs.rmSync(root, { recursive: true }); });
const repo = path.resolve(import.meta.dir, '../..');
const core = path.join(repo, 'plugins/hermitd');
function write(file: string, text: string) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text, { mode: 0o755 }); }
const claudeStub = `#!/usr/bin/env bun
import fs from 'node:fs'; import path from 'node:path';
const file=path.join(process.env.CLAUDE_CONFIG_DIR,'stub.json');const db=JSON.parse(fs.readFileSync(file,'utf8'));const args=process.argv.slice(2);
const where=process.env.IN_CONTAINER?'docker':'host';
function mutate(label){fs.writeFileSync(file,JSON.stringify(db));fs.appendFileSync(process.env.CALLS,where+':'+label+'\\n');
if(process.env.FAIL_AT===where+':'+label&&!fs.existsSync(process.env.FAIL_ONCE)){fs.writeFileSync(process.env.FAIL_ONCE,'1');process.exit(17);}}
if(args.join(' ')==='plugin list --json'){console.log(JSON.stringify(db.installs));}
else if(args.join(' ')==='plugin marketplace list --json'){console.log(JSON.stringify(db.markets.map(name=>({name}))));}
else if(args[1]==='marketplace'&&args[2]==='remove'){db.markets=db.markets.filter(n=>n!==args[3]);db.installs=db.installs.filter(r=>!r.id.endsWith('@'+args[3]));mutate('remove');}
else if(args[1]==='marketplace'&&args[2]==='add'){db.markets.push('hermitd');mutate('add');}
else if(args[1]==='install'){const scope=args[4];const row={id:args[2],scope,enabled:true,installPath:process.env.NEW_CORE};if(scope!=='user')row.projectPath=process.cwd();db.installs.push(row);mutate('install:'+args[2]+':'+scope);}
else {console.error(args);process.exit(2);}
`;
// Real bun, not the sh wrapper: sh resets an inherited PWD that real docker would see.
const dockerStub = `#!/usr/bin/env -S \${REAL_BUN}
import fs from 'node:fs'; import {spawnSync} from 'node:child_process';
const args=process.argv.slice(2);if(args.slice(0,3).join(' ')!=='compose -f docker-compose.hermit.yml'||process.env.PWD!==process.cwd())process.exit(2);
if(args[3]==='ps'){if(process.env.RUNNING==='docker')console.log('container');}
else if(args[3]==='build'){fs.appendFileSync(process.env.CALLS,'docker:build\\n');if(process.env.FAIL_AT==='docker:build'&&!fs.existsSync(process.env.FAIL_ONCE)){fs.writeFileSync(process.env.FAIL_ONCE,'1');process.exit(17);}}
else if(args[3]==='run'){
if(!args.includes('--rm')||!args.includes('--no-deps')||!args.includes('--entrypoint')||args.at(-2)!=='-lc')process.exit(2);
const command=args.at(-1).replaceAll('/hermitd-host-config',process.env.HOST_CONFIG);
const result=spawnSync('bash',['-c',command],{cwd:process.cwd(),env:{...process.env,IN_CONTAINER:'1',CLAUDE_CONFIG_DIR:process.env.DOCKER_CONFIG},stdio:'inherit'});process.exit(result.status??1);
}else process.exit(2);
`;
function fixture(dockerOnly = false) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hermitd-host-migrate-')); roots.push(home);
  const config = path.join(home, 'config'); const dockerConfig = path.join(home, 'docker-config');
  const oldCore = path.join(home, 'old-core');
  const newCore = path.join(home, 'plugins/cache/hermitd/hermitd/1.4.8');
  fs.mkdirSync(path.dirname(newCore), { recursive: true }); fs.symlinkSync(core, newCore, 'dir');
  write(path.join(oldCore, 'scripts/lib/resident-liveness.ts'), `export { residentLiveness, REAL_LIVENESS_DEPS } from ${JSON.stringify(path.join(core, 'scripts/lib/resident-liveness.ts'))};`);
  write(path.join(oldCore, 'scripts/lib/liveness.ts'), `export { LIVENESS_FRESH_SECS } from ${JSON.stringify(path.join(core, 'scripts/lib/liveness.ts'))};`);
  write(path.join(oldCore, 'scripts/lib/lockfile.ts'), `export { acquireLock, releaseLock } from ${JSON.stringify(path.join(core, 'scripts/lib/lockfile.ts'))};`);
  const projects = (dockerOnly ? ['docker'] : ['one', 'two', 'docker']).map(name => path.join(home, name));
  for (const project of projects) {
    write(path.join(project, '.claude-code-hermit/config.json'), JSON.stringify({ agent_name: path.basename(project), _hermit_versions: { 'claude-code-hermit': '1.4.8' } }));
    write(path.join(project, '.claude-code-hermit/state/template-manifest.json'), JSON.stringify({ version: 1, files: { 'bin/hermit-run': { sha256: '0'.repeat(64), plugin_version: '1.4.8' } } }));
    write(path.join(project, '.claude-code-hermit/state/runtime.json'), JSON.stringify({ runtime_mode: 'tmux', shutdown_completed_at: '2026-10-02' }));
    write(path.join(project, '.claude/settings.json'), JSON.stringify({ enabledPlugins: { 'claude-code-hermit@claude-code-hermit': true, 'feed-hermit@claude-code-hermit': false } }));
  }
  const docker = projects.at(-1)!; write(path.join(docker, 'docker-compose.hermit.yml'), 'services: {}');
  const installs = dockerOnly ? [] : [
    { id: 'claude-code-hermit@claude-code-hermit', scope: 'project', projectPath: projects[0], enabled: true, installPath: oldCore },
    { id: 'claude-code-hermit@claude-code-hermit', scope: 'user', enabled: true, installPath: oldCore },
    { id: 'claude-code-dev-hermit@claude-code-hermit', scope: 'local', projectPath: projects[1], enabled: true, installPath: oldCore },
    { id: 'feed-hermit@claude-code-hermit', scope: 'project', projectPath: projects[0], enabled: false, installPath: oldCore },
  ];
  write(path.join(config, 'stub.json'), JSON.stringify({ markets: dockerOnly ? [] : ['claude-code-hermit'], installs }));
  write(path.join(dockerConfig, 'stub.json'), JSON.stringify({ markets: ['claude-code-hermit'], installs: [
    { id: 'claude-code-hermit@claude-code-hermit', scope: 'project', projectPath: docker, enabled: true, installPath: oldCore },
    { id: 'claude-code-hermit@claude-code-hermit', scope: 'local', projectPath: path.join(docker, '.claude/worktrees/removed'), enabled: true, installPath: oldCore },
  ] }));
  write(path.join(config, 'plugins/data/claude-code-hermit-claude-code-hermit/instances.json'), JSON.stringify(projects.map(project_dir => ({ project_dir, name: path.basename(project_dir) }))));
  const bin = path.join(home, 'bin');
  const faultModule = path.join(home, 'fault.ts');
  write(faultModule, `import fs from 'node:fs';
const originalWrite=fs.writeFileSync.bind(fs);const originalExists=fs.existsSync.bind(fs);
for(const method of ['renameSync','writeFileSync']){const original=fs[method].bind(fs);fs[method]=(...args)=>{
  const result=original(...args);const file=String(args[method==='renameSync'?1:0]);const kind=process.env.FAIL_FILE;
  const matches=kind && (kind==='move' ? method==='renameSync'&&file.endsWith('/.hermit') : file.endsWith(kind));
  if(matches&&!originalExists(process.env.FAIL_ONCE)){originalWrite(process.env.FAIL_ONCE,'1');throw new Error('Injected after mutation: '+file);}
  return result;
};}`);
  write(path.join(bin, 'bun'), '#!/bin/sh\nexec "$REAL_BUN" --preload "$FAULT_MODULE" "$@"\n');
  write(path.join(bin, 'claude'), claudeStub); write(path.join(bin, 'docker'), dockerStub);
  write(path.join(bin, 'tmux'), '#!/bin/sh\n[ "$RUNNING" = tmux ]\n');
  write(path.join(home, '.local/bin/hermit'), '#!/bin/sh\necho foreign\n');
  const env = { ...process.env, HOME: home, CLAUDE_CONFIG_DIR: config, CLAUDE_CODE_PLUGIN_CACHE_DIR: '', HERMIT_PLUGIN_ROOT: '', container: '', PATH: [bin, `${home}/.local/bin`, ...process.env.PATH!.split(':').filter(dir => dir !== path.join(os.homedir(), '.local/bin'))].join(':'), REAL_BUN: process.execPath, FAULT_MODULE: faultModule, NEW_CORE: newCore, HOST_CONFIG: config, DOCKER_CONFIG: dockerConfig, CALLS: path.join(home, 'calls'), FAIL_ONCE: path.join(home, 'failed-once'), IN_CONTAINER: '', RUNNING: '' };
  async function run(extra: Record<string, string> = {}) {
    const child = Bun.spawn(['bash', path.join(repo, 'scripts/migrate.sh')], { cwd: home, env: { ...env, ...extra }, stdout: 'pipe', stderr: 'pipe' });
    const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    return { stdout, stderr, exitCode };
  }
  return { home, config, projects, run, newCore, calls: () => fs.existsSync(env.CALLS) ? fs.readFileSync(env.CALLS, 'utf8') : '' };
}
function snapshot(root: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const name of fs.readdirSync(root, { recursive: true }) as string[]) {
    const file = path.join(root, name); const stat = fs.lstatSync(file);
    if (stat.isFile()) result[name] = fs.readFileSync(file).toString('base64');
  }
  return result;
}
function complete(f: ReturnType<typeof fixture>) {
  for (const project of f.projects) expect(fs.existsSync(path.join(project, '.hermit/state/hermitd-migrated'))).toBe(true);
  for (const project of f.projects) expect(fs.existsSync(path.join(project, '.hermit/state/hermitd-inventory.json'))).toBe(false);
  expect(fs.existsSync(path.join(f.config, 'hermitd-migration.json'))).toBe(false);
  const rows = JSON.parse(fs.readFileSync(path.join(f.config, 'plugins/data/hermitd-hermitd/instances.json'), 'utf8'));
  expect(rows.map((row: any) => row.project_dir).sort()).toEqual([...f.projects].sort());
}
test('all agents migrate, disabled installs are reported, foreign shim survives, stamps gate already-migrated', async () => {
  const f = fixture(); const result = await f.run();
  expect(result.stderr).toBe(''); expect(result.exitCode).toBe(0); complete(f);
  expect(result.stdout).toContain('Disabled install not reinstalled: feed-hermit');
  expect(result.stdout).toContain('Rebuilding the Docker image for docker.');
  expect(result.stdout).toContain('Migrated 3 agents:');
  expect(result.stdout).toContain('two (tmux)');
  expect(result.stdout).toContain('Plugins: claude-code-hermit -> hermitd, claude-code-dev-hermit -> hermitd-dev');
  expect(result.stdout).toContain('Plugins in container: claude-code-hermit -> hermitd\n');
  expect(result.stdout).not.toContain('Project migration complete.');
  expect(f.calls()).not.toContain('install:hermitd-feed');
  expect(fs.readFileSync(path.join(f.home, '.local/bin/hermit'), 'utf8')).toContain('foreign');
  const again = await f.run(); expect(again.exitCode).toBe(0); expect(again.stdout).toContain('Already migrated');
  fs.unlinkSync(path.join(f.projects[0], '.hermit/state/hermitd-migrated'));
  const incomplete = await f.run(); expect(incomplete.exitCode).toBe(1); expect(incomplete.stdout).not.toContain('Already migrated');
});
test('registry entries without agent state are skipped', async () => {
  const f = fixture();
  const registry = path.join(f.config, 'plugins/data/claude-code-hermit-claude-code-hermit/instances.json');
  const gone = path.join(f.home, 'deleted-project');
  write(registry, JSON.stringify([...JSON.parse(fs.readFileSync(registry, 'utf8')), { project_dir: gone, name: 'deleted-project' }]));
  const result = await f.run();
  expect(result.stderr).toBe(''); expect(result.exitCode).toBe(0); complete(f);
  expect(result.stdout).toContain(`Skipped (no agent state): ${gone}`);
});
test('Docker-only host registers projects and reports missing host CLI', async () => {
  const f = fixture(true); const result = await f.run();
  expect(result.stderr).toBe(''); expect(result.exitCode).toBe(0); complete(f);
  expect(result.stdout).toContain('Host: hermitd CLI not installed; run the installer.');
  expect(f.calls()).not.toContain('host:remove');
});
test('old marketplace removed by hand: new core installs stand in for the deleted registry', async () => {
  const f = fixture();
  fs.rmSync(path.join(f.config, 'plugins/data/claude-code-hermit-claude-code-hermit'), { recursive: true });
  const installs = f.projects.map(projectPath => ({ id: 'hermitd@hermitd', scope: 'local', projectPath, enabled: true, installPath: f.newCore }));
  write(path.join(f.config, 'stub.json'), JSON.stringify({ markets: ['hermitd'], installs }));
  const result = await f.run();
  expect(result.stderr).toBe(''); expect(result.exitCode).toBe(0); complete(f);
  expect(f.calls()).not.toContain('host:remove');
  expect(result.stdout).toContain('Plugins: none reinstalled, the old marketplace was already removed.');
});
test('an agent found after others migrated is migrated without rechecking them', async () => {
  const f = fixture(true);
  expect((await f.run()).exitCode).toBe(0);
  const late = path.join(f.home, 'late');
  write(path.join(late, '.claude-code-hermit/config.json'), JSON.stringify({ agent_name: 'late', _hermit_versions: { 'claude-code-hermit': '1.4.8' } }));
  write(path.join(late, '.claude-code-hermit/state/runtime.json'), JSON.stringify({ runtime_mode: 'tmux', shutdown_completed_at: '2026-10-02' }));
  const stub = path.join(f.config, 'stub.json');
  write(stub, JSON.stringify({ markets: ['hermitd'], installs: [{ id: 'hermitd@hermitd', scope: 'local', projectPath: late, enabled: true, installPath: f.newCore }] }));
  const result = await f.run({ RUNNING: 'docker' });
  expect(result.stderr).toBe(''); expect(result.exitCode).toBe(0);
  expect(fs.existsSync(path.join(late, '.hermit/state/hermitd-migrated'))).toBe(true);
  expect(result.stdout).toContain('(details printed in an earlier run)');
});
test('orphan refusal says when to rerun instead of naming a stop command', async () => {
  const f = fixture();
  write(path.join(f.projects[0], '.claude-code-hermit/state/runtime.json'), JSON.stringify({ runtime_mode: 'tmux' }));
  write(path.join(f.projects[0], '.claude-code-hermit/state/.heartbeat'), 'now');
  const result = await f.run();
  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain('rerun in');
  expect(result.stderr).not.toContain('Stop with');
});
for (const refusal of ['version', 'conflict', 'tmux', 'docker']) {
  test(`preflight ${refusal} refusal leaves files byte-identical`, async () => {
    const f = fixture();
    if (refusal === 'version') write(path.join(f.projects[0], '.claude-code-hermit/config.json'), '{"_hermit_versions":{"claude-code-hermit":"1.4.7"}}');
    if (refusal === 'conflict') write(path.join(f.projects[0], '.hermit/config.json'), '{}');
    const before = snapshot(f.home);
    const result = await f.run({ RUNNING: refusal });
    expect(result.exitCode).toBe(1); expect(snapshot(f.home)).toEqual(before);
  });
}
for (const mutation of ['docker:remove', 'docker:add', 'docker:install:hermitd@hermitd:project', 'docker:build', 'host:remove', 'host:add', 'host:install:hermitd@hermitd:project', 'host:install:hermitd@hermitd:user', 'host:install:hermitd-dev@hermitd:local']) {
  test(`resumes after ${mutation} without repeating removal`, async () => {
    const f = fixture(); const failed = await f.run({ FAIL_AT: mutation });
    expect(failed.exitCode).toBe(1); expect(failed.stderr).toContain('Resume with:');
    expect(fs.existsSync(path.join(f.config, 'hermitd-migration.json'))).toBe(true);
    const resumed = await f.run(); expect(resumed.stderr).toBe(''); expect(resumed.exitCode).toBe(0); complete(f);
    expect(f.calls().split('\n').filter(line => line === 'host:remove')).toHaveLength(1);
    expect(f.calls().split('\n').filter(line => line === 'docker:remove')).toHaveLength(1);
  });
}

for (const mutation of ['hermitd-migration.json', 'hermitd-inventory.json', 'move', 'template-manifest.json', 'hermitd-migrated', '.local/bin/hermitd', 'instances.json']) {
  test(`resumes after filesystem mutation ${mutation}`, async () => {
    const f = fixture();
    const failed = await f.run({ FAIL_FILE: mutation });
    expect(failed.exitCode).toBe(1);
    expect(failed.stderr).toContain('Resume with:');
    const resumed = await f.run();
    expect(resumed.exitCode).toBe(0); complete(f);
    expect(f.calls().split('\n').filter(line => line === 'docker:remove')).toHaveLength(1);
    expect(f.calls().split('\n').filter(line => line === 'host:remove')).toHaveLength(1);
  });
}
