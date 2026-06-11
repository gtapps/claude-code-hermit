// WP7 tier 3 port of src/ha_agent_lab/apply.py — the YAML apply path:
// simulate, check_config, REST config push, verify, reload.
//
// HA API gotchas honored (see plugin CLAUDE.md):
//   - DELETE of a missing id returns 400 (not 404) with {"message":"Resource
//     not found"} — extractHaErrorMessage surfaces {"message"} verbatim, no
//     404 special-casing.
//   - POST→GET is synchronous on HA 2026.x — the verify GET runs immediately,
//     no retry/delay.
//   - 403 on the config push means YAML mode — fall back with a clear message
//     and still attempt the reload.
//   - --reload is overloaded: it selects both the REST push endpoint and the
//     reload service call (no push-only mode).
//
// Async note: validateAndApply/readConfig/removeConfig are async (the client
// is fetch-based). Tests inject a fake ApplyClient.

import { readFileSync } from 'node:fs';
import { basename, relative } from 'node:path';

import { currentSessionId, slugify, standardMetadata, writeMarkdownArtifact } from './artifacts';
import { HomeAssistantError, extractHaErrorMessage } from './ha-api';
import { canReloadDomain } from './policy';
import { SimulationResult, simulateArtifact } from './simulate';
import { parseYaml } from './yaml';

const CONFIG_DOMAINS = new Set(['automation', 'script']);

/** The slice of HomeAssistantClient the apply path needs (tests inject a fake). */
export interface ApplyClient {
  get(path: string): Promise<any>;
  post(path: string, payload?: Record<string, unknown> | null): Promise<any>;
  delete(path: string): Promise<any>;
}

function unsupportedDomainMsg(domain: string): string {
  return `Domain '${domain}' is not a configurable domain. Choose from: ${[...CONFIG_DOMAINS].sort().join(', ')}.`;
}

export interface ApplyResult {
  ok: boolean;
  configCheckOk: boolean;
  configId: string | null;
  domain: string | null;
  creationAttempted: boolean;
  creationOk: boolean;
  reloadAttempted: boolean;
  reloadDomain: string | null;
  message: string;
  reportPath: string;
}

export interface ReadResult {
  ok: boolean;
  domain: string;
  configId: string;
  config: Record<string, any>;
  message: string;
}

export interface RemoveResult {
  ok: boolean;
  domain: string;
  configId: string;
  message: string;
  reportPath: string;
}

/** Python `str(value or "")`: None/falsy -> "". */
function pyStrOrEmpty(value: unknown): string {
  if (value === null || value === undefined || value === false || value === 0 || value === '') {
    return '';
  }
  return String(value);
}

/** basename without the final extension (Python Path.stem). */
function stem(path: string): string {
  const name = basename(path);
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(0, dot) : name;
}

