import fs from 'node:fs';
import path from 'node:path';
import { safe } from './lib/sanitize';
import { readHookInput, OVERSIZE } from './lib/hook-input';

type Json = any;

/**
 * PreToolUse hook — warn (or block) when Edit/Write targets a marketplace cache copy.
 *
 * Project-local marketplaces declare `"source": "<relative-path>"` in marketplace.json
 * and the runtime loads plugin code from the source. The directory under
 * `.claude/plugins/cache/<marketplace>/<plugin>/<version>/` is a stale snapshot —
 * silent edits to the cache produce no-ops at runtime and waste debugging time.
 *
 * On a cache-path target, this hook prints the canonical source path to stderr
 * and exits 0 (warn, don't block) so debugging workflows still work. Set
 * `HERMIT_CACHE_GUARD=block` to upgrade the warning into a hard block (exit 2).
 *
 * Non-cache paths, non-Edit/Write tool calls, or remote-source plugins → silent
 * passthrough (exit 0). Failures to parse stdin or marketplace.json fail open.
 */

const CACHE_RE = /(?:^|\/)\.claude\/plugins\/cache\/([^/]+)\/([^/]+)\/([^/]+)\/(.*)$/;

function findProjectMarketplace(start: string): string | null {
  let dir = path.resolve(start);
  while (true) {
    const candidate = path.join(dir, '.claude-plugin', 'marketplace.json');
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function resolveSourceRoot(marketplaceFile: string, marketplaceName: string, pluginName: string): string | null {
  let manifest: Json;
  try {
    manifest = JSON.parse(fs.readFileSync(marketplaceFile, 'utf8'));
  } catch (_e) {
    return null;
  }
  if (manifest.name !== marketplaceName) return null;
  const plugins: Json[] = Array.isArray(manifest.plugins) ? manifest.plugins : [];
  const entry = plugins.find(p => p && p.name === pluginName);
  if (!entry) return null;
  const src = entry.source;
  if (typeof src !== 'string') return null; // remote git refs are objects — skip
  const projectRoot = path.dirname(path.dirname(marketplaceFile));
  return path.resolve(projectRoot, src);
}

async function main() {
  const event = await readHookInput();
  if (!event || event === OVERSIZE) process.exit(0); // empty / unparseable / oversize — fail open

  const name = event.tool_name;
  if (name !== 'Edit' && name !== 'Write') process.exit(0);

  const input = event.tool_input || {};
  const filePath = input.file_path || input.path || '';
  if (!filePath) process.exit(0);

  const m = filePath.match(CACHE_RE);
  if (!m) process.exit(0);

  const [, marketplaceName, pluginName, , relInsideVersion] = m;

  const marketplaceFile = findProjectMarketplace(process.cwd());
  if (!marketplaceFile) process.exit(0);

  const sourceRoot = resolveSourceRoot(marketplaceFile, marketplaceName, pluginName);
  if (!sourceRoot) process.exit(0);

  const canonical = path.join(sourceRoot, relInsideVersion);
  const blockMode = process.env.HERMIT_CACHE_GUARD === 'block';
  const verb = blockMode ? 'BLOCKED' : 'WARNING';

  process.stderr.write(
    `[hermit] ${verb}: ${name} target is a marketplace cache copy.\n` +
    `[hermit]   path:   ${safe(filePath)}\n` +
    `[hermit]   source: ${safe(canonical)}\n` +
    `[hermit]   Runtime loads from the source path; cache edits are lost on next plugin install.\n` +
    `[hermit]   ${blockMode ? 'Unset HERMIT_CACHE_GUARD or set it to "warn" to allow.' : 'Set HERMIT_CACHE_GUARD=block to make this a hard error.'}\n`
  );
  process.exit(blockMode ? 2 : 0);
}

main().catch(() => process.exit(0));
