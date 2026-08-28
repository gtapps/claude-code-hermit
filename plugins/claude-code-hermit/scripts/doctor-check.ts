// Fail-open: a failing check records "fail" in its own entry; the orchestrator
// never crashes and the process always exits 0.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import { parseDuration } from './lib/time';
import { globDir, readFrontmatter } from './lib/frontmatter';
import { validate } from './validate-config';
import { kStr } from './lib/format';
import { costIndexPath, readCostIndex, scanAutomatedOpus, scanRoutineLedger } from './lib/cost-log';
import { costLogPath } from './lib/cc-compat';
import { readSettledConfig, readConfigRaw, configExists } from './lib/config-read';
import { PRICING } from './lib/pricing';
import { HERMIT_OUTPUT_STYLE, VOICE_FILE_REL, voiceFileExists, resolvePersistedStyle, outputStyleFor } from './lib/voice';
import { getEnabledChannels } from './lib/channel-config';
import { isContainer } from './lib/container';
import { readChannelToken } from './lib/channel-token';
import { CHANNEL_PROBES, extractBotIdentity } from './lib/channel-probe';
import { siblingPluginDirs, versionedCacheCoreDir, readHermitMeta, readCoreName } from './lib/plugin-siblings';
import { tokenModeActive, defaultConfigDir, credentialsFilePath, parkedCredentialsFilePath, CREDENTIALS_FILENAME } from './lib/setup-token';
import { doctorAlertsPath, readAlertState, mutateOwnedAlerts, DOCTOR_PREFIX } from './lib/alert-state';
import { readDenials } from './lib/denial-log';
import { readRoutineHistory } from './lib/routines/history';
import { isCloseableSessionState } from './lib/auto-close';
import { promptTokensOf, compactibleTokens } from './lib/context-signal';
import { readContextSurface } from './lib/context-surface';
import { expandSessionName } from './lib/tmux';
import { readJson } from './lib/cli';

type Json = any;

// Every check takes its paths as an argument defaulting to PATHS (the argv-derived
// set the CLI runs on), so a test can drive one check against its own scratch dir
// without reloading this module — the seam escalate()/markNotified() already had.
export interface DoctorPaths {
  hermitDir: string;
  configPath: string;
  stateDir: string;
  proposalsDir: string;
  reportPath: string;
  pluginRoot: string;
  hooksPath: string;
  costLog: string;
}

function resolvePaths(dir: string, root: string): DoctorPaths {
  const hermitDir = path.resolve(dir);
  const stateDir = path.join(hermitDir, 'state');
  return {
    hermitDir,
    configPath: path.join(hermitDir, 'config.json'),
    stateDir,
    proposalsDir: path.join(hermitDir, 'proposals'),
    reportPath: path.join(stateDir, 'doctor-report.json'),
    pluginRoot: root,
    hooksPath: path.join(root, 'hooks', 'hooks.json'),
    // Resolve the cost log relative to the hermit dir (from argv), not the CWD —
    // doctor is often run from a different directory than the project root.
    costLog: costLogPath(hermitDir),
  };
}

const PATHS = resolvePaths(
  process.argv[2] || '.claude-code-hermit',
  process.env.CLAUDE_PLUGIN_ROOT || path.resolve(import.meta.dir, '..'),
);

// State files expected to exist after a healthy hatch.
const EXPECTED_STATE_FILES = [
  'alert-state.json',
  'reflection-state.json',
  'runtime.json',
  'monitors.runtime.json',
  'template-manifest.json',
];

// ----------------- Checks -----------------

function checkRuntime(p: DoctorPaths = PATHS) {
  const { pluginRoot } = p;
  try {
    const required: string | null = readHermitMeta(pluginRoot).required_bun_version || null;
    let version: string;
    try {
      version = execFileSync('bun', ['--version'], { encoding: 'utf8', timeout: 5000 }).trim();
    } catch {
      return {
        id: 'runtime', status: 'fail',
        detail: `bun not found — required${required ? ` (${required})` : ''}. Install: curl -fsSL https://bun.sh/install | bash`,
      };
    }
    if (required && !satisfiesRange(version, required)) {
      return { id: 'runtime', status: 'fail', detail: `bun ${version} below required ${required} — run: bun upgrade` };
    }
    return { id: 'runtime', status: 'ok', detail: `bun ${version}${required ? ` (required ${required})` : ''}` };
  } catch (e: any) {
    return { id: 'runtime', status: 'fail', detail: `check failed: ${e.message}` };
  }
}

function checkConfig(p: DoctorPaths = PATHS) {
  const { configPath } = p;
  try {
    if (!fs.existsSync(configPath)) {
      return { id: 'config', status: 'fail', detail: 'config.json not found' };
    }
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    const { errors, warnings } = validate(config);
    if (errors.length > 0) {
      return { id: 'config', status: 'fail', detail: `${errors.length} error(s): ${errors[0]}` };
    }
    if (warnings.length > 0) {
      return { id: 'config', status: 'warn', detail: `${warnings.length} warning(s): ${warnings[0]}` };
    }
    return { id: 'config', status: 'ok', detail: 'all required keys present' };
  } catch (e: any) {
    return { id: 'config', status: 'fail', detail: `check failed: ${e.message}` };
  }
}

function checkHooks(p: DoctorPaths = PATHS) {
  const { pluginRoot, hooksPath } = p;
  try {
    if (!fs.existsSync(hooksPath)) {
      return { id: 'hooks', status: 'fail', detail: `hooks.json not found at ${hooksPath}` };
    }
    const hooks = JSON.parse(fs.readFileSync(hooksPath, 'utf8'));
    const missing: string[] = [];
    const groups = hooks.hooks || {};
    const PLUGIN_SCRIPT_RE = /\$\{CLAUDE_PLUGIN_ROOT\}\/(\S+?\.(?:ts|js|sh|py))/;
    const checkRef = (s: string) => {
      const m = s.match(PLUGIN_SCRIPT_RE);
      if (m && !fs.existsSync(path.join(pluginRoot, m[1]))) missing.push(m[1]);
    };
    for (const entries of Object.values(groups) as Json[]) {
      if (!Array.isArray(entries)) continue;
      for (const entry of entries) {
        for (const h of entry.hooks || []) {
          // String-form hooks carry the path in `command`; exec-form hooks
          // (command: "bun", args: [path]) carry it in `args` — both count.
          checkRef(h.command || '');
          for (const arg of Array.isArray(h.args) ? h.args : []) {
            if (typeof arg === 'string') checkRef(arg);
          }
        }
      }
    }
    if (missing.length > 0) {
      return { id: 'hooks', status: 'fail', detail: `missing script(s): ${missing.join(', ')}` };
    }
    return { id: 'hooks', status: 'ok', detail: 'all referenced hook scripts exist' };
  } catch (e: any) {
    return { id: 'hooks', status: 'fail', detail: `check failed: ${e.message}` };
  }
}

function checkStateFiles(p: DoctorPaths = PATHS) {
  const { hermitDir, stateDir } = p;
  try {
    if (!fs.existsSync(stateDir)) {
      return { id: 'state', status: 'warn', detail: 'state/ directory does not exist' };
    }
    const stateFiles = globDir(stateDir, /\.jsonl?$/);
    const broken: string[] = [];
    for (const f of stateFiles) {
      try {
        const raw = fs.readFileSync(f, 'utf8');
        // A JSONL ledger has no whole-file JSON shape, and a torn trailing line is
        // expected rather than corruption (report-export.ts, prune-observations.ts
        // and config-audit.ts all keep unparseable lines verbatim). Only an
        // *unterminated* final line is a partial write, though: when the file ends
        // in a newline every line is complete and must be validated, or a
        // single-line corrupt ledger reports as parsing cleanly.
        if (f.endsWith('.jsonl')) {
          const lines = raw.split('\n');
          const complete = raw.endsWith('\n') ? lines : lines.slice(0, -1);
          for (const line of complete) {
            if (line.trim()) JSON.parse(line);
          }
        } else {
          JSON.parse(raw);
        }
      } catch (e) { broken.push(path.basename(f)); }
    }
    if (broken.length > 0) {
      return { id: 'state', status: 'fail', detail: `unparseable: ${broken.join(', ')}` };
    }
    const missing = EXPECTED_STATE_FILES.filter(
      f => !fs.existsSync(path.join(stateDir, f))
    );
    if (missing.length > 0) {
      return {
        id: 'state',
        status: 'warn',
        detail: `missing (recreated on next session): ${missing.join(', ')}`,
      };
    }
    const manifestPath = path.join(stateDir, 'template-manifest.json');
    try {
      const m = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      if (!m || typeof m.files !== 'object' || Array.isArray(m.files)) {
        return { id: 'state', status: 'fail', detail: 'template-manifest.json: missing or invalid `files` object' };
      }
      const badKeys = Object.entries(m.files).filter(
        ([, v]: [string, any]) => typeof v?.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(v.sha256)
      ).map(([k]) => k);
      if (badKeys.length > 0) {
        return { id: 'state', status: 'fail', detail: `template-manifest.json: invalid sha256 in: ${badKeys.join(', ')}` };
      }
      // Docker baseline guard: a docker-deployed project with no compose/Dockerfile
      // template baselines has its F2 drift signal unarmed — either never recorded
      // (pre-this-version deploy) or dropped by a manifest rewrite. Warn (not fail):
      // re-running /docker-setup records them. Check the compose/Dockerfile TEMPLATE
      // keys specifically, not any `docker/` key — hermit-evolve Step 5c writes the
      // `docker/docker-entrypoint.hermit.sh` baseline on its own, so its presence
      // does NOT imply docker-setup ran (the F2 baselines would still be missing).
      const projRoot = path.join(hermitDir, '..');
      const dockerDeployed = ['docker-compose.hermit.yml', 'Dockerfile.hermit', 'docker-entrypoint.hermit.sh']
        .some(f => fs.existsSync(path.join(projRoot, f)));
      const hasTemplateBaselines = m.files['docker/docker-compose.hermit.yml.template'] != null
        || m.files['docker/Dockerfile.hermit.template'] != null;
      if (dockerDeployed && !hasTemplateBaselines) {
        return { id: 'state', status: 'warn', detail: 'docker files deployed but compose/Dockerfile template baselines missing from manifest — run /claude-code-hermit:docker-setup to arm drift detection' };
      }
    } catch {
      // file existence was already checked above; any error here is unexpected
      return { id: 'state', status: 'fail', detail: 'template-manifest.json: unreadable' };
    }
    return { id: 'state', status: 'ok', detail: `${stateFiles.length} state file(s) parse cleanly` };
  } catch (e: any) {
    return { id: 'state', status: 'fail', detail: `check failed: ${e.message}` };
  }
}

function checkCost(p: DoctorPaths = PATHS) {
  const { hermitDir, costLog } = p;
  try {
    if (!fs.existsSync(costLog)) {
      return { id: 'cost', status: 'warn', detail: 'no cost data yet (.claude/cost-log.jsonl absent)' };
    }

    const today = new Date().toISOString().slice(0, 10);
    let todayTotal = 0;
    let todayTokens = 0;
    let todayCacheRead = 0;
    const lines = fs.readFileSync(costLog, 'utf8').split('\n');
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line);
        if (entry.timestamp && entry.timestamp.startsWith(today)) {
          todayTotal += entry.estimated_cost_usd || 0;
          todayTokens += entry.total_tokens || 0;
          todayCacheRead += entry.cache_read_tokens || 0;
        }
      } catch {}
    }
    const detail = `today $${todayTotal.toFixed(4)} · ${kStr(todayTokens)} tokens, ${kStr(todayCacheRead)} cached`;

    try {
      const idx = readCostIndex(costIndexPath(hermitDir));
      if (idx && idx.skipped_corrupt_lines > 0) {
        const corruptCount = idx.skipped_corrupt_lines;
        const corruptDetail = `${corruptCount} corrupt cost-log ${corruptCount === 1 ? 'line' : 'lines'} skipped; recorded spend may be understated`;
        return {
          id: 'cost',
          status: 'warn',
          detail: `${detail}; ${corruptDetail}`,
          alert_detail: corruptDetail,
        };
      }
    } catch {
      // Non-fatal — cost-index absent on fresh install
    }

    return { id: 'cost', status: 'ok', detail };
  } catch (e: any) {
    return { id: 'cost', status: 'fail', detail: `check failed: ${e.message}` };
  }
}

function checkProposals(p: DoctorPaths = PATHS) {
  const { proposalsDir } = p;
  try {
    if (!fs.existsSync(proposalsDir)) {
      return { id: 'proposals', status: 'ok', detail: 'proposals/ empty (fresh install)' };
    }
    const files = globDir(proposalsDir, /^PROP-\d+(?:-.+)?\.md$/);
    const now = Date.now();
    const STALE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
    let open = 0;
    let stale = 0;
    for (const f of files) {
      const fm = readFrontmatter(f);
      // `proposed` is the awaiting-review status; `open` was never in the vocabulary
      // (proposed|accepted|resolved|dismissed|deferred — see lib/artifact-theme.ts's
      // CHIP_STATUSES), so this check silently counted zero and both warns below
      // were unreachable.
      if (!fm || fm.status !== 'proposed') continue;
      open++;
      if (fm.created) {
        const age = now - new Date(fm.created).getTime();
        if (Number.isFinite(age) && age > STALE_MS) stale++;
      }
    }
    if (stale > 0) {
      return { id: 'proposals', status: 'warn', detail: `${open} open (${stale} older than 30d)` };
    }
    if (open > 10) {
      return { id: 'proposals', status: 'warn', detail: `${open} open proposals (consider triage)` };
    }
    return { id: 'proposals', status: 'ok', detail: `${open} open proposal(s)` };
  } catch (e: any) {
    return { id: 'proposals', status: 'fail', detail: `check failed: ${e.message}` };
  }
}

// Full npm-style range evaluation (`>=`, `~`, `^`, `||`, comparators) via Bun.semver.
// Unparseable ranges are treated as satisfied — same fail-open posture as the old
// hand-rolled check: don't second-guess a range we can't read.
function satisfiesRange(version: any, range: any): boolean {
  if (typeof version !== 'string' || typeof range !== 'string') return true;
  return Bun.semver.satisfies(version, range);
}

