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
import { costIndexPath, readCostIndex, scanAutomatedOpus, scanRoutineCostWindowed } from './lib/cost-log';
import { costLogPath } from './lib/cc-compat';
import { PRICING } from './lib/pricing';
import { getEnabledChannels } from './hermit-start';
import { readChannelToken } from './lib/channel-token';
import { siblingPluginDirs, versionedCacheCoreDir, readHermitMeta, readCoreName } from './lib/plugin-siblings';

type Json = any;

const hermitDir = path.resolve(process.argv[2] || '.claude-code-hermit');
const configPath = path.join(hermitDir, 'config.json');
const stateDir = path.join(hermitDir, 'state');
const proposalsDir = path.join(hermitDir, 'proposals');
const reportPath = path.join(stateDir, 'doctor-report.json');

const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT || path.resolve(import.meta.dir, '..');
const hooksPath = path.join(pluginRoot, 'hooks', 'hooks.json');
// Resolve the cost log relative to the hermit dir (from argv), not the CWD —
// doctor is often run from a different directory than the project root.
const costLog = costLogPath(hermitDir);

// State files expected to exist after a healthy hatch.
const EXPECTED_STATE_FILES = [
  'alert-state.json',
  'reflection-state.json',
  'runtime.json',
  'monitors.runtime.json',
  'template-manifest.json',
];

// ----------------- Checks -----------------

