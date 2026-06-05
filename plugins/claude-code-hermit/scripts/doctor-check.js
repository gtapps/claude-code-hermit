'use strict';

// Fail-open: a failing check records "fail" in its own entry; the orchestrator
// never crashes and the process always exits 0.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const { globDir, readFrontmatter } = require('./lib/frontmatter');
const { validate } = require('./validate-config');
const { kStr } = require('./lib/format');

const hermitDir = path.resolve(process.argv[2] || '.claude-code-hermit');
const configPath = path.join(hermitDir, 'config.json');
const stateDir = path.join(hermitDir, 'state');
const proposalsDir = path.join(hermitDir, 'proposals');
const reportPath = path.join(stateDir, 'doctor-report.json');

const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT || path.resolve(__dirname, '..');
const hooksPath = path.join(pluginRoot, 'hooks', 'hooks.json');
const costLog = path.resolve('.claude', 'cost-log.jsonl');

// State files expected to exist after a healthy hatch.
const EXPECTED_STATE_FILES = [
  'alert-state.json',
  'reflection-state.json',
  'runtime.json',
  'monitors.runtime.json',
];

// ----------------- Checks -----------------

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
  } catch (e) {
    return { id: 'config', status: 'fail', detail: `check failed: ${e.message}` };
  }
}

function checkHooks() {
  try {
    if (!fs.existsSync(hooksPath)) {
      return { id: 'hooks', status: 'fail', detail: `hooks.json not found at ${hooksPath}` };
    }
    const hooks = JSON.parse(fs.readFileSync(hooksPath, 'utf8'));
    const missing = [];
    const groups = hooks.hooks || {};
    for (const entries of Object.values(groups)) {
      if (!Array.isArray(entries)) continue;
      for (const entry of entries) {
        for (const h of entry.hooks || []) {
          const cmd = h.command || '';
          const m = cmd.match(/\$\{CLAUDE_PLUGIN_ROOT\}\/(\S+?\.(?:js|sh|py))/);
          if (!m) continue;
          const abs = path.join(pluginRoot, m[1]);
          if (!fs.existsSync(abs)) missing.push(m[1]);
        }
      }
    }
    if (missing.length > 0) {
      return { id: 'hooks', status: 'fail', detail: `missing script(s): ${missing.join(', ')}` };
    }
    return { id: 'hooks', status: 'ok', detail: 'all referenced hook scripts exist' };
  } catch (e) {
    return { id: 'hooks', status: 'fail', detail: `check failed: ${e.message}` };
  }
}

function checkStateFiles() {
  try {
    if (!fs.existsSync(stateDir)) {
      return { id: 'state', status: 'warn', detail: 'state/ directory does not exist' };
    }
    const jsonFiles = globDir(stateDir, /\.json$/);
    const broken = [];
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
    return { id: 'state', status: 'ok', detail: `${jsonFiles.length} state file(s) parse cleanly` };
  } catch (e) {
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
    const detail = `today $${todayTotal.toFixed(4)} · ${kStr(todayTokens)}K tokens, ${kStr(todayCacheRead)}K cached`;
    return { id: 'cost', status: 'ok', detail };
  } catch (e) {
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
  } catch (e) {
    return { id: 'proposals', status: 'fail', detail: `check failed: ${e.message}` };
  }
}

// Lightweight semver-range check. Supports `>=X.Y.Z` and `X.Y.Z` (treated as `>=X.Y.Z`).
// Pre-release tags and complex ranges (`^`, `~`, `||`, `<`) are not supported — fall back to ok.
function satisfiesRange(version, range) {
  if (typeof version !== 'string' || typeof range !== 'string') return true;
  const m = range.match(/^\s*(>=|=)?\s*(\d+)\.(\d+)\.(\d+)\s*$/);
  if (!m) return true; // unrecognized range form — don't second-guess
  const [, , rMaj, rMin, rPatch] = m;
  const v = version.match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!v) return true;
  const [, vMaj, vMin, vPatch] = v;
  const cmp = [
    parseInt(vMaj, 10) - parseInt(rMaj, 10),
    parseInt(vMin, 10) - parseInt(rMin, 10),
    parseInt(vPatch, 10) - parseInt(rPatch, 10),
  ];
  for (const c of cmp) {
    if (c > 0) return true;
    if (c < 0) return false;
  }
  return true; // equal
}

