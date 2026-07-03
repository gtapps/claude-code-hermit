// Pure predicate shared by heartbeat-precheck.ts and its coherence test.
// Extracted so both reference one definition — importing heartbeat-precheck.ts
// directly would fire its top-level emit()/process.exit().
//
// Does a HEARTBEAT.md checklist item represent the default proposal-scan item?
// Matches the shipped default ("Review `proposals/` for any with `status:
// proposed` …"): it references proposals AND the `proposed` status it scans for.
// A custom item that merely mentions proposals without that status keyword falls
// through to the generic alert-based rule (unchanged, conservative).
//
// Residual (documented, not eliminated): a compound custom item that DOES contain
// both `proposals/` and `proposed` plus an unrelated clause is classified here and
// can reach 'clean' on an empty queue, skipping the unrelated clause's LLM eval.
// The robust fix is a structural marker in the template, but `hermit-evolve` does
// not migrate operator-edited HEARTBEAT.md, so prose-matching is retained to keep
// the optimization working for existing installs. The coherence test in
// heartbeat-default-scan.test.ts pins the shipped template against this predicate
// so a template reword can't silently reintroduce the wasted-dispatch bug.
export function isProposalScanItem(itemText: string): boolean {
  return /proposals?[\/\s]/i.test(itemText) && /\bproposed\b/i.test(itemText);
}