function checkRuntime() {
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

function checkConfig() {
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

function checkHooks() {
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

function checkStateFiles() {
  try {
    if (!fs.existsSync(stateDir)) {
      return { id: 'state', status: 'warn', detail: 'state/ directory does not exist' };
    }
    const jsonFiles = globDir(stateDir, /\.json$/);
    const broken: string[] = [];
    for (const f of jsonFiles) {
      try { JSON.parse(fs.readFileSync(f, 'utf8')); }
      catch (e) { broken.push(path.basename(f)); }
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
    return { id: 'state', status: 'ok', detail: `${jsonFiles.length} state file(s) parse cleanly` };
  } catch (e: any) {
    return { id: 'state', status: 'fail', detail: `check failed: ${e.message}` };
  }
}

function checkCost() {
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
        return {
          id: 'cost',
          status: 'warn',
          detail: `${detail} — ${idx.skipped_corrupt_lines} corrupt cost-log line(s) skipped; budget figures may be stale`,
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

function checkProposals() {
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
      if (!fm || fm.status !== 'open') continue;
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

function checkDependencies() {
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
function marketplaceCacheFile(coreName: string): string | null {
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
function cachedVersionChangelogPath(coreName: string, version: string): string | null {
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

function checkVersionCurrency() {
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

    const mpFile = marketplaceCacheFile(coreName);
    if (!mpFile) {
      return { id: 'version-currency', status: 'ok', detail: 'no marketplace cache to compare against (dev checkout, or marketplace never added)' };
    }
    let marketplace: Json;
    try {
      marketplace = JSON.parse(fs.readFileSync(mpFile, 'utf8'));
    } catch {
      return { id: 'version-currency', status: 'ok', detail: 'marketplace cache unreadable — skipping' };
    }
    const entry = (Array.isArray(marketplace.plugins) ? marketplace.plugins : []).find((p: Json) => p.name === coreName);
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
      || cachedVersionChangelogPath(coreName, cachedVersion)
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

function checkDockerSecurity() {
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

    let config: Json = {};
    try { config = JSON.parse(fs.readFileSync(configPath, 'utf8')); } catch {}
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

function checkPermissions() {
  try {
    const looseFiles: string[] = [];
    const targets: string[] = [configPath];
    if (fs.existsSync(stateDir)) {
      for (const f of globDir(stateDir, /\.json$/)) targets.push(f);
    }
    for (const p of targets) {
      if (!fs.existsSync(p)) continue;
      const mode = fs.statSync(p).mode & 0o777;
      if (mode & 0o004) looseFiles.push(`${path.basename(p)} (${mode.toString(8)})`);
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

const MS_PER_DAY = 86400000;

function daysSince(iso: any): any {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  return (Date.now() - t) / MS_PER_DAY;
}

function checkArchival() {
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

function checkReflectLoop() {
  try {
    const reflectPath = path.join(stateDir, 'reflection-state.json');
    if (!fs.existsSync(reflectPath)) {
      return { id: 'reflect', status: 'ok', detail: 'reflection-state.json absent (no reflect runs yet)' };
    }
    const rs = JSON.parse(fs.readFileSync(reflectPath, 'utf8'));
    const c = rs.counters || {};
    const total = Number(c.total_runs) || 0;
    const empty = Number(c.empty_runs) || 0;
    const props = Number(c.proposals_created) || 0;
    if (total < 10) {
      return { id: 'reflect', status: 'ok', detail: `${total} reflect run(s) (insufficient sample for empty-rate analysis)` };
    }
    const ratio = empty / total;
    const pct = Math.round(ratio * 100);
    if (ratio > 0.80 && props === 0) {
      return {
        id: 'reflect',
        status: 'warn',
        detail: `reflect loop unproductive: ${empty}/${total} empty (${pct}%), 0 proposals created`,
      };
    }
    return { id: 'reflect', status: 'ok', detail: `${empty}/${total} empty (${pct}%), ${props} proposal(s) created` };
  } catch (e: any) {
    return { id: 'reflect', status: 'fail', detail: `check failed: ${e.message}` };
  }
}

function checkScheduler() {
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

function checkWatchdog() {
  try {
    const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    const wCfg = config.watchdog || {};

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

    const statePath = path.join(stateDir, 'watchdog-state.json');
    let consecutive = 0;
    let lastRun: string | null = null;
    let lastHygieneEval: Json = null;
    try {
      const ws = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
      consecutive = ws.consecutive_stale || 0;
      lastRun = typeof ws.last_run === 'string' ? ws.last_run : null;
      lastHygieneEval = ws.last_hygiene_eval ?? null;
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
// Mirrors hermit-watchdog.ts's compact-tier hygiene primitives (resolveHygieneSessionId,
// promptTokens, isEstimateOnly) rather than importing them: that file resolves state paths
// from a CWD-relative STATE_DIR, while doctor-check.ts is deliberately invocable with an
// explicit hermit dir different from CWD (see the costLog comment above) — importing would
// silently read the wrong session on that path. The logic is small enough to duplicate safely.

/** True when a cost-log entry lacks the real per-call peak (max_prompt_tokens) and spans
 *  more than one API call — its only token count is a summed billing total across calls, so
 *  promptTokensOf averages it back down to a per-call figure instead of using the raw sum.
 *  Mirrors hermit-watchdog.ts's isEstimateOnly (the compact tier averages such entries; only
 *  the destructive /clear tier refuses them). */
function isEstimateOnlyEntry(entry: Json): boolean {
  return typeof entry.max_prompt_tokens !== 'number'
    && typeof entry.api_calls === 'number' && entry.api_calls > 1;
}

function promptTokensOf(entry: Json): number {
  if (typeof entry.max_prompt_tokens === 'number') return entry.max_prompt_tokens;
  const sum = (entry.input_tokens ?? 0) + (entry.cache_write_tokens ?? 0) + (entry.cache_read_tokens ?? 0);
  return isEstimateOnlyEntry(entry) ? Math.round(sum / (entry.api_calls || 1)) : sum;
}

/** Session id whose context size to judge: runtime.json's session_id, falling back to the
 *  harness id in sessions/.status.json for idle-phase wakes (heartbeat/routines/channel
 *  messages) — the same fallback hermit-watchdog.ts's hygiene tiers use, so this check
 *  can't be blind to exactly the accumulation they exist to catch. */
function resolveContextSessionId(runtime: Json): string {
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

function checkContextAge() {
  try {
    const read = readConfigOrCovered('context-age');
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

    const sessionId = resolveContextSessionId(runtime);
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
    // tier acts on: promptTokensOf averages an estimate-only entry (as maybeContextCompact
    // does) rather than skipping it. Only the destructive /clear tier refuses estimate-only
    // entries — mirroring that skip here would blind the check to a bloated session whose
    // latest turn happens to be a multi-call estimate, the exact case compact still compacts.
    const prompt = promptTokensOf(lastEntry);
    if (prompt <= threshold) {
      return { id: 'context-age', status: 'ok', detail: `context ${kStr(prompt)} tokens, at/under ${kStr(threshold)} threshold` };
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
        detail: `context ${kStr(prompt)} tokens over ${kStr(threshold)} threshold, ${ageNote} — context hygiene may be disabled or stuck; see the watchdog check`,
      };
    }

    return { id: 'context-age', status: 'ok', detail: `context ${kStr(prompt)} tokens over threshold, hygiene fired ${ageHours.toFixed(1)}h ago` };
  } catch (e: any) {
    return { id: 'context-age', status: 'fail', detail: `check failed: ${e.message}` };
  }
}

function checkOpusWake() {
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

function checkHeartbeat() {
  try {
    const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    const hbCfg = config.heartbeat || {};

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

    const threshold = 3 * parseDuration(hbCfg.every, 2 * 3600000);
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
function checkRoutineMonitor() {
  try {
    const read = readConfigOrCovered('routine-monitor');
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

function checkRawSize() {
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

// Shape (claudeAiOauth.expiresAt, epoch ms) confirmed by the existing
// hermit-docker login-verification probe (state-templates/bin/hermit-docker).
// Unrecognized shape degrades to 'ok' by design — no false alarms on format
// drift, at the cost of the check silently going dark if the shape changes.
function claudeOAuthStatus(): { status: 'ok' | 'warn'; note: string } {
  const credDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  const credPath = path.join(credDir, '.credentials.json');
  if (!fs.existsSync(credPath)) {
    if (process.env.ANTHROPIC_API_KEY) {
      return { status: 'ok', note: 'API-key mode (no OAuth credentials file)' };
    }
    return { status: 'ok', note: 'no OAuth credentials file (keychain or API-key auth)' };
  }
  let creds: Json;
  try {
    creds = JSON.parse(fs.readFileSync(credPath, 'utf8'));
  } catch {
    return { status: 'warn', note: 'credentials file unreadable (malformed JSON)' };
  }
  const expiresAt = creds?.claudeAiOauth?.expiresAt;
  if (typeof expiresAt !== 'number' || !Number.isFinite(expiresAt)) {
    return { status: 'ok', note: 'credentials present, no recognizable expiry field' };
  }
  const msLeft = expiresAt - Date.now();
  if (msLeft <= 0) {
    const hoursAgo = Math.abs(msLeft) / 3600000;
    return { status: 'warn', note: `OAuth token expired ${hoursAgo.toFixed(1)}h ago — run \`claude /login\` (the ~8h re-login trap)` };
  }
  if (msLeft < 2 * 3600000) {
    return { status: 'warn', note: `OAuth token expires in ${(msLeft / 60000).toFixed(0)}m — re-login soon` };
  }
  return { status: 'ok', note: `OAuth token valid (expires in ${(msLeft / 3600000).toFixed(1)}h)` };
}

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

// Walks sibling plugins' hermit-meta.json credentials[] and runs each
// declared expiry_probe, capped at CRED_PROBE_CEILING total probes (defensive
// ceiling on wall-clock: worst case CRED_PROBE_CEILING × CRED_PROBE_TIMEOUT_MS).
// Entries missing expiry_probe are skipped silently — declaring a credential
// without a probe is allowed, there's just nothing to check.
function probeSiblingCredentials(): { okCount: number; badNotes: string[] } {
  const coreName = readCoreName(pluginRoot);

  let okCount = 0;
  const badNotes: string[] = [];
  let probesRun = 0;
  let skipped = 0;

  for (const dir of siblingPluginDirs(pluginRoot, coreName)) {
    const meta = readHermitMeta(dir);
    const credentials = Array.isArray(meta.credentials) ? meta.credentials : [];
    const pluginLabel = readCoreName(dir) || path.basename(dir);

    for (const cred of credentials) {
      if (!cred || typeof cred.expiry_probe !== 'string' || !cred.expiry_probe) continue;
      // Past the ceiling, count remaining credentials as skipped rather than
      // silently dropping them — an unchecked credential must not read as ok.
      if (probesRun >= CRED_PROBE_CEILING) { skipped++; continue; }
      probesRun++;
      const who = `${pluginLabel}/${cred.name || 'credential'}`;
      const fix = cred.reauth_skill ? ` — run ${cred.reauth_skill}` : '';
      const result = runExpiryProbe(cred.expiry_probe, dir);
      if (result.kind === 'ok') {
        okCount++;
      } else if (result.kind === 'expired') {
        badNotes.push(`${who} EXPIRED${fix}`);
      } else if (result.kind === 'expires') {
        const msLeft = result.at - Date.now();
        if (msLeft <= 0) {
          badNotes.push(`${who} EXPIRED${fix}`);
        } else if (msLeft < CRED_WARN_WINDOW_MS) {
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

function checkCredentialExpiry() {
  try {
    const oauth = claudeOAuthStatus();
    const sib = probeSiblingCredentials();
    const status = (oauth.status === 'warn' || sib.badNotes.length > 0) ? 'warn' : 'ok';
    const parts = [...sib.badNotes, oauth.note]; // worst-first, OAuth note always present
    if (sib.okCount > 0) parts.push(`${sib.okCount} plugin credential(s) ok`);
    return { id: 'credential-expiry', status, detail: parts.join('; ') };
  } catch (e: any) {
    return { id: 'credential-expiry', status: 'fail', detail: `check failed: ${e.message}` };
  }
}

// ----------------- Model pricing known -----------------

// Shared by the two config-reading checks below: config.json's own validity is
// checkConfig()'s job, so a missing/unreadable file here is 'ok', not a second
// failure for the same root cause.
function readConfigOrCovered(id: string): { config: Json } | { covered: { id: string; status: string; detail: string } } {
  if (!fs.existsSync(configPath)) {
    return { covered: { id, status: 'ok', detail: 'config.json absent (covered by config check)' } };
  }
  try {
    return { config: JSON.parse(fs.readFileSync(configPath, 'utf8')) };
  } catch {
    return { covered: { id, status: 'ok', detail: 'config.json unreadable (covered by config check)' } };
  }
}

function checkModelPricingKnown() {
  try {
    const read = readConfigOrCovered('model-pricing-known');
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

// ----------------- Context scan -----------------
// Reads the record startup-context.ts writes on every SessionStart: which
// injected entries (compiled/ bodies, catalog summaries, OPERATOR/SHELL
// excerpts, last report) tripped the injection-marker scan and were blocked.
// The scan itself never mutates files — this check just surfaces its verdict.

function checkContextScan() {
  try {
    const p = path.join(stateDir, 'context-scan.json');
    if (!fs.existsSync(p)) {
      return { id: 'context-scan', status: 'ok', detail: 'no scan record yet (written on next session start)' };
    }
    const d = JSON.parse(fs.readFileSync(p, 'utf-8'));
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
// cost-index.json and routine-metrics.jsonl. See docs/routine-authoring.md.

function medianOf(nums: number[]): number {
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[mid - 1] + s[mid]) / 2 : s[mid];
}

function checkRoutineCost() {
  try {
    const read = readConfigOrCovered('routine-cost');
    if ('covered' in read) return read.covered;
    const config = read.config;

    const routines: Array<{ id: string }> = (Array.isArray(config.routines) ? config.routines : [])
      .filter((r: Json) => r && typeof r.id === 'string' && r.enabled !== false);
    if (routines.length === 0) {
      return { id: 'routine-cost', status: 'ok', detail: 'no enabled routines configured' };
    }

    const index = readCostIndex(costIndexPath(hermitDir));
    if (!index) {
      return { id: 'routine-cost', status: 'ok', detail: 'cost-index.json absent — no routine cost data yet' };
    }
    const bySource = index.by_source || {};

    // Denominator = every fire-TURN that could have generated model cost, not just
    // proceeded fires. cost-tracker attributes a whole session turn to `routine:<id>`
    // off the `[hermit-routine:<id>]` prompt marker whether the fire runs the skill
    // or is idle-gated, so a CronCreate-delivered skip still adds cost to the bucket —
    // routine-precheck.ts stamps exactly one of started|skipped-waiting|skipped-paused
    // per fire (the model-issued `fired` stamp is a later, droppable duplicate of
    // `started`), so counting those three is the true population that generated the
    // cost UNDER CRONCREATE. Monitor-mode skips are different: routine-due.ts stamps
    // skipped-waiting/skipped-paused itself, subprocess-side, with zero model wake and
    // zero cost — counting them in the denominator would dilute $/run below what a
    // genuinely expensive routine actually costs per real invocation, masking it.
    // `started` always counts (a model turn ran either way); monitor-delivered skips
    // are excluded. Counting only `fired` would drop skipped/errored fires from the
    // denominator while their cost stays in the numerator, inflating $/run into false
    // warns. Joining strictly against configured routine ids also filters classifier
    // artifacts (e.g. a stray "routine:fired" by_source key) out.
    const FIRE_EVENTS = new Set(['started', 'skipped-waiting', 'skipped-paused']);
    const fireCounts = new Map<string, number>();
    // Earliest tracked fire `ts` per routine, keyed by cost-index by_source id — routine-metrics.jsonl
    // tracking (added #378) can postdate part of a routine's lifetime cost-index accumulation, so the
    // cost-index numerator (all-time cumulative) and this fire-count denominator (tracked-window only)
    // can silently cover different windows, inflating $/run on hermits that predate the tracking
    // feature (#573). Windowing the numerator to [earliest tracked fire, now] via
    // scanRoutineCostWindowed below keeps both sides on the same window.
    const cutoffBySource = new Map<string, string>();
    try {
      const lines = fs.readFileSync(path.join(stateDir, 'routine-metrics.jsonl'), 'utf-8').split('\n');
      for (const raw of lines) {
        const line = raw.trim();
        if (!line) continue;
        try {
          const e = JSON.parse(line);
          if (!e || typeof e.routine_id !== 'string' || !FIRE_EVENTS.has(e.event)) continue;
          if (e.event !== 'started' && e.delivery === 'monitor') continue; // zero-cost skip — excluded
          fireCounts.set(e.routine_id, (fireCounts.get(e.routine_id) || 0) + 1);
          if (typeof e.ts === 'string' && e.ts) {
            const source = `routine:${e.routine_id}`;
            const prev = cutoffBySource.get(source);
            if (!prev || e.ts < prev) cutoffBySource.set(source, e.ts);
          }
        } catch {}
      }
    } catch {
      // routine-metrics.jsonl absent — fireCounts stays empty, handled as insufficient data below.
    }

    const windowedCost = scanRoutineCostWindowed(costLog, cutoffBySource);

    const MIN_RUNS = 3; // avoid divide-by-small-N false positives
    const perRun: Array<{ id: string; costPerRun: number }> = [];
    for (const r of routines) {
      const runs = fireCounts.get(r.id) || 0;
      if (runs < MIN_RUNS) continue;
      // Prefer the windowed cost (same window as `runs`); fall back to the lifetime cost-index
      // bucket when windowing isn't available (no valid fire ts, or cost-log.jsonl absent) —
      // that preserves today's behavior wherever the new data source can't be used.
      const cost = windowedCost.get(`routine:${r.id}`) ?? bySource[`routine:${r.id}`]?.cost;
      if (typeof cost !== 'number') continue;
      perRun.push({ id: r.id, costPerRun: cost / runs });
    }

    if (perRun.length < 2) {
      return { id: 'routine-cost', status: 'ok', detail: `only ${perRun.length} routine(s) with enough run history — need ≥2 to compare` };
    }

    const floor = typeof config.doctor?.routine_cost_floor_usd === 'number' ? config.doctor.routine_cost_floor_usd : 2;

    // Compare the costliest routine against the median of its PEERS (itself excluded).
    // Including the candidate in the median lets a lone outlier drag the median toward
    // itself — with only two routines that makes 3×median mathematically unreachable, so a
    // genuinely expensive routine in a small fleet would never trip the gate.
    const sorted = perRun.sort((a, b) => a.costPerRun - b.costPerRun);
    const worst = sorted[sorted.length - 1];
    const peerMedian = medianOf(sorted.slice(0, -1).map((p) => p.costPerRun));
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

type LivenessProbe = { url: string; headers?: Record<string, string> };

const LIVENESS_PROBES: Record<string, (token: string) => LivenessProbe> = {
  telegram: (token) => ({
    url: `${process.env.HERMIT_DOCTOR_TELEGRAM_API || 'https://api.telegram.org'}/bot${token}/getMe`,
  }),
  discord: (token) => ({
    url: `${process.env.HERMIT_DOCTOR_DISCORD_API || 'https://discord.com/api/v10'}/users/@me`,
    headers: { Authorization: `Bot ${token}` },
  }),
};

async function checkChannelLiveness() {
  try {
    const read = readConfigOrCovered('channel-liveness');
    if ('covered' in read) return read.covered;
    const config = read.config;

    const channels = config.channels && typeof config.channels === 'object' ? config.channels : {};
    // Reuse hermit-start's canonical enumeration: it iterates dict-valued
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
      const buildProbe = LIVENESS_PROBES[name];
      if (!buildProbe) {
        return { note: `${name}: unknown platform, not probed`, severity: null };
      }
      const token = readChannelToken(hermitDir, name, channels[name]);
      if (!token) {
        return { note: `${name}: no token configured — run /channel-setup`, severity: 'warn' };
      }
      const probe = buildProbe(token);
      try {
        const resp = await fetch(probe.url, { headers: probe.headers, signal: AbortSignal.timeout(LIVENESS_TIMEOUT_MS) });
        if (resp.ok) {
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

// ----------------- Orchestration -----------------

async function runAllChecks() {
  return [
    checkRuntime(),
    checkConfig(),
    checkHooks(),
    checkStateFiles(),
    checkCost(),
    checkProposals(),
    checkDependencies(),
    checkVersionCurrency(),
    checkPermissions(),
    checkDockerSecurity(),
    checkArchival(),
    checkReflectLoop(),
    checkScheduler(),
    checkWatchdog(),
    checkContextAge(),
    checkOpusWake(),
    checkRoutineCost(),
    checkHeartbeat(),
    checkRoutineMonitor(),
    checkRawSize(),
    checkCredentialExpiry(),
    checkModelPricingKnown(),
    checkContextScan(),
    await checkChannelLiveness(),
  ];
}

function writeReport(checks: Json[]) {
  try {
    if (!fs.existsSync(stateDir)) fs.mkdirSync(stateDir, { recursive: true });
    const report = { ts: new Date().toISOString(), checks };
    const tmp = reportPath + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(report, null, 2) + '\n', { encoding: 'utf-8', mode: 0o600 });
    fs.renameSync(tmp, reportPath);
    return report;
  } catch (e: any) {
    process.stderr.write(`[doctor-check] write failed: ${e.message}\n`);
    return { ts: new Date().toISOString(), checks };
  }
}

export {
  checkRuntime, checkConfig, checkHooks, checkStateFiles,
  checkCost, checkProposals, checkDependencies, checkVersionCurrency, checkPermissions,
  checkDockerSecurity, checkArchival, checkReflectLoop, checkScheduler,
  checkWatchdog, checkContextAge, checkOpusWake, checkRoutineCost, checkHeartbeat, checkRoutineMonitor, checkRawSize,
  checkCredentialExpiry, checkModelPricingKnown, checkContextScan, checkChannelLiveness,
  satisfiesRange, cidrOverlap,
  // runAllChecks is async (checkChannelLiveness performs network I/O) — callers must await it.
  runAllChecks, writeReport,
};

if (import.meta.main) {
  try {
    const checks = await runAllChecks();
    const report = writeReport(checks);
    // Print the report JSON so skills/tests can capture it without re-reading.
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  } catch (e: any) {
    process.stderr.write(`[doctor-check] fatal: ${e.message}\n`);
  }
  process.exit(0);
}