export async function validateAndApply(
  root: string,
  client: ApplyClient,
  artifactPath: string,
  reloadDomain: string | null = null,
): Promise<ApplyResult> {
  const simulation = simulateArtifact(root, artifactPath);

  if (!simulation.isValid) {
    const reportPath = writeApplyReport(root, artifactPath, simulation, {
      configCheckOk: false, configId: null, creationAttempted: false,
      creationOk: false, reloadAttempted: false, reloadDomain,
      message: 'Simulation failed. See missing entities or blocked reasons.',
    });
    return {
      ok: false, configCheckOk: false, configId: null, domain: reloadDomain,
      creationAttempted: false, creationOk: false, reloadAttempted: false,
      reloadDomain, message: 'simulation-failed', reportPath,
    };
  }

  let configOk: boolean;
  try {
    const checkResult = await client.post('/api/config/core/check_config', {});
    configOk = isTruthy(checkResult);
  } catch (exc) {
    if (!(exc instanceof HomeAssistantError)) throw exc;
    const reportPath = writeApplyReport(root, artifactPath, simulation, {
      configCheckOk: false, configId: null, creationAttempted: false,
      creationOk: false, reloadAttempted: false, reloadDomain,
      message: `Config validation failed: ${exc.message}`,
    });
    return {
      ok: false, configCheckOk: false, configId: null, domain: reloadDomain,
      creationAttempted: false, creationOk: false, reloadAttempted: false,
      reloadDomain, message: exc.message, reportPath,
    };
  }

  let configId: string | null = null;
  let creationAttempted = false;
  let creationOk = false;
  let driftWarning: string | null = null;
  let yamlModeMessage: string | null = null;

  if (reloadDomain && !canReloadDomain(reloadDomain)) {
    const reportPath = writeApplyReport(root, artifactPath, simulation, {
      configCheckOk: configOk, configId: null, creationAttempted: false,
      creationOk: false, reloadAttempted: false, reloadDomain,
      message: `Reload domain \`${reloadDomain}\` is not allowed.`,
    });
    return {
      ok: false, configCheckOk: configOk, configId: null, domain: reloadDomain,
      creationAttempted: false, creationOk: false, reloadAttempted: false,
      reloadDomain, message: 'reload-blocked', reportPath,
    };
  }

  if (reloadDomain !== null && CONFIG_DOMAINS.has(reloadDomain)) {
    const parsed = parseYaml(readFileSync(artifactPath, 'utf8'));
    const artifactConfig: Record<string, any> =
      parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as Record<string, any>)
        : {};
    configId =
      pyStrOrEmpty(artifactConfig.id).trim() ||
      slugify(pyStrOrEmpty(artifactConfig.alias).trim()) ||
      slugify(stem(artifactPath));
    if (!pyStrOrEmpty(artifactConfig.id).trim()) {
      driftWarning =
        `id '${configId}' derived from ${artifactConfig.alias ? 'alias' : 'filename'} — ` +
        `set id: explicitly in the YAML to prevent drift on rename.`;
    }

    creationAttempted = true;
    try {
      await client.post(`/api/config/${reloadDomain}/config/${configId}`, artifactConfig);
      try {
        const verify = await client.get(`/api/config/${reloadDomain}/config/${configId}`);
        creationOk = verify?.alias === artifactConfig.alias;
      } catch (exc) {
        if (!(exc instanceof HomeAssistantError)) throw exc;
        creationOk = false;
      }
    } catch (exc) {
      if (!(exc instanceof HomeAssistantError)) throw exc;
      if (exc.statusCode === 403) {
        yamlModeMessage =
          `YAML mode: HA rejected REST config push (403). ` +
          `Place the generated YAML in your HA config directory and reload ${reloadDomain}.`;
      } else {
        const haMessage = extractHaErrorMessage(exc);
        const msg = `Config push failed: ${haMessage}`;
        const reportPath = writeApplyReport(root, artifactPath, simulation, {
          configCheckOk: configOk, configId, creationAttempted: true,
          creationOk: false, reloadAttempted: false, reloadDomain,
          message: msg,
        });
        return {
          ok: false, configCheckOk: configOk, configId, domain: reloadDomain,
          creationAttempted: true, creationOk: false, reloadAttempted: false,
          reloadDomain, message: msg, reportPath,
        };
      }
    }
  }

  let reloadAttempted = false;
  if (reloadDomain) {
    await client.post(`/api/services/${reloadDomain}/reload`, {});
    reloadAttempted = true;
  }

  const parts = ['Validation succeeded. Apply flow completed.'];
  if (creationAttempted && creationOk) {
    parts.push(`Config pushed and verified via REST (${reloadDomain}/${configId}).`);
  } else if (yamlModeMessage) {
    parts.push(yamlModeMessage);
  } else {
    parts.push(
      'Generated YAML must still be present in Home Assistant includes for reload to take effect.',
    );
  }
  if (driftWarning) parts.push(driftWarning);
  const message = parts.join(' ');

  const reportPath = writeApplyReport(root, artifactPath, simulation, {
    configCheckOk: configOk, configId, creationAttempted,
    creationOk, reloadAttempted, reloadDomain,
    message,
  });
  return {
    ok: true, configCheckOk: configOk, configId, domain: reloadDomain,
    creationAttempted, creationOk, reloadAttempted,
    reloadDomain, message, reportPath,
  };
}

export async function readConfig(
  client: ApplyClient,
  domain: string,
  configId: string,
): Promise<ReadResult> {
  if (!CONFIG_DOMAINS.has(domain)) {
    return { ok: false, domain, configId, config: {}, message: unsupportedDomainMsg(domain) };
  }

  try {
    const config = await client.get(`/api/config/${domain}/config/${configId}`);
    return { ok: true, domain, configId, config, message: 'ok' };
  } catch (exc) {
    if (!(exc instanceof HomeAssistantError)) throw exc;
    return { ok: false, domain, configId, config: {}, message: extractHaErrorMessage(exc) };
  }
}