function checkDependencies(p: DoctorPaths = PATHS) {
  const { pluginRoot } = p;
  try {
    // Read core version + name from this plugin's own manifest.
    const corePj = path.join(pluginRoot, '.claude-plugin', 'plugin.json');
    if (!fs.existsSync(corePj)) {
      return { id: 'dependencies', status: 'ok', detail: 'core manifest absent — skipping range check' };
    }
    let coreManifest: Json;
    try {
      coreManifest = JSON.parse(fs.readFileSync(corePj, 'utf8'));
    } catch {
      return { id: 'dependencies', status: 'warn', detail: 'core plugin.json unreadable' };
    }
    const coreVersion: string = coreManifest.version;
    if (!coreVersion) {
      return { id: 'dependencies', status: 'ok', detail: 'core version not set — skipping range check' };
    }

    const mismatches: string[] = [];
    let checked = 0;
    for (const dir of siblingPluginDirs(pluginRoot, coreManifest.name || '')) {
      const pj = path.join(dir, '.claude-plugin', 'plugin.json');
      let manifest: Json;
      try { manifest = JSON.parse(fs.readFileSync(pj, 'utf8')); } catch { continue; }
      const meta = readHermitMeta(dir);
      const range = meta.required_core_version;
      if (!range) continue;
      checked++;
      if (!satisfiesRange(coreVersion, range)) {
        mismatches.push(`${manifest.name || path.basename(dir)} requires ${range} (core is ${coreVersion})`);
      }
    }

    if (mismatches.length > 0) {
      return {
        id: 'dependencies',
        status: 'warn',
        detail: `${mismatches.length} sibling(s) outside required_core_version range: ${mismatches[0]}${mismatches.length > 1 ? '…' : ''}`,
      };
    }
    if (checked === 0) {
      return { id: 'dependencies', status: 'ok', detail: 'no sibling plugins declare required_core_version' };
    }
    return { id: 'dependencies', status: 'ok', detail: `${checked} sibling plugin(s) within required_core_version range` };
  } catch (e: any) {
    return { id: 'dependencies', status: 'warn', detail: `check failed: ${e.message}` };
  }
}

// ----------------- Version currency -----------------
// The version-gap signal hermit-evolve's evolve-plan.ts computes (recorded-vs-installed)
// is reactive — it only reports once the operator runs /hermit-evolve. This check is the
// proactive half: "is a newer version already sitting in the local marketplace cache that
// /plugin update hasn't pulled in yet." That cache is only as fresh as the last explicit
// `claude plugin marketplace update` (confirmed empirically — no automatic background
// refresh exists in the CC CLI or anywhere in this plugin's own scripts), so a stale cache
// under-reports rather than over-reports: this check can miss a newer release, but it can
// never claim currency the install doesn't actually have. Worded accordingly below.

/** Locate the marketplace-cache marketplace.json this install's `claude plugin marketplace
 *  update` would refresh, given the versioned-cache layout siblingPluginDirs already
 *  detects (pluginRoot = .claude/plugins/cache/<mp>/<coreName>/<version>/). Returns null
 *  in the monorepo/flat-layout branch (dev checkout — nothing to compare against) or when
 *  the tree/file isn't present. HERMIT_DOCTOR_MARKETPLACE_FILE overrides for tests, since
 *  the real path depends on machine-local install layout the test harness doesn't control. */
function marketplaceCacheFile(coreName: string, p: DoctorPaths): string | null {
  const { pluginRoot } = p;
  const override = process.env.HERMIT_DOCTOR_MARKETPLACE_FILE;
  if (override) return fs.existsSync(override) ? override : null;
  const coreDir = versionedCacheCoreDir(pluginRoot, coreName);
  if (!coreDir) return null; // flat/monorepo layout — no cache to compare
  const cacheMarketplaceDir = path.resolve(coreDir, '..'); // .../plugins/cache/<mp>
  const mp = path.basename(cacheMarketplaceDir);
  const pluginsRoot = path.resolve(cacheMarketplaceDir, '..', '..'); // .../plugins/cache/<mp> -> .../plugins
  const file = path.join(pluginsRoot, 'marketplaces', mp, '.claude-plugin', 'marketplace.json');
  return fs.existsSync(file) ? file : null;
}

/** CHANGELOG.md for the newer version inside the marketplace-cache clone — the git checkout
 *  `claude plugin marketplace update` refreshes alongside marketplace.json, so it carries the
 *  newer version's entries even before `/plugin update` pulls the version's own install-cache
 *  dir. Resolved from the marketplace-repo root (mpFile is <mp-root>/.claude-plugin/marketplace.json)
 *  joined with the plugin's `source` (e.g. "./plugins/claude-code-hermit"). Returns null when
 *  the entry has no usable source or the file isn't present. This is the source that actually
 *  carries the (installedVersion, cachedVersion] range when the check fires; the install-cache
 *  and installed-snapshot CHANGELOGs both stop at installedVersion in that state. */
function marketplaceRepoChangelogPath(mpFile: string, entry: Json): string | null {
  const source = typeof entry?.source === 'string' ? entry.source : '';
  if (!source) return null;
  const repoRoot = path.dirname(path.dirname(mpFile)); // <mp-root>/.claude-plugin/marketplace.json -> <mp-root>
  const file = path.join(repoRoot, source, 'CHANGELOG.md');
  return fs.existsSync(file) ? file : null;
}

/** CHANGELOG.md for a cached-but-not-yet-installed version in the versioned install cache
 *  (.claude/plugins/cache/<mp>/<coreName>/<version>/), used only when `/plugin update` has
 *  already pulled the version's files but hermit-evolve hasn't run yet. */
function cachedVersionChangelogPath(coreName: string, version: string, p: DoctorPaths): string | null {
  const { pluginRoot } = p;
  const coreDir = versionedCacheCoreDir(pluginRoot, coreName);
  if (!coreDir) return null;
  const file = path.join(coreDir, version, 'CHANGELOG.md');
  return fs.existsSync(file) ? file : null;
}

/** True if any CHANGELOG.md section for a version in (from, to] carries a `### Fixed`
 *  heading — escalates version-currency's wording so "behind" doesn't read as purely
 *  cosmetic when the gap includes an actual bug fix. */
function changelogRangeHasFixed(from: string, to: string, file: string): boolean {
  try {
    const changelog = fs.readFileSync(file, 'utf8');
    const sections = changelog.split(/^## \[/m).slice(1);
    for (const section of sections) {
      const m = section.match(/^([^\]]+)\]/);
      const version = m?.[1];
      if (!version || !/^\d+\.\d+\.\d+/.test(version)) continue;
      if (Bun.semver.order(version, from) > 0 && Bun.semver.order(version, to) <= 0 && /^### Fixed/m.test(section)) {
        return true;
      }
    }
    return false;
  } catch {
    return false;
  }
}

function checkVersionCurrency(p: DoctorPaths = PATHS) {
  const { pluginRoot } = p;
  try {
    const corePj = path.join(pluginRoot, '.claude-plugin', 'plugin.json');
    if (!fs.existsSync(corePj)) {
      return { id: 'version-currency', status: 'ok', detail: 'core manifest absent — skipping' };
    }
    let coreManifest: Json;
    try {
      coreManifest = JSON.parse(fs.readFileSync(corePj, 'utf8'));
    } catch {
      return { id: 'version-currency', status: 'warn', detail: 'core plugin.json unreadable' };
    }
    const installedVersion: string = coreManifest.version;
    const coreName: string = coreManifest.name || '';
    if (!installedVersion || !coreName) {
      return { id: 'version-currency', status: 'ok', detail: 'core name/version not set — skipping' };
    }

    const mpFile = marketplaceCacheFile(coreName, p);
    if (!mpFile) {
      return { id: 'version-currency', status: 'ok', detail: 'no marketplace cache to compare against (dev checkout, or marketplace never added)' };
    }
    let marketplace: Json;
    try {
      marketplace = JSON.parse(fs.readFileSync(mpFile, 'utf8'));
    } catch {
      return { id: 'version-currency', status: 'ok', detail: 'marketplace cache unreadable — skipping' };
    }
    const entry = (Array.isArray(marketplace.plugins) ? marketplace.plugins : []).find((plugin: Json) => plugin.name === coreName);
    const cachedVersion: string = entry?.version;
    if (!cachedVersion || !/^\d+\.\d+\.\d+/.test(cachedVersion) || !/^\d+\.\d+\.\d+/.test(installedVersion)) {
      return { id: 'version-currency', status: 'ok', detail: 'marketplace cache has no comparable version entry — skipping' };
    }

    let cachedAt = '';
    try { cachedAt = ` (cached ${fs.statSync(mpFile).mtime.toISOString().slice(0, 10)})`; } catch {}

    if (Bun.semver.order(cachedVersion, installedVersion) <= 0) {
      return { id: 'version-currency', status: 'ok', detail: `installed ${installedVersion}, no newer version in local marketplace cache${cachedAt}` };
    }

    // Read the newer version's CHANGELOG from the marketplace-cache clone (refreshed with
    // marketplace.json), falling back to the install cache if `/plugin update` already pulled
    // it. pluginRoot's own CHANGELOG.md is deliberately NOT a fallback: as the installed
    // version's frozen snapshot it stops at installedVersion, so scanning it for the
    // (installedVersion, cachedVersion] range is structurally empty and would silently
    // under-report a bug-fix gap. HERMIT_DOCTOR_CHANGELOG_PATH is the test seam. When no
    // source is resolvable the escalation is simply omitted rather than faked.
    const cachedChangelog =
      marketplaceRepoChangelogPath(mpFile, entry)
      || cachedVersionChangelogPath(coreName, cachedVersion, p)
      || process.env.HERMIT_DOCTOR_CHANGELOG_PATH
      || null;
    const escalation = cachedChangelog && changelogRangeHasFixed(installedVersion, cachedVersion, cachedChangelog) ? ' — includes Fixed entries' : '';
    return {
      id: 'version-currency',
      status: 'warn',
      detail: `installed ${installedVersion}, marketplace cache has ${cachedVersion}${cachedAt}${escalation} — run \`/plugin marketplace update\` then \`/plugin update\`, then /claude-code-hermit:hermit-evolve`,
    };
  } catch (e: any) {
    return { id: 'version-currency', status: 'warn', detail: `check failed: ${e.message}` };
  }
}

// Pure helpers — no subprocess, fully testable in isolation.

/** Returns true if two IPv4 CIDR strings overlap. Fails open (returns false) on any parse error. */
function cidrOverlap(a: string, b: string): boolean {
  try {
    const parse = (s: string) => {
      const [ip, prefix] = s.split('/');
      const bits = parseInt(prefix, 10);
      const parts = ip.split('.').map(Number);
      const n = (parts[0] << 24 | parts[1] << 16 | parts[2] << 8 | parts[3]) >>> 0;
      const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
      return { base: n & mask, mask };
    };
    const na = parse(a), nb = parse(b);
    return (na.base & nb.mask) === nb.base || (nb.base & na.mask) === na.base;
  } catch { return false; }
}

function checkDockerSecurity(p: DoctorPaths = PATHS) {
  const { hermitDir } = p;
  // Presence check between docker.security.* in config.json and the rendered
  // docker-compose.security.yml overlay. When both are present, also shells out
  // to `docker compose config --format json` (timeout 10s) to detect:
  //   - hermit service ports conflicting with network_mode:service:hermit-netguard (fail)
  //   - overlay subnet colliding with another Docker network on this host (warn)
  // All subprocess failures degrade to warn, never fail — daemon-down is transient.
  try {
    // Anchor to the project root (parent of the agent dir), not process.cwd().
    const projectRoot = path.join(hermitDir, '..');
    const overlayPath = path.join(projectRoot, 'docker-compose.security.yml');
    const overlayPresent = fs.existsSync(overlayPath);

    const config: Json = readSettledConfig(hermitDir);
    const sec = (config.docker && config.docker.security) || null;
    const declared = sec && Object.values(sec).some((v: Json) =>
      v && typeof v === 'object' ? v.enabled === true : v === true
    );

    if (!declared && !overlayPresent) {
      return { id: 'docker-security', status: 'ok', detail: 'not configured (run /docker-security to enable)' };
    }
    if (declared && !overlayPresent) {
      return {
        id: 'docker-security',
        status: 'warn',
        detail: 'posture declared in config but docker-compose.security.yml is missing — re-run /docker-security',
      };
    }
    if (!declared && overlayPresent) {
      return {
        id: 'docker-security',
        status: 'warn',
        detail: 'overlay present but no posture declared in config — likely a manual edit; re-run /docker-security to reconcile',
      };
    }

    // Both declared and overlay present. The deep checks below need the docker CLI,
    // which does not exist inside the hermit container — verification is a host-side
    // concern. Gating here (rather than degrading the ENOENT to warn) keeps a
    // dockerized hermit from reporting a permanent, unfixable warn. Gate on live
    // container detection only: `runtime_mode` records how the hermit was *booted*
    // and stays 'docker' in the bind-mounted state dir the host reads, so keying off
    // it would silently disable the host-side checks for every dockerized hermit.
    if (isContainer()) {
      return {
        id: 'docker-security',
        status: 'ok',
        detail: 'posture declared and overlay present (in-container: compose verification runs on the host)',
      };
    }

    // Both declared and overlay present — run deeper checks via subprocess.
    const baseCompose = path.join(projectRoot, 'docker-compose.hermit.yml');
    if (!fs.existsSync(baseCompose)) {
      return { id: 'docker-security', status: 'ok', detail: 'posture declared and overlay present' };
    }

    let composeCfg: Json;
    try {
      composeCfg = JSON.parse(execFileSync('docker', [
        'compose', '-f', baseCompose, '-f', overlayPath,
        'config', '--format', 'json',
      ], { cwd: projectRoot, timeout: 10_000 }).toString());
    } catch (e: any) {
      return {
        id: 'docker-security',
        status: 'warn',
        detail: `posture declared and overlay present (could not verify via docker compose: ${e.message.slice(0, 80)})`,
      };
    }

    // Check 1: hermit service has ports AND network_mode is service:hermit-netguard.
    const hermitSvc = (composeCfg.services || {}).hermit || {};
    const hermitPorts = hermitSvc.ports || [];
    const networkMode = hermitSvc.network_mode || '';
    if (hermitPorts.length > 0 && networkMode.startsWith('service:')) {
      return {
        id: 'docker-security',
        status: 'fail',
        detail: 'hermit service has ports: but uses network_mode:service:hermit-netguard — Docker will reject this. Re-run /docker-security → "Move ports to netguard", then delete the ports: block from docker-compose.hermit.yml.',
      };
    }

    // Check 2: overlay subnet collides with another Docker network on this host.
    const lanEnabled = sec && sec.network && sec.network.enabled;
    if (lanEnabled) {
      const overlaySubnet = sec.network && sec.network.subnet;
      if (overlaySubnet) {
        try {
          const netNames = execFileSync('docker', ['network', 'ls', '--format', '{{.Name}}'],
            { timeout: 10_000 }).toString().trim().split('\n').filter(Boolean);

          const projectName = (composeCfg.name || path.basename(projectRoot)).toLowerCase();

          for (const net of netNames) {
            let inspectOut = '';
            try {
              inspectOut = execFileSync('docker', ['network', 'inspect', net,
                '--format', '{{range .IPAM.Config}}{{.Subnet}}{{end}}|||{{json .Labels}}'],
                { timeout: 5_000 }).toString().trim();
            } catch { continue; }

            const [subnetPart, labelsPart] = inspectOut.split('|||');
            const subnet = (subnetPart || '').trim();
            if (!subnet || !subnet.includes('/')) continue;

            // Exclude this project's own hermit-net via labels.
            let labels: Json = {};
            try { labels = JSON.parse(labelsPart || '{}'); } catch {}
            const isOwnHermitNet =
              (labels['com.docker.compose.project'] || '').toLowerCase() === projectName &&
              labels['com.docker.compose.network'] === 'hermit-net';
            if (isOwnHermitNet) continue;

            if (cidrOverlap(overlaySubnet, subnet)) {
              return {
                id: 'docker-security',
                status: 'warn',
                detail: `overlay subnet ${overlaySubnet} overlaps Docker network "${net}" (${subnet}). Re-run /docker-security to auto-pick a fresh subnet.`,
              };
            }
          }
        } catch (e: any) {
          return {
            id: 'docker-security',
            status: 'warn',
            detail: `posture declared and overlay present (subnet collision check failed: ${e.message.slice(0, 80)})`,
          };
        }
      }
    }

    return { id: 'docker-security', status: 'ok', detail: 'posture declared and overlay present' };
  } catch (e: any) {
    return { id: 'docker-security', status: 'fail', detail: `check failed: ${e.message}` };
  }
}

