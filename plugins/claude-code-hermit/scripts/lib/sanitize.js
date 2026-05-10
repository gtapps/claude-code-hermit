'use strict';
// Replace C0 controls + DEL + C1 controls with `?` so adversarial tool_input
// values can't inject newlines, ANSI escapes, or 8-bit terminal commands into
// hermit's stderr. C1 (U+0080..U+009F) doesn't appear in legitimate file paths
// or chat IDs, so stripping it is safe.
function safe(s) {
  return String(s ?? '').replace(/[\x00-\x1f\x7f-\x9f]/g, '?');
}
module.exports = { safe };