export async function removeConfig(
  root: string,
  client: ApplyClient,
  domain: string,
  configId: string,
): Promise<RemoveResult> {
  if (!CONFIG_DOMAINS.has(domain)) {
    const msg = unsupportedDomainMsg(domain);
    const reportPath = writeRemoveReport(root, domain, configId, { ok: false, message: msg });
    return { ok: false, domain, configId, message: msg, reportPath };
  }

  let ok: boolean;
  let message: string;
  try {
    const result = await client.delete(`/api/config/${domain}/config/${configId}`);
    ok = result !== null && typeof result === 'object' && !Array.isArray(result) && result.result === 'ok';
    // Python repr of the unexpected payload — JSON is the closest stable form.
    message = ok ? 'ok' : `unexpected response: ${JSON.stringify(result)}`;
  } catch (exc) {
    if (!(exc instanceof HomeAssistantError)) throw exc;
    ok = false;
    message = extractHaErrorMessage(exc);
  }

  const reportPath = writeRemoveReport(root, domain, configId, { ok, message });
  return { ok, domain, configId, message, reportPath };
}

function writeApplyReport(
  root: string,
  artifactPath: string,
  simulation: SimulationResult,
  options: {
    configCheckOk: boolean;
    configId: string | null;
    creationAttempted: boolean;
    creationOk: boolean;
    reloadAttempted: boolean;
    reloadDomain: string | null;
    message: string;
  },
): string {
  const metadata = standardMetadata('apply', `Apply Report — ${basename(artifactPath)}`, {
    session: currentSessionId(root),
    tags: ['apply', 'ha-automation'],
    extra: {
      artifact_path: relative(root, artifactPath),
      config_check_ok: options.configCheckOk,
      config_id: options.configId,
      creation_attempted: options.creationAttempted,
      creation_ok: options.creationOk,
      reload_attempted: options.reloadAttempted,
      reload_domain: options.reloadDomain,
      simulation_valid: simulation.isValid,
      message: options.message,
    },
  });
  const body = [
    `# Apply Report for \`${basename(artifactPath)}\``,
    '',
    `- simulation_valid: ${simulation.isValid}`,
    `- config_check_ok: ${options.configCheckOk}`,
    `- config_id: ${options.configId || 'none'}`,
    `- creation_attempted: ${options.creationAttempted}`,
    `- creation_ok: ${options.creationOk}`,
    `- reload_attempted: ${options.reloadAttempted}`,
    `- reload_domain: ${options.reloadDomain || 'none'}`,
    '',
    `Message: ${options.message}`,
  ].join('\n');
  const slug = `audit-ha-apply-${slugify(stem(artifactPath))}`;
  return writeMarkdownArtifact(
    root,
    '.claude-code-hermit/raw',
    slug,
    metadata,
    body,
    'audit-ha-apply-latest.md',
  );
}

function writeRemoveReport(
  root: string,
  domain: string,
  configId: string,
  options: { ok: boolean; message: string },
): string {
  const metadata = standardMetadata('remove', `Remove Report — ${domain}/${configId}`, {
    session: currentSessionId(root),
    tags: ['ha-remove', `ha-${domain}`],
    extra: {
      domain,
      config_id: configId,
      ok: options.ok,
      message: options.message,
    },
  });
  const body = [
    `# Remove Report for \`${domain}/${configId}\``,
    '',
    `- ok: ${options.ok}`,
    `- domain: ${domain}`,
    `- config_id: ${configId}`,
    '',
    `Message: ${options.message}`,
  ].join('\n');
  const slug = `audit-ha-remove-${domain}-${slugify(configId)}`;
  return writeMarkdownArtifact(
    root,
    '.claude-code-hermit/raw',
    slug,
    metadata,
    body,
    'audit-ha-remove-latest.md',
  );
}

// Python _is_truthy: bool -> itself; dict with "result" -> == "valid";
// other dict -> no value is literal False; everything else -> bool(value).
function isTruthy(checkResult: unknown): boolean {
  if (typeof checkResult === 'boolean') return checkResult;
  if (Array.isArray(checkResult)) return checkResult.length > 0; // Python bool(list)
  if (checkResult !== null && typeof checkResult === 'object') {
    const record = checkResult as Record<string, unknown>;
    if ('result' in record) return record.result === 'valid';
    return !Object.values(record).some((value) => value === false);
  }
  return Boolean(checkResult);
}
