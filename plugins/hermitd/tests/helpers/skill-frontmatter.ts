// Frontmatter reads that lib/frontmatter.ts cannot do.
//
// Its key grammar is /^(\w[\w_]*)\s*:\s*(.*)/ — `\w` has no hyphen, so a
// hyphenated key like `disable-model-invocation` is silently skipped rather
// than returned false. Any check built on that parser would read every skill as
// unflagged and pass vacuously, so the match lives here instead and is shared by
// every test that needs it.

/**
 * The YAML frontmatter block, or '' when the file has none. The delimiters are
 * matched as whole lines (CRLF tolerated) rather than by a fixed offset: a
 * `slice(4, indexOf('\n---'))` reads the wrong bytes on a CRLF file and would
 * report every skill as unflagged, which is the vacuous pass this file exists
 * to avoid.
 */
export function frontmatterBlock(body: string): string {
  return body.match(/^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/)?.[1] ?? '';
}

/**
 * True when the skill carries `disable-model-invocation: true` in its
 * frontmatter. Scoped to the block on purpose: a whole-file substring scan would
 * also match a skill that merely mentions the flag in its prose.
 */
export function isModelInvocationDisabled(body: string): boolean {
  return /^disable-model-invocation:\s*true\s*$/m.test(frontmatterBlock(body));
}