function checkPermissions(p: DoctorPaths = PATHS) {
  const { configPath, stateDir, proposalsDir } = p;
  try {
    const looseFiles: string[] = [];
    const targets: string[] = [configPath];
    if (fs.existsSync(stateDir)) {
      for (const f of globDir(stateDir, /\.jsonl?$/)) targets.push(f);
    }
    for (const target of targets) {
      if (!fs.existsSync(target)) continue;
      const mode = fs.statSync(target).mode & 0o777;
      if (mode & 0o004) looseFiles.push(`${path.basename(target)} (${mode.toString(8)})`);
    }
    if (fs.existsSync(proposalsDir)) {
      const mode = fs.statSync(proposalsDir).mode & 0o777;
      if (mode & 0o004) looseFiles.push(`proposals/ (${mode.toString(8)})`);
    }
    if (looseFiles.length > 0) {
      return {
        id: 'permissions',
        status: 'warn',
        detail: `world-readable: ${looseFiles.slice(0, 3).join(', ')}${looseFiles.length > 3 ? '…' : ''}`,
      };
    }
    return { id: 'permissions', status: 'ok', detail: `${targets.length} sensitive path(s) not world-readable` };
  } catch (e: any) {
    return { id: 'permissions', status: 'fail', detail: `check failed: ${e.message}` };
  }
}

/**
 * bypassPermissions with no isolation boundary around it.
 *
 * Anthropic's guidance splits cleanly: auto mode reviews each action with a
 * classifier and does not require a container, while bypassPermissions removes
 * every check and is only safe inside a container, a VM, or the sandbox runtime
 * (https://code.claude.com/docs/en/sandbox-environments). hermit-start already
 * warns about this at boot, but only interactively — an unattended tmux boot
 * cannot answer that prompt, so nothing catches the combination afterwards.
 *
 * runtime_mode is the primary signal, not isContainer(): a Docker hermit's state
 * dir is bind-mounted to the host, so a doctor run from the host for a
 * containerized hermit sees no /.dockerenv and would false-positive. The
 * container probe is only the fallback for a hermit that has never booted.
 */
function checkBypassIsolation(p: DoctorPaths = PATHS) {
  const { hermitDir, stateDir } = p;
  try {
    const mode = readSettledConfig(hermitDir).permission_mode;
    if (mode !== 'bypassPermissions') {
      return { id: 'bypass-isolation', status: 'ok', detail: `permission_mode ${mode}: no bypass exposure` };
    }

    const runtimeMode = readJson(path.join(stateDir, 'runtime.json'))?.runtime_mode ?? null;

    if (runtimeMode === 'docker') {
      return { id: 'bypass-isolation', status: 'ok', detail: 'bypassPermissions inside a container' };
    }
    // An attended terminal session is the operator watching their own screen,
    // which is the one context bypassPermissions was designed for.
    if (runtimeMode === 'interactive') {
      return { id: 'bypass-isolation', status: 'ok', detail: 'bypassPermissions, last boot was interactive' };
    }

    const remedy = 'switch to auto (/hermit-settings permissions) or run in a container (/docker-setup)';
    if (runtimeMode === 'tmux') {
      return {
        id: 'bypass-isolation',
        status: 'warn',
        detail: `bypassPermissions on a bare tmux host: no isolation boundary — ${remedy}`,
      };
    }
    if (isContainer()) {
      return { id: 'bypass-isolation', status: 'ok', detail: 'bypassPermissions inside a container (no runtime record yet)' };
    }
    return {
      id: 'bypass-isolation',
      status: 'warn',
      detail: `bypassPermissions with no runtime record and no container detected — ${remedy}`,
    };
  } catch (e: any) {
    return { id: 'bypass-isolation', status: 'fail', detail: `check failed: ${e.message}` };
  }
}

const MS_PER_DAY = 86400000;

function daysSince(iso: any): any {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  return (Date.now() - t) / MS_PER_DAY;
}

function checkArchival(p: DoctorPaths = PATHS) {
  const { stateDir } = p;
  try {
    const runtimePath = path.join(stateDir, 'runtime.json');
    if (!fs.existsSync(runtimePath)) {
      return { id: 'archive', status: 'ok', detail: 'no runtime state' };
    }
    const rt = JSON.parse(fs.readFileSync(runtimePath, 'utf8'));
    const state = rt.session_state;
    const sid = rt.session_id;
    const age = daysSince(rt.updated_at);
    const ageStr = age == null ? null : `${age.toFixed(1)}d`;
    const ageDetail = ageStr == null ? 'no timestamp' : `last update ${ageStr} ago`;

    if ((state === 'in_progress' || state === 'waiting') && age > 2) {
      return {
        id: 'archive',
        status: 'warn',
        detail: `stale active session: state=${state}, ${ageDetail} (daily-auto-close may have stopped archiving)`,
      };
    }
    if (state === 'idle' && sid && age > 2) {
      return {
        id: 'archive',
        status: 'warn',
        detail: `orphaned session: id=${sid}, idle but never archived (${ageStr} ago)`,
      };
    }
    return { id: 'archive', status: 'ok', detail: `session_state=${state || 'unset'}, ${ageDetail}` };
  } catch (e: any) {
    return { id: 'archive', status: 'fail', detail: `check failed: ${e.message}` };
  }
}

// Queue health for the midnight auto-close, kept separate from `archive` on purpose:
// a check returns exactly one {id,status,detail}, and the alert ledger keys on id, so
// folding this into checkArchival would force a priority call between two independent
// failures (and silently drop one). Cause-agnostic by design — it fires whenever a
// queued close stops draining, whether the cause is a dead monitor, a hermit with no
// in-session poller at all (heartbeat off AND CronCreate fallback), or a close that
// keeps failing. Corrupt JSON is already checkStateFiles' job; this is semantic only.
function checkAutoClose(p: DoctorPaths = PATHS) {
  const { stateDir } = p;
  try {
    const pendingPath = path.join(stateDir, 'pending-close.json');
    if (!fs.existsSync(pendingPath)) {
      return { id: 'auto-close', status: 'ok', detail: 'no queued close' };
    }
    const pending = readJson(pendingPath);
    if (!pending || typeof pending !== 'object') {
      // File integrity is checkStateFiles' finding; don't double-report the same
      // root cause under a second ledger id. A non-object payload carries no
      // queued_at either way, and the drain's readJSON treats it as no flag.
      return { id: 'auto-close', status: 'ok', detail: 'pending-close.json unreadable or malformed (file integrity is the state check)' };
    }

    const runtimePath = path.join(stateDir, 'runtime.json');
    if (!fs.existsSync(runtimePath)) {
      // auto-close-decision treats a missing runtime exactly like a non-closeable
      // session_state: the next fire reaps the flag. The absent file itself is
      // already the state check's finding.
      return { id: 'auto-close', status: 'ok', detail: 'queued close, runtime.json absent (stale flag is reaped at next fire)' };
    }
    let state: any;
    try {
      state = JSON.parse(fs.readFileSync(runtimePath, 'utf8')).session_state;
    } catch {
      return {
        id: 'auto-close',
        status: 'warn',
        detail: 'close queued but runtime.json is unreadable — nothing can drain it',
      };
    }
    if (!isCloseableSessionState(state)) {
      // Not closeable; the next auto-close-decision reaps the flag itself.
      return { id: 'auto-close', status: 'ok', detail: `queued close, session_state=${state || 'unset'} (stale flag is reaped at next fire)` };
    }

    const age = daysSince(pending.queued_at);
    if (age == null) {
      // Malformed queued_at: the drain's own fail-open path declines to trust it,
      // so don't escalate on it either — checkStateFiles owns malformed state.
      return { id: 'auto-close', status: 'ok', detail: 'queued close, no readable queued_at' };
    }
    if (age > 1) {
      return {
        id: 'auto-close',
        status: 'warn',
        detail: `queued close not drained for ${age.toFixed(1)}d — check heartbeat.enabled and the routine monitor`,
      };
    }
    return { id: 'auto-close', status: 'ok', detail: `queued close pending ${(age * 24).toFixed(1)}h` };
  } catch (e: any) {
    return { id: 'auto-close', status: 'fail', detail: `check failed: ${e.message}` };
  }
}

// Informational only — never warns. A high empty rate is a legitimate steady state, and the
// counters are caller-blind (routine, session finalization, session-close, manual /reflect all
// increment total_runs identically), so no warn could name a knob to turn.
function checkReflectLoop(p: DoctorPaths = PATHS) {
  const { stateDir } = p;
  try {
    const reflectPath = path.join(stateDir, 'reflection-state.json');
    if (!fs.existsSync(reflectPath)) {
      return { id: 'reflect', status: 'ok', detail: 'reflection-state.json absent (no reflect runs yet)' };
    }
    const rs = JSON.parse(fs.readFileSync(reflectPath, 'utf8'));
    const c = rs.counters || {};
    // Legacy and hand-edited state files carry strings, negatives, or missing keys. Mirrors
    // intOf() in update-reflection-state.ts, which rejects numeric strings too — so doctor never
    // reports a count the next reflect run is about to silently reset to 0.
    const int = (v: any) => (typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.floor(v)) : 0);
    const total = int(c.total_runs);
    const since = typeof c.since === 'string' ? ` since ${c.since}` : '';
    if (total === 0) {
      return { id: 'reflect', status: 'ok', detail: `no reflect runs yet${since}` };
    }
    const empty = int(c.empty_runs);
    const props = int(c.proposals_created);
    const micro = int(c.micro_proposals_queued);
    const suppress = int(c.judge_suppress);
    const rate = `${empty}/${total} empty (${Math.round((empty / total) * 100)}%)`;

    if (props + micro + suppress === 0) {
      return { id: 'reflect', status: 'ok', detail: `${rate}, no output or suppressions${since}` };
    }
    // Same code:N shape and same fixed code order as /hermit-health's suppress-mix suffix, so the
    // two surfaces read alike. Codes outside the known set sort last, in insertion order.
    const CODE_ORDER = ['no-evidence', 'covered-by-memory', 'no-sessions'];
    const rank = (code: string) => {
      const i = CODE_ORDER.indexOf(code);
      return i === -1 ? CODE_ORDER.length : i;
    };
    const byCode = (c.judge_suppress_by_code && typeof c.judge_suppress_by_code === 'object')
      ? Object.entries(c.judge_suppress_by_code)
          .map(([code, n]) => [code, int(n)] as const)
          .filter(([, n]) => n > 0)
          .sort((a, b) => rank(a[0]) - rank(b[0]))
      : [];
    const mix = byCode.length ? ` (${byCode.map(([code, n]) => `${code}:${n}`).join(', ')})` : '';
    const suppressed = suppress ? `, ${suppress} suppressed${mix}` : '';
    return {
      id: 'reflect',
      status: 'ok',
      detail: `${rate}, ${props} proposal(s), ${micro} micro-proposal(s)${suppressed}${since}`,
    };
  } catch (e: any) {
    return { id: 'reflect', status: 'fail', detail: `check failed: ${e.message}` };
  }
}

function checkScheduler(p: DoctorPaths = PATHS) {
  const { stateDir } = p;
  // Reads state/cc-stop-snapshot.json written by stop-pipeline.ts on each Stop.
  // The snapshot is point-in-time at last Stop, not live — the captured_at
  // timestamp is always surfaced so staleness is visible rather than silently trusted.
  //
  // Missing snapshot → 'ok': not a failure. First run after upgrade always hits this.
  // unsupported_or_unreachable → 'warn': field was absent, meaning old CC or
  //   task registry unreachable. NEVER report this as "0 crons/tasks" — that
  //   conflation is the silent-wrongness cc-compat exists to prevent.
  try {
    const snapshotPath = path.join(stateDir, 'cc-stop-snapshot.json');
    if (!fs.existsSync(snapshotPath)) {
      return {
        id: 'scheduler',
        status: 'ok',
        detail: 'not yet captured (no Stop since upgrade)',
      };
    }

    const snap = JSON.parse(fs.readFileSync(snapshotPath, 'utf8'));
    const ts = snap.captured_at || 'unknown time';
    // Format as a short ISO string (drop sub-seconds) for readability
    const tsShort = ts.replace(/\.\d+Z$/, 'Z');

    const crons = snap.session_crons || {};
    const tasks = snap.background_tasks || {};

    const isUnsupported = (f: Json) => !f.state || f.state === 'unsupported_or_unreachable';

    // Build per-field descriptions that never collapse absent → zero
    function describeField(field: Json, label: string) {
      if (isUnsupported(field)) {
        return `${label}: unsupported or unreachable`;
      }
      return `${label}: ${field.count} ${field.state === 'empty' ? '(empty)' : 'armed'}`;
    }

    const cronDesc = describeField(crons, 'crons');
    const taskDesc = describeField(tasks, 'tasks');

    const hasUnsupported = isUnsupported(crons) || isUnsupported(tasks);

    const ccVer = snap.cc_version ? ` (cc ${snap.cc_version})` : '';
    const detail = `${cronDesc}, ${taskDesc} — as of ${tsShort}${ccVer}`;

    if (hasUnsupported) {
      return { id: 'scheduler', status: 'warn', detail };
    }
    return { id: 'scheduler', status: 'ok', detail };
  } catch (e: any) {
    return { id: 'scheduler', status: 'fail', detail: `check failed: ${e.message}` };
  }
}

// ----------------- Watchdog -----------------

/**
 * The unit name `hermit-watchdog install` generated for this project.
 *
 * Expanded against the hermit dir, never lib/tmux's cwd-bound getSessionName:
 * doctor is routinely run from somewhere other than the project root, and a
 * wrong name here fails silently rather than loudly — systemd answers `show`
 * for a nonexistent unit with ExecMainStatus=0/Result=success, which reads as
 * a healthy watchdog.
 */
