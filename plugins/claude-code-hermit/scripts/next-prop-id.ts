// next-prop-id.ts — generates the next canonical proposal ID + filename stem.
// Usage (argv):  bun next-prop-id.ts <hermit-state-dir> '<title>'
// Usage (stdin): bun next-prop-id.ts <hermit-state-dir> <<'HERMIT_TITLE'
//                <title>
//                HERMIT_TITLE
//   — stdin required when the title contains an apostrophe (dual-mode convention,
//     matches append-metrics.ts).
// Output (stdout, one line): PROP-NNN-<slug>-HHMMSS
// Exit 1 (+ stderr) on a missing state dir, or on exhausting the same-second
// collision-suffix range — creation should never proceed with a guessed ID.
// Implements proposal-create/SKILL.md § How to Create steps 1-2 (ID + slug +
// same-second collision guard).
//
// Thin CLI wrapper — the ID logic lives in lib/prop-id.ts, shared with
// proposal.ts's create verb (which claims the ID atomically alongside the file
// write, rather than assigning it in a separate step).

import fs from 'node:fs';
import { readStdin } from './lib/cli';
import { nextPropId } from './lib/prop-id';

const stateDir = process.argv[2];

if (!stateDir) {
  console.error("Usage: bun next-prop-id.ts <hermit-state-dir> '<title>'");
  process.exit(1);
}

function readTitle(): Promise<string> {
  if (process.argv[3] !== undefined) return Promise.resolve(process.argv[3]);
  return readStdin().then(s => s.trim());
}

(async () => {
  if (!fs.existsSync(stateDir)) {
    console.error(`Error: state dir not found: ${stateDir}`);
    process.exit(1);
  }

  const title = await readTitle();
  const parts = nextPropId(stateDir, title);
  if (!parts) {
    console.error('Error: exhausted same-second collision suffixes (a-z)');
    process.exit(1);
  }
  process.stdout.write(parts.id + '\n');
  process.exit(0);
})();
