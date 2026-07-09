// progress-log.ts — SHELL.md ## Progress Log append helper, shared by reflect-precheck.ts
// and the two autonomous context-reset flush paths (precompact-stamp.ts, hermit-watchdog.ts).
//
// Extracted from reflect-precheck.ts so a reset flush can reuse the exact same
// section-boundary logic instead of re-deriving it.

import fs from 'node:fs';

// Same boundary convention as startup-context.ts's extractSection and cost-tracker.ts's
// ## Blockers regex: a section ends at the next `\n## ` or EOF.
function appendToProgressLog(shellPath: string, line: string): void {
  try {
    let content = fs.readFileSync(shellPath, 'utf-8');
    const marker = '## Progress Log';
    const idx = content.indexOf(marker);
    if (idx === -1) {
      content = content.trimEnd() + '\n\n' + line + '\n';
    } else {
      const nextSection = content.indexOf('\n## ', idx + marker.length);
      if (nextSection === -1) {
        content = content.trimEnd() + '\n' + line + '\n';
      } else {
        content = content.slice(0, nextSection) + '\n' + line + content.slice(nextSection);
      }
    }
    fs.writeFileSync(shellPath, content, 'utf-8');
  } catch { /* fail-open */ }
}

type ResetKind = 'compacted' | 'cleared';

// Breadcrumb for an autonomous context reset (PreCompact hook, or the watchdog's
// emergency /clear) — a durable Progress Log line so the next session can see that a
// mid-arc reset happened. Deliberately NOT a rescue of unsaved observations (those live
// only in context and aren't deterministically extractable); this is a trace, nothing more.
// Fully fail-open: appendToProgressLog swallows all I/O errors, so this never throws.
function flushResetBreadcrumb(shellPath: string, opts: {
  kind: ResetKind;
  trigger: string;
  hhmm: string;
  tokens?: number;
}): void {
  const verb = opts.kind === 'compacted' ? 'compacted' : 'cleared';
  const tokenSuffix = typeof opts.tokens === 'number' ? ` at ~${Math.round(opts.tokens / 1000)}k tokens` : '';
  const line = `- [${opts.hhmm}] context ${verb} (${opts.trigger})${tokenSuffix} — arc may have unfinished work`;
  appendToProgressLog(shellPath, line);
}

export { appendToProgressLog, flushResetBreadcrumb };