function watchdogUnitName(config: Json, hermitDir: string): string {
  // cmdInstall templates the session name into the instance unit.
  return `hermit-watchdog@${expandSessionName(config, path.dirname(hermitDir))}`;
}

/**
 * Ask systemd how the unit's last run actually ended.
 *
 * A unit whose ExecStart cannot resolve its interpreter exits 127 before the
 * watchdog stamps last_run, so the staleness gate below does eventually notice —
 * but only after STALE_MS, and it reports the generic "enabled but not firing"
 * remedy for what is really a broken unit environment. Reading the unit's own
 * exit status names that case immediately and specifically.
 *
 * Best-effort by construction: not Linux, no systemctl, no bus, or no such unit
 * all mean "nothing to diagnose here", never a doctor failure.
 */
function checkWatchdogUnitStatus(serviceName: string): { status: 'fail'; detail: string } | null {
  if (process.platform !== 'linux' || !Bun.which('systemctl')) return null;
  try {
    const out = execFileSync(
      'systemctl',
      ['--user', 'show', `${serviceName}.service`, '-p', 'ExecMainStatus', '-p', 'Result'],
      // stdio pipes stdout only — systemctl's "Failed to connect to bus" would
      // otherwise leak into doctor output (same pattern as runExpiryProbe).
      { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }
    );
    const props: Record<string, string> = {};
    for (const line of out.split('\n')) {
      const eq = line.indexOf('=');
      if (eq === -1) continue;
      props[line.slice(0, eq)] = line.slice(eq + 1).trim();
    }
    const execStatus = Number(props.ExecMainStatus);
    const result = props.Result;
    const failed = (Number.isFinite(execStatus) && execStatus !== 0) || (!!result && result !== 'success');
    if (!failed) return null;
    const remedy =
      execStatus === 127
        ? "the unit cannot resolve `bun` on its environment PATH — re-run `bin/hermit-watchdog install` to bake the installing shell's PATH, then `systemctl --user daemon-reload`"
        : `inspect with \`journalctl --user -u ${serviceName}\``;
    return {
      status: 'fail',
      detail:
        `watchdog: systemd unit ${serviceName}.service last run failed ` +
        `(ExecMainStatus=${props.ExecMainStatus ?? '?'}, Result=${result ?? '?'}) — ${remedy}`,
    };
  } catch {
    return null;
  }
}

/**
 * A unit generated before the PATH fix carries no `Environment="PATH="` line.
 *
 * The exit-status probe above cannot see that case any more: hermit-exec.sh now
 * resolves `bun` by absolute path, so such a unit exits 0 and stamps `last_run`,
 * and both the probe and the staleness gate read as healthy. The restart tier is
 * still broken — hermit-start's preflight hard-fails when `bun` and `claude`
 * aren't on the unit's own PATH — so the unit file itself is the only remaining
 * evidence. Checked after liveness and the shutdown stamp: those are the
 * higher-severity signals and must win when several hold.
 */
function checkWatchdogUnitPathBaked(serviceName: string): { status: 'warn'; detail: string } | null {
  if (process.platform !== 'linux') return null;
  const unitFile = path.join(os.homedir(), '.config', 'systemd', 'user', `${serviceName}.service`);
  let unit: string;
  try { unit = fs.readFileSync(unitFile, 'utf-8'); } catch { return null; }
  if (/^Environment="?PATH=/m.test(unit)) return null;
  return {
    status: 'warn',
    detail:
      `watchdog: systemd unit ${serviceName}.service predates the PATH fix (no Environment=PATH) — ` +
      'the tick survives via the shim\'s bun fallback, but a restart dies in hermit-start\'s ' +
      'preflight because `bun`/`claude` are off the unit PATH — re-run `bin/hermit-watchdog install`',
  };
}

function checkWatchdog(p: DoctorPaths = PATHS) {
  const { hermitDir, stateDir } = p;
  try {
    const config = readSettledConfig(hermitDir);
    const wCfg = config.watchdog;

    // Steps 0a-0c (post-close clear, emergency clear, routine-hygiene compact) run
    // independent of watchdog.enabled — a hermit can have the restart tier off and
    // still depend on the scheduler tick for hygiene. Only report the "disabled
    // (opt-in)" all-clear when nothing at all needs that tick.
    const hygieneActive = config.post_close_clear === true
      || (typeof wCfg.context_clear_tokens === 'number' && wCfg.context_clear_tokens > 0)
      || config.context_hygiene?.compact?.enabled === true;

    if (!wCfg.enabled && !hygieneActive) {
      return { id: 'watchdog', status: 'ok', detail: 'watchdog: disabled (opt-in via config.watchdog.enabled)' };
    }

    let runtime: Json = null;
    try { runtime = JSON.parse(fs.readFileSync(path.join(stateDir, 'runtime.json'), 'utf-8')); } catch {}

    // Ahead of the staleness gate: a unit that fails on every invocation is a
    // more specific diagnosis than "not firing", and waiting out STALE_MS to say
    // something vaguer helps nobody. Docker mode runs the loop from the container
    // entrypoint, not a systemd user unit, so it is not in scope here.
    const unitInScope = runtime?.runtime_mode === 'tmux' || runtime?.runtime_mode == null;
    const unitName = unitInScope ? watchdogUnitName(config, hermitDir) : null;
    if (unitName) {
      const unitStatus = checkWatchdogUnitStatus(unitName);
      if (unitStatus) return { id: 'watchdog', ...unitStatus };
    }

    const statePath = path.join(stateDir, 'watchdog-state.json');
    let consecutive = 0;
    let lastRun: string | null = null;
    let lastHygieneEval: Json = null;
    let hygieneCounts: Json = null;
    try {
      const ws = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
      consecutive = ws.consecutive_stale || 0;
      lastRun = typeof ws.last_run === 'string' ? ws.last_run : null;
      lastHygieneEval = ws.last_hygiene_eval ?? null;
      hygieneCounts = ws.hygiene_eval_counts ?? null;
    } catch {}

    // Liveness: the watchdog stamps last_run on every invocation, before any gate. A
    // missing or stale last_run means the scheduler/loop isn't firing the script — a
    // higher-severity signal than any past restart, so it takes precedence. Checked
    // even when the restart tier is off, since the hygiene tier needs the same tick.
    const STALE_MS = 20 * 60 * 1000; // ~4× the ~5 min tick interval
    const lastRunMs = lastRun ? Date.parse(lastRun) : NaN;
    const stale = !Number.isFinite(lastRunMs) || Date.now() - lastRunMs > STALE_MS;

    if (stale) {
      const mode = runtime?.runtime_mode;
      const ageNote = Number.isFinite(lastRunMs)
        ? `last ran ${Math.round((Date.now() - lastRunMs) / 60000)}m ago`
        : 'never ran';
      let remedy: string;
      if (mode === 'tmux') {
        remedy = 'run `bin/hermit-watchdog install`';
      } else if (mode === 'docker') {
        remedy = 'recreate the container (`docker compose up -d --force-recreate`) — containers built before v1.1.11 predate the entrypoint watchdog loop';
      } else {
        remedy = 'native: run `bin/hermit-watchdog install`; Docker: recreate the container (`docker compose up -d --force-recreate`)';
      }
      return { id: 'watchdog', status: 'warn', detail: `watchdog: enabled but not firing (${ageNote}) — ${remedy}` };
    }

    // Pathology: a shutdown stamp on a still-alive session silently bricks context
    // hygiene AND watchdog restart recovery — passesLifecycleGuards treats any non-null
    // shutdown_requested_at/shutdown_completed_at as "the hermit is stopping". hermit-start
    // clears both stamps on boot, so a surviving stamp means a non-hermit-stop close
    // planted it (a nightly auto-close reusing /session-close's "Full Shutdown" framing)
    // and the hermit hasn't restarted since. Checked AFTER liveness: a dead scheduler is
    // the higher-severity signal and its remedy differs, so it must win when both hold.
    // Gated on stamp age: a real in-flight hermit-stop stamps shutdown_requested_at
    // seconds before /session-close flips session_state to idle, so a fresh stamp on an
    // in_progress/waiting session is that transient window, not the pathology.
    if (runtime && ['in_progress', 'waiting'].includes(runtime.session_state)) {
      const stamp = runtime.shutdown_requested_at || runtime.shutdown_completed_at;
      const stampMs = stamp ? Date.parse(stamp) : NaN;
      if (stamp && (!Number.isFinite(stampMs) || Date.now() - stampMs > STALE_MS)) {
        return {
          id: 'watchdog',
          status: 'warn',
          detail: `watchdog: session alive (${runtime.session_state}) but runtime.json carries a stale shutdown stamp (${stamp}) — blocks context hygiene and watchdog restart until the next hermit-start clears it`,
        };
      }
    }

    if (unitName) {
      const stalePath = checkWatchdogUnitPathBaked(unitName);
      if (stalePath) return { id: 'watchdog', ...stalePath };
    }

    const eventsPath = path.join(stateDir, 'watchdog-events.jsonl');
    const cutoff = new Date(Date.now() - 7 * MS_PER_DAY).toISOString();
    let restarts = 0;
    let nudges = 0;
    let rearms = 0;
    let clears = 0;
    let compacts = 0;
    try {
      const lines = fs.readFileSync(eventsPath, 'utf-8').split('\n');
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const e = JSON.parse(line);
          if (e.ts < cutoff) continue;
          if (e.action === 'restart') restarts++;
          else if (e.action === 'nudge') nudges++;
          else if (e.action === 're-arm-fallback') rearms++;
          else if (e.action === 'context-clear') clears++;
          else if (e.action === 'context-compact') compacts++;
        } catch {}
      }
    } catch {}

    const parts = [`restarts: ${restarts}`, `nudges: ${nudges}`, `re-arms: ${rearms}`, `clears: ${clears}`, `compacts: ${compacts}`];
    if (consecutive > 0) parts.push(`stale cycles in progress: ${consecutive}`);
    // last_hygiene_eval is keyed per mechanism ({ clear?, compact? }) so a tick where
    // both tiers run keeps each tier's own record. Surface whichever ran most recently.
    const evalMsOf = (r: Json) => { const t = typeof r?.ts === 'string' ? Date.parse(r.ts) : NaN; return Number.isFinite(t) ? t : 0; };
    let mostRecentHygiene: { mech: string; rec: Json } | null = null;
    for (const mech of ['clear', 'compact']) {
      const rec = lastHygieneEval?.[mech];
      if (!rec || typeof rec.outcome !== 'string') continue;
      if (!mostRecentHygiene || evalMsOf(rec) > evalMsOf(mostRecentHygiene.rec)) mostRecentHygiene = { mech, rec };
    }
    if (mostRecentHygiene) {
      const evalMs = evalMsOf(mostRecentHygiene.rec);
      const ageSuffix = evalMs ? `, ${Math.round((Date.now() - evalMs) / 60000)}m ago` : '';
      parts.push(`last hygiene eval: ${mostRecentHygiene.mech}/${mostRecentHygiene.rec.outcome}${ageSuffix}`);
    }
    // Durable first-blocker counters (each evaluation records the first guard that
    // returned, not every binding constraint) — top outcomes per mechanism so the
    // skip mix is readable from one line without a time series.
    if (hygieneCounts && typeof hygieneCounts === 'object') {
      const since = typeof hygieneCounts.since === 'string' ? hygieneCounts.since.slice(0, 10) : '?';
      for (const mech of ['clear', 'compact']) {
        const counts = hygieneCounts[mech];
        if (!counts || typeof counts !== 'object') continue;
        const top = Object.entries(counts)
          .filter(([, n]) => typeof n === 'number')
          .sort((a: Json, b: Json) => b[1] - a[1])
          .slice(0, 4)
          .map(([k, n]) => `${k.replace(/^skip:/, '')} ${n}`);
        if (top.length) parts.push(`${mech} first-blockers since ${since}: ${top.join(', ')}`);
      }
    }
    // Recorded fixed-surface upper bound — informational only (the derivation
    // carries wake contamination, so growth between readings is not by itself a
    // surface-growth signal; no warn threshold here).
    const surfaceRec = readContextSurface(hermitDir);
    if (surfaceRec) {
      const prevNote = surfaceRec.prev ? `, prev ${kStr(surfaceRec.prev.surface_upper_bound_tokens)}` : '';
      parts.push(`surface upper bound ${kStr(surfaceRec.surface_upper_bound_tokens)} (boundary ${String(surfaceRec.boundary_at).slice(0, 10)}${prevNote})`);
    }
    const label = wCfg.enabled
      ? `enabled, last tick ${Math.round((Date.now() - lastRunMs) / 60000)}m ago`
      : 'restart tier disabled, hygiene tier active';
    const detail = `watchdog: ${label} — ${parts.join(', ')} (last 7d)`;

    if (restarts > 0 || consecutive > 0) {
      return { id: 'watchdog', status: 'warn', detail };
    }
    return { id: 'watchdog', status: 'ok', detail };
  } catch (e: any) {
    return { id: 'watchdog', status: 'fail', detail: `check failed: ${e.message}` };
  }
}

// ----------------- Context age -----------------
// The single worst waste pattern the 2026-07-09 live-harness audit found: a session that
// never compacts, silently re-reading a huge context on every turn. 1.2.19 fixed the one
// known cause (a stuck shutdown stamp bricking both hygiene tiers), but nothing tripwires
// the *symptom* independent of cause — this check does, so a future hygiene-disabling bug
// doesn't go unnoticed for days again.
//
// Token-signal selection (promptTokensOf, isEstimateOnlyEntry) now comes from
// lib/context-signal.ts, shared with hermit-watchdog.ts — the previous local
// mirror had drifted to prefer the turn-wide max_prompt_tokens, which on a turn
// that compacted mid-flight describes a context CC already threw away. Only the
// path-dependent helpers (session id resolution, cost-log read) stay local:
// doctor-check.ts is deliberately invocable with an explicit hermit dir
// different from CWD (see the costLog comment above).

/** Session id whose context size to judge: runtime.json's session_id, falling back to the
 *  harness id in sessions/.status.json for idle-phase wakes (heartbeat/routines/channel
 *  messages) — the same fallback hermit-watchdog.ts's hygiene tiers use, so this check
 *  can't be blind to exactly the accumulation they exist to catch. */
function resolveContextSessionId(runtime: Json, p: DoctorPaths): string {
  const { hermitDir } = p;
  const sid = runtime?.session_id;
  if (typeof sid === 'string' && sid) return sid;
  try {
    const status = JSON.parse(fs.readFileSync(path.join(hermitDir, 'sessions', '.status.json'), 'utf8'));
    return typeof status?.session_id === 'string' ? status.session_id : '';
  } catch {
    return '';
  }
}

const CONTEXT_AGE_STALE_HOURS = 24;

