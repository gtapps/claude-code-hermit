// Shared stdin-drain + profile-parsing helper for PreToolUse hooks.
//
// Every hook must consume stdin to completion even past a size cap (avoids
// broken-pipe errors and keeps the "hooks must never leave the pipe half
// read" contract) — so this drains fully and only stops *buffering* once
// maxBytes is exceeded. Returns null on empty, oversize, or unparseable
// input; callers treat null as their fail-open signal.

export const MAX_HOOK_STDIN = 1024 * 1024; // 1MB

// `source` defaults to process.stdin; tests inject a fake async iterable
// since the real stdin stream isn't mockable in-process.
export async function readHookInput(
  maxBytes: number = MAX_HOOK_STDIN,
  source: AsyncIterable<Buffer | string> = process.stdin
): Promise<any | null> {
  try {
    let total = 0;
    let oversize = false;
    const chunks: Buffer[] = [];
    if (source === process.stdin) process.stdin.on('error', () => {});
    for await (const chunk of source) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, 'utf8');
      total += buf.length;
      if (total > maxBytes) { oversize = true; continue; }
      chunks.push(buf);
    }
    if (oversize) return null;
    const raw = Buffer.concat(chunks).toString('utf8').trim();
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export function hookProfile(): string {
  return (process.env.AGENT_HOOK_PROFILE || 'standard').trim().toLowerCase();
}

export function isStrictProfile(): boolean {
  return hookProfile() === 'strict';
}

// Standard drain-parse-dispatch-exit(0) wrapper for hooks whose `main` is a
// synchronous, single-shot handler (no internal early exit(0) branches).
export async function runHook(main: (payload: any) => void): Promise<void> {
  try {
    const payload = await readHookInput();
    if (payload) main(payload);
  } catch { /* fail-open */ }
  process.exit(0);
}
