// Leading-X.Y.Z semver comparison, shared by every surface that decides which way a
// version gap points: the SessionStart banner (check-upgrade.sh mirrors this in its
// bun -e snippet), the boot notice (hermitd-start.ts), the evolve planner
// (evolve-plan.ts) and the stamp writer (evolve-finalize.ts). They must agree on the
// direction — a surface that ordered prereleases differently could tell the operator to
// upgrade while the writer refused the same bump as a regression.
//
// Not Bun.semver.order: it throws on malformed input (an operator-edited config.json
// stamp is reachable input, and these are advisory/guard paths that must never crash)
// and it orders prerelease suffixes, which this comparison deliberately ignores.

/** 3-way compare of X.Y.Z leading semver. Unparseable forms compare equal
 *  (don't second-guess), matching doctor-check.ts satisfiesRange's posture. */
export function cmpSemver(a: string, b: string): number {
  const pa = String(a).match(/^(\d+)\.(\d+)\.(\d+)/);
  const pb = String(b).match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!pa || !pb) return 0;
  for (let i = 1; i <= 3; i++) {
    const d = parseInt(pa[i], 10) - parseInt(pb[i], 10);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}