function checkContextAge(p: DoctorPaths = PATHS) {
  const { hermitDir, stateDir, costLog } = p;
  try {
    const read = readConfigOrCovered('context-age', p);
    if ('covered' in read) return read.covered;
    const config = read.config;

    const compactCfg = config.context_hygiene?.compact;
    const threshold = compactCfg?.min_context_tokens;
    if (!compactCfg || compactCfg.enabled !== true || typeof threshold !== 'number' || threshold <= 0) {
      return { id: 'context-age', status: 'ok', detail: 'context_hygiene.compact not enabled — skipping' };
    }

    const runtimePath = path.join(stateDir, 'runtime.json');
    let runtime: Json = null;
    try { runtime = JSON.parse(fs.readFileSync(runtimePath, 'utf-8')); } catch {}
    if (!runtime || !['in_progress', 'waiting'].includes(runtime.session_state)) {
      return { id: 'context-age', status: 'ok', detail: 'no active session' };
    }

    const sessionId = resolveContextSessionId(runtime, p);
    if (!sessionId) {
      return { id: 'context-age', status: 'ok', detail: 'active session but no session id resolvable — skipping' };
    }

    // Last non-subagent cost-log entry for this session — mirrors getLastCostLogEntry.
    let lastEntry: Json = null;
    if (fs.existsSync(costLog)) {
      for (const line of fs.readFileSync(costLog, 'utf-8').split('\n')) {
        if (!line.trim()) continue;
        try {
          const e = JSON.parse(line);
          if (e && e.session_id === sessionId && e.subagent !== true) lastEntry = e;
        } catch {}
      }
    }
    if (!lastEntry) {
      return { id: 'context-age', status: 'ok', detail: 'no cost-log entry for the active session yet' };
    }

    // This is a compact-tier tripwire, so it judges the same token count the compact
    // tier acts on: estimated compactible conversation (total prompt minus the recorded
    // fixed-surface upper bound, or the 50k cold-start assumption), with estimate-only
    // entries averaged (as maybeContextCompact does) rather than skipped. Only the
    // destructive /clear tier refuses estimate-only entries — mirroring that skip here
    // would blind the check to a bloated session whose latest turn happens to be a
    // multi-call estimate, the exact case compact still compacts.
    const prompt = promptTokensOf(lastEntry);
    const compactible = compactibleTokens(lastEntry, readContextSurface(hermitDir)?.surface_upper_bound_tokens ?? null);
    if (compactible <= threshold) {
      return { id: 'context-age', status: 'ok', detail: `context ${kStr(prompt)} tokens (~${kStr(compactible)} compactible), at/under ${kStr(threshold)} threshold` };
    }

    const eventsPath = path.join(stateDir, 'watchdog-events.jsonl');
    let lastHygieneAt: string | null = null;
    try {
      for (const line of fs.readFileSync(eventsPath, 'utf-8').split('\n')) {
        if (!line.trim()) continue;
        try {
          const e = JSON.parse(line);
          if (['context-compact', 'context-clear', 'post-close-clear'].includes(e.action)
              && (!lastHygieneAt || e.ts > lastHygieneAt)) {
            lastHygieneAt = e.ts;
          }
        } catch {}
      }
    } catch {}

    const ageHours = lastHygieneAt ? (Date.now() - Date.parse(lastHygieneAt)) / 3600000 : Infinity;

    if (!Number.isFinite(ageHours) || ageHours > CONTEXT_AGE_STALE_HOURS) {
      const ageNote = lastHygieneAt ? `last hygiene event ${ageHours.toFixed(1)}h ago` : 'no hygiene event recorded yet';
      return {
        id: 'context-age',
        status: 'warn',
        detail: `context ${kStr(prompt)} tokens (~${kStr(compactible)} compactible) over ${kStr(threshold)} threshold, ${ageNote} — context hygiene may be disabled or stuck; see the watchdog check`,
      };
    }

    return { id: 'context-age', status: 'ok', detail: `context ${kStr(prompt)} tokens (~${kStr(compactible)} compactible) over threshold, hygiene fired ${ageHours.toFixed(1)}h ago` };
  } catch (e: any) {
    return { id: 'context-age', status: 'fail', detail: `check failed: ${e.message}` };
  }
}

function checkOpusWake(p: DoctorPaths = PATHS) {
  const { costLog } = p;
  try {
    const since = new Date(Date.now() - 7 * MS_PER_DAY).toISOString().slice(0, 10);
    const { count, cost } = scanAutomatedOpus(costLog, since);
    if (count > 0) {
      return { id: 'opus-wake', status: 'warn',
        detail: `${count} automated wake(s) on Opus in last 7d ($${cost.toFixed(2)}) — lower the session model to cut tier-drift cost` };
    }
    return { id: 'opus-wake', status: 'ok', detail: 'no Opus automated wakes in last 7d' };
  } catch (e: any) {
    return { id: 'opus-wake', status: 'fail', detail: `check failed: ${e.message}` };
  }
}

function checkHeartbeat(p: DoctorPaths = PATHS) {
  const { hermitDir, stateDir } = p;
  try {
    const config = readSettledConfig(hermitDir);
    const hbCfg = config.heartbeat;

    if (!hbCfg.enabled) {
      return { id: 'heartbeat', status: 'ok', detail: 'heartbeat: disabled' };
    }

    const runtimePath = path.join(stateDir, 'runtime.json');
    if (!fs.existsSync(runtimePath)) {
      return { id: 'heartbeat', status: 'ok', detail: 'heartbeat: enabled, no runtime state' };
    }
    const rt = JSON.parse(fs.readFileSync(runtimePath, 'utf-8'));
    const sessionState = rt.session_state;
    if (sessionState !== 'in_progress' && sessionState !== 'waiting') {
      return { id: 'heartbeat', status: 'ok', detail: `heartbeat: enabled, no active session (state=${sessionState ?? 'unknown'})` };
    }

    const threshold = 3 * parseDuration(hbCfg.every, 30 * 60000);
    // A healthy monitor writes liveness on its first loop iteration (before any
    // sleep), so a real tick lands within seconds of spawn. The absent-liveness
    // grace only needs to cover spawn + first precheck — not a full poll interval
    // — otherwise a spawn-blocked monitor reads "warming up" for hours.
    const STARTUP_GRACE_MS = 2 * 60 * 1000;
    const now = Date.now();

    // Monitor registration time. Used both to reject a liveness tick left by a
    // prior session's monitor (a tick older than started_at is stale, not proof
    // the current monitor is alive) and to bound the startup grace below.
    let startedAt: number | null = null;
    try {
      const monRt = JSON.parse(fs.readFileSync(path.join(stateDir, 'heartbeat-monitor.runtime.json'), 'utf-8'));
      if (typeof monRt.started_at === 'string') {
        const t = Date.parse(monRt.started_at);
        if (Number.isFinite(t)) startedAt = t;
      }
    } catch { /* missing or unparseable */ }

    const livenessPath = path.join(stateDir, 'heartbeat-liveness.json');
    let lastPeekAt: number | null = null;
    try {
      const liveness = JSON.parse(fs.readFileSync(livenessPath, 'utf-8'));
      if (typeof liveness.last_peek_at === 'string') {
        const t = Date.parse(liveness.last_peek_at);
        if (Number.isFinite(t)) lastPeekAt = t;
      }
    } catch { /* missing or unparseable */ }

    const trusted = lastPeekAt !== null && (startedAt === null || lastPeekAt >= startedAt);

    if (trusted) {
      const ageMs = now - lastPeekAt!;
      const tickStr = `${Math.round(ageMs / 60000)}m ago`;
      if (ageMs > threshold) {
        return {
          id: 'heartbeat',
          status: 'fail',
          detail: `heartbeat not ticking — Monitor subprocess spawn likely blocked (seccomp / nested-userns in container); shell /watch streams are dead too. Last tick: ${tickStr}.`,
        };
      }
      return { id: 'heartbeat', status: 'ok', detail: `heartbeat: ticking (last tick ${tickStr})` };
    }

    // No trustworthy tick. Flag once the monitor has had longer than the startup
    // grace to write its first one; otherwise it is still warming up.
    if (startedAt !== null && (now - startedAt) >= STARTUP_GRACE_MS) {
      const tickStr = lastPeekAt !== null ? `${Math.round((now - lastPeekAt) / 60000)}m ago (predates current monitor — stale)` : 'never';
      return {
        id: 'heartbeat',
        status: 'fail',
        detail: `heartbeat not ticking — Monitor subprocess spawn likely blocked (seccomp / nested-userns in container); shell /watch streams are dead too. Last tick: ${tickStr}.`,
      };
    }

    return { id: 'heartbeat', status: 'ok', detail: 'heartbeat: warming up — monitor registered, first tick pending' };
  } catch (e: any) {
    return { id: 'heartbeat', status: 'fail', detail: `check failed: ${e.message}` };
  }
}

// Modeled directly on checkHeartbeat above — same active-session-only gate, same
// startup-grace and trust-liveness-against-started_at logic. Two differences:
// (1) enabled/scope is derived from config.routines (any non-anchor enabled entry),
// not a single heartbeat.enabled flag; (2) a croncreate-fallback mode (Monitor tool
// unavailable) is reported ok rather than evaluated for liveness at all.
function checkRoutineMonitor(p: DoctorPaths = PATHS) {
  const { stateDir } = p;
  try {
    const read = readConfigOrCovered('routine-monitor', p);
    if ('covered' in read) return read.covered;
    const config = read.config;

    const nonAnchorEnabled = (Array.isArray(config.routines) ? config.routines : [])
      .some((r: Json) => r && r.enabled === true && r.id !== 'heartbeat-restart');
    if (!nonAnchorEnabled) {
      return { id: 'routine-monitor', status: 'ok', detail: 'routine-monitor: no monitor-scheduled routines' };
    }

    const runtimeFilePath = path.join(stateDir, 'routine-monitor.runtime.json');
    let monRt: Json = null;
    try { monRt = JSON.parse(fs.readFileSync(runtimeFilePath, 'utf-8')); } catch { /* absent or unparseable */ }
    if (!monRt) {
      return { id: 'routine-monitor', status: 'ok', detail: 'routine-monitor: not yet loaded (run /claude-code-hermit:hermit-routines load)' };
    }
    if (monRt.mode === 'croncreate-fallback') {
      return { id: 'routine-monitor', status: 'ok', detail: 'routine-monitor: croncreate-fallback mode (Monitor unavailable)' };
    }

    const runtimePath = path.join(stateDir, 'runtime.json');
    if (!fs.existsSync(runtimePath)) {
      return { id: 'routine-monitor', status: 'ok', detail: 'routine-monitor: enabled, no runtime state' };
    }
    const rt = JSON.parse(fs.readFileSync(runtimePath, 'utf-8'));
    const sessionState = rt.session_state;
    if (sessionState !== 'in_progress' && sessionState !== 'waiting') {
      return { id: 'routine-monitor', status: 'ok', detail: `routine-monitor: enabled, no active session (state=${sessionState ?? 'unknown'})` };
    }

    const interval = typeof monRt.interval === 'number' && monRt.interval > 0 ? monRt.interval : 60;
    const threshold = Math.max(10 * interval * 1000, 10 * 60 * 1000);
    const STARTUP_GRACE_MS = 2 * 60 * 1000;
    const now = Date.now();

    let startedAt: number | null = null;
    if (typeof monRt.started_at === 'string') {
      const t = Date.parse(monRt.started_at);
      if (Number.isFinite(t)) startedAt = t;
    }

    const livenessPath = path.join(stateDir, 'routine-monitor-liveness.json');
    let lastPeekAt: number | null = null;
    try {
      const liveness = JSON.parse(fs.readFileSync(livenessPath, 'utf-8'));
      if (typeof liveness.last_peek_at === 'string') {
        const t = Date.parse(liveness.last_peek_at);
        if (Number.isFinite(t)) lastPeekAt = t;
      }
    } catch { /* missing or unparseable */ }

    const trusted = lastPeekAt !== null && (startedAt === null || lastPeekAt >= startedAt);

    if (trusted) {
      const ageMs = now - lastPeekAt!;
      const tickStr = `${Math.round(ageMs / 60000)}m ago`;
      if (ageMs > threshold) {
        return {
          id: 'routine-monitor',
          status: 'fail',
          detail: `routine-monitor not ticking — Monitor subprocess spawn likely blocked (seccomp / nested-userns in container). Last tick: ${tickStr}.`,
        };
      }
      return { id: 'routine-monitor', status: 'ok', detail: `routine-monitor: ticking (last tick ${tickStr})` };
    }

    if (startedAt !== null && (now - startedAt) >= STARTUP_GRACE_MS) {
      const tickStr = lastPeekAt !== null ? `${Math.round((now - lastPeekAt) / 60000)}m ago (predates current monitor — stale)` : 'never';
      return {
        id: 'routine-monitor',
        status: 'fail',
        detail: `routine-monitor not ticking — Monitor subprocess spawn likely blocked (seccomp / nested-userns in container). Last tick: ${tickStr}.`,
      };
    }

    return { id: 'routine-monitor', status: 'ok', detail: 'routine-monitor: warming up — monitor registered, first tick pending' };
  } catch (e: any) {
    return { id: 'routine-monitor', status: 'fail', detail: `check failed: ${e.message}` };
  }
}

/**
 * Wake gates that are not gating.
 *
 * A `precheck` fails open: the routine wakes the session anyway, so a broken gate
 * costs no more than having none — but it also saves nothing, silently. This is the
 * only surface that says so. Deliberately its own check rather than a line on
 * routine-monitor: that one returns early in fallback mode and whenever no session
 * is active, and a gate can be failing in exactly those states.
 */
