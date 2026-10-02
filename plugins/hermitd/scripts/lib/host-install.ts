import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { registryDir, registerInMarketplace } from './host-registry';
import { writeFileAtomic } from './md-write';

export const HOST_MARKER = '# hermitd: managed host CLI';
interface Binding { id: string; scope: string; projectPath?: string }
const quote = (text: string) => `'${text.replaceAll("'", "'\\''")}'`;
export function installHost(project: string, root: string, binding: Binding): void {
  const target = path.join(os.homedir(), '.local/bin/hermitd');
  let existing: string | null = null;
  try {
    const stat = fs.lstatSync(target);
    if (stat.isSymbolicLink() || !stat.isFile()) { console.error(`[hermit] Refusing to overwrite foreign ${target}`); return; }
    existing = fs.readFileSync(target, 'utf8');
    if (!existing.split('\n').includes(HOST_MARKER)) { console.error(`[hermit] Refusing to overwrite foreign ${target}`); return; }
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const mp = binding.id.slice('hermitd@'.length);
  const dir = registryDir(mp);
  const bindingFile = path.join(dir, 'binding.json');
  const template = fs.readFileSync(path.join(root, 'state-templates/host/hermitd'), 'utf8');
  // Function replacers: a string replacement would expand `$'`/`$&` inside the quoted path.
  const content = template.replace('__HERMIT_BINDING__', () => quote(bindingFile)).replace('__HERMIT_UPDATE_ID__', () => quote(binding.id));
  const paths = (process.env.PATH ?? '').split(path.delimiter).map(p => path.resolve(p || '.'));
  const earlier = paths.map(p => path.join(p, 'hermitd')).find(p => {
    try { fs.accessSync(p, fs.constants.X_OK); return fs.statSync(p).isFile(); } catch { return false; }
  });
  if (earlier && earlier !== target) console.error(`[hermit] ${earlier} is earlier on PATH; use ${target} or adjust PATH.`);
  if (!paths.includes(path.dirname(target))) console.error(`[hermit] Add ${path.dirname(target)} to PATH.`);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  if (existing !== content) fs.writeFileSync(target, content, { mode: 0o755 });
  fs.chmodSync(target, 0o755);
  fs.mkdirSync(dir, { recursive: true });
  writeFileAtomic(bindingFile, JSON.stringify(binding) + '\n');
  // Use the bound marketplace even when invoked from the catalog clone.
  registerInMarketplace(mp, project, fs.existsSync(path.join(project, 'docker-compose.hermit.yml')) ? 'docker' : 'tmux');
}