function checkDependencies() {
  try {
    // Scan sibling plugins under plugins/<name>/.claude-plugin/plugin.json (monorepo)
    // or ${CLAUDE_PLUGIN_ROOT}/../*/.claude-plugin/plugin.json (legacy flat cache).
    // Read core version from this plugin's own manifest.
    const corePj = path.join(pluginRoot, '.claude-plugin', 'plugin.json');
    if (!fs.existsSync(corePj)) {
      return { id: 'dependencies', status: 'ok', detail: 'core manifest absent — skipping range check' };
    }
    let coreVersion;
    try {
      coreVersion = JSON.parse(fs.readFileSync(corePj, 'utf8')).version;
    } catch {
      return { id: 'dependencies', status: 'warn', detail: 'core plugin.json unreadable' };
    }
    if (!coreVersion) {
      return { id: 'dependencies', status: 'ok', detail: 'core version not set — skipping range check' };
    }

    const siblingsRoot = path.resolve(pluginRoot, '..');
    let siblingDirs = [];
    try { siblingDirs = fs.readdirSync(siblingsRoot, { withFileTypes: true }); } catch {}

    const mismatches = [];
    let checked = 0;
    for (const ent of siblingDirs) {
      if (!ent.isDirectory()) continue;
      if (path.join(siblingsRoot, ent.name) === pluginRoot) continue; // skip self
      const pj = path.join(siblingsRoot, ent.name, '.claude-plugin', 'plugin.json');
      if (!fs.existsSync(pj)) continue;
      let manifest;
      try { manifest = JSON.parse(fs.readFileSync(pj, 'utf8')); } catch { continue; }
      const metaPath = path.join(siblingsRoot, ent.name, '.claude-plugin', 'hermit-meta.json');
      let meta = {};
      try { if (fs.existsSync(metaPath)) meta = JSON.parse(fs.readFileSync(metaPath, 'utf8')); } catch {}
      const range = meta.required_core_version;
      if (!range) continue;
      checked++;
      if (!satisfiesRange(coreVersion, range)) {
        mismatches.push(`${manifest.name || ent.name} requires ${range} (core is ${coreVersion})`);
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
  } catch (e) {
    return { id: 'dependencies', status: 'warn', detail: `check failed: ${e.message}` };
  }
}

// Pure helpers — no subprocess, fully testable in isolation.

/** Returns true if two IPv4 CIDR strings overlap. Fails open (returns false) on any parse error. */
function cidrOverlap(a, b) {
  try {
    const parse = s => {
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

    let config = {};
    try { config = JSON.parse(fs.readFileSync(configPath, 'utf8')); } catch {}
    const sec = (config.docker && config.docker.security) || null;
    const declared = sec && Object.values(sec).some(v =>
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

    let composeCfg;
    try {
      composeCfg = JSON.parse(execFileSync('docker', [
        'compose', '-f', baseCompose, '-f', overlayPath,
        'config', '--format', 'json',
      ], { cwd: projectRoot, timeout: 10_000 }).toString());
    } catch (e) {
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
            let labels = {};
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
        } catch (e) {
          return {
            id: 'docker-security',
            status: 'warn',
            detail: `posture declared and overlay present (subnet collision check failed: ${e.message.slice(0, 80)})`,
          };
        }
      }
    }

    return { id: 'docker-security', status: 'ok', detail: 'posture declared and overlay present' };
  } catch (e) {
    return { id: 'docker-security', status: 'fail', detail: `check failed: ${e.message}` };
  }
}

function checkPermissions() {
  try {
    const looseFiles = [];
    const targets = [configPath];
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
  } catch (e) {
    return { id: 'permissions', status: 'fail', detail: `check failed: ${e.message}` };
  }
}

const MS_PER_DAY = 86400000;

function daysSince(iso) {
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
  } catch (e) {
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
  } catch (e) {
    return { id: 'reflect', status: 'fail', detail: `check failed: ${e.message}` };
  }
}

// ----------------- Orchestration -----------------

function runAllChecks() {
  return [
    checkConfig(),
    checkHooks(),
    checkStateFiles(),
    checkCost(),
    checkProposals(),
    checkDependencies(),
    checkPermissions(),
    checkDockerSecurity(),
    checkArchival(),
    checkReflectLoop(),
  ];
}

function writeReport(checks) {
  try {
    if (!fs.existsSync(stateDir)) fs.mkdirSync(stateDir, { recursive: true });
    const report = { ts: new Date().toISOString(), checks };
    const tmp = reportPath + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(report, null, 2) + '\n', { encoding: 'utf-8', mode: 0o600 });
    fs.renameSync(tmp, reportPath);
    return report;
  } catch (e) {
    process.stderr.write(`[doctor-check] write failed: ${e.message}\n`);
    return { ts: new Date().toISOString(), checks };
  }
}

if (require.main === module) {
  try {
    const checks = runAllChecks();
    const report = writeReport(checks);
    // Print the report JSON so skills/tests can capture it without re-reading.
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  } catch (e) {
    process.stderr.write(`[doctor-check] fatal: ${e.message}\n`);
  }
  process.exit(0);
} else {
  module.exports = {
    checkConfig, checkHooks, checkStateFiles,
    checkCost, checkProposals, checkDependencies, checkPermissions,
    checkDockerSecurity, checkArchival, checkReflectLoop,
    satisfiesRange, cidrOverlap,
    runAllChecks, writeReport,
  };
}