function checkRoutinePrecheck(p: DoctorPaths = PATHS) {
  const { hermitDir, stateDir } = p;
  try {
    const read = readConfigOrCovered('routine-precheck', p);
    if ('covered' in read) return read.covered;
    const config = read.config;

    const gated = (Array.isArray(config.routines) ? config.routines : [])
      .filter((r: Json) => r && r.enabled === true && r.precheck != null && r.id !== 'heartbeat-restart');
    if (gated.length === 0) {
      return { id: 'routine-precheck', status: 'ok', detail: 'routine-precheck: no gated routines' };
    }

    const history = readRoutineHistory(path.join(stateDir, 'routine-metrics.jsonl'), 14);
    const byId = new Map(history.routines.map((r) => [r.id, r]));
    const broken: string[] = [];
    for (const routine of gated) {
      const entry = byId.get(routine.id);
      if (!entry || entry.precheck_errors === 0) continue;
      // Deliberately NOT "did it fire": the gate fails open, so every error IS
      // followed by a wake and a `fired` — a fire count would suppress this check
      // in exactly the case it exists to catch. What counts is evidence the gate
      // ever *answered*: a `skipped-precheck` row (a SKIP verdict), or a wake the
      // errors do not account for (a WAKE verdict). Neither means it never worked,
      // and every fire since has been one the operator meant to skip.
      if (entry.precheck_skips > 0 || entry.starts > entry.precheck_errors) continue;
      broken.push(`${routine.id} (${entry.precheck_errors}x ${entry.last_precheck_error?.detail ?? 'unspecified'})`);
    }

    let monRt: Json = null;
    try { monRt = JSON.parse(fs.readFileSync(path.join(stateDir, 'routine-monitor.runtime.json'), 'utf-8')); } catch { /* absent */ }
    const fallback = monRt && monRt.mode === 'croncreate-fallback';

    if (broken.length) {
      return {
        id: 'routine-precheck',
        status: 'warn',
        detail: `routine-precheck: gate never succeeded for ${broken.join(', ')} — every fire woke the session. Check the script from ${hermitDir}'s project root.`,
      };
    }
    if (fallback) {
      return {
        id: 'routine-precheck',
        status: 'ok',
        detail: `routine-precheck: ${gated.length} gated routine(s), croncreate-fallback mode — prechecks run after the wake, so no zero-token skips`,
      };
    }
    return { id: 'routine-precheck', status: 'ok', detail: `routine-precheck: ${gated.length} gated routine(s), no gate errors in 14d` };
  } catch (e: any) {
    return { id: 'routine-precheck', status: 'fail', detail: `check failed: ${e.message}` };
  }
}

function checkRawSize(p: DoctorPaths = PATHS) {
  const { hermitDir, stateDir } = p;
  try {
    const rawDir = path.join(hermitDir, 'raw');
    if (!fs.existsSync(rawDir)) {
      return { id: 'raw-size', status: 'ok', detail: 'raw/ absent' };
    }

    let bytes = 0;
    let rawFileCount = 0;
    for (const entry of fs.readdirSync(rawDir, { withFileTypes: true })) {
      if (entry.isFile()) {
        if (/^[^.].*\.(md|json)$/.test(entry.name)) rawFileCount++;
        try { bytes += fs.statSync(path.join(rawDir, entry.name)).size; } catch {}
      }
    }
    const archiveDir = path.join(rawDir, '.archive');
    if (fs.existsSync(archiveDir)) {
      for (const entry of fs.readdirSync(archiveDir, { withFileTypes: true })) {
        if (entry.isFile()) {
          try { bytes += fs.statSync(path.join(archiveDir, entry.name)).size; } catch {}
        }
      }
    }

    const mb = bytes / (1024 * 1024);
    const WARN_MB = 50;

    let lastRawArchive: string | null = null;
    try {
      const rt = JSON.parse(fs.readFileSync(path.join(stateDir, 'runtime.json'), 'utf8'));
      lastRawArchive = rt.last_raw_archive_at ?? null;
    } catch {}
    const archiveDays = daysSince(lastRawArchive);
    const sizeWarn = mb > WARN_MB;
    const staleWarn = rawFileCount > 0 && (archiveDays === null || archiveDays > 14);

    if (sizeWarn || staleWarn) {
      const parts: string[] = [];
      if (sizeWarn) parts.push(`${mb.toFixed(1)} MB (>${WARN_MB} MB threshold)`);
      if (staleWarn) parts.push(archiveDays === null ? 'archive-raw has never run' : `archive-raw last ran ${archiveDays.toFixed(0)}d ago`);
      return { id: 'raw-size', status: 'warn', detail: `raw/: ${parts.join('; ')}` };
    }

    return {
      id: 'raw-size', status: 'ok',
      detail: `raw/ ${mb.toFixed(1)} MB, archive-raw ${archiveDays !== null ? `${archiveDays.toFixed(0)}d ago` : 'never run'}`,
    };
  } catch (e: any) {
    return { id: 'raw-size', status: 'fail', detail: `check failed: ${e.message}` };
  }
}

// ----------------- Credential expiry -----------------
//
// Claude Code's own OAuth *access* token is intentionally NOT checked here: it
// refreshes silently via the long-lived refresh token roughly every 8h with
// no operator action, so warning on its expiresAt was a false alarm (confirmed
// live — unattended hermits rewrite .credentials.json hours after boot with no
// /login run).
//
// A `claude setup-token` credential is the opposite case and IS checked: the
// hermit mints it, it lasts a year, nothing refreshes it, and renewal needs a
// human browser tap. Core declares it like any other credential — via its own
// hermit-meta.json — so this check covers core plus every sibling plugin that
// declares an expiry_probe.

// Probe timeout: 5s default; env override exists solely so tests can exercise
// the timeout path without waiting 5 real seconds.
const CRED_PROBE_TIMEOUT_MS_ENV = Number(process.env.HERMIT_CRED_PROBE_TIMEOUT_MS);
const CRED_PROBE_TIMEOUT_MS = CRED_PROBE_TIMEOUT_MS_ENV > 0 ? CRED_PROBE_TIMEOUT_MS_ENV : 5000;
const CRED_WARN_WINDOW_MS = 7 * 24 * 3600000; // < 7d → warn
const CRED_PROBE_CEILING = 8; // defensive cap on total probes run per doctor pass

type ProbeResult =
  | { kind: 'ok' }
  | { kind: 'expired' }
  | { kind: 'expires'; at: number }
  | { kind: 'probe-failed'; reason: string };

// Runs one hermit-meta.json expiry_probe. Protocol: bash -c <cmd>, one line of
// stdout, exactly OK | EXPIRED | EXPIRES:<iso8601>. Anything else (multi-word
// first line, unparseable date, timeout, nonzero exit) degrades to a warn-level
// "probe failed" — never crashes the doctor check. CLAUDE_PLUGIN_ROOT is set to
// the declaring plugin's dir (not core's) so a probe like
// `bun ${CLAUDE_PLUGIN_ROOT}/scripts/check-token.ts` resolves against its own scripts.
function runExpiryProbe(cmd: string, pluginDir: string): ProbeResult {
  let out: string;
  try {
    out = execFileSync('bash', ['-c', cmd], {
      encoding: 'utf8',
      timeout: CRED_PROBE_TIMEOUT_MS,
      stdio: ['ignore', 'pipe', 'ignore'],
      env: { ...process.env, CLAUDE_PLUGIN_ROOT: pluginDir },
    });
  } catch (e: any) {
    return { kind: 'probe-failed', reason: e?.code === 'ETIMEDOUT' || e?.signal === 'SIGTERM' ? 'timeout' : 'exit error' };
  }
  const line = (out.split('\n')[0] || '').trim();
  if (line === 'OK') return { kind: 'ok' };
  if (line === 'EXPIRED') return { kind: 'expired' };
  if (line.startsWith('EXPIRES:')) {
    const at = Date.parse(line.slice('EXPIRES:'.length));
    if (Number.isNaN(at)) return { kind: 'probe-failed', reason: 'malformed date' };
    return { kind: 'expires', at };
  }
  return { kind: 'probe-failed', reason: 'malformed output' };
}

// Walks core's own and sibling plugins' hermit-meta.json credentials[] and runs
// each declared expiry_probe, capped at CRED_PROBE_CEILING total probes (defensive
// ceiling on wall-clock: worst case CRED_PROBE_CEILING × CRED_PROBE_TIMEOUT_MS).
// Entries missing expiry_probe are skipped silently — declaring a credential
// without a probe is allowed, there's just nothing to check.
//
// Core is probed first and deliberately: siblingPluginDirs() excludes core's own
// dir in both cache layouts, so core's setup-token credential would otherwise be
// invisible to the very check that exists to catch expiring credentials.
function probeDeclaredCredentials(p: DoctorPaths): { okCount: number; badNotes: string[] } {
  const { pluginRoot } = p;
  const coreName = readCoreName(pluginRoot);

  let okCount = 0;
  const badNotes: string[] = [];
  let probesRun = 0;
  let skipped = 0;

  for (const dir of [pluginRoot, ...siblingPluginDirs(pluginRoot, coreName)]) {
    const meta = readHermitMeta(dir);
    const credentials = Array.isArray(meta.credentials) ? meta.credentials : [];
    const pluginLabel = (dir === pluginRoot ? coreName : readCoreName(dir)) || path.basename(dir);

    for (const cred of credentials) {
      if (!cred || typeof cred.expiry_probe !== 'string' || !cred.expiry_probe) continue;
      // Past the ceiling, count remaining credentials as skipped rather than
      // silently dropping them — an unchecked credential must not read as ok.
      if (probesRun >= CRED_PROBE_CEILING) { skipped++; continue; }
      probesRun++;
      const who = `${pluginLabel}/${cred.name || 'credential'}`;
      const fix = cred.reauth_skill ? ` — run ${cred.reauth_skill}` : '';
      // Per-credential lead time: a credential whose renewal needs the operator
      // to find a browser deserves more notice than the 7d default. Core's
      // setup-token asks for 14.
      const warnDays = Number(cred.warn_days);
      const warnWindowMs = warnDays > 0 ? warnDays * 24 * 3600000 : CRED_WARN_WINDOW_MS;
      const result = runExpiryProbe(cred.expiry_probe, dir);
      if (result.kind === 'ok') {
        okCount++;
      } else if (result.kind === 'expired') {
        badNotes.push(`${who} EXPIRED${fix}`);
      } else if (result.kind === 'expires') {
        const msLeft = result.at - Date.now();
        if (msLeft <= 0) {
          badNotes.push(`${who} EXPIRED${fix}`);
        } else if (msLeft < warnWindowMs) {
          badNotes.push(`${who} expires in ${(msLeft / (24 * 3600000)).toFixed(1)}d${fix}`);
        } else {
          okCount++;
        }
      } else {
        badNotes.push(`${who} probe failed (${result.reason})`);
      }
    }
  }
  if (skipped > 0) badNotes.push(`${skipped} credential(s) not checked (probe ceiling ${CRED_PROBE_CEILING} reached)`);
  return { okCount, badNotes };
}

// A stored /login credential sitting next to a setup-token is a live hazard, not
// an expiry question: interactive Claude Code sessions prefer .credentials.json
// over CLAUDE_CODE_OAUTH_TOKEN, so the hermit 401s when that stored access token
// lapses (~8h) even though the year-long token is valid. Only a credential that
// still carries a token shadows — a parked file or a /logout stub (empty
// accessToken) is inert, so those return null.
function shadowingCredentialNote(): string | null {
  const configDir = defaultConfigDir();
  if (!tokenModeActive(configDir)) return null;
  try {
    const creds = JSON.parse(fs.readFileSync(credentialsFilePath(configDir), 'utf8'));
    const token = creds?.claudeAiOauth?.accessToken;
    if (typeof token !== 'string' || token.length === 0) return null;
  } catch {
    return null; // absent or unreadable — nothing to shadow
  }
  return `stored ${CREDENTIALS_FILENAME} will shadow the login token in interactive sessions — park it (mv ${credentialsFilePath(configDir)} ${parkedCredentialsFilePath(configDir)}) and restart`;
}

function checkCredentialExpiry(p: DoctorPaths = PATHS) {
  try {
    const sib = probeDeclaredCredentials(p);
    const shadow = shadowingCredentialNote();
    const parts = [...sib.badNotes];
    if (shadow) parts.push(shadow);
    const status = parts.length > 0 ? 'warn' : 'ok';
    if (sib.okCount > 0) parts.push(`${sib.okCount} plugin credential(s) ok`);
    if (parts.length === 0) parts.push('no plugin declares a credential to probe');
    return { id: 'credential-expiry', status, detail: parts.join('; ') };
  } catch (e: any) {
    return { id: 'credential-expiry', status: 'fail', detail: `check failed: ${e.message}` };
  }
}

// ----------------- Model pricing known -----------------

// Shared by the two config-reading checks below: config.json's own validity is
// checkConfig()'s job, so a missing/unreadable file here is 'ok', not a second
// failure for the same root cause.
function readConfigOrCovered(id: string, p: DoctorPaths): { config: Json } | { covered: { id: string; status: string; detail: string } } {
  const { hermitDir } = p;
  if (!configExists(hermitDir)) {
    return { covered: { id, status: 'ok', detail: 'config.json absent (covered by config check)' } };
  }
  const config = readConfigRaw(hermitDir);
  if (config === null) {
    return { covered: { id, status: 'ok', detail: 'config.json unreadable (covered by config check)' } };
  }
  return { config };
}

function checkModelPricingKnown(p: DoctorPaths = PATHS) {
  const { costLog } = p;
  try {
    const read = readConfigOrCovered('model-pricing-known', p);
    if ('covered' in read) return read.covered;
    const config = read.config;

    const known = new Set(Object.keys(PRICING));
    // A model is priced correctly iff cost-tracker's detectModel() maps it to a
    // real tier before pricing (cost-tracker.ts → calculateCost). detectModel
    // substring-matches haiku/opus/sonnet, so full ids like "claude-opus-4-8"
    // ARE priced — only a name with no tier substring silently falls back to
    // sonnet. Mirror that predicate here rather than comparing against the
    // alias-only PRICING keys, which would false-warn on every full model id.
    const isPriced = (m: string) => {
      const lower = m.toLowerCase();
      return known.has(m) || lower.includes('haiku') || lower.includes('opus') || lower.includes('sonnet');
    };
    const unknown: string[] = [];
    const seen = new Set<string>();
    const consider = (m: unknown, where: string) => {
      if (typeof m !== 'string' || !m || isPriced(m)) return;
      const key = `${m}|${where}`;
      if (seen.has(key)) return;
      seen.add(key);
      unknown.push(`"${m}" (${where})`);
    };

    consider(config.model, 'config.model');
    for (const r of Array.isArray(config.routines) ? config.routines : []) {
      consider(r?.model, `routines[${r?.id ?? '?'}].model`);
    }
    consider(config.heartbeat?.model, 'heartbeat.model');

    // Secondary signal: cost-log `model` field, last 7d. Inert today —
    // detectModel() (cost-tracker.ts) collapses every raw model string to
    // haiku|sonnet|opus before logging, so this can't find an unknown yet.
    // Kept so it activates automatically once raw model ids ever persist
    // (e.g. PROP-016), rather than adding it as a second migration later.
    if (fs.existsSync(costLog)) {
      const since = new Date(Date.now() - 7 * MS_PER_DAY).toISOString().slice(0, 10);
      for (const line of fs.readFileSync(costLog, 'utf8').split('\n')) {
        if (!line.trim()) continue;
        try {
          const entry = JSON.parse(line);
          if ((entry.timestamp || '').slice(0, 10) >= since) consider(entry.model, 'cost-log');
        } catch {}
      }
    }

    if (unknown.length > 0) {
      return {
        id: 'model-pricing-known', status: 'warn',
        detail: `unpriced model(s): ${unknown.join(', ')} — cost tracking silently falls back to sonnet pricing`,
      };
    }
    return { id: 'model-pricing-known', status: 'ok', detail: 'all configured models known to the pricing table' };
  } catch (e: any) {
    return { id: 'model-pricing-known', status: 'fail', detail: `check failed: ${e.message}` };
  }
}

