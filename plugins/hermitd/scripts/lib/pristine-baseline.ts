import fs from 'node:fs';
import path from 'node:path';

export interface PristineBaseline {
  key: string;
  buf: Buffer;
}

export function writePristineBaselines(stateDir: string, pristine: PristineBaseline[]): void {
  const pristineRoot = path.join(stateDir, 'state', 'pristine');

  for (const { key } of pristine) {
    const dest = path.join(pristineRoot, key);
    if (!dest.startsWith(pristineRoot + path.sep)) {
      throw new Error(`key '${key}' escapes state/pristine; refusing to write a baseline copy`);
    }
  }

  for (const { key, buf } of pristine) {
    const dest = path.join(pristineRoot, key);
    const destTmp = dest + '.tmp';
    try {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(destTmp, buf);
      fs.renameSync(destTmp, dest);
    } catch (err: any) {
      try { fs.rmSync(dest, { force: true }); } catch { /* best effort */ }
      try { fs.rmSync(destTmp, { force: true }); } catch { /* best effort */ }
      throw new Error(`cannot write pristine baseline for key '${key}': ${err.message}`);
    }
  }
}