function checkMemorySize(p: DoctorPaths = PATHS) {
  const CLAUDE_WARN_LINES = 200;
  const MEMORY_WARN_LINES = 160;
  const MEMORY_WARN_BYTES = 20 * 1024;
  const projectRoot = path.dirname(p.hermitDir);

  // A file saved with a trailing newline (the editor norm) has one more
  // split() element than `wc -l` counts, which would trip every threshold a
  // line early. Drop the trailing blank so the count matches what the operator
  // sees on disk.
  const countLines = (text: string): number => {
    const segments = text.split(/\r?\n/);
    return segments[segments.length - 1] === '' ? segments.length - 1 : segments.length;
  };

  try {
    const parts: string[] = [];

    for (const name of ['CLAUDE.md', 'CLAUDE.local.md']) {
      const filePath = path.join(projectRoot, name);
      if (!fs.existsSync(filePath)) continue;
      try {
        const lines = countLines(fs.readFileSync(filePath, 'utf8'));
        if (lines >= CLAUDE_WARN_LINES) {
          parts.push(`${name}: ${lines} lines (>=${CLAUDE_WARN_LINES}); use native /doctor to trim it`);
        }
      } catch (e: any) {
        parts.push(`${name}: unreadable (${e.message})`);
      }
    }

    // Same key scheme as lib/cc-compat.ts transcriptDirFor: Claude Code replaces
    // every non-alphanumeric character, not just '/'. A '/'-only scheme mis-keys
    // any path containing a dot or other punctuation (a dotted repo name, a
    // project under a hidden directory), and the leg below would then read as a
    // permanent, silent "ok".
    // Known gap: a doctor run whose project root is a *linked git worktree* finds
    // nothing here — Claude Code writes transcripts under the worktree's own key
    // but keeps auto-memory under the main checkout's key, so MEMORY.md never
    // exists at the worktree key and this leg stays silently "ok". Only affects
    // hermits driven from a worktree; a normally-installed hermit is unaffected.
    const pathKey = projectRoot.replace(/[^a-zA-Z0-9]/g, '-');
    const memoryPath = path.join(defaultConfigDir(), 'projects', pathKey, 'memory', 'MEMORY.md');
    // Auto-memory loads only MEMORY.md's first 200 lines or 25 KB, whichever
    // comes first, and drops the rest with no notice. The thresholds sit at 80%
    // of that cap so there is room to consolidate before entries start vanishing.
    if (fs.existsSync(memoryPath)) {
      try {
        const memory = fs.readFileSync(memoryPath, 'utf8');
        const lines = countLines(memory);
        const bytes = Buffer.byteLength(memory, 'utf8');
        const bounds: string[] = [];
        if (lines >= MEMORY_WARN_LINES) bounds.push(`${lines} lines (>=${MEMORY_WARN_LINES} line threshold)`);
        if (bytes >= MEMORY_WARN_BYTES) bounds.push(`${(bytes / 1024).toFixed(1)} KB (>=${MEMORY_WARN_BYTES / 1024} KB byte threshold)`);
        if (bounds.length > 0) {
          parts.push(`MEMORY.md: ${bounds.join('; ')}; approaching the 200-line / 25 KB hard cap (whichever comes first is silently truncated)`);
        }
      } catch (e: any) {
        parts.push(`MEMORY.md: unreadable (${e.message})`);
      }
    }

    if (parts.length > 0) {
      return { id: 'memory-size', status: 'warn', detail: parts.join('; ') };
    }
    return { id: 'memory-size', status: 'ok', detail: 'project CLAUDE files and auto-memory below warning thresholds' };
  } catch (e: any) {
    return { id: 'memory-size', status: 'fail', detail: `check failed: ${e.message}` };
  }
}

// ----------------- Context scan -----------------
// Reads the record startup-context.ts writes on every SessionStart: which
// injected entries (compiled/ bodies, catalog summaries, OPERATOR/SHELL
// excerpts, last report) tripped the injection-marker scan and were blocked.
// The scan itself never mutates files — this check just surfaces its verdict.

function checkContextScan(p: DoctorPaths = PATHS) {
  const { stateDir } = p;
  try {
    const scanPath = path.join(stateDir, 'context-scan.json');
    if (!fs.existsSync(scanPath)) {
      return { id: 'context-scan', status: 'ok', detail: 'no scan record yet (written on next session start)' };
    }
    const d = JSON.parse(fs.readFileSync(scanPath, 'utf-8'));
    const hits = Array.isArray(d.hits) ? d.hits : [];
    if (hits.length === 0) {
      return { id: 'context-scan', status: 'ok', detail: 'startup injection clean' };
    }
    const sources = [...new Set(hits.map((h: Json) => String(h.source)))];
    const shown = sources.slice(0, 3).join(', ') + (sources.length > 3 ? ', …' : '');
    return {
      id: 'context-scan', status: 'warn',
      detail: `${hits.length} blocked entr${hits.length === 1 ? 'y' : 'ies'} in startup injection (${shown}) — content stays on disk; inspect or remove the flagged files`,
    };
  } catch (e: any) {
    return { id: 'context-scan', status: 'fail', detail: `check failed: ${e.message}` };
  }
}

// ----------------- Routine cost -----------------
// Flags expensive-outlier routines (e.g. a "light" haiku routine that turns out to read
// broad state and costs $15/run) so they surface without manually cross-referencing
// cost-log.jsonl by hand. See docs/routine-authoring.md.

function medianOf(nums: number[]): number {
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[mid - 1] + s[mid]) / 2 : s[mid];
}

function checkRoutineCost(p: DoctorPaths = PATHS) {
  const { costLog } = p;
  try {
    const read = readConfigOrCovered('routine-cost', p);
    if ('covered' in read) return read.covered;
    const config = read.config;

    const routines: Array<{ id: string }> = (Array.isArray(config.routines) ? config.routines : [])
      .filter((r: Json) => r && typeof r.id === 'string' && r.enabled !== false);
    if (routines.length === 0) {
      return { id: 'routine-cost', status: 'ok', detail: 'no enabled routines configured' };
    }

    const ledger = scanRoutineLedger(costLog);
    if (ledger.size === 0) {
      return { id: 'routine-cost', status: 'ok', detail: 'no attribution-v2 cost rows yet — insufficient history' };
    }

    // Both cost and runs come from scanRoutineLedger's single v2 population — see the
    // contract there. Iterating configured routine ids also filters classifier artifacts
    // (e.g. a stray "routine:fired" source) and keeps the co-fire `routine:multi` bucket
    // out of the per-routine comparison, so a shared wake turn can neither be charged to
    // one participant nor appear as a zero-cost peer.
    const MIN_RUNS = 3; // avoid divide-by-small-N false positives
    const perRun: Array<{ id: string; costPerRun: number }> = [];
    for (const r of routines) {
      const entry = ledger.get(`routine:${r.id}`);
      if (!entry || entry.runs < MIN_RUNS) continue;
      perRun.push({ id: r.id, costPerRun: entry.cost / entry.runs });
    }

    if (perRun.length < 2) {
      return { id: 'routine-cost', status: 'ok', detail: `only ${perRun.length} routine(s) with ≥${MIN_RUNS} attribution-v2 runs — need ≥2 to compare` };
    }

    const floor = typeof config.doctor?.routine_cost_floor_usd === 'number' ? config.doctor.routine_cost_floor_usd : 2;

    // Compare the costliest routine against the median of its PEERS (itself excluded).
    // Including the candidate in the median lets a lone outlier drag the median toward
    // itself — with only two routines that makes 3×median mathematically unreachable, so a
    // genuinely expensive routine in a small fleet would never trip the gate.
    const sorted = perRun.sort((a, b) => a.costPerRun - b.costPerRun);
    const worst = sorted[sorted.length - 1];
    const peerMedian = medianOf(sorted.slice(0, -1).map((peer) => peer.costPerRun));
    const threshold = Math.max(peerMedian * 3, floor);

    if (worst.costPerRun > threshold) {
      return {
        id: 'routine-cost', status: 'warn',
        detail: `${worst.id} $${worst.costPerRun.toFixed(2)}/run vs peer median $${peerMedian.toFixed(2)} (threshold $${threshold.toFixed(2)}) — audit what it reads`,
      };
    }
    return { id: 'routine-cost', status: 'ok', detail: `${perRun.length} routine(s) compared, none over $${threshold.toFixed(2)}/run` };
  } catch (e: any) {
    return { id: 'routine-cost', status: 'fail', detail: `check failed: ${e.message}` };
  }
}

// ----------------- Channel liveness -----------------
// Core's first direct outward egress: one token-authed liveness call per
// enabled channel. Never surface fetch error messages or probe URLs in
// `detail` — Telegram embeds the bot token in the request URL.

const LIVENESS_TIMEOUT_MS = Number(process.env.HERMIT_DOCTOR_LIVENESS_TIMEOUT_MS) || 5000;

async function checkChannelLiveness(p: DoctorPaths = PATHS) {
  const { hermitDir } = p;
  try {
    const read = readConfigOrCovered('channel-liveness', p);
    if ('covered' in read) return read.covered;
    const config = read.config;

    const channels = config.channels && typeof config.channels === 'object' ? config.channels : {};
    // Reuse lib/channel-config's canonical enumeration: it iterates dict-valued
    // channel entries only (so the `channels.primary` string pointer is skipped
    // generically, no name hardcoding) and applies the same pyTruthy default-on
    // `enabled` semantics used everywhere else.
    const enabled = getEnabledChannels(config);

    if (enabled.length === 0) {
      return { id: 'channel-liveness', status: 'ok', detail: 'no channels configured — probe skipped' };
    }

    // Probe every channel concurrently — each fetch is independent (own token,
    // own URL, own timeout), so serializing them would add up to N × timeout
    // of dead wall-clock time to every doctor run for no correctness benefit.
    const results = await Promise.all(enabled.map(async (name): Promise<{ note: string; severity: 'warn' | 'fail' | null }> => {
      const buildProbe = CHANNEL_PROBES[name];
      if (!buildProbe) {
        return { note: `${name}: no liveness probe for this platform — not checked`, severity: null };
      }
      const token = readChannelToken(hermitDir, name, channels[name]);
      if (!token) {
        return { note: `${name}: no token configured — run /channel-setup`, severity: 'warn' };
      }
      const probe = buildProbe(token);
      try {
        const resp = await fetch(probe.url, { headers: probe.headers, signal: AbortSignal.timeout(LIVENESS_TIMEOUT_MS) });
        if (resp.ok) {
          // The probe response already carries the bot's own account, so the
          // stored self-mention identity (channel-bot-id.ts) can be validated
          // here for free. A mismatch means the token now belongs to a
          // different bot — the stored id would label mentions of a
          // decommissioned account as "you".
          const stored = channels[name]?.bot_user_id;
          const storedName = channels[name]?.bot_username;
          if (stored != null || storedName != null) {
            const live = extractBotIdentity(name, await resp.json().catch(() => null));
            if (stored != null && live.id && String(stored) !== live.id) {
              return {
                note: `${name}: reachable, but stored bot identity is stale (token belongs to a different bot) — re-run /channel-setup`,
                severity: 'warn',
              };
            }
            // The handle is mutable while the id is not (a Telegram bot can be
            // renamed in BotFather), and Telegram mentions carry only the
            // handle — a stale one silently stops matching self-mentions, and
            // can start matching whoever claimed the freed name.
            if (storedName != null && live.username &&
                String(storedName).toLowerCase() !== live.username.toLowerCase()) {
              return {
                note: `${name}: reachable, but stored bot_username is stale (the bot was renamed) — re-run /channel-setup`,
                severity: 'warn',
              };
            }
          }
          return { note: `${name}: reachable`, severity: null };
        } else if (resp.status === 401 || resp.status === 403) {
          return { note: `${name}: auth rejected (HTTP ${resp.status}) — bot token invalid or revoked`, severity: 'fail' };
        } else {
          return { note: `${name}: unexpected HTTP ${resp.status}`, severity: 'warn' };
        }
      } catch (e: any) {
        const reason = e?.name === 'TimeoutError' ? 'timeout' : 'network error';
        return { note: `${name}: unreachable (${reason})`, severity: 'warn' };
      }
    }));

    let worst: 'ok' | 'warn' | 'fail' = 'ok';
    for (const r of results) {
      if (r.severity === 'fail') worst = 'fail';
      else if (r.severity === 'warn' && worst !== 'fail') worst = 'warn';
    }

    return { id: 'channel-liveness', status: worst, detail: results.map(r => r.note).join('; ') };
  } catch (e: any) {
    return { id: 'channel-liveness', status: 'fail', detail: `check failed: ${e.message}` };
  }
}

/**
 * Voice carrier — has config.voice actually reached the system prompt?
 *
 * A drift check, not an ownership one: `config.voice` is the operator's answer and
 * `apply-settings voice-render` writes it into the settings key (and, for a custom
 * voice, the style file). Both are re-rendered at every boot, so a mismatch means
 * one of two things — the hermit has not restarted since the change, or something
 * outside the hermit took the key. Either way the remedy is the same, and neither
 * is a reason for the hermit to reclaim anything on its own.
 *
 * `voice.style` unset means the hermit does not own the key at all. A style the
 * operator picked in /config is then simply reported, never warned about — that
 * includes the Claude Code built-ins this hermit does not render itself.
 *
 * Resolution spans local, project and user scope rather than reading the hermit's
 * own hatch target: the case worth catching is a hermit whose key sits in committed
 * settings.json while a /config pick in settings.local.json outranks it — where the
 * hermit's own file looks perfectly correct.
 */
function checkVoiceCarrier(p: DoctorPaths = PATHS) {
  const id = 'voice-carrier';
  try {
    const projectRoot = path.dirname(p.hermitDir);
    const config = readSettledConfig(p.hermitDir);
    const want = outputStyleFor(config.voice);
    const { value, source } = resolvePersistedStyle(projectRoot);

    if (want === null) {
      return {
        id, status: 'ok',
        detail: value === null
          ? 'no voice configured (Claude Code defaults)'
          : `no voice configured; outputStyle "${value}" (${source}) is your own`,
      };
    }

    const remedy = 'restart the hermit, or run: /claude-code-hermit:hermit-settings voice';
    if (value !== want) {
      return {
        id, status: 'warn',
        detail: `config.voice wants "${want}" but outputStyle is ${value === null ? 'unset' : `"${value}" (${source})`} — ${remedy}`,
      };
    }
    if (want === HERMIT_OUTPUT_STYLE && !voiceFileExists(projectRoot)) {
      return {
        id, status: 'warn',
        detail: `outputStyle is "${HERMIT_OUTPUT_STYLE}" (${source}) but ${VOICE_FILE_REL} is missing — ${remedy}`,
      };
    }
    return {
      id, status: 'ok',
      detail: want === HERMIT_OUTPUT_STYLE
        ? `voice active from ${VOICE_FILE_REL} (${source})`
        : `voice active: "${want}" (${source})`,
    };
  } catch (e: any) {
    return { id, status: 'warn', detail: `check failed: ${e.message}` };
  }
}

const CLASSIFIER_DENIALS_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const CLASSIFIER_DENIALS_DETAIL_MAX = 200;
const CLASSIFIER_DENIALS_TOOL_LIMIT = 3;
const CLASSIFIER_DENIALS_PROG_LIMIT = 3;
// The hook only fires on denials, so the log can never see the successful calls
// between them and Claude Code's documented "3 in a row" fallback is not derivable.
// Time-clustering is the honest substitute, and it is cross-tool because that
// fallback is tool-agnostic — the old per-tool count was an artifact of the dedup
// window being the only counter available, not a modelling choice. 10 minutes is
// calibrated against the incident that motivated the notifier: four denials in
// nine minutes is one cluster of four.
const CLASSIFIER_DENIALS_CLUSTER_MS = 10 * 60 * 1000;
const CLASSIFIER_DENIALS_CLUSTER_FAIL = 3;
// Reporting floor. Auto mode suspends every wildcarded interpreter allow rule
// (docs/security.md § Auto-mode Classifier), so the hermit's own script calls
// re-enter the classifier constantly and an occasional stochastic denial is the
// baseline, not an incident. Warning on a single one would pin a busy install to
// a permanent `warn` and put "all checks passed" out of reach, costing more
// signal than the row buys. Below the floor the count still renders, as `ok`.
const CLASSIFIER_DENIALS_WARN_MIN_TOTAL = 3;
const CLASSIFIER_DENIALS_WARN_MIN_CLUSTER = 2;

function formatDenyTool(tool: string, total: number, programs: Record<string, number>): string {
  const entries = Object.entries(programs).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  if (entries.length === 0) return `${tool} ×${total}`;
  const shown = entries.slice(0, CLASSIFIER_DENIALS_PROG_LIMIT);
  const extra = entries.length - shown.length;
  const prog = shown.map(([n, k]) => `${n} ×${k}`).join(', ');
  return extra > 0 ? `${tool}: ${prog}, +${extra} more` : `${tool}: ${prog}`;
}

/** Most denials falling inside any single CLUSTER_MS span, across all tools. */
function largestDenialCluster(sortedMs: number[]): number {
  let best = 0;
  let lo = 0;
  for (let hi = 0; hi < sortedMs.length; hi++) {
    while (sortedMs[hi] - sortedMs[lo] > CLASSIFIER_DENIALS_CLUSTER_MS) lo++;
    best = Math.max(best, hi - lo + 1);
  }
  return best;
}

function checkClassifierDenials(p: DoctorPaths = PATHS) {
  const id = 'classifier-denials';
  try {
    const now = Date.now();
    const read = readDenials(p.hermitDir, now - CLASSIFIER_DENIALS_WINDOW_MS);
    if ('error' in read) {
      return { id, status: 'warn', detail: `check failed: permission-denied-events.jsonl unreadable (${read.error})` };
    }
    // Before the empty-window return, not after: a log whose every line is torn
    // would otherwise report a clean all-ok over a damaged file, which is the
    // exact failure this count exists to prevent.
    const damaged = read.malformed > 0 ? `; ${read.malformed} unreadable row(s)` : '';
    if (read.rows.length === 0) {
      return read.malformed > 0
        ? { id, status: 'warn', detail: `no readable classifier denials in 7d${damaged}` }
        : { id, status: 'ok', detail: 'no classifier denials recorded in 7d' };
    }

    const byTool = new Map<string, { total: number; programs: Record<string, number> }>();
    for (const row of read.rows) {
      const entry = byTool.get(row.tool) ?? { total: 0, programs: {} };
      entry.total += 1;
      if (row.prog) entry.programs[row.prog] = (entry.programs[row.prog] ?? 0) + 1;
      byTool.set(row.tool, entry);
    }

    const counted = [...byTool.entries()].map(([tool, e]) => ({ tool, ...e }));
    counted.sort((a, b) => b.total - a.total || a.tool.localeCompare(b.tool));
    const grand = read.rows.length;
    const cluster = largestDenialCluster(read.rows.map(r => Date.parse(r.ts)).sort((a, b) => a - b));

    const shown = counted.slice(0, CLASSIFIER_DENIALS_TOOL_LIMIT);
    const extraTools = counted.length - shown.length;
    const parts = shown.map(c => formatDenyTool(c.tool, c.total, c.programs));
    if (extraTools > 0) parts.push(`+${extraTools} more`);

    const status = cluster >= CLASSIFIER_DENIALS_CLUSTER_FAIL
      ? 'fail'
      : (grand >= CLASSIFIER_DENIALS_WARN_MIN_TOTAL || cluster >= CLASSIFIER_DENIALS_WARN_MIN_CLUSTER)
        ? 'warn'
        : 'ok';
    // Budget the breakdown, not the whole line: a long MCP tool key or a busy
    // install must not push the cluster count or the fail guidance — the actionable
    // half — past the cap and truncate it away.
    const head = `${grand} denials in 7d — `;
    const tail = `; largest cluster ${cluster} in 10 min`
      + damaged
      // A cluster is not the documented consecutive-denial count (see CLUSTER_MS),
      // so this correlates rather than asserting that the session actually stalled.
      + (status === 'fail'
        ? `; a cluster this size is around where auto mode falls back to prompting`
        : '');
    const budget = CLASSIFIER_DENIALS_DETAIL_MAX - head.length - tail.length;
    let body = parts.join('; ');
    if (body.length > budget) body = body.slice(0, Math.max(0, budget - 1)) + '…';
    return { id, status, detail: `${head}${body}${tail}` };
  } catch (e: any) {
    return { id, status: 'warn', detail: `check failed: ${e.message}` };
  }
}

// ----------------- Orchestration -----------------

async function runAllChecks(p: DoctorPaths = PATHS) {
  return [
    checkRuntime(p),
    checkConfig(p),
    checkHooks(p),
    checkStateFiles(p),
    checkCost(p),
    checkProposals(p),
    checkDependencies(p),
    checkVersionCurrency(p),
    checkPermissions(p),
    checkDockerSecurity(p),
    checkBypassIsolation(p),
    checkArchival(p),
    checkAutoClose(p),
    checkReflectLoop(p),
    checkScheduler(p),
    checkWatchdog(p),
    checkContextAge(p),
    checkOpusWake(p),
    checkRoutineCost(p),
    checkHeartbeat(p),
    checkRoutineMonitor(p),
    checkRoutinePrecheck(p),
    checkRawSize(p),
    checkCredentialExpiry(p),
    checkModelPricingKnown(p),
    checkMemorySize(p),
    checkContextScan(p),
    checkVoiceCarrier(p),
    checkClassifierDenials(p),
    await checkChannelLiveness(p),
  ];
}

// ----------------- Escalation ledger (issue #690) -----------------
//
// Per-finding dedup lives in state/doctor-alerts.json, this script's own file.
// It is NOT in alert-state.json: heartbeat's classifyTick rebuilds alerts{} from
// prevAlerts ∪ firing, so a doctor key parked there ages out after two clean ticks.
//
// Deriving the transition here (rather than in SKILL.md prose, as before) is the
// same correction #594 applied to heartbeat: the model renders and sends, it does
// not decide what is new. `notified` is the two-phase flag from cost-tracker.ts —
// set false on write, flipped true only once the send is confirmed, so a finding
// raised while the channel is down is re-offered on the next run instead of lost.

export interface DoctorEscalation {
  persisted: boolean;
  prior_state_known: boolean;
  new: { id: string; status: string; detail: string }[];
  resolved: string[];
}

const NO_ESCALATION = (prior_state_known: boolean): DoctorEscalation =>
  ({ persisted: false, prior_state_known, new: [], resolved: [] });

// `dir` defaults to the argv-derived hermitDir; tests pass their own so cases
// stay isolated without reloading this module.
function escalate(checks: Json[], nowIso: string, dir: string = PATHS.hermitDir): DoctorEscalation {
  try {
    const ledgerPath = doctorAlertsPath(dir);
    // writeReport creates state/ too, but it runs *after* this — without the mkdir a hermit
    // whose state dir is missing gets persisted:false and the skill suppresses the whole
    // notification, exactly on the broken install where the findings matter most.
    try { fs.mkdirSync(path.dirname(ledgerPath), { recursive: true }); } catch { /* write below reports the failure */ }
    const failing = new Map<string, Json>();
    for (const c of checks) {
      if (c?.status === 'warn' || c?.status === 'fail') failing.set(DOCTOR_PREFIX + c.id, c);
    }

    // Classify the prior ledger BEFORE mutating — mutateOwnedAlerts quarantines a
    // corrupt file and rebuilds from empty, which is indistinguishable downstream
    // from a first run and would re-notify every standing finding. `missing` is a
    // genuine first run: an empty ledger is a trustworthy prior (nothing was sent).
    const prior = readAlertState(ledgerPath);
    if (prior.kind === 'ioerror') return NO_ESCALATION(false); // healthy file we couldn't read — touch nothing
    const priorStateKnown = prior.kind !== 'corrupt';

    const pending: { id: string; status: string; detail: string }[] = [];
    const resolved: string[] = [];
    const applied = mutateOwnedAlerts(ledgerPath, (alerts) => {
      for (const [key, c] of failing) {
        const prev = alerts[key];
        const message = c.alert_detail ?? c.detail;
        alerts[key] = prev
          ? { ...prev, status: c.status, message, last_seen: nowIso,
              count: (typeof prev.count === 'number' ? prev.count : 0) + 1 }
          : { first_seen: nowIso, last_seen: nowIso, status: c.status, message,
              suppressed: false, notified: false, count: 1 };
        // Anything not yet confirmed delivered is still owed to the operator.
        if (alerts[key].notified !== true) pending.push({ id: c.id, status: c.status, detail: c.detail });
      }
      for (const key of Object.keys(alerts)) {
        if (key.startsWith(DOCTOR_PREFIX) && !failing.has(key)) {
          delete alerts[key];
          resolved.push(key.slice(DOCTOR_PREFIX.length));
        }
      }
    });
    if (!applied) return NO_ESCALATION(priorStateKnown);

    // On a rebuilt-from-corrupt ledger the entries were re-seeded above (so the
    // next run dedups normally), but this run stays silent — we cannot know what
    // the lost ledger had already announced.
    return {
      persisted: true,
      prior_state_known: priorStateKnown,
      new: priorStateKnown ? pending : [],
      resolved: priorStateKnown ? resolved : [],
    };
  } catch (e: any) {
    process.stderr.write(`[doctor-check] escalation failed: ${e.message}\n`);
    return NO_ESCALATION(false);
  }
}

// Flip `notified` on findings the caller confirmed reached the operator. Mirrors
// cost-tracker.ts's `--mark-budget-notified` verb. Unknown ids are ignored.
function markNotified(ids: string[], dir: string = PATHS.hermitDir): boolean {
  const ledgerPath = doctorAlertsPath(dir);
  // Only confirm against a ledger we could actually read. mutateOwnedAlerts would happily
  // quarantine a corrupt file, rebuild it empty and report success — dropping the episodes
  // just announced, so the next run reads them as new and re-notifies. Report false instead.
  if (readAlertState(ledgerPath).kind !== 'ok') return false;
  return mutateOwnedAlerts(ledgerPath, (alerts) => {
    for (const id of ids) {
      const entry = alerts[DOCTOR_PREFIX + id];
      if (entry && entry.notified !== true) entry.notified = true;
    }
  });
}

function writeReport(checks: Json[], escalation?: DoctorEscalation, p: DoctorPaths = PATHS) {
  const { stateDir, reportPath } = p;
  try {
    if (!fs.existsSync(stateDir)) fs.mkdirSync(stateDir, { recursive: true });
    const report = { ts: new Date().toISOString(), checks, ...(escalation ? { escalation } : {}) };
    // PID-specific tmp so two overlapping runs can't interleave into one file
    // (matches lib/alert-state.ts's writeAlertState).
    const tmp = `${reportPath}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(report, null, 2) + '\n', { encoding: 'utf-8', mode: 0o600 });
    fs.renameSync(tmp, reportPath);
    return report;
  } catch (e: any) {
    process.stderr.write(`[doctor-check] write failed: ${e.message}\n`);
    return { ts: new Date().toISOString(), checks, ...(escalation ? { escalation } : {}) };
  }
}

export {
  checkRuntime, checkConfig, checkHooks, checkStateFiles,
  checkCost, checkProposals, checkDependencies, checkVersionCurrency, checkPermissions,
  checkDockerSecurity, checkBypassIsolation, checkArchival, checkAutoClose, checkReflectLoop, checkScheduler,
  checkWatchdog, checkContextAge, checkOpusWake, checkRoutineCost, checkHeartbeat, checkRoutineMonitor,
  checkRoutinePrecheck, checkRawSize,
  checkCredentialExpiry, checkModelPricingKnown, checkMemorySize, checkContextScan, checkVoiceCarrier, checkClassifierDenials, checkChannelLiveness,
  satisfiesRange, cidrOverlap,
  // Tests build their own paths for a scratch dir; the CLI runs on the argv-derived default.
  resolvePaths,
  // runAllChecks is async (checkChannelLiveness performs network I/O) — callers must await it.
  runAllChecks, writeReport, escalate, markNotified,
};

if (import.meta.main) {
  try {
    // `doctor-check.ts <dir> --mark-notified <id>…` — confirm delivery of findings
    // the caller already sent, so they stop being re-offered. No checks are run.
    if (process.argv[3] === '--mark-notified') {
      const ok = markNotified(process.argv.slice(4));
      process.stdout.write(JSON.stringify({ marked: ok }) + '\n');
      process.exit(0);
    }
    const checks = await runAllChecks();
    const escalation = escalate(checks, new Date().toISOString());
    const report = writeReport(checks, escalation);
    if (process.argv[3] === '--gate') {
      // Routine precheck gate (lib/routines/gate.ts runDoctorGate). SKIP only when
      // nothing is owed AND the ledger itself is trustworthy; either failure must
      // wake so the skill's own fail-open path (SKILL.md: record under ## Findings,
      // send nothing) still gets to run. The escalation ledger is idempotent across
      // runs — `notified` only flips on a confirmed send — so the skill re-running
      // these checks on a WAKE re-offers the same findings rather than losing them.
      const skip = escalation.new.length === 0 && escalation.persisted && escalation.prior_state_known;
      process.stdout.write((skip ? 'SKIP' : 'WAKE') + '\n');
      process.exit(0);
    }
    // Print the report JSON so skills/tests can capture it without re-reading.
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  } catch (e: any) {
    process.stderr.write(`[doctor-check] fatal: ${e.message}\n`);
  }
  process.exit(0);
}
